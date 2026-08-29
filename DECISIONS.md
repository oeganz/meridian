# Decision Log

Engineering decisions for Meridian: what changed, the evidence, and what got
rejected. Live money — every entry should let a future reader reconstruct *why*,
including the reasoning that turned out wrong.

Not to be confused with `decision-log.js` / `decision-log.json`, which is the
agent's own runtime record of trading decisions (fed back into prompts).

Format: newest first. Each entry states the evidence and, where a hypothesis was
abandoned, says so plainly.

---

## 2026-08-29 — Downside close rules, close mutex, LP staleness watch

**Trigger:** GOLD-SOL closed -30.94% / -$4.83 after 32 min. Largest single loss
of the week; week net was -$1.61 across 26 closes before it.

### What actually happened

Deployed 05:30:22 at volatility 6.1536, single-sided SOL, 40 bins below entry,
bin_step 100. Last clean screen sample `05:55:38 token=-3.03%`. First hit after
cooldown: `06:01:38 token=-66.90%`.

Between two consecutive 4-second polls the token fell from above -2.5% to -66.9%.
Range floor was ≈ `entry × 0.99^40` ≈ 0.000575; token reached 0.000285. Price
crossed all 40 bins inside one poll interval, converting the full 0.15 SOL to
GOLD on the way down.

**No stop-loss value could have exited inside that window.** `-2.5%` was never
observable. This was a rug, not a bleed.

### Decisions taken

**1. Downside close rules 6 and 7 (`index.js`)** — the real gap.

`getDeterministicCloseRule` rules 3 and 4 both gate on `active_bin > upper_bin`.
No `active_bin < lower_bin` check existed anywhere. For single-sided SOL, price
falling *below* range is the primary loss mode and had zero deterministic
coverage — it relied entirely on rule 1, whose `pnl_pct` comes from the Meteora
indexer.

- Rule 6: `active_bin < lower_bin - outOfRangeBinsToClose` → close (deep break)
- Rule 7: `active_bin < lower_bin` AND `minutes_out_of_range >= outOfRangeWaitMinutes` → close (sustained)

Chose both, mirroring the upside, because the two failure shapes differ: a fast
break and a slow bleed need different triggers. Numbered 6/7 rather than 3b/4b so
rule numbers in historical logs keep their meaning.

Rule 6 deliberately has no take-profit guard (rule 3 does). A pump above range is
a win worth letting run; a break below range is fully converted to the base token
and earning nothing, so there is no upside to preserve.

Bin ids come from the same Meteora payload as `pnl_pct` but are positional rather
than a priced aggregate, so they did not exhibit the lag described below.

**Honest scope: rules 6/7 would NOT have saved GOLD-SOL.** That rug outran any
poll interval. They cover slow bleeds, which had no coverage at all.

**2. Close mutex (`tools/dlmm.js`)** — management cycle began closing at
06:02:29.926; tick-stop fired its own close at 06:02:42.655. Tick-stop's claim hit
`No fee to claim`, its Step 2 succeeded, and management's Step 2 then errored:
`Transaction 4SZn52rKkAT... resulted in an error.` Two independent closers, no
mutual exclusion. Guard placed inside `closePosition` so it covers every caller.
Position did close; cost was one failed tx.

**3. LP staleness watch (`tick-stop.js`) — LOG ONLY, deliberately not wired to exits.**

```
06:01:38.776  token=-66.90%  lp=1.50%
06:02:10.681  token=-57.65%  lp=1.50%   <- identical to 2dp, 32s apart
06:02:26.334  [PnL poll] -31.77%
```

Confirmed not a local cache: `fetchDlmmPnlForPool` does a bare `fetch()` per call,
`lpAgentRelayEnabled=False`, `LPAGENT_API_KEY` unset, no `pnl_pct_suspicious`
warning fired. Both readers hit the same endpoint and read the same
`pnlPctChange`. The lag is upstream in Meteora's PnL indexer, ~45-60s behind spot.

Design flaw it exposes: tick-stop gates a *fast* detector (Jupiter spot) behind a
*slow* confirmer (Meteora indexer), so the slow feed vetoes the fast one during
exactly the events where speed matters.

**Not acting on it, because on this trade the lag helped.** Token was -66.90% at
first detection and -48.19% at close; closing immediately would have realized
*worse* than -30.94%. Logging first to gather cases before changing exit
behaviour on a signal that has so far only ever paid.

### Rejected: 1h price-drop entry gate

**This was my own top recommendation. The backtest killed it.**

Reasoning was that the screener talked itself into knife-catching. Its logged
rationale at deploy:

> "The 21% 1h dip with 981 net buyers signals a dip-buying opportunity on a named
> political meme rather than a dump."

Backtest — scraped every `get_top_candidates` snapshot from `actions-*.jsonl`,
joined to closes by pool name (`timeframe=1h`, so `price_change_pct` is the 1h
number):

```
1h chg              n      net$     avg$     WR
<=-20 hard dip      1     +0.08   +0.076   100%
-20..-10            1     -0.17   -0.175     0%
0..+20              7     -1.79   -0.256    57%
>=+20               2     +0.27   +0.135   100%

gate 1h<=-20%: blocks n=1 worth +0.08 | keeps n=10 worth -1.70
```

Only 11 matched closes of 292 — 30 of 54 candidate snapshots are truncated at
1000 chars in the action log. Every threshold tested blocked near-nothing and
left the losses untouched; the -20% gate blocks a *winner*. Losses cluster in
`0..+20` (calm entries), not dips. GOLD-SOL isn't in the sample at all — its
snapshot was truncated.

**Conclusion: withdrawn.** n=11 cannot support a live-money entry filter, and what
little data exists points the opposite way. The knife-catching story was a
plausible narrative from a single trade. One rug is not a class.

**Follow-up worth doing:** raise the action-log result truncation limit above 1000
chars so candidate snapshots survive. Without that, no entry-filter hypothesis
can ever be tested — this is the real blocker.

### Also considered, not done

- **Loosening `stopLossPct` from -2.5%** — deliberately deferred again so the
  effect of the volatility ceiling change (2026-08-28) stays attributable.
- **Backfill of corrupt `initial_value_usd`** in `pool-memory.json` /
  `lessons.json`. Rows predating the 2026-08-28 fix carry ~15x inflated cost
  bases (pool TVL instead of position size), so `evolveThresholds()` still reads
  corrupted history. Recoverable via `amount_sol × entry_sol_price`. Not started.

### Verification

`test/test-close-rules.js` added (new — close rules had no coverage at all).
Covers rules 6/7 thresholds, the inclusive/exclusive boundary, direction
isolation (upside must not trip downside rules), rule ordering when `pnl_pct` is
fresh vs stale, and rule 6's absent TP guard.

All pass: `test-close-rules`, `test-tick-stop`, `test-outcome-cooldown`.

---

## 2026-08-28 — maxVolatilityHard 8 → 7

7d/26-trade review split the old 5-8 volatility band: 5-7 nets +$1.91, 7-8 nets
-$3.25 and produced every catastrophic loss of the week (-7.4%, -8.7%, -11.9%).
The original 5-8 conclusion was averaging a good sub-band with a bad one.

Also shipped: tick-stop headroom-scaled cooldown (flat 30s bench let WindChill-SOL
run +1.13% → -8.37% inside one blind window), and the `initial_value_usd` fix
(`index.js` was passing the *pool's* TVL as the position's cost basis, corrupting
the denominator of every `pnl_pct` in the learning layer).

Note: GOLD-SOL deployed at volatility 6.1536 — inside the band certified safe
here. This change is not implicated in that loss.
