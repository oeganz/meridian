// Self-check for outcome-based cooldown selection in pool-memory.
// Run: node test/test-outcome-cooldown.js
import assert from "node:assert";

// Mirror of the cooldown-selection branch in pool-memory.js (kept in sync by hand).
function outcomeCooldown({ pnl_pct, close_reason, winBigHours = 6, winSmallHours = 3, lossBigHours = 24 }) {
  const pnl = Number(pnl_pct);
  const reason = String(close_reason || "");
  const isLoss = Number.isFinite(pnl) && pnl <= -5;
  const isWinBig = Number.isFinite(pnl) && pnl >= 5;
  const isWinSmall = Number.isFinite(pnl) && pnl > 0 && pnl < 5;
  const isDust = reason.includes("Rule 5") || (Number.isFinite(pnl) && Math.abs(pnl) < 0.5);
  if (isDust) return null;
  if (isLoss) return lossBigHours;
  if (isWinBig) return winBigHours;
  if (isWinSmall) return winSmallHours;
  return null;
}

assert.equal(outcomeCooldown({ pnl_pct: 8,   close_reason: "Rule 2 take profit" }), 6,  "win 8% → 6h");
assert.equal(outcomeCooldown({ pnl_pct: 5,   close_reason: "Rule 2 take profit" }), 6,  "win exactly 5% → 6h");
assert.equal(outcomeCooldown({ pnl_pct: 4.9, close_reason: "Rule 2 take profit" }), 3,  "win 4.9% → 3h");
assert.equal(outcomeCooldown({ pnl_pct: 0.5, close_reason: "Rule 3 pumped above" }), 3, "small win → 3h");
assert.equal(outcomeCooldown({ pnl_pct: -2,  close_reason: "Rule 1 stop loss" }), null, "loss 2% (below -5% bucket) → no cooldown, normal cycle");
assert.equal(outcomeCooldown({ pnl_pct: -5,  close_reason: "Rule 1 stop loss" }), 24,  "loss 5% → 24h");
assert.equal(outcomeCooldown({ pnl_pct: -10, close_reason: "Rule 1 stop loss" }), 24,  "loss 10% → 24h");
assert.equal(outcomeCooldown({ pnl_pct: 0,   close_reason: "Rule 5 low yield" }), null, "dust via reason → skip");
assert.equal(outcomeCooldown({ pnl_pct: 0.3, close_reason: "Rule 3 pumped above" }), null, "dust via magnitude → skip");
assert.equal(outcomeCooldown({ pnl_pct: null, close_reason: "Rule 3" }), null, "missing pnl → skip (let other cooldowns handle)");
assert.equal(outcomeCooldown({ pnl_pct: -100, close_reason: "Rule 1" }), 24, "outlier negative pnl → still 24h");

console.log("PASS: outcome cooldown");
