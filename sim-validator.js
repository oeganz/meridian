#!/usr/bin/env node
/**
 * sim-validator.js — Sandbox accuracy validator.
 *
 * Compares our price-space LP formula against:
 *   1. Bin-space exposure (mathematically correct for DLMM)
 *   2. Live Meteora pool state (real active bin)
 *   3. DexScreener price (same source as sim-poller)
 *
 * Usage:
 *   node sim-validator.js                    # validate all open sim positions
 *   node sim-validator.js <pool_address>     # validate specific pool
 *
 * Standalone — no agent dependencies needed (reads state.json directly).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "state.json");
const HISTORY_FILE = path.join(__dirname, "sim-history.jsonl");

// ─── Helpers ──────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/** Price at a bin given bin_step (bps) and bin offset from reference. */
function binToPrice(refPrice, refBinId, binId, binStep) {
  return refPrice * Math.pow(1 + binStep / 10000, binId - refBinId);
}

/** Our sim formula: linear in price space. */
function priceSpaceExposure(currentPrice, lowerUsd, upperUsd) {
  const range = upperUsd - lowerUsd;
  if (range <= 0) return 0;
  return clamp((currentPrice - lowerUsd) / range, 0, 1);
}

/** True DLMM formula: linear in bin space. */
function binSpaceExposure(currentBin, lowerBin, upperBin) {
  const range = upperBin - lowerBin;
  if (range <= 0) return 0;
  return clamp((currentBin - lowerBin) / range, 0, 1);
}

/** LP value given exposure and prices. */
function lpValue(initialUsd, exposure, currentPrice, entryPrice) {
  return initialUsd * (1 - exposure) + initialUsd * exposure * (currentPrice / entryPrice);
}

// ─── Data Fetchers ────────────────────────────────────────────────

async function fetchDexScreenerPrice(poolAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`);
    if (!res.ok) return null;
    const price = parseFloat((await res.json())?.pairs?.[0]?.priceUsd ?? 0) || null;
    return price;
  } catch { return null; }
}

async function fetchMeteoraPools(poolAddress) {
  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${poolAddress}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ─── Main Validator ───────────────────────────────────────────────

async function validatePosition(pos) {
  const {
    id,
    pool,
    pool_name,
    entry_token_price_usd:  entryPrice,
    sim_price_range_lower_usd: lowerUsd,
    sim_price_range_upper_usd: upperUsd,
    initial_value_usd:      initialUsd,
    active_bin_at_deploy:   deployBin,
    bin_step:               binStep,
    bin_range,
  } = pos;

  const result = {
    pool_name: pool_name || pool?.slice(0, 8),
    pool,
    warnings: [],
    ok: false,
  };

  if (!entryPrice || !lowerUsd || !upperUsd || !initialUsd) {
    result.warnings.push("Missing sim params (entryPrice/lowerUsd/upperUsd/initialUsd) — position too old or pre-June fix");
    return result;
  }

  // Fetch live data in parallel
  const [currentPrice, meteoraData] = await Promise.all([
    fetchDexScreenerPrice(pool),
    fetchMeteoraPools(pool),
  ]);

  if (!currentPrice) {
    result.warnings.push("DexScreener price fetch failed");
    return result;
  }

  result.current_price_usd = currentPrice;
  result.entry_price_usd   = entryPrice;
  result.lower_usd         = lowerUsd;
  result.upper_usd         = upperUsd;
  result.initial_value_usd = initialUsd;

  // ── Formula A: our sim (price-space) ──────────────────────────
  const exposureSim  = priceSpaceExposure(currentPrice, lowerUsd, upperUsd);
  const valueSim     = lpValue(initialUsd, exposureSim, currentPrice, entryPrice);
  const pnlSimPct    = ((valueSim - initialUsd) / initialUsd) * 100;

  result.sim = {
    exposure:  parseFloat(exposureSim.toFixed(4)),
    value_usd: parseFloat(valueSim.toFixed(4)),
    pnl_pct:   parseFloat(pnlSimPct.toFixed(2)),
  };

  // ── Formula B: bin-space (mathematically correct) ─────────────
  // Need: current active bin + bin_step from Meteora, plus lowerBin/upperBin from deploy data
  const realBinStep = meteoraData?.dlmm_params?.bin_step
    ?? meteoraData?.bin_step
    ?? binStep;
  const currentActiveBin = meteoraData?.active_bin_id
    ?? meteoraData?.current_active_bin
    ?? meteoraData?.activeBinId
    ?? null;

  if (currentActiveBin != null && deployBin != null && realBinStep != null) {
    const binsBelow   = bin_range?.count ?? Math.round(Math.log(upperUsd / lowerUsd) / Math.log(1 + realBinStep / 10000));
    const lowerBin    = deployBin - binsBelow;
    const upperBin    = deployBin; // at deploy, active bin = upper bound

    const exposureBin = binSpaceExposure(currentActiveBin, lowerBin, upperBin);
    const valueBin    = lpValue(initialUsd, exposureBin, currentPrice, entryPrice);
    const pnlBinPct   = ((valueBin - initialUsd) / initialUsd) * 100;

    result.bin_space = {
      current_active_bin: currentActiveBin,
      deploy_bin:         deployBin,
      lower_bin:          lowerBin,
      upper_bin:          upperBin,
      bins_below:         binsBelow,
      bin_step:           realBinStep,
      exposure:           parseFloat(exposureBin.toFixed(4)),
      value_usd:          parseFloat(valueBin.toFixed(4)),
      pnl_pct:            parseFloat(pnlBinPct.toFixed(2)),
    };

    // ── Delta analysis ────────────────────────────────────────────
    const exposureDelta = Math.abs(exposureSim - exposureBin);
    const valueDeltaUsd = Math.abs(valueSim - valueBin);
    const valueDeltaPct = (valueDeltaUsd / initialUsd) * 100;

    result.delta = {
      exposure_abs:    parseFloat(exposureDelta.toFixed(4)),
      value_usd:       parseFloat(valueDeltaUsd.toFixed(4)),
      value_pct:       parseFloat(valueDeltaPct.toFixed(2)),
      accurate:        valueDeltaPct < 2.0,  // <2% error = acceptable
    };

    if (valueDeltaPct >= 5.0) result.warnings.push(`HIGH error: ${valueDeltaPct.toFixed(1)}% value delta (sim vs bin-space)`);
    else if (valueDeltaPct >= 2.0) result.warnings.push(`Moderate error: ${valueDeltaPct.toFixed(1)}% value delta`);
  } else {
    result.warnings.push(
      `Bin-space check skipped — missing: ${[
        currentActiveBin == null && "current_active_bin",
        deployBin == null && "active_bin_at_deploy",
        realBinStep == null && "bin_step",
      ].filter(Boolean).join(", ")}`
    );
    // Still check price direction sanity
    if (currentPrice < lowerUsd) {
      result.warnings.push(`Price $${currentPrice} below lower bound $${lowerUsd.toFixed(6)} — position OOR (full SOL retained)`);
    } else if (currentPrice > upperUsd) {
      result.warnings.push(`Price $${currentPrice} above upper bound $${upperUsd.toFixed(6)} — 100% token exposure (max IL)`);
    }
  }

  // ── Meteora pool sanity ───────────────────────────────────────
  if (meteoraData) {
    result.meteora_active_bin = currentActiveBin;
    result.meteora_bin_step   = realBinStep;
    result.meteora_pool_name  = meteoraData?.name || null;
  }

  result.ok = result.warnings.filter(w => w.startsWith("HIGH")).length === 0;
  return result;
}

function printResult(r) {
  const ok = r.ok ? "✓" : "✗";
  console.log(`\n${ok} ${r.pool_name} (${r.pool?.slice(0, 12)}...)`);

  if (r.current_price_usd != null) {
    console.log(`  Price:   $${r.current_price_usd} | Entry: $${r.entry_price_usd} | Range: [$${r.lower_usd?.toFixed(6)} – $${r.upper_usd?.toFixed(6)}]`);
  }

  if (r.sim) {
    const label = r.delta ? `Sim   (price-space)` : `Sim`;
    console.log(`  ${label}:  exposure=${r.sim.exposure} | value=$${r.sim.value_usd} | PnL=${r.sim.pnl_pct}%`);
  }

  if (r.bin_space) {
    console.log(`  Bin-space:  exposure=${r.bin_space.exposure} | value=$${r.bin_space.value_usd} | PnL=${r.bin_space.pnl_pct}%`);
    console.log(`  Bins:  deploy=${r.bin_space.deploy_bin} | current=${r.bin_space.current_active_bin} | range=[${r.bin_space.lower_bin}–${r.bin_space.upper_bin}] (${r.bin_space.bins_below} bins, step=${r.bin_space.bin_step}bps)`);
  }

  if (r.delta) {
    const tag = r.delta.accurate ? "OK" : r.delta.value_pct >= 5 ? "HIGH ERROR" : "WARN";
    console.log(`  Delta:  exposure=${r.delta.exposure_abs} | value=$${r.delta.value_usd} (${r.delta.value_pct}%) [${tag}]`);
  }

  if (r.warnings.length) {
    r.warnings.forEach(w => console.log(`  ⚠ ${w}`));
  }
}

// ─── History summary ──────────────────────────────────────────────

function printHistorySummary() {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.log("\nNo sim-history.jsonl found.");
    return;
  }
  const lines = fs.readFileSync(HISTORY_FILE, "utf8").trim().split("\n").filter(Boolean);
  if (!lines.length) { console.log("\nsim-history.jsonl is empty."); return; }

  const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byPosition = {};
  for (const r of records) {
    const key = r.position_id || r.pool_name || "unknown";
    if (!byPosition[key]) byPosition[key] = [];
    byPosition[key].push(r);
  }

  console.log(`\n── sim-history.jsonl: ${records.length} records across ${Object.keys(byPosition).length} position(s) ──`);
  for (const [posId, recs] of Object.entries(byPosition)) {
    const first = recs[0];
    const last  = recs[recs.length - 1];
    const pnls  = recs.map(r => r.pnl_usd).filter(v => v != null);
    const minPnl = Math.min(...pnls).toFixed(4);
    const maxPnl = Math.max(...pnls).toFixed(4);
    console.log(`  ${first.pool_name || posId}: ${recs.length} polls | pnl range [$${minPnl} – $${maxPnl}] | last exposure=${last.token_exposure}`);
  }
}

// ─── Entry point ──────────────────────────────────────────────────

async function main() {
  const filterPool = process.argv[2] || null;

  // Load open positions from state.json
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    console.error(`Cannot read state.json: ${e.message}`);
    process.exit(1);
  }

  const positions = Object.entries(state.positions || {})
    .filter(([, v]) => !v.closed)
    .map(([id, v]) => ({ id, ...v }))
    .filter(p => !filterPool || p.pool === filterPool || p.pool_name?.includes(filterPool));

  if (!positions.length) {
    console.log("No open sim positions to validate.");
    printHistorySummary();
    process.exit(0);
  }

  console.log(`\n═══ Sim Validator — ${new Date().toISOString()} ═══`);
  console.log(`Validating ${positions.length} open position(s)...\n`);

  for (const pos of positions) {
    const result = await validatePosition(pos);
    printResult(result);
  }

  printHistorySummary();
  console.log("\n═══ Done ═══\n");
}

main().catch(err => { console.error(err); process.exit(1); });
