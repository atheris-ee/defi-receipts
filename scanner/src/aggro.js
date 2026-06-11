// Aggressive DeFi strategies scanner
// CLM sniping, flashloan arb paths, recursive leverage, funding rate farming, liquidation proximity
import { fetchJSON, cached, setCache, log } from './utils.js';
import { fetchRewardTokenDecay, rewardDecayFactor } from './yields.js';

// X251: Tokens with established on-chain lending markets (Aave, Compound, Morpho, etc.).
// Used specifically for FUNDING LONG_PERP borrow cost estimation.
// Excludes meme tokens (WIF, PEPE, SHIB, BONK, DOGE) which are in MAJOR_TOKENS
// for CLM risk but have no deep lending markets — actual borrow cost 15-30%+, not 3%.
const FUNDING_BORROW_MAJORS = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'AVAX', 'MATIC', 'ARB', 'OP', 'LINK', 'UNI', 'AAVE',
  'SUI', 'NEAR', 'ATOM', 'XRP', 'ADA', 'DOT', 'XMR', 'LTC', 'APT', 'BCH', 'FIL',
  'PENDLE', 'CRV', 'LDO', 'ENA', 'INJ', 'SEI', 'TIA', 'FTM', 'S', 'MNT',
  'WETH', 'WBTC', 'WSOL', 'WAVAX', 'WBNB', 'WMATIC', 'CBBTC', 'WBTC.B', 'BTC.B',
  'STETH', 'WSTETH', 'EZETH', 'WEETH', 'RSETH', 'OSETH', 'METH', 'EETH',
  'MSOL', 'JUPSOL', 'JITOSOL',
]);

// X127: Module-scope major token set — used by CLM risk scoring and FUNDING.
// Includes wrapped variants (WSOL, WETH, WAVAX, etc.) for pool symbol matching.
const MAJOR_TOKENS = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'AVAX', 'MATIC', 'ARB', 'OP', 'LINK', 'UNI', 'AAVE', 'DOGE', 'SUI', 'NEAR', 'ATOM',
  'XRP', 'ADA', 'DOT', 'XMR', 'LTC', 'TRX', 'APT', 'BCH', 'TON', 'HBAR', 'FIL', 'TAO',
  'HYPE', 'PEPE', 'kPEPE', 'SHIB', 'WIF', 'kBONK', 'PENDLE', 'CRV', 'LDO', 'ENA',
  'WLD', 'PAXG', 'ZEC', 'INJ', 'SEI', 'TIA', 'FTM', 'S', 'MNT',
  // Wrapped/bridged variants common in LP pool symbols
  'WETH', 'WBTC', 'WSOL', 'WAVAX', 'WBNB', 'WMATIC', 'WFTM', 'WSTETH', 'CBETH', 'RETH',
  'CBBTC', 'WBTC.B', 'BTC.B', 'WHYPE',
  // Major DeFi protocol tokens with deep liquidity
  'AERO', 'VELO', 'JOE', 'CAKE', 'SUSHI', 'GMX', 'GNS',
  // Major stablecoins (always safe as pair component)
  'USDC', 'USDT', 'DAI', 'BUSD', 'FRAX', 'TUSD', 'PYUSD', 'USDS', 'LUSD', 'GHO',
  'USDT0', 'USD₮0', 'EURC', 'CRVUSD', 'USDD', 'USDP', 'UST', 'MIM', 'SUSD', 'RAI', 'GUSD',
  'USD1',
  // Major LSTs/LRTs
  'STETH', 'EZETH', 'WEETH', 'RSETH', 'SWETH', 'OSETH', 'METH', 'EETH', 'ANKETH',
  'MSOL', 'JSOL', 'JUPSOL', 'BSOL', 'JITOSOL',
  'AUSD', 'SUSDE', 'USDE', 'SDAI', 'SAVAX',
]);

// X127: Check if a pool pair contains any non-major token
function hasNonMajorToken(symbol) {
  const tokens = (symbol || '').toUpperCase().split('-');
  return tokens.some(t => t.length > 0 && !MAJOR_TOKENS.has(t));
}

// ============================================================
// 1. CLM — Concentrated Liquidity Management
// Find pools with extreme fee/TVL ratio (tight range = massive APY)
// ============================================================
async function scanCLM() {
  log('[CLM] Scanning concentrated liquidity pools...');
  const pools = await getCachedPools();

  // X173: Fetch reward token decay for emission-adjusted CLM projected APY.
  // CLM rewardApy (protocol emissions) was added raw — AERO rewards at 76%+ could decay 90%.
  const decayMap = await fetchRewardTokenDecay(pools);

  // CLM projects use concentrated liquidity (Uni v3 style)
  const CLM_PROJS = new Set([
    'uniswap-v3','uniswap-v4','aerodrome-slipstream','velodrome-v3',
    'pancakeswap-amm-v3','camelot-v3','quickswap-v3','thena-v3',
    'joe-v2.1','joe-v2.2','orca-dex','meteora-dlmm','raydium-clmm',
    'ambient-finance','maverick-v2','kim-exchange-v4',
    'quickswap-dex','thena-fusion',
    'ekubo',
    'blackhole-clmm','pharaoh-v3','sparkdex-v3.1',
    'shadow-exchange-clmm','alien-base-v3',
    'project-x','hyperion','bluefin-spot',
    'turbos','nest-v1','ramses-cl',
    'etherex-cl','supernova-cl','fluxion-network','flowx-v3',
  ]);
  // X29: Also detect CLM pools from aggregator protocols via poolMeta
  const CLM_META_PATTERNS = /^(uniswap|aerodrome|velodrome|pancakeswap|camelot|quickswap|thena|sushiswap|ekubo|maverick|gamma|steer|orca|meteora|raydium|cetus|ambient|blackhole|pharaoh|sparkdex|shadow|alien|project-x|hyperion|bluefin|turbos|nest|ramses|etherex|supernova|fluxion|flowx|concentrated)/i;
  // Constant-product AMMs (NOT concentrated-liquidity) that the meta regex would otherwise catch
  // on poolMeta substrings like "raydium" / "sushiswap". Concentrating a constant-product LP is
  // impossible, so projecting a tight-range multiplier for these is a false positive.
  const AMM_CONSTANT_PRODUCT = new Set([
    'raydium-amm','sushiswap','uniswap-v2','pancakeswap-amm','biswap','apeswap','quickswap',
    'velodrome-v2','aerodrome','spookyswap','traderjoe','honeyswap',
  ]);
  function isClmPool(p) {
    if (CLM_PROJS.has(p.project)) return true; // explicit allow (incl pancakeswap-amm-v3 etc.)
    // X-fix 2026-05: exclude constant-product AMMs (raydium-amm, sushiswap v2, *-amm, *-v2)
    if (AMM_CONSTANT_PRODUCT.has(p.project) || /-amm$|-v2$/.test(p.project || '')) return false;
    const meta = (p.poolMeta || '').split(' ')[0];
    return meta.length > 0 && CLM_META_PATTERNS.test(meta);
  }

  // X62: Require minimum base fee APY for CLM entries.
  // Concentration multiplies fee revenue only — rewards accrue per LP share regardless of range width.
  // A pool with 0% base + 494% rewards shows "~494% at 3x" which is misleading (concentration adds 0%).
  const clmPools = pools.filter(p =>
    isClmPool(p) &&
    (p.tvlUsd || 0) > 50000 &&
    (p.apy || 0) > 20 &&
    (p.apyBase || 0) >= 5  // X62: no fee revenue = nothing to concentrate
  );

  // Score by fee intensity: high base APY + high volume relative to TVL = concentrated range opportunity
  const scored = clmPools.map(p => {
    const rawBaseApy = p.apyBase || 0;
    const rewardApy = p.apyReward || 0;
    const totalApy = p.apy || 0;
    const mean30d = p.apyMean30d || totalApy;

    // X44: Spike/outlier filter for CLM — use conservative base APY.
    // CLM managers who enter tight ranges based on spiked fees get crushed when fees normalize.
    // Outlier pools: cap at 1.2x mean30d (DefiLlama flags statistical outliers).
    // Non-outlier but spiking (>2x mean30d): cap at 1.5x mean30d.
    const isOutlier = p.outlier === true;
    const isNonOutlierSpike = !isOutlier && rawBaseApy > mean30d * 2 && mean30d > 5;
    const spikeBuffer = isOutlier ? 1.2 : isNonOutlierSpike ? 1.5 : 999;
    const spikeAdjBase = (isOutlier || isNonOutlierSpike) ? Math.min(rawBaseApy, (p.apyMean30d || rawBaseApy) * spikeBuffer) : rawBaseApy;
    // X296: Only label as spike when adjustment is material (≥5% of rawBaseApy).
    // Outlier pools where current APY barely exceeds mean30d*1.2 get a trivial 1-2%
    // adjustment that triggers "FEE SPIKE: current APY likely transient" — misleading
    // when the shown rate IS approximately the sustainable rate. Score still uses
    // spikeAdjBase (correct minor adjustment), but label is suppressed for noise.
    const spikeLabel = spikeAdjBase < rawBaseApy * 0.95;

    // X85: Declining fee environment discount for CLM.
    // When fees are declining (base7d >> current or mean30d >> current for outliers),
    // the current base APY is unreliable — fees may continue dropping.
    // A CLM manager entering at 4x concentration on a halving fee pool will see
    // projected returns evaporate while rebalancing gas stays constant.
    const base7d = p.apyBase7d || null;
    // X217: threshold 1.5→1.3 (parity with carry.js/shortfarm.js X117). A 30%+ decline from
    // 7d avg makes projected CLM returns unreliable — gas costs fixed, fee revenue dropping.
    const isDecl7d = base7d !== null && base7d > spikeAdjBase * 1.3;  // 7d avg was 1.3x+ current
    const isDeclMean = isOutlier && !base7d && mean30d > spikeAdjBase * 2.0;  // outlier + mean30d 2x+ current + no 7d
    const isDeclining = isDecl7d || isDeclMean;
    // Apply conservative discount: use fraction of current base when declining
    const declineFactor = isDecl7d && base7d > spikeAdjBase * 2 ? 0.6 : isDeclining ? 0.8 : 1.0;
    const preDeclBase = spikeAdjBase * declineFactor;
    const declineLabel = isDeclining;

    // X113: Prediction-based risk penalty for CLM pools.
    // DefiLlama predictions (Down with high probability) signal fee decline that makes
    // tight-range CLM especially dangerous — gas costs are fixed but fee revenue drops.
    // Less harsh than carry/yields (0.1x) since CLM targets active managers, but should
    // still penalize. outlier+Down≥80%: 0.5x score, +2 risk. Down≥80%: 0.7x, +1 risk.
    // outlier+noPredictions: 0.8x, +1 risk.
    // X120: predFactor now applied to baseApy (not just score) so projected APY reflects
    // prediction. Previously "153% at 7.7x [FEES PREDICTED DOWN]" was contradictory —
    // user sees high projection + warning label. Now projection uses discounted base.
    const pred = p.predictions || {};
    const predDown = (pred.predictedClass || '').toLowerCase() === 'down';
    const predProb = pred.predictedProbability || 0;
    const predFactor = (isOutlier && predDown && predProb >= 80) ? 0.5
      : (predDown && predProb >= 80) ? 0.7
      : (isOutlier && !pred.predictedClass) ? 0.8
      : 1.0;
    const predRiskPenalty = (isOutlier && predDown && predProb >= 80) ? 2
      : ((predDown && predProb >= 80) || (isOutlier && !pred.predictedClass)) ? 1
      : 0;
    const predLabel = predFactor < 1.0;
    // X120: Apply predFactor to baseApy so projected APY reflects fee prediction
    const baseApy = preDeclBase * predFactor;

    const feeIntensity = baseApy; // pure trading fee yield (spike+decline+prediction-adjusted)
    const apyVolatility = Math.abs(totalApy - mean30d) / Math.max(mean30d, 1);

    // X36 FIX: Concentration multiplier must respect PRICE volatility, not just APY stability.
    // A volatile pair (ETH-USDC) with stable fees still goes out of range on a 3% price move.
    // Pair-type caps based on realistic rebalance frequency:
    //   - Stable pairs (USDC-USDT): max 10x — price barely moves, weekly rebalance fine
    //   - Correlated pairs (ETH-WSTETH): max 5x — small drift, daily rebalance
    //   - Volatile pairs (ETH-USDC): max 3x — frequent large moves, aggressive daily rebalance
    const rawIsStable = stablePair(p);
    const sym = (p.symbol || '').toUpperCase();
    // X176: Non-major stablecoin pairs (USDC-THUSD etc.) treated as correlated, not stable.
    // If the non-major stablecoin depegs, 10x concentration + 95% in-range assumptions fail
    // catastrophically — position goes 100% out of range with maximum IL.
    const isNonMajorStablePair = rawIsStable && hasNonMajorToken(p.symbol);
    const isStable = rawIsStable && !isNonMajorStablePair;
    // X124+X173: cross-currency stablecoins (EURC-USDC, CADC-USDC) are correlated, not volatile
    const isCrossCurrencyStablePair = isCrossCurrencyStable(p);
    const isCorrelated = !isStable && (
      isCrossCurrencyStablePair ||
      isNonMajorStablePair ||
      (/STETH|CBETH|RETH|SETH|METH|ARBWETH|AARBWETH|WBETH|EETH|EZETH|WEETH|RSETH|SWETH|OSETH|ANKETH/i.test(sym) && /ETH/i.test(sym)) ||
      (p.ilRisk === 'no' && /ETH.*ETH/i.test(sym))
    );
    const pairTypeCap = isStable ? 10 : isCorrelated ? 5 : 3;

    const apyBasedMultiplier = Math.min(10, Math.max(1.5, 5 / (apyVolatility + 0.5)));
    const tightRangeMultiplier = Math.min(pairTypeCap, apyBasedMultiplier);
    // X114: In-range time factor — concentrated positions are NOT in range 100% of the time.
    // At higher concentration, the range is tighter and price moves push you out more often.
    // Even with daily rebalancing, volatile pairs at 3x spend ~30-35% of time out of range.
    // Stable pairs at 10x are almost always in range (price barely moves).
    // These factors are conservative estimates from empirical V3 LP data.
    // X243: Non-major volatile pairs (meme/micro-cap tokens) have 2-3x higher daily price
    // volatility than major pairs (ETH-USDC). A meme token with 10-30% daily swings exits
    // a 3x concentration range ~55-60% of the time (vs ~35% for ETH). WHYPE-USDC at 0.65
    // overstated projected APY by ~45% vs realized. 0.45 matches empirical meme LP data.
    const isNonMajorVolatile = !isStable && !isCorrelated && hasNonMajorToken(p.symbol);
    const inRangeFactor = isStable ? 0.95 : isCorrelated ? 0.85 : isNonMajorVolatile ? 0.45 : 0.65;
    // X173: Apply reward token decay — AERO/emission rewards can lose 60-90% of value.
    // Rewards accrue per LP share (not concentrated) but token value decays.
    const tokenDecay = rewardDecayFactor(p, decayMap);
    const adjRewardApy = rewardApy * tokenDecay;
    const emissionPct = (rewardApy + baseApy) > 0 ? (rewardApy / (rewardApy + baseApy) * 100) : 0;
    const emissionHeavy = emissionPct > 50;
    // X-fix 2026-05: IMPERMANENT-LOSS drag. inRangeFactor only models the FRACTION OF TIME fees
    // are earned (out-of-range = 0 fees); it does NOT capture the divergence loss suffered WHILE
    // in range (as price moves you sell the appreciating asset). For a concentrated position this
    // IL is materially larger than full-range IL and grows with both volatility and concentration.
    // Applied as a conservative empirical haircut on the fee-derived portion (rewards are unaffected
    // by IL). Calibrated so volatile-major projections land in the ~20-60% realized band the prior
    // no-IL model overshot. Stable pairs barely diverge (~0 IL).
    const ilDragFactor = isStable ? 0.98 : isCorrelated ? 0.90 : isNonMajorVolatile ? 0.50 : 0.68;
    const projectedApy = (baseApy * tightRangeMultiplier * inRangeFactor * ilDragFactor) + adjRewardApy;
    // X73: Rebalance cost scales with pair type (rebalance frequency).
    // Base cost = weekly rebalance gas. Volatile pairs need daily rebalancing (5x),
    // correlated need every 2-3 days (3x), stable stay weekly (1x).
    // X91: extended chain gas costs (was missing Aptos/Sui/etc. — defaulted to $15 Ethereum)
    const weeklyGasCost = p.chain === 'Solana' ? 0.5 : p.chain === 'Base' ? 0.70 : p.chain === 'Arbitrum' ? 3 : (p.chain === 'OP Mainnet' || p.chain === 'Optimism') ? 1 : p.chain === 'Polygon' ? 0.35 : p.chain === 'Avalanche' ? 3 : p.chain === 'BSC' ? 1.4 : p.chain === 'Sui' ? 0.14 : p.chain === 'Aptos' ? 0.14 : p.chain === 'Stellar' ? 0.07 : p.chain === 'Flow' ? 0.07 : p.chain === 'Hyperliquid L1' ? 0.35 : p.chain === 'MegaETH' ? 0.35 : p.chain === 'Monad' ? 0.35 : 15;
    const rebalanceFreqMul = isStable ? 1 : isCorrelated ? 3 : 5;
    const estRebalanceCost = weeklyGasCost * rebalanceFreqMul;
    const netProjectedApy = projectedApy - estRebalanceCost;

    // X76: Minimum capital for CLM based on actual gas costs per rebalance tx.
    // Gas per rebalance tx in USD (approve+swap+repositionRange):
    // X91: match chain list with weeklyGasCost above + RECURSIVE gas table (line ~403)
    const gasPerTxUsd = p.chain === 'Solana' ? 0.01 : p.chain === 'Base' ? 0.10 : p.chain === 'Arbitrum' ? 0.50 : (p.chain === 'OP Mainnet' || p.chain === 'Optimism') ? 0.15 : p.chain === 'Polygon' ? 0.05 : p.chain === 'Avalanche' ? 0.50 : p.chain === 'BSC' ? 0.20 : p.chain === 'Sui' ? 0.02 : p.chain === 'Aptos' ? 0.02 : p.chain === 'Stellar' ? 0.01 : p.chain === 'Flow' ? 0.01 : p.chain === 'Hyperliquid L1' ? 0.05 : p.chain === 'MegaETH' ? 0.05 : p.chain === 'Monad' ? 0.05 : 15;
    const annualTxCount = isStable ? 52 : isCorrelated ? 150 : 365;
    const annualGasUsd = gasPerTxUsd * annualTxCount;
    // X193: Min capital where gas < 15% of net projected returns (±20% mandate accuracy)
    // Was 50% (breakeven) — allowed 28% APY overstatement for volatile CLM at $200 capital.
    // At 15%: max overstatement at minCapital = 15/85 = 17.6%, within ±20% mandate.
    const minCapitalUsd = netProjectedApy > 0 ? Math.ceil(annualGasUsd / (netProjectedApy / 100 * 0.15)) : 99999;

    return {
      pool: p.pool,
      project: p.project,
      chain: p.chain,
      pair: p.symbol,
      tvl: p.tvlUsd,
      currentApy: totalApy,
      baseApy,
      rawBaseApy,
      rewardApy: adjRewardApy,
      rawRewardApy: rewardApy,
      rewardDecay: tokenDecay,
      emissionHeavy,
      mean30dApy: mean30d,
      spikeAdjusted: spikeLabel || false,
      decliningFees: declineLabel || false,
      predictedDown: predLabel || false,
      tightRangeProjectedApy: Math.round(netProjectedApy * 100) / 100,
      tightRangeMultiplier: tightRangeMultiplier.toFixed(1) + 'x',
      estRebalanceCost: estRebalanceCost + '% annualized (' + (isStable ? 'weekly' : isCorrelated ? '2-3d' : 'daily') + ')',
      feeIntensity: Math.round(baseApy),
      stablePair: p.stablecoin || false,
      volatilityScore: Math.round(apyVolatility * 100) / 100,
      pairType: isStable ? 'stable' : isCorrelated ? 'correlated' : 'volatile',
      pairTypeCap: pairTypeCap + 'x',
      inRangeFactor,
      strategy: (function() {
        // X120: Show prediction-adjusted base with original in parentheses
        // X252: Suppress adj label when rounding makes before/after display identical
        const spikeVisibleDiff = spikeLabel && Math.round(baseApy) < Math.round(rawBaseApy);
        const predVisibleDiff = predLabel && predFactor < 1.0 && Math.round(baseApy) < Math.round(preDeclBase);
        const declVisibleDiff = declineLabel && declineFactor < 1.0 && Math.round(baseApy) < Math.round(spikeAdjBase);
        const baseLabel = spikeVisibleDiff
          ? baseApy.toFixed(0) + '% base (spike-adj from ' + rawBaseApy.toFixed(0) + '%)'
          : predVisibleDiff
          ? baseApy.toFixed(0) + '% base (pred-adj from ' + preDeclBase.toFixed(0) + '%)'
          : declVisibleDiff
          ? baseApy.toFixed(0) + '% base (decline-adj from ' + spikeAdjBase.toFixed(0) + '%)'
          : baseApy.toFixed(0) + '% base';
        const pairLabel = isStable ? 'stable pair' : isCorrelated ? 'correlated' : 'volatile';
        const ilNote = isStable ? 'Low IL, weekly rebalance.' : isCorrelated ? 'Moderate IL, rebalance every 2-3d.' : 'HIGH IL RISK, daily rebalance needed.';
        const spikeNote = '';
        const declNote = '';
        const predNote = '';
        const nonMajorNote = hasNonMajorToken(p.symbol) ? ' [NON-MAJOR TOKEN]' : '';
        const rangeNote = inRangeFactor < 1.0 ? ' (' + Math.round(inRangeFactor * 100) + '% est. in-range time)' : '';
        // X173: Show emission-adjusted reward when decay is significant
        const emissionNote = rewardApy > 5 && tokenDecay < 0.9 ? ' [EMISSION ADJ: rewards ' + Math.round(tokenDecay * 100) + '% sustainable]' : '';
        return 'TIGHT RANGE ' + pairLabel + ': ' + p.symbol + ' on ' + p.project + '(' + p.chain + ') — current ' + baseLabel + ' -> ~' + netProjectedApy.toFixed(0) + '% at ' + tightRangeMultiplier.toFixed(1) + 'x concentration' + rangeNote + '. ' + ilNote + spikeNote + declNote + predNote + nonMajorNote + emissionNote;
      })(),
      // X127: Non-major token detection — meme/micro-cap tokens in CLM pairs
      // Concentrated LP on meme tokens (FARTCOIN, ASTEROID, etc.) is much riskier than
      // on established tokens (ETH, USDC) due to potential 90%+ crashes, rug pulls,
      // and sudden liquidity evaporation making rebalancing impossible.
      nonMajorToken: hasNonMajorToken(p.symbol),
      // X139: Metadata parity with other categories (same pattern as X68, X91, X135)
      no7dData: p.apyBase7d == null,
      sameChain: true, // CLM is always same-chain LP provision
      // X49: Dynamic risk scoring for CLM — was hardcoded in index.js (stable=3, volatile=6)
      // Base: stable=3, correlated=4, volatile=5 (active management + IL risk gradient)
      // +1 TVL < $5M (thin liquidity, hard to enter/exit concentrated positions)
      // +1 spike-adjusted (transient fee spike, may not persist into tight range)
      // +1 non-major token (X127: meme/micro-cap crash risk)
      risk: (function() {
        let r = isStable ? 3 : isCorrelated ? 4 : 5;
        if ((p.tvlUsd || 0) < 5_000_000) r += 1; // low TVL penalty
        if (spikeLabel) r += 1; // spike penalty — fees may not persist
        if (declineLabel) r += 1; // X85: declining fees — projection unreliable
        r += predRiskPenalty; // X113: prediction-based risk
        if (hasNonMajorToken(p.symbol)) r += 1; // X127: meme/micro-cap token risk
        if (emissionHeavy) r += 1; // X173: >50% APY from token emissions — decay risk
        return Math.min(10, r);
      })(),
      // X120: predFactor no longer separate — baked into baseApy → projectedApy → netProjectedApy
      score: netProjectedApy * Math.log10(Math.max(p.tvlUsd, 1000)) * (isStable ? 1.5 : 0.8) / (apyVolatility + 1),
      minCapitalUsd,
    };
  }).filter(p => p.tightRangeProjectedApy > 30 && (p.tvl || 0) >= 1_000_000 && p.tightRangeProjectedApy <= 500)
    .sort((a, b) => b.score - a.score);

  return {
    total: scored.length,
    stable_pairs: scored.filter(p => p.pairType === 'stable').slice(0, 15),
    correlated_pairs: scored.filter(p => p.pairType === 'correlated').slice(0, 15),
    volatile_pairs: scored.filter(p => p.pairType !== 'stable' && p.pairType !== 'correlated').slice(0, 15),
    top: scored.slice(0, 20),
  };
}

// X173: Non-USD fiat stablecoins — detect cross-currency pairs by symbol when ilRisk='no'
const NON_USD_FIAT_RE = /EURC|EURS|EURT|CADC|GYEN|XSGD|BRZ|TRYB|GBPT|NZDS|JPYC|CEUR|CJPY|CREAL|AGEUR|DCHF|SEUR/i;
function isCrossCurrencyStable(pool) {
  if (!pool.stablecoin) return false;
  if (pool.ilRisk === 'yes') return true;
  const sym = (pool.symbol || '').toUpperCase();
  return NON_USD_FIAT_RE.test(sym) && /USD|DAI|FRAX/i.test(sym);
}

function stablePair(p) {
  // X124+X173: Cross-currency stablecoin pairs (EURC-USDC, CADC-USDC) have real FX volatility
  // (~5-8% annual). Treat as correlated (not stable) — 5x max concentration, 85% in-range, 2-3d rebalance.
  if (isCrossCurrencyStable(p)) return false;
  return p.stablecoin || /USD.*USD|DAI.*USD|FRAX.*USD|EUR.*EUR/i.test(p.symbol || '');
}

// ============================================================
// 2. FLASHLOAN ARB — Multi-hop routes with zero capital
// ============================================================
async function scanFlashloanArb() {
  log('[FLASHLOAN] Scanning multi-hop arb routes...');

  // Check Solana routes via Jupiter for circular arbs at scale
  const routes = [];
  const SOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

  // Test multiple amounts for size-dependent arb (larger = more slippage = different optimal route)
  const amounts = [
    { label: '10 SOL', lamports: '10000000000' },
    { label: '100 SOL', lamports: '100000000000' },
    { label: '1000 SOL', lamports: '1000000000000' },
  ];

  for (const amt of amounts) {
    try {
      // SOL -> USDC -> SOL (triangle through stablecoin)
      const q1 = await fetchJSON('https://quote-api.jup.ag/v6/quote?inputMint=' + SOL + '&outputMint=' + USDC + '&amount=' + amt.lamports + '&slippageBps=10');
      if (!q1 || !q1.outAmount) continue;
      const q2 = await fetchJSON('https://quote-api.jup.ag/v6/quote?inputMint=' + USDC + '&outputMint=' + SOL + '&amount=' + q1.outAmount + '&slippageBps=10');
      if (!q2 || !q2.outAmount) continue;

      const inSol = parseInt(amt.lamports);
      const outSol = parseInt(q2.outAmount);
      const profitLamports = outSol - inSol;
      const profitPct = (profitLamports / inSol) * 100;
      const profitSol = profitLamports / 1e9;
      const gasCost = 0.01; // ~0.01 SOL for flash route

      if (profitSol - gasCost > 0) {
        routes.push({
          route: 'SOL -> USDC -> SOL',
          size: amt.label,
          inputSol: inSol / 1e9,
          outputSol: outSol / 1e9,
          grossProfitSol: profitSol.toFixed(6),
          gasCost: gasCost,
          netProfitSol: (profitSol - gasCost).toFixed(6),
          netProfitPct: ((profitSol - gasCost) / (inSol / 1e9) * 100).toFixed(4),
          routeHops1: q1.routePlan?.length || '?',
          routeHops2: q2.routePlan?.length || '?',
          flashloanable: true,
          note: 'Atomic via Jupiter. Flashloan from Solend/MarginFi for zero capital.',
        });
      }
    } catch (e) { /* skip */ }

    // SOL -> USDT -> USDC -> SOL (quad hop)
    try {
      const q1 = await fetchJSON('https://quote-api.jup.ag/v6/quote?inputMint=' + SOL + '&outputMint=' + USDT + '&amount=' + amt.lamports + '&slippageBps=10');
      if (!q1 || !q1.outAmount) continue;
      const q2 = await fetchJSON('https://quote-api.jup.ag/v6/quote?inputMint=' + USDT + '&outputMint=' + USDC + '&amount=' + q1.outAmount + '&slippageBps=10');
      if (!q2 || !q2.outAmount) continue;
      const q3 = await fetchJSON('https://quote-api.jup.ag/v6/quote?inputMint=' + USDC + '&outputMint=' + SOL + '&amount=' + q2.outAmount + '&slippageBps=10');
      if (!q3 || !q3.outAmount) continue;

      const inSol = parseInt(amt.lamports);
      const outSol = parseInt(q3.outAmount);
      const profitSol = (outSol - inSol) / 1e9;
      const gasCost = 0.015;

      if (profitSol - gasCost > 0) {
        routes.push({
          route: 'SOL -> USDT -> USDC -> SOL',
          size: amt.label,
          inputSol: inSol / 1e9,
          outputSol: outSol / 1e9,
          grossProfitSol: profitSol.toFixed(6),
          gasCost,
          netProfitSol: (profitSol - gasCost).toFixed(6),
          netProfitPct: ((profitSol - gasCost) / (inSol / 1e9) * 100).toFixed(4),
          flashloanable: true,
          note: 'Triangle arb through USDT-USDC depeg spread.',
        });
      }
    } catch (e) { /* skip */ }
  }

  // EVM flashloan routes via 1inch/paraswap price comparison
  const evmRoutes = [];
  try {
    // Check ETH-USDC price across aggregators
    const dexPairs = await fetchJSON('https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
    const ethPairs = (dexPairs.pairs || []).filter(p =>
      p.chainId === 'ethereum' && (p.liquidity?.usd || 0) > 500000
    );

    if (ethPairs.length >= 2) {
      const prices = ethPairs.map(p => ({ dex: p.dexId, price: parseFloat(p.priceUsd), liq: p.liquidity.usd }));
      prices.sort((a, b) => a.price - b.price);
      const low = prices[0];
      const high = prices[prices.length - 1];
      const spread = (high.price - low.price) / low.price;

      if (spread > 0.001) {
        const flashAmount = Math.min(low.liq, high.liq) * 0.05; // 5% of lesser pool
        const flashFee = flashAmount * 0.0009; // Aave flashloan fee 0.09%
        const grossProfit = flashAmount * spread;
        const gasEst = 50; // ~$50 gas for complex flash tx on Ethereum
        const netProfit = grossProfit - flashFee - gasEst;

        if (netProfit > 0) {
          evmRoutes.push({
            route: 'ETH: ' + low.dex + ' -> ' + high.dex,
            chain: 'ethereum',
            spread: (spread * 100).toFixed(3) + '%',
            flashAmount: '$' + Math.round(flashAmount),
            flashFee: '$' + flashFee.toFixed(2),
            gasEst: '$' + gasEst,
            grossProfit: '$' + grossProfit.toFixed(2),
            netProfit: '$' + netProfit.toFixed(2),
            flashloanSource: 'Aave v3 (0.09% fee) or Balancer (0% fee)',
            note: 'Single-tx: flashloan ETH from Aave -> buy on ' + low.dex + ' -> sell on ' + high.dex + ' -> repay flash',
          });
        }
      }
    }
  } catch (e) { log('[FLASHLOAN] EVM scan error: ' + e.message); }

  return {
    solana_routes: routes,
    evm_routes: evmRoutes,
    total: routes.length + evmRoutes.length,
  };
}

// ============================================================
// 3. RECURSIVE LEVERAGE — Max LTV loops with flashloan setup
// ============================================================
async function scanRecursiveLeverage() {
  log('[RECURSIVE] Scanning max-leverage loops...');
  const pools = await getCachedPools();
  const borrow = await getCachedBorrow();

  // X67: Fetch reward token decay for emission-adjusted supply APY
  const decayMap = await fetchRewardTokenDecay(pools);

  const borrowById = {};
  for (const b of borrow) borrowById[b.pool] = b;

  const supplyById = {};
  for (const p of pools) if (p.pool) supplyById[p.pool] = p;

  const loops = [];

  for (const [poolId, bd] of Object.entries(borrowById)) {
    const s = supplyById[poolId];
    if (!s) continue;
    if ((s.tvlUsd || 0) < 500000) continue;

    const borrowRate = bd.apyBaseBorrow || 0;
    const borrowReward = bd.apyRewardBorrow || 0;
    const netBorrowCost = borrowRate - borrowReward;
    const ltv = bd.ltv || 0;
    if (ltv < 0.5 || borrowRate <= 0) continue;

    // X67: Emission-adjusted supply APY — use base + reward*decay instead of raw apy.
    // For leveraged positions, emission decay is amplified: if rewards drop, the loop can go negative.
    const baseApy = s.apyBase || 0;
    const rewardApy = s.apyReward || 0;
    const rawSupplyApy = s.apy || 0;
    const tokenDecay = rewardDecayFactor(s, decayMap);
    let effectiveSupplyApy = baseApy + rewardApy * tokenDecay;
    const emissionPct = rawSupplyApy > 0 ? (rewardApy / rawSupplyApy * 100) : 0;
    const emissionHeavy = emissionPct > 50;

    // X67: Spike discount — if current APY >> mean30d and predictions are Down, discount.
    // Same logic as carry.js/shortfarm.js X7/X10 spike tiers.
    const mean30d = s.apyMean30d || 0;
    const isSpike = mean30d > 0 && rawSupplyApy > 2 * mean30d;
    const isOutlier = s.outlier === true;
    const predClass = s.predictions?.predictedClass || '';
    const isDown = /down/i.test(predClass);
    const downPct = s.predictions?.binnedConfidence || 0;
    let spikeDiscount = 1.0;
    if (isOutlier && isDown && downPct >= 80) spikeDiscount = 0.1;
    else if (!isOutlier && isDown && downPct >= 80) spikeDiscount = 0.3;
    else if (isOutlier && isDown) spikeDiscount = 0.4;
    else if (isOutlier && !predClass) spikeDiscount = 0.5;
    else if (isSpike && isDown) spikeDiscount = 0.5;

    // Apply spike discount to effective supply APY
    if (spikeDiscount < 1.0) {
      effectiveSupplyApy = effectiveSupplyApy * spikeDiscount;
    }

    const supplyApy = effectiveSupplyApy;

    // Calculate recursive leverage
    // With LTV of L, max leverage = 1/(1-L)
    // At each loop: deposit X, borrow X*L, deposit X*L, borrow X*L*L...
    // Total exposure = X * 1/(1-L)
    // Net APY = supplyApy * leverage - netBorrowCost * (leverage - 1)
    const maxLev = 1 / (1 - ltv);
    // Use 90% of max LTV for safety margin
    const safeLtv = ltv * 0.9;
    const safeLev = 1 / (1 - safeLtv);

    const netApyMaxLev = supplyApy * maxLev - netBorrowCost * (maxLev - 1);
    const netApySafeLev = supplyApy * safeLev - netBorrowCost * (safeLev - 1);

    if (netApySafeLev < 10) continue; // minimum 10% to be interesting

    // X87: chain must be declared before first use (was causing TDZ ReferenceError, silently
    // caught by try/catch, producing 0 recursive results — entire category invisible in report).
    const chain = (s.chain || '').toLowerCase();
    const isLowGas = ['solana', 'base', 'arbitrum', 'bsc', 'polygon', 'avalanche', 'optimism'].includes(chain);

    // Flashloan setup: instead of manual looping, use flashloan to reach target leverage in 1 tx
    // Flashloan X*(leverage-1), deposit all, borrow X*(leverage-1), repay flash
    // X85: Not all chains have flashloan infrastructure. Chains without flashloans require
    // manual loop (deposit→borrow→deposit→borrow... 5-10 txs), higher gas, partial execution risk.
    const FLASH_LOAN_CHAINS = new Set(['ethereum', 'arbitrum', 'base', 'optimism', 'avalanche', 'polygon', 'bsc', 'solana', 'gnosis', 'fantom', 'linea', 'zksync', 'scroll', 'mantle', 'blast', 'manta']);
    const hasFlashLoan = FLASH_LOAN_CHAINS.has(chain);
    const flashMultiplier = safeLev - 1;
    const flashFee = s.chain === 'Solana' ? 0 : hasFlashLoan ? 0.09 : 0; // Aave 0.09%, Solana free, no-flash N/A
    const flashCostAnnualized = flashFee * 0.01; // one-time cost, negligible annualized

    // Liquidation distance: how much collateral price can drop before liquidation
    // At safeLev, effective utilization = safeLtv. Liq triggers when price drops by (1 - safeLtv/ltv).
    // With safeLtv = ltv * 0.9, this gives a 10% buffer regardless of LTV.
    const liqDistance = ((1 - (safeLtv / ltv)) * 100);

    // X80: Minimum capital from gas costs.
    // Flash loan chains: 2 txs (setup + unwind). Non-flash: ~8 manual loop txs (setup) + ~8 unwind.
    const perTxGas = chain === 'solana' ? 0.01 : chain === 'base' ? 0.10 : chain === 'arbitrum' ? 0.30 : chain === 'optimism' ? 0.20 : chain === 'polygon' ? 0.10 : chain === 'avalanche' ? 0.50 : chain === 'bsc' ? 0.20 : chain === 'stellar' ? 0.01 : chain === 'sui' ? 0.02 : chain === 'aptos' ? 0.02 : chain === 'flow' ? 0.01 : chain === 'hyperliquid l1' ? 0.05 : chain === 'megaeth' ? 0.05 : chain === 'monad' ? 0.05 : 15; // Ethereum mainnet
    // X85: Flash loan = 1 complex multicall tx. Manual loop = ~8 simple txs per direction (deposit+borrow per loop iteration).
    const setupTxCount = hasFlashLoan ? 1 : Math.ceil(safeLev); // manual loops = ~leverage iterations
    const flashGasUsd = hasFlashLoan ? (perTxGas * 5) : (perTxGas * setupTxCount * 2); // flash tx is ~5x simple tx
    const roundTripGas = flashGasUsd * 2; // setup + unwind
    // X229: Min capital: gas < 15% of 1-year net APY returns (parity with CLM X193)
    // At 50% threshold, displayed APY was overstated by up to 50% at minCapital.
    // At 15%: max overstatement = 15/85 = 17.6%, within ±20% mandate.
    const minCapitalUsd = netApySafeLev > 0 ? Math.ceil(roundTripGas / (netApySafeLev / 100 * 0.15)) : 99999;

    // X68: Base-only loop APY — what happens if emissions stop?
    // baseOnlyNet = baseApy * leverage - netBorrowCost * (leverage - 1)
    // If negative, the loop is entirely dependent on reward emissions continuing.
    const baseOnlyNetApy = baseApy * safeLev - netBorrowCost * (safeLev - 1);
    const baseSpreadNegative = baseOnlyNetApy < 0;

    // X39: Leverage-based risk penalty (same as G5 shortfarm.js)
    // Higher leverage = higher liquidation risk, especially for volatile collateral
    let risk = s.stablecoin ? 4 : 6;
    const leverageRiskPenalty = safeLev > 8 ? 3 : safeLev > 5 ? 2 : safeLev > 3 ? 1 : 0;
    risk = Math.min(10, risk + leverageRiskPenalty);
    // X185: Removed always-true liqDistance < 15 check. liqDistance = (1 - safeLtv/ltv)*100
    // is always 10% because safeLtv = ltv * 0.9. The condition was a tautology adding +1
    // risk to ALL entries unconditionally. Leverage-based penalty (line 537) already scales risk.
    // X67: Emission-heavy loops add +1 risk (rewards can stop, turning loop negative)
    if (emissionHeavy) risk = Math.min(10, risk + 1);
    // X68: Base spread negative + emission heavy = loop goes negative if rewards stop. +1 risk.
    if (baseSpreadNegative && emissionHeavy) risk = Math.min(10, risk + 1);
    // X67: Spike-discounted loops add +1 risk
    if (spikeDiscount < 1.0) risk = Math.min(10, risk + 1);
    // X85: No flashloan = manual loop, harder execution, +1 risk
    if (!hasFlashLoan) risk = Math.min(10, risk + 1);
    // X181: Non-major token recursive loop risk. Meme/micro-cap collateral can crash 50%+,
    // triggering liquidation at leveraged exposure. Parity with CLM (X127), CARRY (X178).
    const isNonMajorRecursive = hasNonMajorToken(s.symbol);
    if (isNonMajorRecursive) risk = Math.min(10, risk + 1);

    // X68: Score discount for emission-heavy leveraged loops.
    // emissionPct > 80%: 0.5x (almost entirely emission bet at leverage)
    // emissionPct > 50% + baseSpreadNegative: 0.6x (loop unprofitable without rewards)
    // emissionPct > 50%: 0.8x (material emission dependency)
    const emissionScoreDiscount = emissionPct > 80 ? 0.5
      : (emissionHeavy && baseSpreadNegative) ? 0.6
      : emissionHeavy ? 0.8 : 1.0;

    // X67: Strategy label warnings
    const labels = [];
    if (emissionHeavy) labels.push('[' + emissionPct.toFixed(0) + '% EMISSIONS]');
    if (baseSpreadNegative) labels.push('[BASE SPREAD NEG]');
    if (spikeDiscount < 1.0) labels.push('[SPIKE ADJ]');
    if (!hasFlashLoan) labels.push('[NO FLASHLOAN]');
    if (isNonMajorRecursive) labels.push('[NON-MAJOR TOKEN]');
    const labelStr = labels.length > 0 ? ' ' + labels.join(' ') : '';

    loops.push({
      project: s.project,
      chain: s.chain,
      token: s.symbol,
      supplyApy: parseFloat(supplyApy.toFixed(2)),
      supplyApyRaw: parseFloat(rawSupplyApy.toFixed(2)),
      borrowRate: parseFloat(borrowRate.toFixed(2)),
      borrowReward: parseFloat(borrowReward.toFixed(2)),
      netBorrowCost: parseFloat(netBorrowCost.toFixed(2)),
      ltv: parseFloat((ltv * 100).toFixed(0)),
      maxLeverage: parseFloat(maxLev.toFixed(1)),
      safeLeverage: parseFloat(safeLev.toFixed(1)),
      netApyAtMaxLev: parseFloat(netApyMaxLev.toFixed(2)),
      netApyAtSafeLev: parseFloat(netApySafeLev.toFixed(2)),
      liqDistancePct: parseFloat(liqDistance.toFixed(1)),
      hasFlashLoan,
      flashSetup: hasFlashLoan
        ? 'Flashloan ' + flashMultiplier.toFixed(1) + 'x collateral -> deposit -> borrow -> repay'
        : 'Manual loop: deposit -> borrow -> deposit -> borrow (~' + setupTxCount + ' iterations)',
      flashFee: flashFee + '%',
      tvl: s.tvlUsd,
      totalBorrow: bd.totalBorrowUsd || 0,
      stablecoin: s.stablecoin || false,
      lowGasChain: isLowGas,
      emissionPct: parseFloat(emissionPct.toFixed(0)),
      emissionHeavy,
      baseSpreadNegative,
      baseOnlyNetApy: parseFloat(baseOnlyNetApy.toFixed(2)),
      spikeDiscount,
      emissionScoreDiscount,
      risk,
      leverageRiskPenalty,
      minCapitalUsd,
      // X135: Metadata fields for report warnings (parity with CARRY/SHORT_FARM/YIELD)
      lowTvl: s.tvlUsd < 1000000,
      no7dData: s.apyBase7d == null,
      sameChain: true, // RECURSIVE is always same-protocol same-chain
      nonMajorToken: isNonMajorRecursive,
      strategy: (netBorrowCost <= 0 ? 'FREE BORROW ' : '') + 'Recursive loop ' + s.symbol + ' on ' + s.project + '(' + s.chain + '): ' + safeLev.toFixed(1) + 'x leverage ' + (hasFlashLoan ? 'via flashloan' : 'via manual loop') + ' = ' + netApySafeLev.toFixed(1) + '% net APY (max ' + maxLev.toFixed(1) + 'x)' + labelStr,
      score: netApySafeLev * Math.log10(Math.max(s.tvlUsd, 1000)) * (s.stablecoin ? 1.5 : 0.8) * (isLowGas ? 1.2 : 1) * (netBorrowCost <= 0 ? 2 : 1) * emissionScoreDiscount / Math.max(1, safeLev * 2) / Math.max(1, risk / 4),
    });
  }

  loops.sort((a, b) => b.score - a.score);

  // X63: Dedup by token|project|chain — same recursive trade concept, keep highest score.
  // JLP on jupiter-lend had 5 entries (different lending pools, same trade), PYUSD on euler-v2 had 2.
  const seenRecursive = new Set();
  const deduped = [];
  for (const l of loops) {
    const key = (l.token + '|' + l.project + '|' + l.chain).toLowerCase();
    if (seenRecursive.has(key)) continue;
    seenRecursive.add(key);
    deduped.push(l);
  }

  return {
    total: deduped.length,
    top: deduped.slice(0, 20),
    stable_loops: loops.filter(l => l.stablecoin).slice(0, 15),
    volatile_loops: loops.filter(l => !l.stablecoin).slice(0, 15),
    free_borrow_loops: loops.filter(l => l.netBorrowCost <= 0).slice(0, 10),
  };
}

// ============================================================
// 4. FUNDING RATE FARMING — Delta-neutral perp strategies
// ============================================================

// Fetch the funding interval Hyperliquid currently uses. Verified 2026-05-01 via
// /info predictedFundings ("HlPerp" → fundingIntervalHours: 1) and corroborated
// against /info fundingHistory which returns 24 records per 24h. Earlier code
// assumed 8h periods (× 3 × 365 = × 1095) which understated annualized funding
// by 8×; the correct multiplier per the predictedFundings response is
// (24 / fundingIntervalHours) × 365. Sourcing the value live keeps us robust
// to a future change in funding cadence.
async function fetchHlFundingIntervalHours() {
  const resp = await fetchJSON("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "predictedFundings" }),
    timeout: 10000,
  });
  if (!Array.isArray(resp)) throw new Error("predictedFundings: unexpected shape");
  for (const [, venues] of resp) {
    if (!Array.isArray(venues)) continue;
    for (const [venue, info] of venues) {
      if (venue === "HlPerp" && info && Number.isFinite(info.fundingIntervalHours)) {
        return info.fundingIntervalHours;
      }
    }
  }
  throw new Error("predictedFundings: HlPerp interval not found");
}

async function scanFundingRates() {
  log("[FUNDING] Scanning perp funding rates...");
  const results = [];

  // Hyperliquid funding rates via POST
  try {
    const [hlData, hlIntervalHours] = await Promise.all([
      fetchJSON("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        timeout: 15000,
      }),
      fetchHlFundingIntervalHours(),
    ]);
    const hlPeriodsPerYear = (24 / hlIntervalHours) * 365;
    log("[FUNDING] Hyperliquid funding interval: " + hlIntervalHours + "h (" + hlPeriodsPerYear.toFixed(0) + " periods/year)");
    // Response: [meta, assetCtxs]
    if (Array.isArray(hlData) && hlData.length >= 2) {
      const meta = hlData[0];
      const ctxs = hlData[1];
      for (let i = 0; i < ctxs.length; i++) {
        const c = ctxs[i];
        const name = (meta.universe && meta.universe[i]) ? meta.universe[i].name : "?";
        const fundingPerPeriod = parseFloat(c.funding || 0);
        if (Math.abs(fundingPerPeriod) < 0.000001) continue;
        // X-fix 2026-05: skip the Hyperliquid zero-premium INTEREST FLOOR. HL funding = premium +
        // a fixed interest component (0.01% per 8h). When the premium ≈ 0, funding pins at that
        // interest floor (0.0000125 * intervalHours per period ≈ 10.95% annualized at 1h) for
        // EVERY major simultaneously — it is the structural baseline everyone earns, not a real,
        // capturable funding edge. Drop SHORT_PERP entries sitting within 8% of the floor (keeps
        // genuine positive-premium spreads and all negative/LONG_PERP rates).
        const hlInterestFloor = 0.0000125 * hlIntervalHours;
        // 4% band: tight enough to catch the exact-floor cluster (all pinned at the floor value)
        // without dropping a genuine small-positive-premium edge sitting just above it.
        if (fundingPerPeriod > 0 && Math.abs(fundingPerPeriod - hlInterestFloor) < hlInterestFloor * 0.04) continue;
        const annualized = fundingPerPeriod * hlPeriodsPerYear * 100;
        const oi = parseFloat(c.openInterest || 0);
        const markPx = parseFloat(c.markPx || 0);
        const oiUsd = oi * markPx;
        if (Math.abs(annualized) > 5 && oiUsd > 100000) {
          // Sustainability discount: extreme rates mean-revert, low OI = illiquid/volatile
          const absAnn = Math.abs(annualized);
          const rateFactor = absAnn > 100 ? 0.4 : absAnn > 50 ? 0.6 : absAnn > 30 ? 0.8 : 1.0;
          const oiFactor = Math.min(1, Math.log10(Math.max(oiUsd, 1000)) / 7.5); // $10M+ OI = ~0.93, $1M = ~0.8, $100k = ~0.67
          const sustainFactor = rateFactor * oiFactor;
          // Dynamic risk: base 3 (delta-neutral requires active management: monitoring funding
          // rates, managing margin, perp DEX counterparty risk — NOT comparable to passive YIELD
          // risk 1-2 or SPREAD risk 2), +1 for low OI, +1 for extreme rate
          let fundRisk = 3 + (oiUsd < 5e6 ? 1 : 0) + (absAnn > 50 ? 1 : 0);
          const sustainableApy = parseFloat((Math.abs(annualized) * sustainFactor).toFixed(1));
          const rawApy = Math.abs(annualized).toFixed(0);
          const sustainNote = sustainFactor < 0.9 ? ' (' + rawApy + '% raw, sustainability-adj)' : '';

          // X46: LONG_PERP requires borrowing spot to sell short — subtract estimated borrow cost
          const isLongPerp = annualized < 0;
          // X92/X127: use module-scope MAJOR_TOKENS (expanded to 45+ tokens + wrapped variants)
          const isMajor = MAJOR_TOKENS.has(name);
          // X251: use FUNDING_BORROW_MAJORS for borrow cost — meme tokens (WIF, PEPE, SHIB etc.)
          // are in MAJOR_TOKENS for CLM but have no deep lending markets (actual borrow 15-30%+)
          const isBorrowable = FUNDING_BORROW_MAJORS.has(name);
          // X57: non-borrowable tokens have no reliable borrow market — 15% est cost, +2 risk
          const estBorrowCost = isLongPerp ? (isBorrowable ? 3 : 15) : 0;
          const netApy = sustainableApy - estBorrowCost;
          // X136: LONG_PERP non-borrowable with OI < $2M — no lending market exists, un-executable
          // Funding rate is likely a single trader's temporary imbalance that flips quickly
          if (isLongPerp && !isBorrowable && oiUsd < 2e6) continue;
          // X159: SHORT_PERP non-major with OI < $1M — too thin for delta-neutral strategy.
          // At $464K OI, a $5000 user position = 1.1% of market → moves funding rate.
          // Rate driven by 1-2 traders; when they close, rate reverses immediately.
          if (!isLongPerp && !isMajor && oiUsd < 1e6) continue;
          if (isLongPerp) fundRisk += isBorrowable ? 1 : 3; // +1 borrowable (lending market exists), +3 non-borrowable (borrow unlikely)
          // X60: SHORT_PERP on non-major tokens has spot liquidity/slippage risk
          if (!isLongPerp && !isMajor) fundRisk += 1;
          // X187/X194: Extreme raw rate on non-major tokens — near-certain rate reversal risk.
          // 50%+ funding on a meme token means speculative frenzy that burns out fast (days, not weeks).
          // At 72% raw ZEREBRO ranked above safe SPREAD (X193). Threshold 80→50.
          if (!isMajor && absAnn >= 50) fundRisk += 1;
          if (isLongPerp && netApy < 5) continue; // not worth the complexity after borrow cost

          const displayApy = isLongPerp ? parseFloat(netApy.toFixed(1)) : sustainableApy;
          const borrowNote = isLongPerp ? ' (est. ' + estBorrowCost + '% borrow cost deducted)' : '';
          const borrowHardLabel = (isLongPerp && !isBorrowable) ? ' [BORROW HARD]' : '';
          const spotLiqLabel = (!isLongPerp && !isMajor) ? ' [SPOT THIN]' : '';
          results.push({
            exchange: "Hyperliquid",
            symbol: name,
            fundingIntervalHours: hlIntervalHours,
            fundingPerPeriodPct: (fundingPerPeriod * 100).toFixed(6) + "%",
            annualizedPct: parseFloat(annualized.toFixed(2)),
            sustainableApy: displayApy,
            rawSustainableApy: sustainableApy,
            estBorrowCost,
            oiUsd: Math.round(oiUsd),
            markPrice: markPx,
            direction: annualized > 0 ? "SHORT_PERP (longs pay shorts)" : "LONG_PERP (shorts pay longs)",
            strategy: annualized > 0
              ? "Buy spot " + name + " + short perp on Hyperliquid = collect " + displayApy + "% APY" + sustainNote + " (OI: $" + (oiUsd/1e6).toFixed(1) + "M)" + spotLiqLabel
              : "Short spot (borrow+sell) " + name + " + long perp on Hyperliquid = collect " + displayApy + "% net APY" + borrowNote + sustainNote + borrowHardLabel,
            deltaNeutral: true,
            sustainFactor: parseFloat(sustainFactor.toFixed(3)),
            risk: fundRisk,
            // X57: non-major LONG_PERP gets 0.4x score. X60: non-major SHORT_PERP gets 0.85x (spot liquidity risk)
            score: Math.abs(annualized) * Math.log10(Math.max(oiUsd, 1000)) * sustainFactor * (isLongPerp ? (isBorrowable ? 0.7 : 0.4) : (!isMajor ? 0.85 : 1)),
          });
        }
      }
    }
    log("[FUNDING] Hyperliquid: " + results.filter(r => r.exchange === "Hyperliquid").length + " markets with significant funding");
  } catch (e) { log("[FUNDING] Hyperliquid error: " + e.message); }

  // Drift leg REMOVED 2026-06-11 (P308): the protocol's funding-rate crank froze on-chain at
  // 2026-04-01T18:31:47Z across all markets (PerpMarket PDA timestamps identical); every public
  // API serves that frozen snapshot or 4xx. FUNDING is Hyperliquid-only until Drift revives.

  results.sort((a, b) => (b.score || 0) - (a.score || 0));

  return {
    total: results.length,
    top: results.slice(0, 30),
    hyperliquid: results.filter(r => r.exchange === "Hyperliquid").slice(0, 15),
    driftStatus: "REMOVED",
    note: "Delta-neutral: hold spot + opposite perp position. Collect funding with zero directional risk."
      + " [Drift leg removed 2026-06-11 — protocol funding crank frozen on-chain since 2026-04-01; Hyperliquid only]",
  };
}

// ============================================================
// 5. LIQUIDATION PROXIMITY — Positions near liquidation threshold
// ============================================================
async function scanLiquidationProximity() {
  log('[LIQUIDATION] Scanning positions near liquidation...');
  // DeFi Llama doesn't provide individual position data
  // Instead, look at pools with high utilization (borrow/supply ratio) = more positions near liq
  const pools = await getCachedPools();
  const borrow = await getCachedBorrow();

  const borrowById = {};
  for (const b of borrow) borrowById[b.pool] = b;

  const supplyById = {};
  for (const p of pools) if (p.pool) supplyById[p.pool] = p;

  const hotMarkets = [];

  for (const [poolId, bd] of Object.entries(borrowById)) {
    const s = supplyById[poolId];
    if (!s) continue;

    const totalSupply = bd.totalSupplyUsd || 0;
    const totalBorrow = bd.totalBorrowUsd || 0;
    if (totalSupply < 1000000 || totalBorrow < 500000) continue;

    const utilization = totalBorrow / totalSupply;
    if (utilization < 0.7) continue; // only high-utilization markets

    const ltv = bd.ltv || 0;
    const liquidationBonus = ltv > 0.8 ? 5 : ltv > 0.7 ? 7.5 : 10; // typical bonus %
    const borrowRate = bd.apyBaseBorrow || 0;

    hotMarkets.push({
      project: s.project,
      chain: s.chain,
      token: s.symbol,
      totalSupply,
      totalBorrow,
      utilization: parseFloat((utilization * 100).toFixed(1)),
      ltv: parseFloat((ltv * 100).toFixed(0)),
      borrowRate: parseFloat(borrowRate.toFixed(2)),
      estLiquidationBonus: liquidationBonus + '%',
      potentialLiqVolume: parseFloat((totalBorrow * 0.05).toFixed(0)), // est 5% of borrows near liq
      strategy: 'Monitor ' + s.project + '(' + s.chain + ') ' + s.symbol + ' — ' + (utilization * 100).toFixed(0) + '% utilized, $' + (totalBorrow / 1e6).toFixed(1) + 'M borrowed. Liquidation bonus: ' + liquidationBonus + '%. Bot needed for execution.',
      score: utilization * totalBorrow * liquidationBonus / 1000,
    });
  }

  hotMarkets.sort((a, b) => b.score - a.score);

  return {
    total: hotMarkets.length,
    top: hotMarkets.slice(0, 20),
    note: 'High-utilization markets = more positions near liquidation. Need on-chain bot for actual liquidation execution.',
  };
}

// ============================================================
// HELPERS
// ============================================================
async function getCachedPools() {
  const key = 'aggro_pools';
  let data = cached(key, 300);
  if (!data) {
    const resp = await fetchJSON('https://yields.llama.fi/pools');
    data = resp.data || resp;
    setCache(key, data);
  }
  return data;
}

async function getCachedBorrow() {
  const key = 'aggro_borrow';
  let data = cached(key, 300);
  if (!data) {
    data = await fetchJSON('https://yields.llama.fi/lendBorrow');
    setCache(key, data);
  }
  return data;
}

// ============================================================
// MAIN EXPORT
// ============================================================
export async function scanAggressive() {
  log('=== AGGRESSIVE STRATEGIES SCAN ===');

  const results = {};

  try { results.clm = await scanCLM(); log('[CLM] Found ' + results.clm.total + ' CLM opportunities'); }
  catch (e) { log('[CLM] Error: ' + e.message); results.clm = { total: 0, top: [] }; }

  // DROPPED (consolidation 2026-05): scanFlashloanArb was orphaned — neither index.js nor the
  // dashboard ever read aggro.flashloan, and flasharb.js already computes flashloan arb (with a
  // proper same-DEX guard aggro's inline copy lacked). Removing reclaims Jupiter+DexScreener calls.

  try { results.recursive = await scanRecursiveLeverage(); log('[RECURSIVE] Found ' + results.recursive.total + ' loops'); }
  catch (e) { log('[RECURSIVE] Error: ' + e.message); results.recursive = { total: 0, top: [] }; }

  try { results.funding = await scanFundingRates(); log('[FUNDING] Found ' + results.funding.total + ' funding opps'); }
  catch (e) { log('[FUNDING] Error: ' + e.message); results.funding = { total: 0, top: [] }; }

  // DROPPED (consolidation 2026-05): scanLiquidationProximity duplicated liquidator.js. The report
  // uses liquidation.json (liquidator.js) and the dashboard now reads liquidation.json too, so the
  // aggro liquidation copy (no protocol whitelist, cruder scoring) had no consumer.

  return { timestamp: new Date().toISOString(), ...results };
}
