/**
 * sim-poller.js — LP-aware PnL simulation for DRY_RUN positions.
 *
 * Single-sided SOL deploy: SOL deposited in bins BELOW entry price.
 * upper = entry price (active bin at deploy), lower = N bins below.
 * At deploy: 0% base token. As price drops → SOL swapped into base token.
 *
 * Exposure grows as price falls from upper → lower:
 *   token_exposure = clamp((upperUsd - currentPrice) / (upperUsd - lowerUsd), 0, 1)
 *
 * Tokens acquired incrementally at avg price = midpoint of crossed bins:
 *   in-range:    avg_acq = (upperUsd + currentPrice) / 2
 *   below-range: avg_acq = (upperUsd + lowerUsd) / 2
 *
 * Value:
 *   sol_portion   = initialUsd * (1 - exposure)          — SOL held, flat in USD
 *   token_portion = (initialUsd * exposure / avg_acq) * currentPrice
 *   above-range:  all SOL → value = initialUsd (flat, no token exposure)
 */

import cron from "node-cron";
import fs from "fs";
import path from "path";
import { getOpenPositions, updateSimSnapshot } from "./state.js";
import { fetchTokenPrice } from "./tools/dlmm.js";

const HISTORY_PATH = path.resolve("./sim-history.jsonl");

/**
 * Compute LP-aware snapshot for a single position.
 * Returns null if required data missing or price fetch fails.
 */
export async function computeLpPnl(pos) {
  const {
    entry_token_price_usd: entryPrice,
    sim_price_range_lower_usd: lowerUsd,
    sim_price_range_upper_usd: upperUsd,
    pool,
    amount_sol,
  } = pos;

  if (!pool || !entryPrice || !lowerUsd || !upperUsd) return null;

  // Sanitize initial_value_usd — recompute from amount_sol if missing or implausible.
  // Implausible = implied SOL price > $500 (bad LLM-provided value, pre-June fix).
  const solPrice = parseFloat(process.env.DRY_RUN_SOL_PRICE || "150");
  const expectedUsd = amount_sol ? parseFloat((amount_sol * solPrice).toFixed(2)) : null;
  let initialUsd = pos.initial_value_usd;
  if (initialUsd == null) {
    if (!expectedUsd) return null;
    initialUsd = expectedUsd;
  } else if (amount_sol && initialUsd / amount_sol > 500) {
    // Implied SOL price > $500 — bad data, override
    initialUsd = expectedUsd;
  }

  const currentPrice = await fetchTokenPrice(pool).catch(() => null);
  if (!currentPrice) return null;

  // upperUsd = entryPrice (active bin at deploy). Exposure grows as price drops.
  const range = upperUsd - lowerUsd;
  const token_exposure =
    range > 0 ? Math.min(1, Math.max(0, (upperUsd - currentPrice) / range)) : 0;

  // Avg price at which SOL was converted to base token across crossed bins.
  // In-range: only bins from currentPrice to upperUsd have been crossed.
  // Below-range: all bins crossed, full range.
  const avg_acquisition_price =
    token_exposure > 0
      ? currentPrice >= lowerUsd
        ? (upperUsd + currentPrice) / 2   // in range: midpoint of crossed bins
        : (upperUsd + lowerUsd) / 2        // below range: midpoint of full range
      : upperUsd; // unused when exposure=0, but avoid div-by-zero

  const sol_portion = initialUsd * (1 - token_exposure);
  const base_tokens = token_exposure > 0 ? (initialUsd * token_exposure) / avg_acquisition_price : 0;
  const token_portion = base_tokens * currentPrice;
  const current_value_usd = parseFloat((sol_portion + token_portion).toFixed(4));
  const pnl_usd = parseFloat((current_value_usd - initialUsd).toFixed(4));

  return {
    token_exposure: parseFloat(token_exposure.toFixed(4)),
    avg_acquisition_price: parseFloat(avg_acquisition_price.toFixed(6)),
    current_price_usd: currentPrice,
    current_value_usd,
    pnl_usd,
    polled_at: new Date().toISOString(),
  };
}

/**
 * Refresh snapshots for all open DRY_RUN positions.
 * Called by cron and on-demand from wallet.js / dlmm.js.
 */
export async function refreshSimSnapshots() {
  const positions = getOpenPositions();
  for (const pos of positions) {
    const snapshot = await computeLpPnl(pos);
    if (!snapshot) continue;

    updateSimSnapshot(pos.id, snapshot);

    // Append to sim-history.jsonl for config benchmarking
    const record = {
      ts: snapshot.polled_at,
      position_id: pos.id,
      pool: pos.pool,
      pool_name: pos.pool_name,
      strategy: pos.strategy,
      ...snapshot,
      initial_value_usd: pos.initial_value_usd,
      entry_token_price_usd: pos.entry_token_price_usd,
      lower_usd: pos.sim_price_range_lower_usd,
      upper_usd: pos.sim_price_range_upper_usd,
    };
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(record) + "\n");
  }
}

/**
 * Start 5-minute polling cron. Only call when DRY_RUN=true.
 * Runs immediately on boot, then every 5 minutes.
 */
export function startSimPoller() {
  // Immediate boot refresh
  refreshSimSnapshots().catch((err) =>
    console.error("[sim-poller] boot refresh failed:", err.message)
  );

  cron.schedule("* * * * *", () => {
    refreshSimSnapshots().catch((err) =>
      console.error("[sim-poller] refresh failed:", err.message)
    );
  });
}
