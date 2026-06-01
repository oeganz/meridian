#!/usr/bin/env node
/**
 * sim-audit.js — Time-range audit of sim-history.jsonl.
 *
 * Reads recorded polls and shows per-position PnL trajectory,
 * exposure curve, anomalies — no live fetching needed.
 *
 * Usage:
 *   node sim-audit.js                              # all history
 *   node sim-audit.js --since 04:00               # 4am today → now
 *   node sim-audit.js --since 2026-06-01T04:00    # explicit ISO start
 *   node sim-audit.js --since 04:00 --until 12:00 # window
 *   node sim-audit.js --pool grail                # filter by pool name
 *   node sim-audit.js --since 04:00 --pool DATBIHGAH
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, "sim-history.jsonl");

// ─── Time parsing ─────────────────────────────────────────────────

function parseTimeArg(arg) {
  if (!arg) return null;
  // HH:MM → today at that time (local)
  if (/^\d{1,2}:\d{2}$/.test(arg)) {
    const [h, m] = arg.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }
  // ISO or date string
  const d = new Date(arg);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Args ─────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  return {
    since:     parseTimeArg(get("--since")),
    until:     parseTimeArg(get("--until")) ?? new Date(),
    poolFilter: (get("--pool") || "").toLowerCase() || null,
  };
}

// ─── Load + filter records ────────────────────────────────────────

function loadRecords({ since, until, poolFilter }) {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.error("sim-history.jsonl not found.");
    process.exit(1);
  }

  const lines = fs.readFileSync(HISTORY_FILE, "utf8").trim().split("\n").filter(Boolean);
  const records = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      const ts = new Date(r.ts);
      if (since && ts < since) continue;
      if (until && ts > until) continue;
      if (poolFilter && !String(r.pool_name || r.pool || "").toLowerCase().includes(poolFilter)) continue;
      records.push({ ...r, _ts: ts });
    } catch { /* skip bad lines */ }
  }
  return records;
}

// ─── Group by position ────────────────────────────────────────────

function groupByPosition(records) {
  const map = {};
  for (const r of records) {
    const key = r.position_id || r.pool || "unknown";
    if (!map[key]) map[key] = { name: r.pool_name || key, records: [] };
    map[key].records.push(r);
  }
  // Sort each group by time
  for (const g of Object.values(map)) {
    g.records.sort((a, b) => a._ts - b._ts);
  }
  return map;
}

// ─── Anomaly detection ────────────────────────────────────────────

function detectAnomalies(records) {
  const issues = [];
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const curr = records[i];
    const dt = (curr._ts - prev._ts) / 60000; // minutes between polls

    // PnL jump > 20% in one poll interval
    if (prev.pnl_usd != null && curr.pnl_usd != null) {
      const jump = Math.abs(curr.pnl_usd - prev.pnl_usd);
      const initVal = curr.initial_value_usd || prev.initial_value_usd || 1;
      const jumpPct = (jump / initVal) * 100;
      if (jumpPct > 20) {
        issues.push(`  ⚠ Sudden PnL jump ${jumpPct.toFixed(1)}% at ${curr._ts.toISOString().slice(11,16)} (${prev.pnl_usd?.toFixed(4)} → ${curr.pnl_usd?.toFixed(4)})`);
      }
    }

    // Exposure out of [0,1]
    if (curr.token_exposure != null && (curr.token_exposure < 0 || curr.token_exposure > 1)) {
      issues.push(`  ⚠ Invalid exposure ${curr.token_exposure} at ${curr._ts.toISOString().slice(11,16)}`);
    }

    // Price missing
    if (curr.current_price_usd == null || curr.current_price_usd <= 0) {
      issues.push(`  ⚠ Missing/zero price at ${curr._ts.toISOString().slice(11,16)}`);
    }

    // Gap > 15min (poller missed)
    if (dt > 15) {
      issues.push(`  ⚠ Poll gap ${dt.toFixed(0)}min at ${curr._ts.toISOString().slice(11,16)}`);
    }
  }
  return issues;
}

// ─── Render position report ───────────────────────────────────────

function renderPosition(name, records) {
  const first = records[0];
  const last  = records[records.length - 1];

  const pnls       = records.map(r => r.pnl_usd).filter(v => v != null);
  const exposures  = records.map(r => r.token_exposure).filter(v => v != null);
  const prices     = records.map(r => r.current_price_usd).filter(v => v != null);
  const initVal    = first.initial_value_usd ?? "?";

  const minPnl = pnls.length ? Math.min(...pnls) : null;
  const maxPnl = pnls.length ? Math.max(...pnls) : null;
  const minExp = exposures.length ? Math.min(...exposures) : null;
  const maxExp = exposures.length ? Math.max(...exposures) : null;
  const minPx  = prices.length ? Math.min(...prices) : null;
  const maxPx  = prices.length ? Math.max(...prices) : null;

  const startPnl = pnls[0] ?? null;
  const endPnl   = pnls[pnls.length - 1] ?? null;
  const pnlPct   = initVal && endPnl != null ? ((endPnl / initVal) * 100).toFixed(2) : "?";

  const duration  = ((last._ts - first._ts) / 60000).toFixed(0);
  const anomalies = detectAnomalies(records);

  // Exposure bar (20 chars wide)
  const expBar = (exp) => {
    if (exp == null) return "?";
    const filled = Math.round(exp * 20);
    return "[" + "█".repeat(filled) + "░".repeat(20 - filled) + "]";
  };

  console.log(`\n── ${name} ──────────────────────────────────`);
  console.log(`   Polls : ${records.length} over ${duration}min  (${first._ts.toISOString().slice(11,16)} → ${last._ts.toISOString().slice(11,16)} UTC)`);
  console.log(`   Init  : $${initVal}`);
  console.log(`   PnL   : start=$${startPnl?.toFixed(4)} | end=$${endPnl?.toFixed(4)} (${pnlPct}%) | range=[$${minPnl?.toFixed(4)} – $${maxPnl?.toFixed(4)}]`);
  console.log(`   Price : $${minPx?.toFixed(6)} – $${maxPx?.toFixed(6)}`);
  console.log(`   Exp   : ${expBar(minExp)} ${(minExp*100)?.toFixed(0)}% min`);
  console.log(`           ${expBar(maxExp)} ${(maxExp*100)?.toFixed(0)}% max`);
  console.log(`           ${expBar(last.token_exposure)} ${((last.token_exposure ?? 0)*100).toFixed(0)}% final`);

  if (anomalies.length) {
    console.log(`   Anomalies (${anomalies.length}):`);
    anomalies.forEach(a => console.log(a));
  } else {
    console.log(`   Anomalies: none`);
  }

  // Timeline — one line per poll (compact)
  if (records.length <= 30) {
    console.log(`\n   Time(UTC)  Price        Exposure  PnL($)   PnL%`);
    for (const r of records) {
      const pnlPctR = r.initial_value_usd && r.pnl_usd != null
        ? ((r.pnl_usd / r.initial_value_usd) * 100).toFixed(1).padStart(6)
        : "     ?";
      const exp = r.token_exposure != null ? (r.token_exposure * 100).toFixed(0).padStart(3) + "%" : "  ?%";
      const px  = r.current_price_usd != null ? ("$" + r.current_price_usd.toFixed(6)).padEnd(13) : "?            ";
      const pnl = r.pnl_usd != null ? r.pnl_usd.toFixed(4).padStart(8) : "       ?";
      console.log(`   ${r._ts.toISOString().slice(11,16)}      ${px} ${exp}    ${pnl} ${pnlPctR}%`);
    }
  } else {
    console.log(`   (${records.length} polls — timeline omitted, too long)`);
  }
}

// ─── Entry ────────────────────────────────────────────────────────

function main() {
  const { since, until, poolFilter } = parseArgs();

  const sinceStr = since ? since.toISOString().slice(0, 16) : "beginning";
  const untilStr = until.toISOString().slice(0, 16);
  console.log(`\n═══ Sim Audit: ${sinceStr} → ${untilStr} UTC ═══`);
  if (poolFilter) console.log(`    Filter: pool="${poolFilter}"`);

  const records = loadRecords({ since, until, poolFilter });

  if (!records.length) {
    console.log("\nNo records in this time window.\n");
    process.exit(0);
  }

  console.log(`    ${records.length} poll records loaded\n`);

  const groups = groupByPosition(records);
  for (const [, group] of Object.entries(groups)) {
    renderPosition(group.name, group.records);
  }

  // Summary
  const allPnls = records.map(r => r.pnl_usd).filter(v => v != null);
  console.log(`\n═══ Summary ═══`);
  console.log(`  Positions tracked : ${Object.keys(groups).length}`);
  console.log(`  Total polls       : ${records.length}`);
  if (allPnls.length) {
    console.log(`  PnL range overall : $${Math.min(...allPnls).toFixed(4)} – $${Math.max(...allPnls).toFixed(4)}`);
  }
  console.log();
}

main();
