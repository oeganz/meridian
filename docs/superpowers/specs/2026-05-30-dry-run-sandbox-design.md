# DRY_RUN Sandbox Simulation — Design Spec

**Date:** 2026-05-30  
**Status:** Approved  

---

## Problem

DRY_RUN mode tracks positions in `state.json` but:

1. PnL always shows `$0` — no token price stored at deploy, no live price fetched at check time
2. `/close <n>` and `/closeall` show ❌ — `closePosition()` returns `{ dry_run: true }` without `success: true`, Telegram handler treats it as failure
3. `recordPerformance()` never called on sandbox closes — lessons system learns nothing from sandbox runs
4. Management LLM close also broken — executor.js DRY_RUN mock returns generic stub for `close_position`, never marks position closed in state.json

`/set <n> <note>` already works (pure state.js write) — no change needed.

---

## Decisions

| Decision | Choice |
|----------|--------|
| Price source | Token USD price from DexScreener (pool_address lookup) |
| Lessons on close | Record with `simulated: true` flag; `evolveThresholds()` skips simulated records |
| Close notification | `notifyClose()` fires with `[SIMULATED]` prefix |
| Architecture | Centralize DRY_RUN logic in `dlmm.js` + `executor.js` (Approach A) |

---

## Architecture

Two call paths for close exist — both must work:

```
Telegram /close → index.js → closePosition() in dlmm.js  [direct call]
LLM agent       → executor.js executeTool() → fn(args)   [intercepted]
```

**Key insight:** executor.js DRY_RUN mock intercepts WRITE_TOOLS before calling `fn()`. For `deploy_position` this is correct (mock the TX). For `close_position` in DRY_RUN, we should call `fn(args)` directly — dlmm.js `closePosition()` owns the DRY_RUN close simulation, so both paths converge there.

---

## Components

### 1. Token Price Cache (`tools/dlmm.js`)

New module-level cache + helper:

```js
const _tokenPriceCache = new Map(); // pool_address → { price, at }
const TOKEN_PRICE_CACHE_TTL = 5 * 60_000; // 5 min

async function fetchTokenPrice(pool_address) {
  const cached = _tokenPriceCache.get(pool_address);
  if (cached && Date.now() - cached.at < TOKEN_PRICE_CACHE_TTL) return cached.price;
  // DexScreener: /latest/dex/pairs/solana/{pool_address}
  const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pool_address}`).catch(() => null);
  const pair = res?.ok ? (await res.json())?.pairs?.[0] : null;
  const price = pair ? parseFloat(pair.priceUsd ?? 0) : null;
  if (price != null) _tokenPriceCache.set(pool_address, { price, at: Date.now() });
  return price;
}
```

Returns `null` on failure — callers degrade gracefully (fall back to `$0` display).

---

### 2. Entry Price at Deploy (`tools/executor.js` + `state.js`)

**executor.js** DRY_RUN `deploy_position` mock:
- Call `fetchTokenPrice(args.pool_address)` (imported from dlmm.js or inlined)
- Pass result as `entry_token_price_usd` to `trackPosition()`

**state.js** `trackPosition()`:
- Add `entry_token_price_usd = null` to destructured params
- Persist to state.json position object

---

### 3. Live PnL in `getMyPositions` (`tools/dlmm.js`)

DRY_RUN position map fetches current price per position:

```
currentPrice = await fetchTokenPrice(p.pool)   // null-safe
entryPrice   = p.entry_token_price_usd          // null if old position
initialUsd   = p.initial_value_usd ?? amount_sol * solPrice

// Fee simulation (time-weighted)
ageDays  = age_minutes / 1440
simFees  = fee_tvl_ratio > 0 ? initialUsd * (fee_tvl_ratio / 100) * ageDays : 0

// PnL simulation
if (currentPrice && entryPrice && entryPrice > 0):
  priceChangePct = (currentPrice - entryPrice) / entryPrice
  simPnlUsd = initialUsd * priceChangePct + simFees
else:
  simPnlUsd = simFees   // fallback: fees only
```

`fetchTokenPrice` calls are parallelized: `await Promise.all(tracked.map(...))`.

---

### 4. DRY_RUN Close (`tools/dlmm.js` `closePosition()`)

Replaces current stub `return { dry_run: true, would_close: ... }`:

```
1. Fetch final token price via fetchTokenPrice(tracked.pool)
2. Calculate final PnL (same formula as getMyPositions)
3. recordClose(position_address, reason)   ← state.js (existing fn)
4. recordPerformance({ ...perfData, simulated: true })   ← lessons.js
5. notifyClose({ pair: `[SIMULATED] ${tracked.pool_name}`, pnlUsd, pnlPct })
6. Return { success: true, dry_run: true, pnl_usd, pnl_pct, pool_name, position: position_address }
```

If `tracked` is null (position not in state.json): return `{ success: false, error: "Position not found in sandbox state" }`.

---

### 5. executor.js DRY_RUN Mock — `close_position` forwarding

In the DRY_RUN mock block, add explicit `close_position` case:

```js
if (name === "close_position") {
  // Delegate to dlmm.js closePosition — it owns DRY_RUN close logic
  return await fn(args);
}
```

This makes the LLM-agent path converge with the Telegram path at dlmm.js.

---

### 6. Lessons — Simulated Flag (`lessons.js`)

**`recordPerformance(perf)`:**
- Accept `simulated` field — persist it to the performance record in `lessons.json`
- No other change needed at record time

**`evolveThresholds()`:**
- Filter: `const records = allRecords.filter(r => !r.simulated)` before computing winners/losers
- Simulated records preserved in history but don't influence threshold evolution

---

## Data Flow

```
DEPLOY (DRY_RUN)
  executor.js mock
    → fetchTokenPrice(pool_address)          [DexScreener]
    → trackPosition({ entry_token_price_usd, ... })   [state.json]

CHECK (management cycle / /positions)
  getMyPositions() DRY_RUN path
    → Promise.all(tracked.map(p => fetchTokenPrice(p.pool)))   [cached 5min]
    → compute simPnlUsd + simFees per position
    → return positions[] with live pnl_usd, unclaimed_fees_usd

CLOSE (/close, /closeall, LLM agent)
  Telegram path: closePosition() in dlmm.js   [direct]
  LLM path:      executor.js → fn(args) → closePosition() in dlmm.js
    → fetchTokenPrice(pool)
    → markClosed() + recordPerformance(simulated:true)
    → notifyClose("[SIMULATED] ...")
    → { success: true, pnl_usd, pnl_pct }
```

---

## Files Changed

| File | Change |
|------|--------|
| `tools/dlmm.js` | Add `fetchTokenPrice()` cache helper; update `getMyPositions()` DRY_RUN map to fetch live prices + compute PnL; replace `closePosition()` DRY_RUN stub with full simulation |
| `tools/executor.js` | `deploy_position` mock: fetch + store `entry_token_price_usd`; `close_position` mock: forward to `fn(args)` |
| `state.js` | Add `entry_token_price_usd` to `trackPosition()`; `recordClose()` already exists — no change needed |
| `lessons.js` | `recordPerformance()` persist `simulated` flag; `evolveThresholds()` filter simulated records |

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| DexScreener returns null | PnL shows `$0` / fees-only; position still displays |
| Position not in state on close | Return `{ success: false, error: "Position not found" }` |
| `recordPerformance` throws | Log warning, close still succeeds |
| Price fetch throws | Catch, return null, degrade gracefully |

---

## Out of Scope

- Token price fetch for positions deployed before this change (no `entry_token_price_usd` stored) — these fall back to fees-only PnL
- Real IL (impermanent loss) math — simulated PnL is linear price change, not LP curve math
- `claim_fees` DRY_RUN — currently not a user-reported issue
