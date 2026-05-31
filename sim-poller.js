/**
 * sim-poller.js — LP-aware PnL simulation for DRY_RUN positions.
 *
 * DLMM single-sided SOL deploy: starts at 0% token exposure.
 * Token exposure grows linearly from 0→1 as price moves lower→upper bound.
 *
 *   token_exposure = clamp((currentPrice - lowerUsd) / (upperUsd - lowerUsd), 0, 1)
 *   currentValue   = initialUsd * (1 - exposure)
 *                  + initialUsd * exposure * (currentPrice / entryPrice)
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
    initial_value_usd: initialUsd,
    entry_token_price_usd: entryPrice,
    sim_price_range_lower_usd: lowerUsd,
    sim_price_range_upper_usd: upperUsd,
    pool,
  } = pos;

  if (!pool || !entryPrice || !lowerUsd || !upperUsd || initialUsd == null) return null;

  const currentPrice = await fetchTokenPrice(pool).catch(() => null);
  if (!currentPrice) return null;

  const range = upperUsd - lowerUsd;
  const token_exposure =
    range > 0 ? Math.min(1, Math.max(0, (currentPrice - lowerUsd) / range)) : 0;

  const sol_portion = initialUsd * (1 - token_exposure);
  const token_portion = initialUsd * token_exposure * (currentPrice / entryPrice);
  const current_value_usd = parseFloat((sol_portion + token_portion).toFixed(4));
  const pnl_usd = parseFloat((current_value_usd - initialUsd).toFixed(4));

  return {
    token_exposure: parseFloat(token_exposure.toFixed(4)),
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

  cron.schedule("*/5 * * * *", () => {
    refreshSimSnapshots().catch((err) =>
      console.error("[sim-poller] refresh failed:", err.message)
    );
  });
}
