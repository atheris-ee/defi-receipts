// ALPHA hunter — surfaces opportunities the standard scanners filter out or don't examine.
// Purpose: asymmetric / structural edges that don't fit the risk-adjusted ranker.
// Output shape matches what buildReport expects so findings can merge into top_strategies.

import { loadData, log, fetchJSON } from './utils.js';

// Canonical trade-identity key, identical in form to the dashboard's opportunities.mjs destKey, so
// an ALPHA entry derived from a yields/carry pool collapses against that same pool's YIELD/CARRY
// card on the dashboard (no more ALPHA + FREE_CARRY double-count for one trade).
function normSymbol(s) {
  return String(s || '').toUpperCase().split(/[-/]/).map((t) => t.trim()).filter(Boolean).sort().join('-');
}
function destKey(project, chain, symbol) {
  return `dest:${String(project || '').trim()}|${String(chain || '').trim()}|${normSymbol(symbol)}`;
}

// ------------------------------------------------------------------
// Blue-chip gate (user feedback 2026-06-11): alpha on volatile micro-caps (WETH-ASTEROID
// uniswap-v2 @ 197% etc.) is unwanted — "we want blue chip assets and derivatives most of
// the time". Every leg of a pair must be a major or a fiat-pegged/staked-major derivative
// for the play to alert or headline. Non-major plays are NOT dropped: they keep a flag and
// a ×0.2 score so they stay auditable on the dashboard's /all page but never alert.
// ------------------------------------------------------------------
const MAJOR_LEGS = new Set([
  'BTC', 'WBTC', 'CBBTC', 'TBTC', 'BTCB', 'ETH', 'WETH', 'STETH', 'WSTETH', 'RETH', 'CBETH',
  'WEETH', 'METH', 'EZETH', 'RSETH', 'OSETH', 'ETHX', 'SOL', 'WSOL', 'JITOSOL', 'MSOL',
  'JUPSOL', 'BSOL', 'INF', 'BNB', 'WBNB', 'AVAX', 'WAVAX', 'MATIC', 'POL', 'ARB', 'OP',
  'SUI', 'APT', 'LINK', 'UNI', 'AAVE', 'LDO', 'MKR', 'CRV', 'CVX', 'COMP', 'SNX', 'GMX',
  'PENDLE', 'JUP', 'JTO', 'PYTH', 'TIA', 'SEI', 'INJ', 'NEAR', 'ATOM', 'DOT', 'ADA', 'XRP',
  'DOGE', 'LTC', 'BCH', 'TON', 'TRX', 'WLD', 'S', 'FTM', 'HYPE', 'WHYPE', 'XAUT', 'PAXG',
  // forex/commodity legs — gmtrade-style perp-LP derivatives are first-class for this user
  'XAU', 'XAG', 'AUD', 'CAD', 'NZD', 'SGD', 'WTI', 'BRENT', 'NG',
]);
const STABLE_LEG = /^(USD[A-Z0-9]*|[A-Z0-9]*USD[A-Z0-9]?|DAI|SDAI|FRAX|LUSD|GUSD|TUSD|FDUSD|PYUSD|GHO|CRVUSD|DOLA|MIM|BOLD|EUR[A-Z0-9]*|[A-Z0-9]*EUR|GBP[A-Z0-9]*|CHF[A-Z0-9]*|JPY[A-Z0-9]*)$/;
const isMajorLeg = (t) => { t = String(t || '').toUpperCase().trim(); return MAJOR_LEGS.has(t) || STABLE_LEG.test(t); };
function isMajorPair(sym) {
  const legs = String(sym || '').toUpperCase().split(/[-/]/).map((x) => x.trim()).filter(Boolean);
  return legs.length > 0 && legs.every(isMajorLeg);
}
function bluechipGate(entries) {
  let demoted = 0;
  for (const a of entries) {
    let sym = null;
    const dk = String(a._dedupKey || '');
    if (dk.startsWith('dest:')) sym = dk.split('|').pop();
    else if (a.alphaType === 'FRESH_INCENTIVE') {
      const m = String(a.action || '').toUpperCase().match(/([A-Z0-9.]{2,12}[-/][A-Z0-9.]{2,12}(?:[-/][A-Z0-9.]{2,12})?)/);
      sym = m ? m[1] : null; // no pair in the campaign name -> not gated (the $/day floors apply)
    }
    if (sym == null || isMajorPair(sym)) continue;
    a.nonMajorToken = true;
    a.profitScore = Math.round(a.profitScore * 0.2 * 100) / 100;
    a.alphaReason = (a.alphaReason || '') + ' [NON-MAJOR pair — demoted: blue-chip preference]';
    demoted++;
  }
  return demoted;
}
function splitProtoChain(s) {
  const m = String(s || '').match(/^([^()]+?)\s*\(([^)]+)\)\s*$/);
  return m ? { project: m[1].trim(), chain: m[2].trim() } : { project: String(s || '').trim(), chain: '' };
}

// ------------------------------------------------------------------
// Hunter 1 — "Resurrected extremes": high-quality pools the main ranker
// dropped for being risk >= 8, bag-trapped, or spike-discounted.
// These are suppressed by the safety scorer but often represent real spikes
// that will reward being early.
// ------------------------------------------------------------------
function huntExtremeYields(yields) {
  if (!yields?.top_50) return [];
  const out = [];
  const seen = new Set();
  for (const p of yields.top_50) {
    const risk = p.risk || 5;
    const apy = p.apy || 0;
    const apyMean = p.apyMean30d || apy;
    const tvl = p.tvlUsd || 0;
    const spikeRatio = apyMean > 0 ? apy / apyMean : 1;
    // Sanity clamp: APY > 500% is almost always a DefiLlama reward-decay miscalc
    // (e.g. 1337USDC showing 297994%). Real spike APYs top out around 300% in stable regimes.
    if (apy > 500 || apyMean > 500) continue;
    // Dedup by symbol+project+chain
    const key = `${p.symbol}|${p.project}|${p.chain}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Three flags for resurrection (loosened 2026-04-24 to catch calmer regimes):
    const highRiskHighFloor = risk >= 7 && apyMean >= 15 && tvl >= 250_000;
    const bagTrapRealFloor = p.bagTrap === true && apyMean >= 20 && tvl >= 200_000;
    const spikeCatchable = p.spikeDiscounted === true && apyMean >= 8 && spikeRatio >= 1.3;
    if (!highRiskHighFloor && !bagTrapRealFloor && !spikeCatchable) continue;

    let reason;
    if (spikeCatchable) reason = `SPIKE ×${spikeRatio.toFixed(1)} above 30d mean ${apyMean.toFixed(0)}% — enter now, exit when ratio<1.2`;
    else if (bagTrapRealFloor) reason = `BAG-TRAP flag but 30d mean ${apyMean.toFixed(0)}% — micro-TVL gamble`;
    else reason = `HIGH-RISK but 30d-mean floor ${apyMean.toFixed(0)}% — ranker suppressed`;

    out.push({
      category: 'ALPHA',
      action: `${p.symbol} on ${p.project}(${p.chain}) @ ${apy.toFixed(1)}% (30d mean ${apyMean.toFixed(1)}%)`,
      expectedReturn: `${apy.toFixed(1)}% APY headline`,
      risk: risk + '/10',
      tvl: `$${(tvl / 1e6).toFixed(2)}M`,
      profitScore: Math.min(apy * (apyMean / 30) * Math.log(tvl / 100_000), 400),
      alphaReason: reason,
      alphaType: 'RESURRECTED_EXTREME',
      minCapitalUsd: 0,
      _dedupKey: destKey(p.project, p.chain, p.symbol),
    });
  }
  return out.sort((a, b) => b.profitScore - a.profitScore).slice(0, 5);
}

// ------------------------------------------------------------------
// Hunter 2 — "Synthetic short with carry": FREE_BORROW tokens where the
// borrow reward exceeds interest. Conceptually you're short the token AND
// paid to hold the short. Asymmetric if the token has real downside pressure.
// ------------------------------------------------------------------
function huntSyntheticShorts(shortfarm, carry) {
  // shortfarm is null since the merge (P1.4); kept as a param for back-compat. Use optional
  // chaining on BOTH sources so a null shortfarm can't throw.
  const candidates = [
    ...(shortfarm?.free_borrow_farms || []),
    ...(carry?.free_borrow_carries || []),
  ];
  if (!candidates.length) return [];
  // FIX 2026-05: dedup by BORROWED TOKEN only (best destination wins), not token|stakeIn — the
  // old key let the same "borrow CBBTC at -29.9%" decision appear 3× (orca / aerodrome / beefy),
  // consuming all 3 SYNTHETIC_SHORT slots with one trade. Sort by carry desc first so the best
  // venue is the one kept.
  candidates.sort((a, b) => ((b.netYield || b.netSpread || 0) - (a.netYield || a.netSpread || 0)));
  const out = [];
  const seen = new Set();
  for (const f of candidates) {
    const netCarry = (f.netYield || f.netSpread || 0);
    const netBorrow = f.netBorrowCost || 0;
    if (netBorrow >= 0) continue; // must be getting paid to borrow
    if (netCarry < 3) continue; // need meaningful carry
    if (f.stablecoin === true) continue; // no directional short thesis on a stable
    const tok = (f.token || '').toUpperCase();
    if (seen.has(tok)) continue;
    seen.add(tok);
    // Prefer tokens with declining 7d base apy (token demand weakening → short thesis intact)
    const decayBonus = f.decayRatio7d && f.decayRatio7d > 1.3 ? 1.5 : 1.0;
    const stake = splitProtoChain(f.stakeIn);
    out.push({
      category: 'ALPHA',
      action: `SYNTHETIC SHORT ${f.token} — borrow at ${netBorrow.toFixed(1)}% (paid), stake in ${f.stakeIn || 'dest'}, net +${netCarry.toFixed(1)}%`,
      expectedReturn: `+${netCarry.toFixed(1)}% carry + price downside if ${f.token} drops`,
      risk: (f.risk || 5) + '/10',
      profitScore: Math.min(netCarry * 4 * decayBonus, 300),
      alphaReason: `Paid ${Math.abs(netBorrow).toFixed(1)}% to hold short + ${netCarry.toFixed(1)}% stake yield. Asymmetric if ${f.token} has fundamental downside.`,
      alphaType: 'SYNTHETIC_SHORT',
      minCapitalUsd: f.minEconomicalUsd || 0,
      // Collapse against the source FREE_CARRY card for the same destination pool on the dashboard.
      _dedupKey: destKey(stake.project, stake.chain, f.lpPairSymbol || f.stakeSymbol || f.token),
    });
  }
  return out.sort((a, b) => b.profitScore - a.profitScore).slice(0, 3);
}

// ------------------------------------------------------------------
// Hunter 3 — "Pendle basis spike": Pendle pools where current APY is
// materially above 30d mean AND apyMean30d floor is attractive.
// The spike is real fee revenue; enter now, sell PT or unwind when ratio compresses.
// ------------------------------------------------------------------
function huntPendleBasis(yields) {
  if (!yields?.top_50) return [];
  const out = [];
  const seen = new Set();
  for (const p of yields.top_50) {
    if (p.project !== 'pendle') continue;
    const apy = p.apy || 0;
    const mean = p.apyMean30d || apy;
    if (apy > 500 || mean > 500) continue; // sanity clamp
    const ratio = mean > 0 ? apy / mean : 1;
    const tvl = p.tvlUsd || 0;
    // Spike conditions (loosened 2026-04-24): APY ≥ 1.15× 30d mean, floor ≥ 8%
    if (ratio < 1.15 || mean < 8) continue;
    if (tvl < 500_000) continue; // need liquidity to actually enter
    // FIX 2026-05: dedup AFTER the filters. Previously seen.add fired before the ratio/mean/tvl
    // gates, so a non-qualifying row (e.g. APYUSD ratio 0.91) claimed the symbol|chain key and
    // silently blocked a later qualifying spike row — output was always 0 despite real signal.
    const key = `${p.symbol}|${p.chain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      category: 'ALPHA',
      action: `PENDLE BASIS: ${p.symbol} on ${p.chain} — spiked to ${apy.toFixed(1)}% (30d mean ${mean.toFixed(1)}%, ratio ${ratio.toFixed(2)}×)`,
      expectedReturn: `${apy.toFixed(1)}% headline, regresses to ~${mean.toFixed(1)}%`,
      risk: (p.risk || 2) + '/10',
      tvl: `$${(tvl / 1e6).toFixed(2)}M`,
      profitScore: Math.min((apy - mean) * Math.log(tvl / 500_000) * 3, 350),
      alphaReason: `Spike catchable — realize ${((apy + mean) / 2).toFixed(1)}% weighted yield if you exit when ratio<1.15`,
      alphaType: 'PENDLE_BASIS',
      minCapitalUsd: 100,
      _dedupKey: destKey(p.project, p.chain, p.symbol),
    });
  }
  return out.sort((a, b) => b.profitScore - a.profitScore).slice(0, 3);
}

// ------------------------------------------------------------------
// Hunter 4 — "Composable collateral": LP/receipt tokens from high-yield pools
// that ALSO appear as borrowable collateral somewhere. Means the capital
// pulls double duty — earn LP yield AND use the LP token as collateral to
// borrow stable at low cost, redeposit for more yield. Hidden recursive leverage.
// ------------------------------------------------------------------
function huntComposableCollateral(yields, carry) {
  if (!yields?.top_50 || !carry?.top_carries) return [];
  // Extract the set of tokens that appear as borrow-collateral in any carry trade.
  const borrowableTokens = new Set();
  const sources = [
    ...(carry.top_carries || []),
    ...(carry.top_stable_carries || []),
    ...(carry.top_volatile_carries || []),
    ...(carry.free_borrow_carries || []),
  ];
  for (const c of sources) {
    if (c.token) borrowableTokens.add(c.token.toUpperCase());
  }
  const out = [];
  const seen = new Set();
  for (const p of yields.top_50) {
    if (!p.symbol) continue;
    const sym = p.symbol.toUpperCase();
    const apy = p.apy || 0;
    if (apy > 500) continue; // sanity clamp
    if (apy < 8) continue;
    if ((p.tvlUsd || 0) < 2_000_000) continue;
    // Match by exact symbol OR by LP-component presence (e.g. USDC-ETH LP → check if USDC-ETH exists as collateral)
    const directMatch = borrowableTokens.has(sym);
    if (!directMatch) continue;
    const key = `${sym}|${p.project}|${p.chain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      category: 'ALPHA',
      action: `COMPOSABLE: ${sym} on ${p.project}(${p.chain}) @ ${apy.toFixed(1)}% — token is borrowable collateral elsewhere`,
      expectedReturn: `${apy.toFixed(1)}% base + recursive leverage stack possible`,
      risk: ((p.risk || 3) + 2) + '/10', // recursion adds risk
      tvl: `$${(p.tvlUsd / 1e6).toFixed(2)}M`,
      profitScore: Math.min(apy * 2.5, 280),
      alphaReason: `${sym} is a yield-bearing token AND usable as collateral — stack by depositing LP, borrow stable, redeposit. Check liquidation risk.`,
      alphaType: 'COMPOSABLE_STACK',
      minCapitalUsd: 500,
      _dedupKey: destKey(p.project, p.chain, p.symbol),
    });
  }
  return out.sort((a, b) => b.profitScore - a.profitScore).slice(0, 3);
}

// ------------------------------------------------------------------
// Hunter 5 — "Early launch": paid-boosted brand-new tokens with REAL liquidity and turnover.
// This is the asymmetric/convex early-entry signal the retired liquidity.js was meant to provide
// but never did (its new-pairs endpoint was broken and it surfaced raw memecoin promo spam). Here
// we pull DexScreener token-boosts, then VERIFY each survivor against the (correct) token-pairs
// endpoint: keep only tokens with >$50K liquidity, >$50K 24h volume, not dust, not already dumping.
// Fully defensive — any network/parse failure returns [] and never breaks the alpha scan. Risk 9
// (these are small convex gambles) and capped score so they inform without dominating.
// ------------------------------------------------------------------
async function huntEarlyLaunch() {
  try {
    const boosts = await fetchJSON('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 10000 });
    if (!Array.isArray(boosts)) return [];
    // Dedup by token, keep the highest cumulative boost; drop $-dust boosts and one-word spam.
    const byToken = new Map();
    for (const b of boosts) {
      const total = Number(b.totalAmount || b.amount || 0);
      if (total < 100) continue;                              // filter $10-tier promo spam
      if (String(b.description || '').trim().length < 20) continue; // one-word / empty spam
      const key = `${b.chainId}:${b.tokenAddress}`;
      if (!byToken.has(key) || byToken.get(key).total < total) byToken.set(key, { ...b, total });
    }
    const candidates = [...byToken.values()].sort((a, b) => b.total - a.total).slice(0, 8);
    const out = [];
    for (const b of candidates) {
      if (out.length >= 4) break;
      try {
        const resp = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${b.tokenAddress}`, { timeout: 8000 });
        const list = Array.isArray(resp?.pairs) ? resp.pairs : [];
        const best = list.filter((p) => (p.liquidity?.usd || 0) > 50000)
          .sort((a, c) => (c.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        if (!best) continue;                                  // no real liquidity = spam, drop
        const liq = best.liquidity.usd;
        const vol24 = best.volume?.h24 || 0;
        const chg24 = best.priceChange?.h24 || 0;
        const fdv = best.fdv || 0;
        if (vol24 < 50000) continue;                          // need real turnover
        if (fdv > 0 && fdv < 100000) continue;                // dust micro-cap
        if (chg24 < -30) continue;                            // already dumping hard
        const sym = best.baseToken?.symbol || b.tokenAddress.slice(0, 6);
        const turnover = liq > 0 ? vol24 / liq : 0;
        const score = Math.min(Math.log10(Math.max(b.total, 100)) * (1 + Math.min(turnover, 5)) * (1 + Math.max(chg24, 0) / 100) * 18, 250);
        out.push({
          category: 'ALPHA',
          action: `EARLY LAUNCH: ${sym} on ${b.chainId} — $${(liq / 1e3).toFixed(0)}K liq, $${(vol24 / 1e3).toFixed(0)}K 24h vol, ${chg24 >= 0 ? '+' : ''}${chg24.toFixed(0)}% 24h ($${b.total} boosted)`,
          expectedReturn: `early entry — ${turnover.toFixed(1)}× daily turnover, convex`,
          risk: '9/10',
          tvl: `$${(liq / 1e3).toFixed(0)}K`,
          profitScore: score,
          alphaReason: `Paid-boosted ($${b.total}) new token with REAL liquidity ($${(liq / 1e3).toFixed(0)}K) and turnover (${turnover.toFixed(1)}×). Asymmetric early bet — size small, high risk of -100%.`,
          alphaType: 'EARLY_LAUNCH',
          minCapitalUsd: 50,
          _open: { chain: b.chainId, token: sym, buyUrl: b.url || best.url },
          _dedupKey: `launch:${b.chainId}:${b.tokenAddress}`,
        });
      } catch { /* skip this token */ }
    }
    return out.sort((a, b) => b.profitScore - a.profitScore).slice(0, 3);
  } catch (e) {
    log('[ALPHA] early-launch hunter error (non-fatal): ' + e.message);
    return [];
  }
}

// ------------------------------------------------------------------
// Hunter 5 — "Fresh incentive window": Merkl campaigns first seen <72h ago still paying >20% APR
// (pre-filtered into incentives.json fresh_high_apr by research-incentives). Day-1 dilution is the
// documented edge (45,374% → 58.7% APR in one day on a May campaign): the APR on a fresh program
// is pre-crowd. Floors keep dust out — a campaign must pay real $/day to be worth touching.
// ------------------------------------------------------------------
function huntFreshIncentives(incentives) {
  const fresh = incentives && incentives.fresh_high_apr;
  if (!Array.isArray(fresh)) return [];
  const out = [];
  for (const c of fresh) {
    const apr = +c.apr || 0, daily = +c.dailyRewards || 0, tvl = +c.tvl || 0;
    if (apr < 20) continue;
    if (daily < 50) continue; // $50/day reward budget floor — below that there is nothing to harvest
    out.push({
      category: 'ALPHA',
      action: `${c.name} [${c.protocol}/${c.chain}] @ ${apr.toFixed(1)}% APR (Merkl, ${(+c.ageHoursSinceFirstSeen || 0).toFixed(0)}h since first seen)`,
      expectedReturn: `${apr.toFixed(1)}% APR while the entry window lasts`,
      risk: '6/10',
      tvl: `$${(tvl / 1e6).toFixed(2)}M`,
      profitScore: Math.min(Math.sqrt(daily) * Math.min(apr, 200) / 10, 300),
      alphaReason: `fresh Merkl campaign paying $${daily.toFixed(0)}/day — enter before dilution`,
      alphaType: 'FRESH_INCENTIVE',
      minCapitalUsd: 0,
      depositUrl: c.depositUrl || undefined,
      _dedupKey: `merkl:${c.id}`,
    });
  }
  return out.sort((a, b) => b.profitScore - a.profitScore).slice(0, 5);
}

// ------------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------------
export async function scanAlpha() {
  log('Hunting asymmetric / novel-structure alpha...');
  const yields = loadData('yields.json');
  const carry = loadData('carry.json');
  // incentives.json is written by the Phase-0 research pass (possibly last scan's — 5 min stale
  // at worst, irrelevant against a 72h freshness window).
  const incentives = loadData('incentives.json');
  // shortfarm.json retired (merged into carry). Synthetic shorts now come from carry's
  // free_borrow_carries alone (same negative-net-borrow trades the shortfarm feed carried).
  const resurrectedExtremes = huntExtremeYields(yields);
  const syntheticShorts = huntSyntheticShorts(null, carry);
  const pendleBasis = huntPendleBasis(yields);
  const composable = huntComposableCollateral(yields, carry);
  const earlyLaunch = []; // EARLY_LAUNCH disabled 2026-06-03 (DexScreener boosted-memecoin promo feed, per user). huntEarlyLaunch() retained below but not called.
  const freshIncentives = huntFreshIncentives(incentives);

  const all = [...resurrectedExtremes, ...syntheticShorts, ...pendleBasis, ...composable, ...earlyLaunch, ...freshIncentives];
  const demoted = bluechipGate(all); // before the sort, so non-major plays sink
  all.sort((a, b) => (b.profitScore || 0) - (a.profitScore || 0));
  if (demoted) log(`  blue-chip gate: ${demoted} non-major play${demoted === 1 ? '' : 's'} demoted ×0.2`);

  log(`  RESURRECTED_EXTREME: ${resurrectedExtremes.length}`);
  log(`  SYNTHETIC_SHORT:     ${syntheticShorts.length}`);
  log(`  PENDLE_BASIS:        ${pendleBasis.length}`);
  log(`  COMPOSABLE_STACK:    ${composable.length}`);
  log(`  EARLY_LAUNCH:        ${earlyLaunch.length}`);
  log(`  FRESH_INCENTIVE:     ${freshIncentives.length}`);

  return {
    timestamp: new Date().toISOString(),
    total: all.length,
    resurrected_extremes: resurrectedExtremes,
    synthetic_shorts: syntheticShorts,
    pendle_basis: pendleBasis,
    composable_stacks: composable,
    early_launch: earlyLaunch,
    fresh_incentives: freshIncentives,
    all_alpha: all,
  };
}
