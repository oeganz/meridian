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



// Mirror of the cooldown choice in the SCREEN_HIT_BUT_LP_OK branch.
function cooldownFor({ lpPnlPct, stopLossPct, nearStopPct = 3 }) {
  return lpPnlPct - stopLossPct <= nearStopPct ? 0 : 30_000;
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

// -- Blind-window regression: cooldown scales with headroom --
// WindChill-SOL went lp=+1.13% -> lp=-8.37% inside one flat 30s bench,
// overshooting the -2.5% stop by 5.9pp. Near the stop we must not bench.
assert.equal(
  cooldownFor({ lpPnlPct: -1.0, stopLossPct: -2.5 }),
  0,
  "lp -1.0% = 1.5pp of headroom -> recheck next tick, no 30s bench"
);
assert.equal(
  cooldownFor({ lpPnlPct: 0.4, stopLossPct: -2.5 }),
  0,
  "lp +0.4% = 2.9pp of headroom -> still near the stop, recheck next tick"
);
assert.equal(
  cooldownFor({ lpPnlPct: 0.5, stopLossPct: -2.5 }),
  0,
  "lp +0.5% = exactly 3pp -> boundary is inclusive, recheck next tick"
);
assert.equal(
  cooldownFor({ lpPnlPct: 0.51, stopLossPct: -2.5 }),
  30_000,
  "lp +0.51% = 3.01pp -> just outside the near-stop band, bench"
);
assert.equal(
  cooldownFor({ lpPnlPct: 5.0, stopLossPct: -2.5 }),
  30_000,
  "lp +5% = 7.5pp of headroom -> safe to bench 30s"
);

console.log("PASS: tick-stop two-stage + headroom cooldown");
