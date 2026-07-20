import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { isOorCloseReason } from "./pool-memory.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";
const POOL_MEMORY_FILE = "./pool-memory.json";

// Normalize free-text close_reason strings (e.g. "Stop loss: PnL -16% <= -15%",
// "⚡ Trailing TP: peak 9% → current 5%") into the fixed rule buckets used by
// getDeterministicCloseRule() in index.js, so drift in close patterns is
// visible without manual jq archaeology.
function bucketCloseReason(reason) {
  const text = String(reason || "").toLowerCase();
  if (!text) return "other";
  if (text.includes("trailing")) return "trailing_tp";
  if (text.includes("stop loss")) return "stop_loss";
  if (text.includes("take profit")) return "take_profit";
  if (text.includes("pumped far above range")) return "pumped_above_range";
  if (isOorCloseReason(reason)) return "oor";
  if (text.includes("low yield")) return "low_yield";
  return "other";
}

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 4b. Close-reason breakdown (last 24h, across all pools in pool-memory.json)
  const poolMemory = loadJson(POOL_MEMORY_FILE) || {};
  const closesLast24h = Object.values(poolMemory)
    .flatMap(entry => entry.deploys || [])
    .filter(d => d.closed_at && new Date(d.closed_at) > last24h);
  const closeReasonBuckets = {};
  for (const d of closesLast24h) {
    const bucket = bucketCloseReason(d.close_reason);
    if (!closeReasonBuckets[bucket]) closeReasonBuckets[bucket] = { count: 0, pnlSum: 0 };
    closeReasonBuckets[bucket].count++;
    closeReasonBuckets[bucket].pnlSum += d.pnl_pct ?? 0;
  }
  const closeReasonLines = Object.entries(closeReasonBuckets)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([bucket, { count, pnlSum }]) => `• ${bucket}: ${count} (avg PnL ${(pnlSum / count >= 0 ? "+" : "") + (pnlSum / count).toFixed(2)}%)`);

  // 5. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Close Reasons (24h):</b>`,
    closeReasonLines.length > 0 ? closeReasonLines.join("\n") : "• No closes recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "────────────────"
  ];

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
