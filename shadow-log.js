/**
 * Shadow log — records what a closed position's token did AFTER the exit.
 *
 * Why: the stop-loss fires so reliably that no survivor population exists.
 * A backtest of "what if the stop were wider" over 292 closes found n=1 at
 * -2.5% and n=0 below -5%: every position that dipped past the stop was
 * closed by it, so there is nothing to compare against. This builds that
 * counterfactual prospectively instead of trying to mine it from history.
 *
 * What it measures — read this before trusting a number from it.
 * It records the BASE TOKEN price at close and again at +5/+15/+30 min.
 * That is not LP PnL. The position is gone; real LP PnL is unrecoverable.
 * For a single-sided SOL position that broke below its range the two are
 * close (the position is ~100% converted to base token, so it tracks the
 * token 1:1), and that is the case the stop-loss fires on. For a stop that
 * fired while still in range, token move OVERSTATES what holding would have
 * returned, because part of the position was still SOL. Treat vs_close_pct
 * as an upper bound on the value of holding, not an estimate of it.
 *
 * Logs every close, not only stops, because the same file then also answers
 * "are take-profits leaving money on the table" at zero extra cost — and the
 * median hold is 23 minutes, so early exit is suspected on both sides.
 *
 * Observation only. Nothing here influences any trading decision.
 *
 * ponytail: whole-file rewrite per sweep, and probes are dropped once filled
 * (no compaction). Fine at ~10 closes/day; revisit if the file passes ~50k rows.
 */
import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { getTrackedPosition } from "./state.js";

const LOG_DIR = "./logs";
const SHADOW_FILE = path.join(LOG_DIR, "shadow-closes.jsonl");
const PROBE_MINUTES = [5, 15, 30];
const SWEEP_MS = 60_000;
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";

let _interval = null;

// ─── pure helpers (unit-tested in test/test-shadow-log.js) ───

/** Probe marks that are due and not yet filled. */
export function dueProbes(rec, nowMs) {
  const closedMs = new Date(rec.closed_at).getTime();
  if (!Number.isFinite(closedMs)) return [];
  return PROBE_MINUTES.filter(
    (m) => rec.probes?.[m] == null && nowMs - closedMs >= m * 60_000
  );
}

/** True once every probe is filled — record can be retired from the pending set. */
export function isComplete(rec) {
  return PROBE_MINUTES.every((m) => rec.probes?.[m] != null);
}

/** A record whose last probe is long past but never filled (token delisted, sustained
 *  API failure). Retired so a dead row is not re-fetched forever. */
export function isAbandoned(rec, nowMs) {
  const closedMs = new Date(rec.closed_at).getTime();
  if (!Number.isFinite(closedMs)) return true;
  return nowMs - closedMs > (Math.max(...PROBE_MINUTES) + 60) * 60_000;
}

export function probeResult(rec, price, nowMs) {
  const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);
  return {
    at: new Date(nowMs).toISOString(),
    price,
    // > 0 means the token was higher than at the exit: holding would have been better.
    vs_close_pct: round2(pct(rec.close_token_price_usd, price)),
    vs_entry_pct: round2(pct(rec.entry_token_price_usd, price)),
  };
}

function round2(v) {
  return typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(2)) : null;
}

// ─── io ───

async function fetchPrices(mints) {
  if (!mints.length) return {};
  const headers = process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {};
  const res = await fetch(`${JUPITER_PRICE_API}?ids=${mints.join(",")}`, { headers });
  if (!res.ok) throw new Error(`Jupiter price ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const m of mints) {
    const p = data[m]?.usdPrice;
    if (typeof p === "number" && p > 0) out[m] = p;
  }
  return out;
}

function readAll() {
  if (!fs.existsSync(SHADOW_FILE)) return [];
  return fs.readFileSync(SHADOW_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function writeAll(rows) {
  fs.writeFileSync(SHADOW_FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/**
 * Called after a successful close. Snapshots entry/close token price so the
 * sweeper can price the counterfactual later. Never throws into the caller —
 * a logging failure must not affect a close.
 */
export async function recordShadowClose({ position_address, reason, result }) {
  try {
    const t = getTrackedPosition(position_address);
    if (!t?.base_mint || !t?.entry_token_price_usd) return;

    let closePrice = null;
    try {
      closePrice = (await fetchPrices([t.base_mint]))[t.base_mint] ?? null;
    } catch (e) {
      log("shadow_warn", `close price fetch failed for ${t.pool_name || position_address.slice(0, 8)}: ${e.message}`);
    }
    if (!closePrice) return; // without a close price there is no baseline to compare to

    const rec = {
      position: position_address,
      pool: t.pool,
      pool_name: t.pool_name || null,
      base_mint: t.base_mint,
      reason: reason || null,
      closed_at: new Date().toISOString(),
      entry_token_price_usd: t.entry_token_price_usd,
      close_token_price_usd: closePrice,
      realized_pnl_pct: result?.pnl_pct ?? null,
      realized_pnl_usd: result?.pnl_usd ?? null,
      probes: Object.fromEntries(PROBE_MINUTES.map((m) => [m, null])),
    };
    fs.appendFileSync(SHADOW_FILE, JSON.stringify(rec) + "\n");
    log("shadow", `tracking post-close for ${rec.pool_name || position_address.slice(0, 8)} @ ${closePrice}`);
  } catch (e) {
    log("shadow_warn", `recordShadowClose failed: ${e.message}`);
  }
}

async function sweep() {
  const rows = readAll();
  if (!rows.length) return;
  const now = Date.now();

  const pending = rows.filter((r) => !isComplete(r) && !isAbandoned(r, now));
  const needed = pending.filter((r) => dueProbes(r, now).length);
  if (!needed.length) return;

  let priceMap = {};
  try {
    priceMap = await fetchPrices([...new Set(needed.map((r) => r.base_mint))]);
  } catch (e) {
    log("shadow_warn", `sweep price fetch failed: ${e.message}`);
    return; // leave probes unfilled; retry next sweep
  }

  let filled = 0;
  for (const rec of needed) {
    const price = priceMap[rec.base_mint];
    if (!price) continue;
    for (const m of dueProbes(rec, now)) {
      rec.probes[m] = probeResult(rec, price, now);
      filled++;
    }
  }
  if (filled) {
    writeAll(rows);
    log("shadow", `filled ${filled} post-close probe(s)`);
  }
}

export function startShadowLog() {
  if (_interval) return;
  _interval = setInterval(() => {
    sweep().catch((e) => log("shadow_warn", e.message));
  }, SWEEP_MS);
  log("cron", `Shadow close log started — probes at +${PROBE_MINUTES.join("/+")}min, ${SWEEP_MS / 1000}s sweep`);
}

export function stopShadowLog() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    log("cron", "Shadow close log stopped");
  }
}
