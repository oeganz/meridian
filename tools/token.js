const DATAPI_BASE = "https://datapi.jup.ag/v1";

// ── Fallback helpers ───────────────────────────────────────────
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC_URL    = process.env.RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

async function heliusRpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "meridian", method, params }),
  });
  if (!res.ok) throw new Error(`Helius RPC ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function dexScreenerPair(mint) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json();
  return data?.pairs?.[0] ?? null;
}

// ──────────────────────────────────────────────────────────────

/**
 * Get the narrative/story behind a token from Jupiter ChainInsight.
 * Falls back to DexScreener description on 403/error.
 */
export async function getTokenNarrative({ mint }) {
  try {
    const res = await fetch(`${DATAPI_BASE}/chaininsight/narrative/${mint}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return { mint, narrative: data.narrative || null, status: data.status };
  } catch {
    const pair = await dexScreenerPair(mint);
    return {
      mint,
      narrative: pair?.info?.description ?? null,
      status: "fallback_dexscreener",
    };
  }
}

/**
 * Search for token data by name, symbol, or mint address.
 * Falls back to DexScreener + OKX on Jupiter 403/error.
 */
export async function getTokenInfo({ query }) {
  let tokens = null;

  try {
    const url = `${DATAPI_BASE}/assets/search?query=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    tokens = Array.isArray(data) ? data : [data];
  } catch {
    // Fallback: DexScreener
    const pair = await dexScreenerPair(query);
    if (!pair) return { found: false, query };

    const mint = pair.baseToken?.address ?? query;
    const result = {
      mint,
      name:           pair.baseToken?.name ?? null,
      symbol:         pair.baseToken?.symbol ?? null,
      mcap:           pair.fdv ?? null,
      price:          parseFloat(pair.priceUsd ?? 0),
      liquidity:      pair.liquidity?.usd ?? null,
      holders:        null,
      organic_score:  null,
      organic_label:  null,
      launchpad:      null,
      graduated:      null,
      global_fees_sol: null,
      audit:          null,
      stats_1h: pair.volume?.h1 != null ? {
        price_change: pair.priceChange?.h1?.toFixed(2) ?? null,
        buy_vol:      pair.volume?.h1?.toFixed(0) ?? null,
        sell_vol:     null,
        buyers:       null,
        net_buyers:   null,
      } : null,
      stats_24h_net_buyers: null,
      _source: "dexscreener_fallback",
    };

    const { getAdvancedInfo, getClusterList } = await import("./okx.js");
    const [adv, clusters] = await Promise.all([
      getAdvancedInfo(mint).catch(() => null),
      getClusterList(mint).catch(() => []),
    ]);
    if (adv) {
      result.risk_level      = adv.risk_level;
      result.bundle_pct      = adv.bundle_pct;
      result.sniper_pct      = adv.sniper_pct;
      result.suspicious_pct  = adv.suspicious_pct;
      result.new_wallet_pct  = adv.new_wallet_pct;
      result.smart_money_buy = adv.smart_money_buy;
      result.tags            = adv.tags;
    }
    if (clusters?.length) {
      result.kol_in_clusters   = clusters.some((c) => c.has_kol);
      result.top_cluster_trend = clusters[0]?.trend ?? null;
      result.clusters          = clusters;
    }

    return { found: true, query, results: [result] };
  }

  if (!tokens?.length) return { found: false, query };

  const results = tokens.slice(0, 5).map((t) => ({
    mint:            t.id,
    name:            t.name,
    symbol:          t.symbol,
    mcap:            t.mcap,
    price:           t.usdPrice,
    liquidity:       t.liquidity,
    holders:         t.holderCount,
    organic_score:   t.organicScore,
    organic_label:   t.organicScoreLabel,
    launchpad:       t.launchpad,
    graduated:       !!t.graduatedPool,
    global_fees_sol: t.fees != null ? parseFloat(t.fees.toFixed(2)) : null,
    audit: t.audit ? {
      mint_disabled:    t.audit.mintAuthorityDisabled,
      freeze_disabled:  t.audit.freezeAuthorityDisabled,
      top_holders_pct:  t.audit.topHoldersPercentage?.toFixed(2),
      bot_holders_pct:  t.audit.botHoldersPercentage?.toFixed(2),
      dev_migrations:   t.audit.devMigrations,
    } : null,
    stats_1h: t.stats1h ? {
      price_change: t.stats1h.priceChange?.toFixed(2),
      buy_vol:      t.stats1h.buyVolume?.toFixed(0),
      sell_vol:     t.stats1h.sellVolume?.toFixed(0),
      buyers:       t.stats1h.numOrganicBuyers,
      net_buyers:   t.stats1h.numNetBuyers,
    } : null,
    stats_24h_net_buyers: t.stats24h ? t.stats24h.numNetBuyers : null,
  }));

  // Enrich first result with OKX smart money + risk data
  if (results[0]?.mint) {
    const { getAdvancedInfo, getClusterList } = await import("./okx.js");
    const [adv, clusters] = await Promise.all([
      getAdvancedInfo(results[0].mint).catch(() => null),
      getClusterList(results[0].mint).catch(() => []),
    ]);
    if (adv) {
      results[0].risk_level      = adv.risk_level;
      results[0].bundle_pct      = adv.bundle_pct;
      results[0].sniper_pct      = adv.sniper_pct;
      results[0].suspicious_pct  = adv.suspicious_pct;
      results[0].new_wallet_pct  = adv.new_wallet_pct;
      results[0].smart_money_buy = adv.smart_money_buy;
      results[0].tags            = adv.tags;
    }
    if (clusters?.length) {
      results[0].kol_in_clusters   = clusters.some((c) => c.has_kol);
      results[0].top_cluster_trend = clusters[0]?.trend ?? null;
      results[0].clusters          = clusters;
    }
  }

  return { found: true, query, results };
}

/**
 * Get holder distribution for a token mint.
 * Falls back to Helius DAS on Jupiter 403/error.
 * Smart wallet cross-reference filters from fetched list on fallback.
 */
export async function getTokenHolders({ mint, limit = 20 }) {
  let holders     = [];
  let totalSupply = null;
  let usingFallback = false;

  try {
    const [holdersRes, tokenRes] = await Promise.all([
      fetch(`${DATAPI_BASE}/holders/${mint}?limit=100`),
      fetch(`${DATAPI_BASE}/assets/search?query=${mint}`),
    ]);
    if (!holdersRes.ok) throw new Error(`${holdersRes.status}`);
    const data      = await holdersRes.json();
    const tokenData = tokenRes.ok ? await tokenRes.json() : null;
    const tokenInfo = Array.isArray(tokenData) ? tokenData[0] : tokenData;
    totalSupply     = tokenInfo?.totalSupply || tokenInfo?.circSupply || null;
    holders         = Array.isArray(data) ? data : (data.holders || data.data || []);
  } catch {
    // Fallback: Helius DAS getTokenAccounts + getTokenSupply
    usingFallback = true;
    const [accts, supply] = await Promise.all([
      heliusRpc("getTokenAccounts", { mint, limit: 100, options: { showZeroBalance: false } }).catch(() => null),
      heliusRpc("getTokenSupply", [mint]).catch(() => null),
    ]);
    const rawSupply = Number(supply?.value?.amount ?? 0);
    totalSupply     = rawSupply || null;
    holders         = (accts?.token_accounts ?? []).map((acc) => ({
      address:    acc.owner,
      amount:     acc.amount,
      percentage: rawSupply > 0 ? (Number(acc.amount) / rawSupply) * 100 : null,
      tags:       [],
    }));
  }

  const mapped = holders.slice(0, Math.min(limit, 100)).map((h) => {
    const tags   = (h.tags || []).map((t) => t.name || t.id || t);
    const isPool = tags.some((t) => /pool|amm|liquidity|raydium|orca|meteora/i.test(t));
    const pct    = totalSupply
      ? (Number(h.amount) / totalSupply) * 100
      : (h.percentage ?? h.pct ?? null);
    return {
      address:     h.address || h.wallet,
      amount:      h.amount,
      pct:         pct != null ? parseFloat(pct.toFixed(4)) : null,
      sol_balance: h.solBalanceDisplay ?? h.solBalance,
      tags:        tags.length ? tags : undefined,
      is_pool:     isPool || undefined,
      funding:     h.addressInfo?.fundingAddress ? {
        address: h.addressInfo.fundingAddress,
        amount:  h.addressInfo.fundingAmount,
        slot:    h.addressInfo.fundingSlot,
      } : undefined,
    };
  });

  const realHolders = mapped.filter((h) => !h.is_pool);
  const top10Pct    = realHolders.slice(0, 10).reduce((s, h) => s + (Number(h.pct) || 0), 0);

  // ─── Bundle / Cluster Analysis (OKX) ─────────────────────────
  const { getAdvancedInfo, getClusterList } = await import("./okx.js");
  const [advancedData, clusterList] = await Promise.all([
    getAdvancedInfo(mint).catch(() => null),
    getClusterList(mint).catch(() => []),
  ]);

  // ─── Smart Wallet / KOL Cross-reference ──────────────────────
  const { listSmartWallets } = await import("../smart-wallets.js");
  const { wallets: smartWallets } = listSmartWallets();
  let smartWalletsHolding = [];

  if (smartWallets.length > 0) {
    const smartWalletMap = new Map(smartWallets.map((w) => [w.address, w]));

    let kwHolders = [];
    if (usingFallback) {
      // Filter from already-fetched list — no extra API call needed
      kwHolders = holders.filter((h) => smartWalletMap.has(h.address || h.wallet));
    } else {
      const addresses = smartWallets.map((w) => w.address).join(",");
      const kwRes     = await fetch(
        `${DATAPI_BASE}/holders/${mint}?addresses=${addresses}`
      ).catch(() => null);
      if (kwRes?.ok) {
        const kwData = await kwRes.json();
        kwHolders    = Array.isArray(kwData) ? kwData : (kwData?.holders || kwData?.data || []);
      } else {
        // Also fall back to local filter if Jupiter fails here too
        kwHolders = holders.filter((h) => smartWalletMap.has(h.address || h.wallet));
      }
    }

    const matchedHolders = kwHolders
      .map((h) => ({ ...h, addr: h.address || h.wallet }))
      .filter((h) => smartWalletMap.has(h.addr));

    await Promise.all(matchedHolders.map(async (h) => {
      const wallet = smartWalletMap.get(h.addr);
      const pct    = totalSupply
        ? parseFloat(((Number(h.amount) / totalSupply) * 100).toFixed(4))
        : null;

      let pnl = null;
      if (!usingFallback) {
        try {
          const pnlRes = await fetch(`${DATAPI_BASE}/pnl-positions?address=${h.addr}&assetId=${mint}`);
          if (pnlRes.ok) {
            const pnlData = await pnlRes.json();
            const pos     = pnlData?.[h.addr]?.tokenPositions?.[0];
            if (pos) pnl = {
              balance:         pos.balance,
              balance_usd:     pos.balanceValue,
              avg_cost:        pos.averageCost,
              realized_pnl:    pos.realizedPnl,
              unrealized_pnl:  pos.unrealizedPnl,
              total_pnl:       pos.totalPnl,
              total_pnl_pct:   pos.totalPnlPercentage,
              buys:            pos.totalBuys,
              sells:           pos.totalSells,
              wins:            pos.totalWins,
              bought_value:    pos.boughtValue,
              sold_value:      pos.soldValue,
              first_active:    pos.firstActiveTime,
              last_active:     pos.lastActiveTime,
              holding_days:    pos.holdingPeriodInSeconds
                ? Math.round(pos.holdingPeriodInSeconds / 86400)
                : null,
            };
          }
        } catch { /* ignore */ }
      }

      smartWalletsHolding.push({
        name:        wallet.name,
        category:    wallet.category,
        address:     h.addr,
        pct,
        sol_balance: h.solBalanceDisplay ?? h.solBalance,
        pnl,
      });
    }));
  }

  return {
    mint,
    global_fees_sol:          null,
    total_fetched:            holders.length,
    showing:                  mapped.length,
    top_10_real_holders_pct:  top10Pct.toFixed(2),
    _source:                  usingFallback ? "helius_fallback" : "jupiter",
    // OKX advanced info
    risk_level:     advancedData?.risk_level     ?? null,
    bundle_pct:     advancedData?.bundle_pct     ?? null,
    sniper_pct:     advancedData?.sniper_pct     ?? null,
    suspicious_pct: advancedData?.suspicious_pct ?? null,
    new_wallet_pct: advancedData?.new_wallet_pct ?? null,
    smart_wallets_holding: smartWalletsHolding,
    holders: mapped,
  };
}
