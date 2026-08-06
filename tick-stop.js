/**
 * Tick-level stop-loss — fires close within ~1s of PnL crossing stopLossPct,
 * instead of waiting for the 30s PnL poll / 10min management cycle.
 *
 * Source: independent of Meteora's PnL API (which can lag). We compute
 * PnL% from a live token price (Jupiter price v3) vs the entry price
 * captured at deploy.
 *
 * ponytail: upgrade path — replace Jupiter poll with Helius/Birdeye WS or
 * Solana log subscribe for sub-second latency. Add when this still misses
 * dumps >2%.
 */
import { log } from "./logger.js";
import { getTrackedPositions, setPositionInstruction } from "./state.js";
import { closePosition } from "./tools/dlmm.js";
import { config } from "./config.js";

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const POLL_MS = 1000;
const COOLDOWN_MS = 60_000; // per-position re-arm after a trigger / false-positive
const MAX_PARALLEL_FETCH = 4;

let _interval = null;
let _busy = false;
let _lastTriggerAt = 0;
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
  _busy = true;
  try {
    const open = getTrackedPositions(true).filter((p) => !p.closed);
    if (!open.length) return;

    const stopLossPct = config.management.stopLossPct;
    const eligible = open.filter((p) => {
      if (!p.base_mint || !p.entry_token_price_usd) return false;
      if (inCooldown(p.position)) return false;
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
      const pnlPct = ((live - p.entry_token_price_usd) / p.entry_token_price_usd) * 100;
      if (pnlPct <= stopLossPct) {
        const sinceLast = Date.now() - _lastTriggerAt;
        if (sinceLast < 5000) {
          // back-to-back triggers are likely the same dump across multiple positions — throttle
          log("tick_stop", `throttled ${p.pool_name || p.position.slice(0, 8)} pnl=${pnlPct.toFixed(2)}%`);
          setCooldown(p.position, 30_000);
          continue;
        }
        _lastTriggerAt = Date.now();
        setCooldown(p.position);
        log("tick_stop", `STOP-LOSS TICK ${p.pool_name || p.position.slice(0, 8)} pnl=${pnlPct.toFixed(2)}% entry=${p.entry_token_price_usd} live=${live}`);
        try {
          const res = await closePosition({
            position_address: p.position,
            reason: `⚡ Tick stop-loss: PnL ${pnlPct.toFixed(2)}% <= ${stopLossPct}%`,
          });
          log("tick_stop", `close result: ${res?.success ? "OK" : res?.error || "unknown"}`);
        } catch (e) {
          log("tick_stop_error", `close failed: ${e.message}`);
        }
      }
    }
  } finally {
    _busy = false;
  }
}

export function startTickStop() {
  if (_interval) return;
  _interval = setInterval(() => {
    tickOnce().catch((e) => log("tick_stop_error", e.message));
  }, POLL_MS);
  log("cron", `Tick stop-loss started — ${POLL_MS}ms poll on open positions`);
}

export function stopTickStop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    log("cron", "Tick stop-loss stopped");
  }
}
