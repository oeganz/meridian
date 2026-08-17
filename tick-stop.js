/**
 * Tick-level stop-loss — fires close within ~1s of a real dump, instead of
 * waiting for the 30s PnL poll / 10min management cycle.
 *
 * Two-stage by design. Jupiter token price vs entry is only a cheap SCREEN;
 * it is NOT position PnL. A single-sided SOL DLMM position sits below the
 * active bin, so a 3% downward token tick is the position working as intended
 * and collecting fees. Closing on that alone burned 24 round trips in 5 days
 * for -1% gas+slippage each and zero fee capture. So a price-screen hit now
 * only triggers a real getPositionPnl() read, and the close needs the LP
 * value to actually be below stopLossPct.
 *
 * Also: no close before tickStopGraceSeconds after deploy (memecoins routinely
 * wick 3% in the first minute, before any fee has accrued), and the close goes
 * through executeTool so it lands in the action log and reaches
 * recordPerformance()/pool-memory. Direct closePosition() calls bypassed both,
 * which is why 24 on-chain closes left ~5 rows in actions-*.jsonl.
 *
 * ponytail: upgrade path — replace Jupiter poll with Helius/Birdeye WS or
 * Solana log subscribe for sub-second latency. Add when this still misses
 * dumps >2%.
 */
import { log } from "./logger.js";
import { getTrackedPositions } from "./state.js";
import { getPositionPnl } from "./tools/dlmm.js";
import { executeTool } from "./tools/executor.js";
import { config } from "./config.js";

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
// 1s polling without an API key gets a solid wall of Jupiter 429s, which makes
// the screen blind exactly when it matters. 4s still catches a dump far inside
// the 30s PnL poller / 10min cron that back it up.
const POLL_MS = Math.max(1000, Number(config.management.tickStopPollMs ?? 4000));
const COOLDOWN_MS = 60_000; // per-position re-arm after a trigger / false-positive
const MAX_PARALLEL_FETCH = 4;
const RATE_LIMIT_BACKOFF_MS = 60_000;

let _interval = null;
let _busy = false;
let _lastTriggerAt = 0;
let _rateLimitedUntil = 0;
const _cooldownUntil = new Map(); // position_address -> ms epoch

function inCooldown(positionAddress) {
  const until = _cooldownUntil.get(positionAddress);
  return until && Date.now() < until;
}

function setCooldown(positionAddress, ms = COOLDOWN_MS) {
  _cooldownUntil.set(positionAddress, Date.now() + ms);
}

async function fetchPrices(mints) {
  const url = `${JUPITER_PRICE_API}?ids=${mints.join(",")}`;
  const headers = JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
  const res = await fetch(url, { headers });
  if (res.status === 429) {
    // Park the whole screen briefly instead of retrying every tick — a tight
    // retry loop is what earned the 429 in the first place.
    _rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    throw new Error("Jupiter price 429 (backing off 60s)");
  }
  if (!res.ok) throw new Error(`Jupiter price ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const mint of mints) {
    const entry = data[mint];
    if (entry && typeof entry.usdPrice === "number") {
      out[mint] = entry.usdPrice;
    }
  }
  return out;
}

async function tickOnce() {
  if (_busy) return;
  if (Date.now() < _rateLimitedUntil) return;
  _busy = true;
  try {
    const open = getTrackedPositions(true).filter((p) => !p.closed);
    if (!open.length) return;

    const stopLossPct = config.management.stopLossPct;
    const graceMs = Math.max(0, Number(config.management.tickStopGraceSeconds ?? 300)) * 1000;
    const screenPct = Number(config.management.tickStopScreenPct ?? stopLossPct);
    const eligible = open.filter((p) => {
      if (!p.base_mint || !p.entry_token_price_usd) return false;
      if (inCooldown(p.position)) return false;
      // Entry grace: a fresh position has earned no fees yet, so an early wick
      // can only ever close at a loss.
      const age = p.deployed_at ? Date.now() - new Date(p.deployed_at).getTime() : Infinity;
      if (age < graceMs) return false;
      return true;
    });
    if (!eligible.length) return;

    // Batch unique base mints
    const mints = [...new Set(eligible.map((p) => p.base_mint))];
    // Fetch in chunks to keep request size sane
    const chunks = [];
    for (let i = 0; i < mints.length; i += MAX_PARALLEL_FETCH) {
      chunks.push(mints.slice(i, i + MAX_PARALLEL_FETCH));
    }
    const priceMap = {};
    for (const chunk of chunks) {
      try {
        const got = await fetchPrices(chunk);
        Object.assign(priceMap, got);
      } catch (e) {
        log("tick_stop_warn", `price fetch failed: ${e.message}`);
      }
    }

    for (const p of eligible) {
      const live = priceMap[p.base_mint];
      if (!live) continue;
      const tokenMovePct = ((live - p.entry_token_price_usd) / p.entry_token_price_usd) * 100;
      if (tokenMovePct > screenPct) continue;

      const sinceLast = Date.now() - _lastTriggerAt;
      if (sinceLast < 5000) {
        // back-to-back triggers are likely the same dump across multiple positions — throttle
        log("tick_stop", `throttled ${p.pool_name || p.position.slice(0, 8)} token=${tokenMovePct.toFixed(2)}%`);
        setCooldown(p.position, 30_000);
        continue;
      }

      // Screen hit — now read the REAL LP position PnL before closing anything.
      let lpPnlPct = null;
      try {
        const pnl = await getPositionPnl({ pool_address: p.pool, position_address: p.position });
        lpPnlPct = typeof pnl?.pnl_pct === "number" ? pnl.pnl_pct : null;
      } catch (e) {
        log("tick_stop_warn", `pnl read failed for ${p.pool_name || p.position.slice(0, 8)}: ${e.message}`);
      }
      if (lpPnlPct == null) {
        setCooldown(p.position, 30_000);
        continue;
      }
      if (lpPnlPct > stopLossPct) {
        // Token dipped but the LP position is still fine — this is the case that
        // used to force a losing close. Back off and re-screen later.
        log("tick_stop", `screen hit but LP ok ${p.pool_name || p.position.slice(0, 8)} token=${tokenMovePct.toFixed(2)}% lp=${lpPnlPct.toFixed(2)}%`);
        setCooldown(p.position, 30_000);
        continue;
      }

      _lastTriggerAt = Date.now();
      setCooldown(p.position);
      log("tick_stop", `STOP-LOSS TICK ${p.pool_name || p.position.slice(0, 8)} lp=${lpPnlPct.toFixed(2)}% token=${tokenMovePct.toFixed(2)}% entry=${p.entry_token_price_usd} live=${live}`);
      try {
        // via executeTool so the close is logged and reaches recordPerformance()
        const res = await executeTool("close_position", {
          position_address: p.position,
          reason: `⚡ Tick stop-loss: LP PnL ${lpPnlPct.toFixed(2)}% <= ${stopLossPct}%`,
        });
        log("tick_stop", `close result: ${res?.success ? "OK" : res?.error || res?.reason || "unknown"}`);
      } catch (e) {
        log("tick_stop_error", `close failed: ${e.message}`);
      }
    }
  } finally {
    _busy = false;
  }
}

export function startTickStop() {
  if (_interval) return;
  if (config.management.tickStopEnabled === false) {
    log("cron", "Tick stop-loss disabled by config");
    return;
  }
  _interval = setInterval(() => {
    tickOnce().catch((e) => log("tick_stop_error", e.message));
  }, POLL_MS);
  log("cron", `Tick stop-loss started — ${POLL_MS}ms poll on open positions (grace=${config.management.tickStopGraceSeconds}s screen=${config.management.tickStopScreenPct}%)`);
}

export function stopTickStop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    log("cron", "Tick stop-loss stopped");
  }
}
