// Self-check for shadow-log probe scheduling and math.
// The point of the shadow log is to build the survivor population a stop-loss
// backtest needs, so a silently-wrong probe schedule would poison the only
// evidence we'll have. Run: node test/test-shadow-log.js
import assert from "node:assert";
import { dueProbes, isComplete, isAbandoned, probeResult } from "../shadow-log.js";

const T0 = Date.parse("2026-08-29T12:00:00.000Z");
const at = (min) => T0 + min * 60_000;
const rec = (probes = { 5: null, 15: null, 30: null }) => ({
  closed_at: new Date(T0).toISOString(),
  entry_token_price_usd: 0.001,
  close_token_price_usd: 0.0008, // closed at -20% vs entry
  probes,
});

// ─── Probe scheduling ─────────────────────────────────────────
assert.deepEqual(dueProbes(rec(), at(0)), [], "nothing due at close");
assert.deepEqual(dueProbes(rec(), at(4)), [], "nothing due before +5min");
assert.deepEqual(dueProbes(rec(), at(5)), [5], "+5 due exactly on the mark");
assert.deepEqual(dueProbes(rec(), at(16)), [5, 15], "a missed sweep backfills earlier marks");
assert.deepEqual(dueProbes(rec(), at(99)), [5, 15, 30], "long outage still backfills all");

// Already-filled marks are never refetched — sweeps run every 60s and would
// otherwise overwrite a +5min reading with a +30min price.
assert.deepEqual(
  dueProbes(rec({ 5: { price: 1 }, 15: null, 30: null }), at(20)), [15],
  "filled probes are not re-collected"
);

// A corrupt row must not be treated as perpetually due.
assert.deepEqual(dueProbes({ closed_at: "not-a-date", probes: {} }, at(60)), []);

// ─── Retirement ───────────────────────────────────────────────
assert.equal(isComplete(rec({ 5: {}, 15: {}, 30: {} })), true);
assert.equal(isComplete(rec({ 5: {}, 15: {}, 30: null })), false);
assert.equal(isAbandoned(rec(), at(30)), false, "still in the probe window");
assert.equal(isAbandoned(rec(), at(91)), true, "1h past last mark -> stop retrying");
assert.equal(isAbandoned({ closed_at: "not-a-date" }, at(0)), true, "corrupt row retires");

// ─── The number the whole exercise exists to produce ──────────
// vs_close_pct > 0 means the token was HIGHER than at the exit: holding would
// have beaten the stop. This is the counterfactual, so its sign must be right.
const r = rec();
assert.equal(probeResult(r, 0.0012, at(5)).vs_close_pct, 50, "recovered 50% above the exit");
assert.equal(probeResult(r, 0.0004, at(5)).vs_close_pct, -50, "kept falling: stop was right");
assert.equal(probeResult(r, 0.0008, at(5)).vs_close_pct, 0, "flat");
assert.equal(probeResult(r, 0.0012, at(5)).vs_entry_pct, 20, "vs entry uses entry price, not close");

// Guard against a divide-by-zero producing Infinity in the analysis file.
assert.equal(probeResult({ ...r, close_token_price_usd: 0 }, 0.001, at(5)).vs_close_pct, null);

console.log("PASS: shadow log probe scheduling + counterfactual math");
