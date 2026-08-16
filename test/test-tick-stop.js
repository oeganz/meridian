// Self-check for tick-stop.js two-stage decision logic.
// Run: node test/test-tick-stop.js
import assert from "node:assert";

// Mirror of the screen / lp-check / close branch in tick-stop.js (kept in sync by hand).
// Order matches tick-stop.js: grace → screen → lp-read → close.
function decide({ tokenMovePct, lpPnlPct, stopLossPct, screenPct, ageMs, graceMs }) {
  if (ageMs < graceMs) return "GRACE";
  if (tokenMovePct > screenPct) return "SCREEN_PASS";
  if (lpPnlPct == null) return "NO_LP_DATA";
  if (lpPnlPct > stopLossPct) return "SCREEN_HIT_BUT_LP_OK";
  return "CLOSE";
}



const base = { stopLossPct: -2.5, screenPct: -2.5, graceMs: 300_000 };

// ─── The regression this fixes ─────────────────────────────────
// Old code: any token move <= -2.5% within seconds of deploy → forced close.
// This produced 24 round trips in 5 days at ~-1% each for zero fees.
assert.equal(
  decide({ ...base, tokenMovePct: -3, lpPnlPct: 1.2, ageMs: 600_000 }),
  "SCREEN_HIT_BUT_LP_OK",
  "post-grace: token dipped 3% but LP still +1.2% → no close (was: forced losing close)"
);
assert.equal(
  decide({ ...base, tokenMovePct: -4, lpPnlPct: 1.5, ageMs: 600_000 }),
  "SCREEN_HIT_BUT_LP_OK",
  "post-grace: token -4%, LP +1.5% → no close (was: forced losing close)"
);

// ─── Entry grace ──────────────────────────────────────────────
assert.equal(
  decide({ ...base, tokenMovePct: -5, lpPnlPct: -3, ageMs: 10_000 }),
  "GRACE",
  "10s old, even with bad LP — too early, hold for fees"
);
assert.equal(
  decide({ ...base, tokenMovePct: -5, lpPnlPct: -3, ageMs: 600_000 }),
  "CLOSE",
  "10 min old, real LP drawdown — close"
);

// ─── Real dump, real LP drawdown ──────────────────────────────
assert.equal(
  decide({ ...base, tokenMovePct: -8, lpPnlPct: -4, ageMs: 600_000 }),
  "CLOSE",
  "8% token dump + -4% LP after grace → close"
);

// ─── Token didn't even move below screen ──────────────────────
assert.equal(
  decide({ ...base, tokenMovePct: 1, lpPnlPct: 5, ageMs: 600_000 }),
  "SCREEN_PASS",
  "token up → no screen hit, no close"
);
assert.equal(
  decide({ ...base, tokenMovePct: -1, lpPnlPct: -1, ageMs: 600_000 }),
  "SCREEN_PASS",
  "small token move, LP also small — let normal cycle handle"
);

// ─── LP read failed (rpc down) — back off, don't close blindly ─
assert.equal(
  decide({ ...base, tokenMovePct: -5, lpPnlPct: null, ageMs: 600_000 }),
  "NO_LP_DATA",
  "rpc down → no close, cooldown 30s and retry"
);

// ─── Edge: LP exactly at threshold ────────────────────────────
assert.equal(
  decide({ ...base, tokenMovePct: -3, lpPnlPct: -2.5, ageMs: 600_000 }),
  "CLOSE",
  "LP at -2.5% = stopLoss threshold → close"
);

console.log("PASS: tick-stop two-stage");
