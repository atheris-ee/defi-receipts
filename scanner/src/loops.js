// Leverage loop and lending spread scanner
// Fixed: separates LP yield from lending yield, filters low-liq chains, uses real borrow rates
import { fetchJSON, cached, setCache, loadConfig, log, riskScore } from './utils.js';
import { crossChainCost, sameChainMinCapital } from './carry.js';

const LOW_LIQ_CHAINS = new Set(['flare', 'celo', 'harmony', 'aurora', 'moonbeam', 'moonriver', 'fuse', 'boba', 'velas', 'telos', 'kava']);

// X79: Chains with non-standard bridge infrastructure — no direct EVM bridge,
// may require CEX intermediary or specialized bridges (Wormhole, LayerSwap).
// Cross-chain spreads involving these chains deserve higher risk.
const HARD_BRIDGE_CHAINS = new Set(['tron', 'stellar', 'starknet', 'ton', 'near', 'cosmos', 'osmosis', 'injective']);

// X140: Non-EVM chains with decent but non-native bridge infrastructure (Wormhole, deBridge, LayerZero).
// Bridging EVM↔non-EVM is harder than EVM↔EVM (different address formats, key types, past exploits
// like Wormhole $320M). Not as hard as HARD_BRIDGE_CHAINS (which may need CEX intermediary), but
// deserves +1 risk for the added bridge complexity and counterparty risk.
const NON_EVM_CHAINS = new Set(['solana', 'sui', 'aptos', 'bitcoin', 'sei']);

// Projects that are LP/AMM (NOT lending) — must not mix with lending spreads
const LP_PROJECTS = new Set([
  'kamino-liquidity', 'uniswap-v3', 'uniswap-v2', 'aerodrome', 'aerodrome-slipstream',
  'velodrome-v2', 'curve-dex', 'raydium', 'orca', 'meteora', 'pancakeswap-amm-v3',
  'balancer-v2', 'trader-joe', 'sparkdex-v3.1', 'camelot-v3', 'sushiswap',
  'blackhole-clmm', 'thena-v3', 'quickswap-v3',
]);

// Projects that are pure lending
const LENDING_PROJECTS = new Set([
  'aave-v3', 'aave-v2', 'compound-v3', 'compound-v2', 'morpho-v1', 'morpho-blue',
  'spark-savings', 'sparklend', 'kamino-lend', 'drift', 'marginfi', 'solend',
  'benqi-lending', 'venus-core-pool', 'venus-flux', 'radiant-v2',
]);

function isLending(project) {
  const p = (project || '').toLowerCase();
  if (LENDING_PROJECTS.has(p)) return true;
  if (LP_PROJECTS.has(p)) return false;
  // Heuristic: if name contains 'lend', 'borrow', 'savings', it's lending
  return /lend|borrow|savings|money.?market/i.test(p);
}

function isLP(project) {
  const p = (project || '').toLowerCase();
  return LP_PROJECTS.has(p) || /amm|swap|dex|liquidity|clmm|pool/i.test(p);
}

async function getAllPools() {
  const key = 'all_pools_loops';
  let data = cached(key, 300);
  if (!data) {
    const resp = await fetchJSON('https://yields.llama.fi/pools');
    data = (resp.data || resp).filter(p => (p.tvlUsd || 0) > 100000);
    setCache(key, data);
  }
  return data;
}

// X24: Tokens known to be bridgeable across chains. Cross-chain spreads for vault tokens
// (STEAKETH, GTWETH, BBQAUSD, etc.) are impossible — user can't bridge them.
const BRIDGEABLE_TOKENS = new Set([
  'ETH', 'BTC', 'USDC', 'USDT', 'DAI', 'USDE', 'SOL', 'PYUSD', 'EURC',
  'FRAX', 'LUSD', 'GHO', 'CRVUSD', 'TUSD', 'BUSD', 'USDCE', 'USDBC',
  'BNB', 'AVAX', 'MATIC', 'ARB', 'OP', 'FTM', 'LINK', 'UNI', 'AAVE',
  'CRV', 'MKR', 'COMP', 'SNX', 'SUSHI', 'BAL', 'LDO', 'RPL',
  'STETH', 'CBETH', 'RETH', 'SETH2', 'OSETH', 'EETH',
  'CBBTC', 'TBTC', 'BTC.B', 'BTCB',
  'USD₮0', 'USDT0', 'USD1', 'USDG', 'FDUSD',
  'JUP', 'RAY', 'BONK', 'DEEP', 'SUI', 'APT',
]);

// X35: Conservative APY for spread calculation — cap spiking lending rates at 2x their
// 30d mean when DefiLlama predicts Down with ≥70% confidence. Lending rate spikes
// (high utilization events) revert within days; the spread is transient.
function conservativeApy(pool) {
  const raw = pool.apyBase || 0;
  const mean30d = pool.apyMean30d;
  if (!mean30d || mean30d <= 0) return raw;
  const ratio = raw / mean30d;
  const pred = pool.predictions || {};
  const isDown = pred.predictedClass === 'Down' && (pred.predictedProbability || 0) >= 70;
  // Only cap when current is >2x mean AND predicted to revert
  if (ratio > 2 && isDown) {
    return Math.min(raw, mean30d * 2);
  }
  return raw;
}

function findLendingSpread(pools) {
  // ONLY compare lending-to-lending, never LP-to-lending
  const lendingPools = pools.filter(p => isLending(p.project));

  const byToken = {};
  for (const p of lendingPools) {
    const sym = (p.symbol || '').split('-')[0].replace(/^W/, '').toUpperCase();
    if (!sym || sym.length > 12) continue;
    if (!byToken[sym]) byToken[sym] = [];
    byToken[sym].push(p);
  }

  const spreads = [];
  for (const [token, tokenPools] of Object.entries(byToken)) {
    if (tokenPools.length < 2) continue;

    const supplyPools = tokenPools.filter(p => !p.pool.includes('borrow') && (p.apyBase || 0) > 0);
    if (supplyPools.length < 2) continue;

    // X35: sort by conservative APY (spike-adjusted) for ranking
    supplyPools.sort((a, b) => conservativeApy(b) - conservativeApy(a));
    const best = supplyPools[0];
    const worst = supplyPools[supplyPools.length - 1];
    const bestApy = conservativeApy(best);
    const worstApy = worst.apyBase || 0;
    const spread = bestApy - worstApy;

    if (spread < 1.0) continue;

    // PATCH: skip when best/worst are on the SAME project+chain. Different vaults of the
    // same protocol don't constitute a real "move" opportunity — usually a vault-specific
    // APY spike artifact (e.g., morpho-v1 CSYUSDC vault at 297K% vs 5% on same protocol).
    if (best.project === worst.project && (best.chain || '').toLowerCase() === (worst.chain || '').toLowerCase()) continue;

    // PATCH: skip when the best-side APY > 10x the worst-side AND TVL < $5M — instant-rate
    // extrapolation on an illiquid vault. Not a strategic spread.
    if ((best.apyBase || 0) > 10 * (worst.apyBase || 0) && (best.tvlUsd || 0) < 5_000_000) continue;

    const bestChain = (best.chain || '').toLowerCase();
    const worstChain = (worst.chain || '').toLowerCase();
    const sameChain = bestChain === worstChain;
    const lowLiqInvolved = LOW_LIQ_CHAINS.has(bestChain) || LOW_LIQ_CHAINS.has(worstChain);
    // X79: flag cross-chain spreads involving non-standard bridge chains
    const hardBridge = !sameChain && (HARD_BRIDGE_CHAINS.has(bestChain) || HARD_BRIDGE_CHAINS.has(worstChain));
    // X140: flag cross-chain spreads crossing EVM↔non-EVM boundary (Wormhole/deBridge needed)
    const nonEvmBridge = !sameChain && !hardBridge && (NON_EVM_CHAINS.has(bestChain) || NON_EVM_CHAINS.has(worstChain));

    // Skip if low-liq chain is the "high yield" side — likely unsustainable
    if (LOW_LIQ_CHAINS.has(bestChain)) continue;

    // X24: Cross-chain spreads only for bridgeable tokens. Vault tokens (STEAKETH,
    // GTWETH, BBQAUSD, KPK, etc.) can't be moved between chains.
    if (!sameChain && !BRIDGEABLE_TOKENS.has(token)) continue;

    // X20: chain-specific bridge costs (replaces flat 0.3%)
    let bridgeCost = 0;
    let minEconomicalUsd = 0;
    if (!sameChain) {
      const cc = crossChainCost(worstChain, bestChain);
      bridgeCost = cc.bridgeCostPercent;
      minEconomicalUsd = cc.minEconomicalUsd;
    }
    // X133: same-chain gas minimum capital (2 txs: withdraw + deposit)
    if (sameChain) {
      minEconomicalUsd = sameChainMinCapital(bestChain, spread, 2);
    }

    const netSpread = spread - bridgeCost;
    if (netSpread < 0.5) continue;

    // X35: detect if high-yield side was spike-capped
    const rawBestApy = best.apyBase || 0;
    // X170: Only flag as spike-capped when the difference is meaningful (>5% relative).
    // conservativeApy() may clip by tiny amounts (7.0%→6.95%) due to prediction rounding,
    // creating false [RATE SPIKE] labels that mislead users.
    const spikeCapped = rawBestApy > bestApy * 1.05;
    const spikeLabel = spikeCapped ? ` [RATE SPIKE: ${rawBestApy.toFixed(1)}% current, using ${bestApy.toFixed(1)}% conservative]` : '';

    // X174: Destination rate elevation detection — parity with carry.js/shortfarm.js declining tiers.
    // SPREAD entries had no stability check: a dest rate that spiked from 3% to 8% showed +5% spread
    // with no warning, but the rate may revert within days. CARRY/SHORT_FARM have decayRatio7d tiers
    // (X116-X118) — SPREAD should too. Check if best-side rate is elevated above mean30d.
    const bestMean30d = best.apyMean30d || 0;
    const bestApyBase7d = best.apyBase7d;
    // Use 7d avg if available, else fall back to mean30d
    const bestHistorical = bestApyBase7d != null && bestApyBase7d > 0 ? bestApyBase7d : bestMean30d;
    let rateElevated = false;
    let rateElevatedRatio = 1.0;
    let conservativeSpreadApy = bestApy;
    if (bestHistorical > 0 && bestApy > 0) {
      rateElevatedRatio = bestApy / bestHistorical;
      // >1.3x above historical = rate is elevated, spread may narrow
      if (rateElevatedRatio >= 1.3) {
        rateElevated = true;
        // Use conservative APY: historical * 1.1 (small premium for current conditions)
        conservativeSpreadApy = Math.min(bestApy, bestHistorical * 1.1);
      }
    }
    // X198: Compute conservative net spread for BOTH elevated and declining destinations.
    // Declining: dest rate may continue dropping — use destApy * decliningFactor as conservative estimate.
    // Same score-display alignment pattern as X118 (CARRY decaying).
    let conservativeNetSpread = netSpread;
    if (rateElevated) {
      conservativeNetSpread = Math.max(conservativeSpreadApy - worstApy - bridgeCost, 0);
    }
    // X226: Removed inline [DEST RATE ELEVATED] label — metadata covers this (same dedup pattern as X225/X218/X216)

    // X196/X197: Destination rate declining detection — symmetric to rateElevated.
    // Parity with carry.js/shortfarm.js declining tiers (X117): threshold 1.3, tiered factors.
    // When dest rate has dropped from historical, spread may continue shrinking.
    // AL scallop-lend: mean30d 21% → current 12% (ratio 1.74) → 0.85x factor.
    let rateDeclining = false;
    let rateDecliningRatio = 1.0;
    let decliningFactor = 1.0;
    if (!rateElevated && bestHistorical > 0 && bestApy > 0) {
      rateDecliningRatio = bestHistorical / bestApy; // >1 means rate dropped
      if (rateDecliningRatio >= 1.3) {
        rateDeclining = true;
        // Tiered factors matching carry.js/shortfarm.js declining stability tiers
        if (rateDecliningRatio >= 2.0) decliningFactor = 0.7;
        else if (rateDecliningRatio >= 1.5) decliningFactor = 0.85;
        else decliningFactor = 0.9; // 1.3-1.5 mild decline
      }
    }
    // X198: Conservative spread for declining — dest rate may continue dropping
    if (rateDeclining) {
      const conservativeDecliningApy = bestApy * decliningFactor;
      conservativeNetSpread = Math.max(conservativeDecliningApy - worstApy - bridgeCost, 0);
    }
    // X226: Removed inline [DEST RATE DECLINING] label — metadata covers this (same dedup pattern as X225/X218/X216)

    spreads.push({
      type: 'lending_spread',
      token,
      highYieldProtocol: best.project,
      highYieldChain: best.chain,
      highYieldApy: bestApy,
      highYieldApyRaw: rawBestApy,
      highYieldTvl: best.tvlUsd,
      highYieldMean30d: bestMean30d,
      highYieldApy7d: bestApyBase7d,
      lowYieldProtocol: worst.project,
      lowYieldChain: worst.chain,
      lowYieldApy: worst.apyBase,
      lowYieldTvl: worst.tvlUsd,
      grossSpreadPct: spread.toFixed(2),
      estBridgeCost: bridgeCost.toFixed(2) + '%',
      netSpreadPct: netSpread.toFixed(2),
      conservativeNetSpreadPct: (rateElevated || rateDeclining) ? conservativeNetSpread.toFixed(2) : undefined,
      sameChain,
      minEconomicalUsd,
      spikeCapped,
      rateElevated,
      rateElevatedRatio: rateElevated ? rateElevatedRatio : undefined,
      rateDeclining,
      rateDecliningRatio: rateDeclining ? rateDecliningRatio : undefined,
      decliningFactor: rateDeclining ? decliningFactor : undefined,
      hardBridge,
      nonEvmBridge,
      no7dData: bestApyBase7d == null, // X174b: parity with YIELD/CARRY/RECURSIVE/CLM — destination has no 7d APY history
      action: `Move ${token} from ${worst.project}(${worst.chain}) → ${best.project}(${best.chain}) for +${((rateElevated || rateDeclining) ? conservativeNetSpread : netSpread).toFixed(2)}% net APY${spikeLabel}${hardBridge ? ' [COMPLEX BRIDGE]' : nonEvmBridge ? ' [NON-EVM BRIDGE]' : ''}`,
      feasibility: sameChain ? 'EASY' : hardBridge ? 'HARD' : nonEvmBridge ? 'MODERATE_BRIDGE' : lowLiqInvolved ? 'RISKY' : 'MODERATE',
    });
  }

  return spreads.sort((a, b) => parseFloat(b.netSpreadPct) - parseFloat(a.netSpreadPct));
}

function findLeverageLoops(pools) {
  const config = loadConfig();
  const loops = [];

  // Only consider lending pools for loops (you can't leverage-loop an LP position the same way)
  const lendingPools = pools.filter(p => isLending(p.project) || isLP(p.project));

  const incentivized = lendingPools.filter(p =>
    (p.apyReward || 0) > 0 && (p.tvlUsd || 0) > config.min_tvl_usd
  );

  for (const p of incentivized) {
    const chain = (p.chain || '').toLowerCase();

    // Skip low-liquidity chains entirely for leverage loops (can't exit safely)
    if (LOW_LIQ_CHAINS.has(chain)) continue;

    const totalApy = (p.apyBase || 0) + (p.apyReward || 0);
    // More conservative borrow rate estimation
    // Use 2x supply base rate + 2% spread (closer to reality than 1.5x + 1%)
    const estBorrowRate = (p.apyBase || 0) * 2 + 2.0;
    const leverage = 3;
    const leveragedApy = (totalApy * leverage) - (estBorrowRate * (leverage - 1));

    // Only include if meaningful boost AND above threshold
    if (leveragedApy <= totalApy * 1.2 || leveragedApy <= 12) continue;

    // Discount emission-heavy loops
    const emissionPct = totalApy > 0 ? ((p.apyReward || 0) / totalApy) * 100 : 0;
    const sustainability = emissionPct > 80 ? 'EMISSION_HEAVY' : emissionPct > 50 ? 'MIXED' : 'REAL_YIELD';

    loops.push({
      type: 'leverage_loop',
      protocol: p.project,
      chain: p.chain,
      token: p.symbol,
      poolType: isLP(p.project) ? 'LP' : 'LENDING',
      baseApy: totalApy.toFixed(2),
      apyBase: (p.apyBase || 0).toFixed(2),
      apyReward: (p.apyReward || 0).toFixed(2),
      emissionPct: Math.round(emissionPct),
      sustainability,
      estBorrowRate: estBorrowRate.toFixed(2),
      leverage: leverage + 'x',
      leveragedApy: leveragedApy.toFixed(2),
      boostVsBase: ((leveragedApy / totalApy - 1) * 100).toFixed(0) + '%',
      risk: Math.min(10, riskScore(p) + (isLP(p.project) ? 1 : 0)),
      tvl: p.tvlUsd,
      action: `${isLP(p.project) ? '[LP] ' : ''}Loop ${p.symbol} on ${p.project}(${p.chain}): deposit → borrow → redeposit at ${leverage}x for ~${leveragedApy.toFixed(1)}% APY`,
      warning: leveragedApy > 100 ? 'Very high — verify real borrow rates' : emissionPct > 80 ? 'Emission-dependent — reward token may dump' : null
    });
  }

  return loops.sort((a, b) => parseFloat(b.leveragedApy) - parseFloat(a.leveragedApy));
}

export async function scanLoops() {
  log('Scanning lending spreads and leverage loops (LP/lending separated)...');

  const allPools = await getAllPools();
  log(`Found ${allPools.length} pools to analyze`);

  const lendingSpreads = findLendingSpread(allPools);
  // leverage_loops DROPPED (consolidation 2026-05): findLeverageLoops was a broken second
  // implementation of recursive leverage — it forced 3x on LP/AMM pools that cannot be looped,
  // fabricated the borrow rate (apyBase*2+2) instead of joining a real borrow market, and emitted
  // 200000% APY artifacts. index.js already ignored it; RECURSIVE is sourced solely from
  // aggro.recursive (real LTV + real borrow rates via /lendBorrow).

  return {
    timestamp: new Date().toISOString(),
    lending_spreads: lendingSpreads.slice(0, 30),
    leverage_loops: [],
    total_opportunities: lendingSpreads.length,
    note: 'Lending spreads only (lending-only, no LP). leverage_loops retired — see aggro.recursive.'
  };
}
