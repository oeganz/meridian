// Self-check for getDeterministicCloseRule ordering, focused on the downside
// rules 6/7 added after the GOLD-SOL loss.
// Run: node test/test-close-rules.js
import assert from "node:assert";

// Mirror of getDeterministicCloseRule in index.js (kept in sync by hand).
// Only the branches under test are reproduced; ordering matches the original.
function decide(position, cfg) {
  const pnlSuspect = position.pnl_pct != null && position.pnl_pct <= -90 &&
    position.amount_sol && (position.total_value_usd ?? 0) > 0.01;

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= cfg.stopLossPct) return 1;
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= cfg.takeProfitPct) return 2;
  if (
    position.active_bin != null && position.upper_bin != null &&
    position.active_bin > position.upper_bin + cfg.outOfRangeBinsToClose &&
    (position.pnl_pct == null || position.pnl_pct < cfg.takeProfitPct)
  ) return 3;
  if (
    position.active_bin != null && position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= cfg.outOfRangeWaitMinutes
  ) return 4;
  if (
    position.active_bin != null && position.lower_bin != null &&
    position.active_bin < position.lower_bin - cfg.outOfRangeBinsToClose
  ) return 6;
  if (
    position.active_bin != null && position.lower_bin != null &&
    position.active_bin < position.lower_bin &&
    (position.minutes_out_of_range ?? 0) >= cfg.outOfRangeWaitMinutes
  ) return 7;
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < cfg.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) return 5;
  return null;
}

// Live VPS values at time of writing.
const cfg = {
  stopLossPct: -2.5, takeProfitPct: 12,
  outOfRangeBinsToClose: 5, outOfRangeWaitMinutes: 15, minFeePerTvl24h: 7,
};

// GOLD-SOL's actual range. Single-sided SOL: 40 bins below entry, none above.
const base = { lower_bin: -1216, upper_bin: -1176, pnl_pct: null, minutes_out_of_range: 0 };

// ─── Rule 6: deep break below range ───────────────────────────
// The gap this fills: before rules 6/7, a position whose price fell out the
// BOTTOM of its range had no deterministic rule at all. It depended on rule 1,
// whose pnl_pct comes from Meteora's indexer and ran ~45-60s stale during the
// GOLD-SOL collapse. Bin ids are positional, so they don't carry that lag.
assert.equal(
  decide({ ...base, active_bin: -1222 }, cfg), 6,
  "6 bins below lower_bin -> close, no PnL needed"
);
assert.equal(
  decide({ ...base, active_bin: -1400 }, cfg), 6,
  "far below range -> close"
);
assert.equal(
  decide({ ...base, active_bin: -1221 }, cfg), null,
  "exactly 5 bins below = at threshold, not past it -> no close yet"
);
assert.equal(
  decide({ ...base, active_bin: -1200 }, cfg), null,
  "inside range -> no close"
);

// ─── Rule 7: sustained below range ────────────────────────────
assert.equal(
  decide({ ...base, active_bin: -1218, minutes_out_of_range: 15 }, cfg), 7,
  "below range 15min (not deep enough for 6) -> close"
);
assert.equal(
  decide({ ...base, active_bin: -1218, minutes_out_of_range: 14 }, cfg), null,
  "below range but only 14min -> hold, may re-enter range"
);

// ─── Direction matters: upside must not trip downside rules ───
assert.equal(
  decide({ ...base, active_bin: -1174, minutes_out_of_range: 30 }, cfg), 4,
  "2 bins above range for 30min (shallow, so not rule 3) -> rule 4, NOT a downside rule"
);
assert.equal(
  decide({ ...base, active_bin: -1100 }, cfg), 3,
  "far above range -> rule 3"
);

// ─── Ordering: PnL rules still win when data is fresh ─────────
assert.equal(
  decide({ ...base, active_bin: -1400, pnl_pct: -31.77 }, cfg), 1,
  "stop loss outranks rule 6 when pnl_pct is available"
);
assert.equal(
  decide({ ...base, active_bin: -1400, pnl_pct: null }, cfg), 6,
  "GOLD-SOL case: pnl_pct stale/absent, bins still say dumped -> rule 6 catches it"
);

// ─── Rule 6 has no take-profit guard, unlike rule 3 ───────────
// Rule 3 excludes positions already at TP (a pump above range is a win worth
// letting run). Below range there is no equivalent case: single-sided SOL that
// broke downward is fully converted to the base token and earning nothing.
assert.equal(
  decide({ ...base, active_bin: -1400, pnl_pct: 5 }, cfg), 6,
  "below range with positive PnL still closes — no upside left to capture"
);

console.log("PASS: close rules 6/7 downside coverage");
