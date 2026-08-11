// Self-check for the anchored trailing-TP ratchet + tick-stop entry price.
// Run: node test/test-tp-ladder.js
import assert from "node:assert";

// Mirror of the decision branch in state.js:432-460 (kept in sync by hand).
function trailingDecision(peak, current, cfg) {
  const anchorPct = cfg.trailingTpAnchorPct ?? 5;
  const tpAnchored = peak >= anchorPct;
  const dropFromPeak = peak - current;
  const dropLimit = tpAnchored ? (cfg.trailingAnchorDropPct ?? 2) : cfg.trailingDropPct;
  const floorPct = cfg.trailingProfitFloorPct ?? 6;
  if (dropFromPeak >= dropLimit) {
    if (!tpAnchored || peak < floorPct || current >= floorPct) return "TRAILING_TP";
  }
  return null;
}

const cfg = {
  takeProfitPct: 12,
  trailingTpAnchorPct: 5,
  trailingDropPct: 3,
  trailingAnchorDropPct: 2,
  trailingProfitFloorPct: 6,
};

// Unanchored (peak < 5): plain trailingDropPct applies.
assert.equal(trailingDecision(4, 0.5, cfg), "TRAILING_TP", "peak 4 dropping 3.5 must exit");
assert.equal(trailingDecision(4, 2, cfg), null, "peak 4 dropping 2 must hold");

// Anchored winner: tighter 2% trail, but only if exit lands >= floor.
assert.equal(trailingDecision(9, 6.5, cfg), "TRAILING_TP", "peak 9 -> 6.5 exits above floor");
assert.equal(trailingDecision(9, 5, cfg), null, "peak 9 -> 5 is below floor, hold for stop-loss");
assert.equal(trailingDecision(9, 8, cfg), null, "peak 9 -> 8 within 2% trail, hold");

// The regression this fixes: old anchor let a 9% peak decay to -2% untouched.
assert.equal(trailingDecision(20, 18, cfg), "TRAILING_TP", "20 -> 18 gives back 2%, locks +18");

// Peak below the floor but above anchor: floor must not trap it forever.
assert.equal(trailingDecision(5.5, 3.4, cfg), "TRAILING_TP", "peak < floor exits normally");

console.log("PASS: trailing TP ladder");
