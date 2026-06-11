// Yield farming scanner — finds highest real yields across all chains
// Fixed: APY decay tracking, chain maturity filtering, emission vs base yield separation
import { fetchJSON, cached, setCache, riskScore, loadConfig, log } from './utils.js';
import { sameChainMinCapital } from './carry.js';

// X13: V3/CLM passive-LP discount for yield entries.
// Same logic as carry.js — concentrated liquidity headline APYs massively over-promise
// for passive LPs. A uniswap-v4 stablecoin pool showing 219% is ~80% for a wide-range LP.
// X211: CeDeFi protocols — centralized custody yield products (parity with carry.js/shortfarm.js).
// bitway(BSC): 10-12% on stablecoins with 100% base, 0% emissions, no 7d, no realized data.
// Hallmarks of off-chain yield management. +2 risk for counterparty risk (total fund loss possible).
const CEDEFI_PROJS = new Set([
  'bitway',       // BSC — stablecoin yield with no on-chain yield source
]);

// X224: RWA/credit protocols — yield from real-world lending (under/uncollateralized).
const RWA_CREDIT_PROJS = new Set([
  'goldfinch', 'maple', 'clearpool', 'truefi', 'centrifuge', 'credix',
  'huma', 'atlendis', 'ribbon-lend', 'jia', 'florence-finance',
]);

const CLM_PROJS = new Set([
  'uniswap-v3','uniswap-v4','aerodrome-slipstream','velodrome-v3',
  'pancakeswap-amm-v3','camelot-v3','quickswap-v3','thena-v3',
  'joe-v2.1','joe-v2.2','orca-dex','meteora-dlmm','raydium-clmm',
  'ambient-finance','maverick-v2','kim-exchange-v4',
  'quickswap-dex','thena-fusion',
  'steer-protocol','gamma','arrakis-v1',
  'hyperswap-v3','cetus-clmm','sushiswap-v3',
  'full-sail',
  'ekubo',
  'blackhole-clmm','pharaoh-v3','sparkdex-v3.1',
  'shadow-exchange-clmm','alien-base-v3',
  'project-x','hyperion','bluefin-spot',
  'turbos','nest-v1','ramses-cl',
  'etherex-cl','supernova-cl','fluxion-network','flowx-v3',
]);

// X29: CLM DEX name patterns found in poolMeta of aggregator/wrapper protocols.
const CLM_META_PATTERNS = /^(uniswap|aerodrome|velodrome|pancakeswap|camelot|quickswap|thena|sushiswap|ekubo|maverick|gamma|steer|orca|meteora|raydium|cetus|ambient|project-x|hyperion|bluefin|turbos|nest|ramses|etherex|supernova|fluxion|flowx|concentrated)/i;

function isClmPool(pool) {
  if (CLM_PROJS.has((pool.project || '').toLowerCase())) return true;
  const meta = (pool.poolMeta || '').split(' ')[0];
  return meta.length > 0 && CLM_META_PATTERNS.test(meta);
}

// X173: Non-USD fiat stablecoins — detect cross-currency pairs by symbol when ilRisk='no'
const NON_USD_FIAT_RE = /EURC|EURS|EURT|CADC|GYEN|XSGD|BRZ|TRYB|GBPT|NZDS|JPYC|CEUR|CJPY|CREAL|AGEUR|DCHF|SEUR/i;
function isCrossCurrencyStable(pool) {
  if (!pool.stablecoin) return false;
  if (pool.ilRisk === 'yes') return true;
  const sym = (pool.symbol || '').toUpperCase();
  return NON_USD_FIAT_RE.test(sym) && /USD|DAI|FRAX/i.test(sym);
}

function clmPassiveFactor(pool) {
  if (!isClmPool(pool)) return 1.0;
  const sym = (pool.symbol || '').toUpperCase();
  // X124+X173: cross-currency stablecoins (EURC-USDC, CADC-USDC) → correlated (0.5), not stable (0.6)
  if (isCrossCurrencyStable(pool)) return 0.5;
  if (pool.stablecoin || /USD.*USD|DAI.*USD|FRAX.*USD|EUR.*EUR/i.test(sym)) return 0.6;
  if (/STETH|CBETH|RETH|SETH|METH|ARBWETH|AARBWETH|WBETH|EETH|EZETH|WEETH|RSETH|SWETH|OSETH|ANKETH/i.test(sym) && /ETH/i.test(sym)) return 0.5;
  if (pool.ilRisk === 'no' && /ETH.*ETH/i.test(sym)) return 0.5;
  return 0.2;
}

const V3_PASSIVE_APY_CAP = { stable: 80, correlated: 150, volatile: 200 };
function v3PassiveApyCap(pool) {
  if (!isClmPool(pool)) return Infinity;
  // X124+X173: cross-currency stablecoins get correlated cap, not stable cap
  if (isCrossCurrencyStable(pool)) return V3_PASSIVE_APY_CAP.correlated;
  if (pool.stablecoin || /USD.*USD|DAI.*USD|FRAX.*USD|EUR.*EUR/i.test((pool.symbol||'').toUpperCase())) return V3_PASSIVE_APY_CAP.stable;
  if (pool.ilRisk === 'no') return V3_PASSIVE_APY_CAP.correlated;
  return V3_PASSIVE_APY_CAP.volatile;
}

// Minimum chain-level TVL to consider — filters out illiquid/niche chains
const MATURE_CHAINS = {
  ethereum: 50e9, arbitrum: 2e9, base: 1e9, solana: 3e9,
  bsc: 3e9, polygon: 500e6, avalanche: 500e6, optimism: 500e6,
};

// Chains with low liquidity / high risk that need extra scrutiny
const LOW_LIQ_CHAINS = new Set(['flare', 'celo', 'harmony', 'aurora', 'moonbeam', 'moonriver', 'fuse', 'boba', 'velas', 'telos', 'kava']);

// G7 FIX: Per-token reward decay discount based on 90-day price performance.
// Instead of flat 0.4x discount on all reward tokens, look at each token's actual price trend.
// Returns a Map of "chain:address" → discount factor (0.1 to 1.0).
const CHAIN_SLUG_MAP = {
  ethereum: 'ethereum', arbitrum: 'arbitrum', base: 'base', bsc: 'bsc',
  polygon: 'polygon', optimism: 'optimism', avalanche: 'avax', solana: 'solana',
};

export async function fetchRewardTokenDecay(pools) {
  const tokenSet = new Set();
  for (const p of pools) {
    if (!p.rewardTokens || !p.rewardTokens.length || (p.apyReward || 0) < 1) continue;
    const chain = CHAIN_SLUG_MAP[(p.chain || '').toLowerCase()];
    if (!chain) continue;
    for (const addr of p.rewardTokens) {
      tokenSet.add(`${chain}:${addr.toLowerCase()}`);
    }
  }

  const tokens = [...tokenSet];
  if (!tokens.length) return new Map();

  const decayMap = new Map();
  const cacheKey = 'reward_token_decay';
  const cachedDecay = cached(cacheKey, 3600); // cache 1h
  if (cachedDecay) {
    for (const [k, v] of Object.entries(cachedDecay)) decayMap.set(k, v);
    return decayMap;
  }

  // Batch in groups of 10 to avoid hammering the API
  const now = Math.floor(Date.now() / 1000);
  const d90ago = now - 90 * 86400;

  for (let i = 0; i < tokens.length; i += 10) {
    const batch = tokens.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(async (coinId) => {
        try {
          const resp = await fetchJSON(
            `https://coins.llama.fi/chart/${coinId}?start=${d90ago}&span=90&period=1d`,
            { timeout: 8000 }
          );
          const prices = resp?.coins?.[coinId]?.prices;
          if (!prices || prices.length < 2) return { coinId, factor: 0.4 }; // fallback
          const first = prices[0].price;
          const last = prices[prices.length - 1].price;
          if (!first || first === 0) return { coinId, factor: 0.4 };
          const pctChange = (last - first) / first;
          // down >50% → 0.1, down 20-50% → 0.3, stable ±20% → 0.7, up → 1.0
          let factor;
          if (pctChange < -0.5) factor = 0.1;
          else if (pctChange < -0.2) factor = 0.3;
          else if (pctChange <= 0.2) factor = 0.7;
          else factor = 1.0;
          return { coinId, factor };
        } catch {
          return { coinId, factor: 0.4 };
        }
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') decayMap.set(r.value.coinId, r.value.factor);
    }
  }

  // Cache the results
  setCache(cacheKey, Object.fromEntries(decayMap));
  return decayMap;
}

// Look up the reward discount factor for a pool.
// If multiple reward tokens, use the weighted average (equal weight for simplicity).
// Falls back to 0.4 if no data available.
export function rewardDecayFactor(pool, decayMap) {
  if (!decayMap || !decayMap.size) return 0.4;
  if (!pool.rewardTokens || !pool.rewardTokens.length) return 0.4;
  const chain = CHAIN_SLUG_MAP[(pool.chain || '').toLowerCase()];
  if (!chain) return 0.4;
  let sum = 0, count = 0;
  for (const addr of pool.rewardTokens) {
    const key = `${chain}:${addr.toLowerCase()}`;
    if (decayMap.has(key)) {
      sum += decayMap.get(key);
      count++;
    }
  }
  return count > 0 ? sum / count : 0.4;
}

// X111 (audit C1): Sanity check for DefiLlama APY data artifacts.
// DefiLlama occasionally publishes broken APYs (vault contracts whose APY
// computation overflows or returns nonsense, often in newly created Morpho/Euler
// vaults). Signature: huge headline (often six figures) AND a flat 30d window
// (apyMean30d ≈ apy because the artifact has been present for the entire window).
// The pre-existing isExtremeOutlier check requires DefiLlama to flag p.outlier=true,
// which they often don't on fresh pools. This filter catches the data-artifact
// pattern without depending on upstream flags.
//
// Rationale for thresholds:
//   - 5000% is an absolute kill switch — no legitimate sustained yield reaches
//     there. Catches the morpho-blue 297,996% family and similar overflow bugs.
//   - 500% is the practical ceiling for legitimate sustained yield in DeFi.
//     Above this needs evidence of being a real recent spike, not a stuck
//     broken value. The discriminator is divergence from the 30d mean.
//   - "Real spike" pattern: current is high, 30d mean is much lower
//     (uniswap-v3 AIOT-USDT current=3349%, mean30d=10% — drift 320× = real).
//   - "Artifact" pattern: current and 30d mean are both high and similar
//     (aerodrome WETH-USDC current=4777%, mean30d=11728% — drift 0.59 but
//     both numbers absurd; real LPs would have arbitraged this away).
//   - Therefore: drift threshold catches stuck-flat artifacts, AND a
//     "both high" check catches sustained-broken artifacts where mean30d
//     has had time to absorb the bad data alongside current.
const APY_SANITY_HARD_CEILING = 5000;
const APY_SANITY_SOFT_CEILING = 500;
const APY_SANITY_BOTH_HIGH_CURRENT = 1000;
const APY_SANITY_BOTH_HIGH_MEAN = 500;
const APY_SANITY_FLAT_RATIO = 0.5;
function isApyDataArtifact(pool) {
  const apy = pool.apy || 0;
  const mean30d = pool.apyMean30d || 0;
  if (apy >= APY_SANITY_HARD_CEILING) return true;
  if (apy < APY_SANITY_SOFT_CEILING) return false;
  // Above the soft ceiling, we need evidence this is a real recent spike.
  if (mean30d <= 0) return true; // no history at >500% is not trustable
  // "Both high" pattern: current and 30d mean both implausibly high.
  // Real spikes start from low historical means.
  if (apy >= APY_SANITY_BOTH_HIGH_CURRENT && mean30d >= APY_SANITY_BOTH_HIGH_MEAN) return true;
  // Drift check: stuck-flat broken value where current ≈ mean30d.
  const drift = Math.abs(apy - mean30d) / mean30d;
  return drift < APY_SANITY_FLAT_RATIO;
}

// X1: Realized-APY tracking — fetch historical APY from DefiLlama /chart/{poolId},
// compare 30d average vs current headline to compute per-protocol empirical discount factors.
// This replaces guesswork with observed data: if a protocol's pools consistently deliver
// only 40% of their headline APY over 30 days, we apply a 0.4x realized factor.
export async function fetchRealizedApyRatios(pools, maxPerProtocol = 5, maxTotal = 60) {
  const cacheKey = 'realized_apy_ratios';
  const cachedRatios = cached(cacheKey, 3600); // cache 1h
  if (cachedRatios) return cachedRatios;

  // Pick top pools per protocol (by TVL — more reliable data for high-TVL pools)
  const byProtocol = {};
  for (const p of pools) {
    if ((p.tvlUsd || 0) < 500000 || (p.apy || 0) < 5) continue; // skip tiny/dead pools
    const proj = (p.project || 'unknown').toLowerCase();
    if (!byProtocol[proj]) byProtocol[proj] = [];
    byProtocol[proj].push(p);
  }

  // X4: two-pass sampling for broad coverage + depth on important protocols
  // Pass 1: one high-TVL pool per protocol (broad coverage)
  // Pass 2: fill remaining slots with extra pools from high-pool-count protocols
  const protocolEntries = Object.entries(byProtocol)
    .sort((a, b) => b[1].length - a[1].length); // most-pooled first

  for (const [, projPools] of protocolEntries) {
    projPools.sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0));
  }

  // Pass 1: one pool per protocol, prioritize by pool count (higher impact)
  const pass1 = [];
  for (const [proj, projPools] of protocolEntries) {
    if (pass1.length >= maxTotal) break;
    pass1.push({ pool: projPools[0].pool, project: proj, apy: projPools[0].apy || 0 });
  }

  // Pass 2: extra pools from protocols with most qualifying pools
  const pass2 = [];
  for (const [proj, projPools] of protocolEntries) {
    for (const p of projPools.slice(1, maxPerProtocol)) {
      pass2.push({ pool: p.pool, project: proj, apy: p.apy || 0, poolCount: projPools.length });
    }
  }
  pass2.sort((a, b) => b.poolCount - a.poolCount || b.apy - a.apy);

  const toFetch = [...pass1, ...pass2].slice(0, maxTotal);

  if (!toFetch.length) return {};

  const coveredProtocols = new Set(toFetch.map(t => t.project)).size;
  log(`X1: Fetching realized APY for ${toFetch.length} pools across ${coveredProtocols}/${Object.keys(byProtocol).length} protocols...`);

  const d30ago = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const results = [];

  // Batch in groups of 10 — DefiLlama handles this without rate limiting
  for (let i = 0; i < toFetch.length; i += 10) {
    const batch = toFetch.slice(i, i + 10);
    const batchResults = await Promise.allSettled(
      batch.map(async ({ pool, project, apy }) => {
        try {
          const resp = await fetchJSON(
            `https://yields.llama.fi/chart/${pool}`,
            { timeout: 10000 }
          );
          const data = resp?.data;
          if (!data || data.length < 7) return null; // need at least 7 days

          // Get last 30 days of APY data
          const recent = data.filter(d => d.timestamp >= d30ago);
          const apyValues = (recent.length >= 7 ? recent : data.slice(-30))
            .map(d => d.apy || 0)
            .filter(v => v > 0);

          if (apyValues.length < 7) return null;

          const avg30d = apyValues.reduce((s, v) => s + v, 0) / apyValues.length;
          // Ratio: what fraction of current headline was actually delivered over 30d?
          const ratio = apy > 0 ? Math.min(avg30d / apy, 2.0) : 1.0; // cap at 2.0 (can over-deliver)
          return { project, pool, currentApy: apy, avg30dApy: avg30d, ratio };
        } catch {
          return null;
        }
      })
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
  }

  // Aggregate per protocol: median ratio (more robust than mean against outliers)
  const protocolRatios = {};
  const byProj = {};
  for (const r of results) {
    if (!byProj[r.project]) byProj[r.project] = [];
    byProj[r.project].push(r.ratio);
  }
  for (const [proj, ratios] of Object.entries(byProj)) {
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    // Clamp between 0.1 and 1.5 — below 0.1 is data noise, above 1.5 is unusual
    protocolRatios[proj] = parseFloat(Math.max(0.1, Math.min(1.5, median)).toFixed(3));
  }

  log(`X1: Realized ratios for ${Object.keys(protocolRatios).length} protocols (sampled ${results.length} pools)`);
  setCache(cacheKey, protocolRatios);
  return protocolRatios;
}

export async function scanYields() {
  const config = loadConfig();
  const cacheKey = 'yields_all';
  let pools = cached(cacheKey, config.cache_ttl_seconds);

  if (!pools) {
    log('Fetching yield data from DeFi Llama...');
    const resp = await fetchJSON(config.apis.defillama_yields);
    pools = resp.data || resp;
    setCache(cacheKey, pools);
  }

  log(`Processing ${pools.length} pools...`);

  // G7: fetch per-token reward decay factors
  const decayMap = await fetchRewardTokenDecay(pools);
  if (decayMap.size) log(`Reward token decay: ${decayMap.size} tokens priced`);

  // X1: fetch per-protocol realized-APY ratios from historical data
  const realizedRatios = await fetchRealizedApyRatios(pools);

  const validChains = new Set(config.chains.map(c => c.toLowerCase()));

  let droppedArtifactCount = 0;
  let droppedArtifactSamples = [];
  const scored = pools
    .filter(p => {
      const chain = (p.chain || '').toLowerCase();
      if (!validChains.has(chain)) return false;
      if ((p.tvlUsd || 0) < config.min_tvl_usd) return false;
      if ((p.apy || 0) < config.min_apy_threshold) return false;
      // X59: skip pools with empty/missing symbol — users can't identify what to deposit into.
      // morpho-blue has pools with empty symbol (data artifacts from unnamed vaults).
      if (!p.symbol || p.symbol.trim() === '') return false;
      // X111 (audit C1): drop DefiLlama APY data artifacts before scoring/ranking.
      if (isApyDataArtifact(p)) {
        droppedArtifactCount++;
        if (droppedArtifactSamples.length < 5) {
          droppedArtifactSamples.push(`${p.project} ${p.symbol} ${p.chain} apy=${(p.apy||0).toFixed(0)}% mean30d=${(p.apyMean30d||0).toFixed(0)}%`);
        }
        return false;
      }
      return true;
    })
    .map(p => {
      const chain = (p.chain || '').toLowerCase();
      const isLowLiqChain = LOW_LIQ_CHAINS.has(chain);
      const baseApy = p.apyBase || 0;
      const rewardApy = p.apyReward || 0;
      const totalApy = p.apy || 0;
      // X23+X28: fall back to min(mean30d, baseApy) when apyBase7d is null (no 7d data).
      // X23 used mean30d alone to avoid spiked current values, but that over-ranks crashed pools
      // (e.g. merkl LVWETH: mean30d=1095%, current=12.6% → was ranking at 500% cap).
      // min() is always conservative: picks mean30d for spikes, current for crashes.
      const base7d = p.apyBase7d != null ? p.apyBase7d : Math.min(p.apyMean30d || baseApy, baseApy);
      const mean30d = p.apyMean30d || totalApy;

      // G7: per-token reward discount replaces flat factors
      const tokenDecay = rewardDecayFactor(p, decayMap);
      // 7d-blended APY: base7d (real yield) + reward weighted by token health
      const apyBlend7d = base7d + rewardApy * Math.min(tokenDecay + 0.2, 1.0);

      // X14: CLM-adjusted blend7d — for passive LPs, base fees must be discounted by
      // concentration factor. Reward emissions are per-LP-share, not range-dependent.
      const clmFactor = clmPassiveFactor(p);
      // X30: use min(base7d, baseApy) for CLM ranking to prevent spiked 7d data from
      // inflating score. V3 apyBase7d reflects concentrated-LP fees which can spike 22x
      // above current (e.g. pancakeswap WETH-USDC: base7d=761%, current=33.8%). After 0.2x
      // CLM factor that's 152% ranking vs 6.76% actual passive — massive over-ranking.
      const clmBase7d = clmFactor < 1.0 ? Math.min(base7d, baseApy) : base7d;
      // X37: CLM discount applies to BOTH base and rewards — passive LPs earn
      // proportionally less of concentration-dependent reward emissions too.
      const clmAdjBlend7d = clmFactor < 1.0
        ? Math.min(clmBase7d * clmFactor + rewardApy * clmFactor * Math.min(tokenDecay + 0.2, 1.0), v3PassiveApyCap(p))
        : apyBlend7d;

      // Sustainability: compare current vs 30d mean
      const decayRatio = mean30d > 0 ? totalApy / mean30d : 1;
      const decayRatio7d = base7d > 0 ? baseApy / base7d : 1;
      const isSpiking = decayRatio > 2;
      const isDecaying = decayRatio < 0.5;

      // Emission dependency: what % of yield is token rewards vs real yield
      const emissionPct = totalApy > 0 ? (rewardApy / totalApy) * 100 : 0;
      const isEmissionHeavy = emissionPct > 80;

      // X2: Bag trap detection — low-TVL pools with IL exposure are exit traps
      const isBagTrap = (p.tvlUsd || 0) < 500000 && p.ilRisk === 'yes';
      // X58: extreme outlier = outlier + no predictions + absurd base APY (>200%).
      // Data artifacts like morpho-blue ADPUSDC 298,000%, 1337USDC 298,000%.
      const pred58 = p.predictions || {};
      const isExtremeOutlier = p.outlier === true && !pred58.predictedClass && baseApy > 200;

      // Adjust risk for chain maturity and emission dependency
      let adjustedRisk = riskScore(p);
      if (isLowLiqChain) adjustedRisk = Math.min(10, adjustedRisk + 2);
      if (isEmissionHeavy) adjustedRisk = Math.min(10, adjustedRisk + 1);
      if (isSpiking) adjustedRisk = Math.min(10, adjustedRisk + 1);
      if (isBagTrap) adjustedRisk = Math.min(10, adjustedRisk + 2);
      if (isExtremeOutlier) adjustedRisk = Math.min(10, adjustedRisk + 2);
      // X91: TVL < $1M risk penalty — consistent with carry.js/shortfarm.js (X50).
      // Sub-$1M pools have thinner exit liquidity, less protocol battle-testing, and
      // higher impact from large deposits. riskScore() only penalizes < $500K.
      const isLowTvl = !isBagTrap && (p.tvlUsd || 0) < 1_000_000 && (p.tvlUsd || 0) >= 500_000;
      if (isLowTvl) adjustedRisk = Math.min(10, adjustedRisk + 1);
      // X92: Micro pool penalty — single-sided pools with TVL < $500K escape bag-trap
      // (which requires ilRisk=yes). ERUSDC morpho-blue $234K at 141% APY: thin exit
      // liquidity, APY dominated by single deposit/withdrawal, possible vault depeg.
      const isMicroPool = !isBagTrap && (p.tvlUsd || 0) < 500_000;
      if (isMicroPool) adjustedRisk = Math.min(10, adjustedRisk + 2);
      // X94: No-data risk penalty — protocols with BOTH no 7d data AND no realized APY data.
      // Parity with carry.js/shortfarm.js (X79). A protocol with zero empirical verification
      // (no 7d track record + no realized APY measurement) is fundamentally unverified.
      // upshift UPSSYLVA at 27% / risk 2 had both flags but no risk penalty — same risk as
      // empirically-verified pendle at 16%.
      const has7dData = p.apyBase7d != null && p.apyBase7d !== 0;
      const proj79 = (p.project || '').toLowerCase();
      const hasRealizedData79 = proj79 in realizedRatios;
      if (!hasRealizedData79 && !has7dData) adjustedRisk = Math.min(10, adjustedRisk + 1);
      // X95: Volatile LP IL risk penalty — parity with carry.js X41.
      // LP pairs with non-correlated volatile assets (BOME-WSOL, ETH-USDC) have real IL risk
      // that can exceed fee APY during price drops. "Deposit into raydium-amm BOME-WSOL"
      // implies simple deposit but user faces 20-30% IL on a 50% meme token crash.
      // Stablecoin pairs and correlated ETH pairs (ETH-WSTETH) exempt.
      const sym95 = (p.symbol || '').toUpperCase();
      const isVolatileLp = p.ilRisk === 'yes' && !p.stablecoin &&
        !/USD.*USD|DAI.*USD|FRAX.*USD|EUR.*EUR/i.test(sym95) &&
        !(/STETH|CBETH|RETH|SETH|METH|WBETH|EETH|EZETH|WEETH|RSETH|SWETH|OSETH|ANKETH/i.test(sym95) && /ETH.*ETH/i.test(sym95));
      if (isVolatileLp) adjustedRisk = Math.min(10, adjustedRisk + 1);
      // X110: Perps LP token risk — single-token perps LP products (JLP, GLP, HLP) are
      // classified as ilRisk="no" by DefiLlama (single token deposit), but they expose
      // holders to 60-70% volatile asset basket (BTC/ETH/SOL) + counterparty risk to
      // perpetual traders. JLP at risk 2/10 = same as stablecoin pendle — misleading.
      const PERPS_LP_TOKENS = new Set(['JLP', 'GLP', 'HLP', 'ALP', 'FLP']);
      const isPerpsLp = PERPS_LP_TOKENS.has((p.symbol || '').toUpperCase());
      if (isPerpsLp) adjustedRisk = Math.min(10, adjustedRisk + 2);
      // X177: Non-major token acquisition risk — single-sided YIELD entries for protocol-native
      // tokens (SUP, IAERO, AVLT) require user to BUY a volatile small-cap token specifically
      // for the strategy. USD-denominated return = APY minus price depreciation. A 29% APY on
      // SUP is meaningless if SUP drops 40% — net -11% in USD. Stablecoins/majors/LSTs that
      // users already hold don't have this acquisition risk.
      const YIELD_KNOWN_TOKENS = new Set([
        'BTC', 'ETH', 'SOL', 'BNB', 'AVAX', 'MATIC', 'ARB', 'OP', 'LINK', 'UNI', 'AAVE',
        'DOGE', 'SUI', 'NEAR', 'ATOM', 'XRP', 'ADA', 'DOT', 'XMR', 'LTC', 'TRX', 'APT',
        'BCH', 'TON', 'HBAR', 'FIL', 'TAO', 'HYPE', 'PEPE', 'SHIB', 'WIF', 'PENDLE', 'CRV',
        'LDO', 'ENA', 'WLD', 'PAXG', 'INJ', 'SEI', 'TIA', 'FTM', 'S', 'MON',
        'WETH', 'WBTC', 'WSOL', 'WAVAX', 'WBNB', 'WMATIC', 'WFTM',
        'WSTETH', 'STETH', 'CBETH', 'RETH', 'EZETH', 'WEETH', 'RSETH', 'SWETH', 'OSETH',
        'METH', 'EETH', 'ANKETH', 'MSOL', 'JSOL', 'JUPSOL', 'BSOL', 'JITOSOL',
        'USDC', 'USDT', 'DAI', 'FRAX', 'PYUSD', 'USDS', 'LUSD', 'GHO', 'USDT0',
        'EURC', 'CRVUSD', 'USDD', 'MIM', 'SUSD', 'RAI', 'GUSD', 'USD1', 'USDP',
        'SUSDE', 'USDE', 'SDAI', 'SAVAX', 'AUSD', 'AERO', 'VELO', 'CAKE', 'GMX', 'GNS',
        'CBBTC', 'JOE',
      ]);
      const symUpper = (p.symbol || '').toUpperCase();
      const isSingleSided = p.ilRisk !== 'yes' && !symUpper.includes('-');
      // Check exact match OR if symbol ends with a known token (vault derivatives: YCRV → CRV,
      // SDAI → DAI, SUSDE → USDE). Prefix patterns: y/s/w/a/c + major token.
      // X177: Exclude suffix matches where project name contains the token symbol (case-insensitive),
      // indicating it's the protocol's native token, not a derivative. E.g., IAERO from
      // iaero-protocol is NOT an AERO derivative — project "iaero-protocol" contains "iaero".
      const projLower = (p.project || '').toLowerCase();
      const symLower = (p.symbol || '').toLowerCase();
      const isNativeToken = symLower.length >= 3 && projLower.includes(symLower);
      const isKnownToken = YIELD_KNOWN_TOKENS.has(symUpper) ||
        (!isNativeToken && [...YIELD_KNOWN_TOKENS].some(t => t.length >= 3 && symUpper.length > t.length && symUpper.endsWith(t)));
      const isNonMajorToken = isSingleSided && !p.stablecoin && !isPerpsLp && !isKnownToken;
      if (isNonMajorToken) adjustedRisk = Math.min(10, adjustedRisk + 2);
      // X211: CeDeFi counterparty risk — centralized custody protocols (parity with carry.js/shortfarm.js X171)
      const isCedefi = CEDEFI_PROJS.has((p.project || '').toLowerCase()) ||
                       (p.project || '').toLowerCase().includes('cedefi');
      if (isCedefi) adjustedRisk = Math.min(10, adjustedRisk + 2);
      // X224: RWA/credit protocol — real-world lending with borrower default risk
      const isRwaCredit = RWA_CREDIT_PROJS.has((p.project || '').toLowerCase());
      if (isRwaCredit) adjustedRisk = Math.min(10, adjustedRisk + 2);

      // X142: Spike-predicted risk penalty — DefiLlama predicts APY decline or outlier detected
      // but pool isn't yet spiking by decayRatio. IDAI-IUSDC-IUSDT (238%, spikeFactor 0.3,
      // decayRatio 1.71) had risk 3/10 — system valued it at 0.3x but risk didn't reflect
      // predicted decline. Skip if already penalized by isSpiking (+1) or isExtremeOutlier (+2).
      if (!isSpiking && !isExtremeOutlier) {
        const pred142 = p.predictions || {};
        const isDown142 = pred142.predictedClass === 'Down';
        const downProb142 = pred142.predictedProbability || 0;
        const isOutlier142 = p.outlier === true;
        const apyPct1D142 = Math.abs(p.apyPct1D || 0);
        if ((isDown142 && downProb142 >= 80) || (isOutlier142 && isDown142) ||
            (isOutlier142 && apyPct1D142 > 200) || (isOutlier142 && !pred142.predictedClass)) {
          adjustedRisk = Math.min(10, adjustedRisk + 1);
        }
      }

      // X13+X29: V3/CLM passive-LP discount for yield entries.
      // Concentrated liquidity headline APYs massively over-promise for passive LPs.
      // Apply clmPassiveFactor (0.2-0.6x) to base fees + cap. Realized ratio is NOT redundant:
      // it captures fee sustainability over time, CLM factor captures passive vs active LP gap.
      const v3Cap = v3PassiveApyCap(p);
      const isClmPool = v3Cap < Infinity;

      // Profit score: blend current + 7d (farmable window), cap by 30d for spikes
      // G7: use per-token decay factor instead of flat 0.4
      const rawEffectiveApy = baseApy + (rewardApy * tokenDecay);
      // X29+X37: apply CLM passive factor to BOTH base and rewards — CLM reward
      // emissions are concentration-dependent, passive LPs get proportionally less.
      const effectiveApy = clmFactor < 1.0
        ? Math.min(baseApy * clmFactor + rewardApy * clmFactor * tokenDecay, v3Cap)
        : (isClmPool ? Math.min(rawEffectiveApy, v3Cap) : rawEffectiveApy);
      const rawBlend7d = isSpiking ? Math.min(apyBlend7d, mean30d * 1.5) : apyBlend7d;
      // X29: use CLM-adjusted blend7d (already computed above) for ranking CLM pools
      const rankApy = clmFactor < 1.0 ? clmAdjBlend7d : (isClmPool ? Math.min(rawBlend7d, v3Cap) : rawBlend7d);
      // X96+X124+X185: Declining-APY detection — parity with carry.js/shortfarm.js (X117).
      // Old threshold (2x) missed pools like saturn SUSDAT (7d=20%, current=14%, ratio 1.43x)
      // which correctly showed [DECLINING] in carry but had no warning in yields.
      // New: 1.3x threshold (mild decline), 2x (rapid decline). Risk + score penalties.
      // X185: When no 7d data, use mean30d for declining detection. superform SUP had
      // mean30d=47.5% but current=29.3% (38% decline) with NO [DECLINING] label because
      // has7dData was false. mean30d provides meaningful decline signal even without 7d tracking.
      const isDeclining7d = (has7dData && base7d > baseApy * 1.3 && baseApy > 0) ||
                            (!has7dData && mean30d > totalApy * 1.3 && totalApy > 2);
      const isRapidlyDeclining7d = (has7dData && base7d > baseApy * 2 && baseApy > 0) ||
                                   (!has7dData && mean30d > totalApy * 2 && totalApy > 2);
      // X248: Rate-elevation detection — parity with carry.js/shortfarm.js X220.
      // When current APY > 1.5x mean30d with no 7d data to verify sustainability,
      // the rate is anomalously high and likely to revert. pendle SUPERUSDC: current 18.26%
      // vs mean30d 11.17% (1.63x elevation) with 78% "Down" prediction — shows unqualified
      // at risk 1/10, 39% overstatement if it reverts (violates ±20% mandate).
      const mean30dRatio = (mean30d > 0 && totalApy > 0) ? mean30d / totalApy : 1.0;
      const isElevatedRate = !has7dData && mean30d > 0 && mean30dRatio < 0.65 && totalApy > 2;
      const isSeverelyElevated = isElevatedRate && mean30dRatio < 0.5;
      // Stability/elevation factor for scoring
      const elevationFactor = isSeverelyElevated ? 0.7 : isElevatedRate ? 0.8 : 1.0;
      if (isElevatedRate) adjustedRisk = Math.min(10, adjustedRisk + 1);
      // Stability factor for declining pools — reduce ranking score
      const decliningFactor = isRapidlyDeclining7d ? 0.7 : isDeclining7d ? 0.9 : 1.0;
      if (isDeclining7d) adjustedRisk = Math.min(10, adjustedRisk + 1);
      const adjRankApy = isRapidlyDeclining7d ? Math.min(rankApy, rawEffectiveApy * 1.2) : rankApy;
      // PATCH P5a: HARD CAP 500% APY for ranking. Above that = emission/spike noise.
      const cappedForRank = Math.min(adjRankApy, 500);
      // PATCH P5b: sustainability-weighted dampening — real yield wins over emission pump.
      const sustFactor = isSpiking ? 0.2 : isEmissionHeavy ? 0.25 : isDecaying ? 0.4 : (baseApy > rewardApy) ? 1.0 : 0.6;
      // X1+X6: per-protocol realized-APY factor — empirical discount from historical data
      // X6 FIX: Only apply protocol-level realized ratio to emission-dependent pools (emissionPct > 50%).
      // Base-yield pools in heterogeneous protocols (curve-dex, convex) get unfairly penalized by
      // a ratio driven by emission pools' over-promising. sustFactor already handles base-yield spikes.
      const proj = (p.project || '').toLowerCase();
      const hasRealizedData = proj in realizedRatios;
      const rawRealizedFactor = hasRealizedData ? realizedRatios[proj] : 0.9; // X63: unknown protocols get 0.9x uncertainty discount
      const realizedFactor = emissionPct > 50 ? rawRealizedFactor : Math.max(rawRealizedFactor, 0.7);
      // X7: spike/outlier discount using DefiLlama prediction data.
      const pred = pred58;
      const isDownPred = pred.predictedClass === 'Down';
      const downProb = pred.predictedProbability || 0;
      const isOutlierPool = p.outlier === true;
      const apyPct1D = Math.abs(p.apyPct1D || 0);
      let spikeFactor = 1.0;
      if (isExtremeOutlier) {
        // X58: much harder discount than generic outlier+noPrediction (was 0.5x).
        // 0.1x on cappedForRank=500 + risk+2 + sustFactor ensures these rank below
        // legitimate 16% yields. ADPUSDC 298,000%: score ~82→~8, eliminated from top 3.
        spikeFactor = 0.1;
      } else if (isDownPred && downProb >= 80) {
        spikeFactor = isOutlierPool ? 0.1 : 0.3;
      } else if (isOutlierPool && isDownPred) {
        // X52: outlier + Down below 80% — moderate discount. Previously got 1.0x (no discount),
        // which was WORSE than outlier+noPrediction (0.5x). Having "likely declining" evidence
        // should never rank better than having no evidence at all.
        spikeFactor = 0.4;
      } else if (isOutlierPool && apyPct1D > 200) {
        spikeFactor = 0.4;
      } else if (isOutlierPool && !pred.predictedClass) {
        // X10: outlier with no prediction data = too new for DefiLlama to assess.
        spikeFactor = 0.5;
      }
      // X94: Micro-pool score penalty — TVL < $500K single-sided pools have capital dilution
      // risk: $5K deposit into $234K pool = 2.1% of TVL, immediately diluting the APY.
      // +2 risk (above) catches some but 141%/risk6 still outranks 27%/risk3. 0.3x score
      // ensures micro-pools only surface when no better alternatives exist.
      const microPoolFactor = isMicroPool ? 0.3 : 1.0;
      // X190: Non-major token YIELD score discount — user must buy the volatile token to earn
      // yield denominated in that token. IAERO (21.91%, risk 5) outranked SUSDU (10.50%, risk 3)
      // for YIELD slot 2 at $200. If IAERO drops >18%, entire year's yield is wiped out. Risk +2
      // alone doesn't suffice because inflated APY on volatile tokens outweighs the risk divisor.
      // Same principle as CLM non-major 0.5x (X146).
      const nonMajorFactor = isNonMajorToken ? 0.5 : 1.0;
      const profitScore = (cappedForRank * sustFactor * realizedFactor * spikeFactor * microPoolFactor * decliningFactor * elevationFactor * nonMajorFactor / Math.max(adjustedRisk, 1)) * Math.log10(Math.max(p.tvlUsd, 1000));

      return {
        pool: p.pool,
        chain: p.chain,
        project: p.project,
        symbol: p.symbol,
        tvlUsd: p.tvlUsd,
        apy: totalApy,
        apyPassive: (clmFactor < 1.0 && effectiveApy < totalApy) ? parseFloat(effectiveApy.toFixed(2)) : undefined,
        clmCapped: clmFactor < 1.0 && effectiveApy < totalApy,
        apyBase: baseApy,
        apyReward: rewardApy,
        apyMean30d: mean30d,
        apyBase7d: base7d,
        apyBlend7d: parseFloat(apyBlend7d.toFixed(2)),
        emissionPct: Math.round(emissionPct),
        decayRatio: parseFloat(decayRatio.toFixed(2)),
        decayRatio7d: parseFloat(decayRatio7d.toFixed(2)),
        sustainability: isSpiking ? 'SPIKING' : isDecaying ? 'DECAYING' : emissionPct > 80 ? 'EMISSION_HEAVY' : baseApy > rewardApy ? 'REAL_YIELD' : 'MIXED',
        rewardDecayFactor: parseFloat(tokenDecay.toFixed(2)),
        realizedApyRatio: parseFloat(realizedFactor.toFixed(3)),
        clmAdjBlend7d: clmFactor < 1.0 ? parseFloat(clmAdjBlend7d.toFixed(2)) : undefined,
        has7dData,
        spikeDiscounted: spikeFactor < 1.0,
        spikeFactor: spikeFactor < 1.0 ? spikeFactor : undefined,
        extremeOutlier: isExtremeOutlier,
        ilRisk: p.ilRisk,
        volatileLp: isVolatileLp || undefined,
        declining7d: isDeclining7d || undefined,
        rateElevated: isElevatedRate || undefined, // X248: current >> mean30d, rate likely to revert
        bagTrap: isBagTrap,
        lowTvl: isLowTvl || undefined,
        microPool: isMicroPool || undefined,
        noRealizedData: !hasRealizedData || undefined,
        nonMajorToken: isNonMajorToken || undefined,
        cedefi: isCedefi || undefined, // X211: CeDeFi = centralized custody counterparty risk
        rwaCredit: isRwaCredit || undefined, // X224: RWA credit = borrower default risk
        stablecoin: p.stablecoin,
        risk: adjustedRisk,
        profitScore
      };
    })
    .filter(p => p.risk <= config.max_risk_score)
    .sort((a, b) => b.profitScore - a.profitScore);

  // top_real_yield / top_stable_yields / top_bluechip sub-lists DROPPED (consolidation 2026-05):
  // each was 100% a subset of top_50 and consumed by neither the report nor the dashboard.

  // X3: FARMABLE_7D — short-term farming on cheap chains with stable base rate
  // X13: Require real apyBase7d data from DefiLlama. When apyBase7d is null, the code
  // falls back to current baseApy making decayRatio7d=1.0 — faking stability for pools
  // with no 7d history (e.g. brand-new spike pools like GITLAWB that crashed 95% in 1 day).
  // X14: Use CLM-adjusted blend7d for V3/CLM pools — passive LPs capture a fraction of
  // headline fee APY. Also exclude emission-heavy pools (>80% rewards) — FARMABLE_7D
  // targets stable base rates, not token emission dumps.
  const CHEAP_CHAINS = new Set(['polygon', 'base', 'arbitrum', 'optimism']);
  const farmable7d = scored.filter(p => {
    const chain = (p.chain || '').toLowerCase();
    const effectiveBlend7d = p.clmAdjBlend7d != null ? p.clmAdjBlend7d : p.apyBlend7d;
    return effectiveBlend7d > 50
      && p.has7dData === true
      && p.decayRatio7d > 0.7
      && !p.spikeDiscounted
      && p.emissionPct <= 80
      && CHEAP_CHAINS.has(chain)
      && p.risk <= 6;
  }).slice(0, 20);

  if (droppedArtifactCount > 0) {
    log(`X111: dropped ${droppedArtifactCount} APY data artifacts (samples: ${droppedArtifactSamples.join(' | ')})`);
  }

  return {
    timestamp: new Date().toISOString(),
    total_pools_scanned: pools.length,
    opportunities_found: scored.length,
    apy_artifacts_dropped: droppedArtifactCount,
    apy_artifacts_samples: droppedArtifactSamples,
    top_50: scored.slice(0, 50),
    farmable_7d: farmable7d,
    best_strategies: (() => {
      // Dedup by project+symbol+chain: Pendle maturity pools generate identical action strings
      // X110: per-protocol cap (max 3) in candidate selection — previously 9/10 entries were pendle,
      // blocking non-pendle entries (jupiter-lend JLP on Solana, yearn, upshift) from reaching
      // buildReport(). At $200, only 1 YIELD showed (Base pendle) because all non-pendle candidates
      // were Ethereum (min $700+). With cap, cheap-chain alternatives surface as candidates.
      const seen = new Set();
      const protoCounts = {};
      const chainCounts = {};
      const unique = [];
      for (const p of scored) {
        const key = `${p.project}|${p.symbol}|${p.chain}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const proto = (p.project || '').toLowerCase();
        const protoChain = `${proto}|${p.chain}`;
        protoCounts[proto] = (protoCounts[proto] || 0) + 1;
        protoCounts[protoChain] = (protoCounts[protoChain] || 0) + 1;
        // X110: per-chain cap (max 8) prevents Ethereum from consuming all candidate slots.
        // At $200 capital, Ethereum yields have min $400-1100 (gas), so Ethereum-heavy lists
        // leave only 1 YIELD visible. Cap ensures cheap-chain entries (Solana, Base) surface.
        chainCounts[p.chain] = (chainCounts[p.chain] || 0) + 1;
        if (protoCounts[proto] > 4 || protoCounts[protoChain] > 3) continue;
        if (chainCounts[p.chain] > 8) continue;
        unique.push(p);
        if (unique.length >= 25) break;
      }
      return unique;
    })().map(p => ({
      action: `Deposit into ${p.project} ${p.symbol} on ${p.chain}` + (p.extremeOutlier ? ' [EXTREME OUTLIER — headline unreliable]' : ''),
      // X58: extreme outlier APYs (298,000%) are data artifacts — show "up to X%" capped
      apy: p.extremeOutlier ? Math.min(p.apy, 200) : (p.clmCapped ? p.apyPassive : p.apy),
      apyRawHeadline: p.extremeOutlier ? p.apy : undefined,
      apyHeadline: p.clmCapped ? p.apy : undefined,
      clmCapped: p.clmCapped,
      apyBase: p.apyBase,
      apyReward: p.apyReward,
      emissionPct: p.emissionPct,
      sustainability: p.sustainability,
      apyMean30d: p.apyMean30d,
      tvl: p.tvlUsd,
      chain: p.chain,
      risk: p.risk,
      bagTrap: p.bagTrap,
      lowTvl: p.lowTvl,
      microPool: p.microPool,
      volatileLp: p.volatileLp,
      declining7d: p.declining7d,
      rateElevated: p.rateElevated, // X248: current >> mean30d, rate likely to revert
      apyBase7d: p.apyBase7d,
      noRealizedData: p.noRealizedData,
      nonMajorToken: p.nonMajorToken,
      cedefi: p.cedefi, // X211: CeDeFi counterparty risk flag
      rwaCredit: p.rwaCredit, // X224: RWA credit = borrower default risk
      no7dData: !p.has7dData,
      realizedApyRatio: p.realizedApyRatio,
      spikeDiscounted: p.spikeDiscounted || undefined,
      spikeFactor: p.spikeFactor,
      // X105: minimum capital from chain gas costs — Ethereum deposits cost $15+,
      // making sub-$500 deposits unprofitable at 15% APY (gas > year-1 return).
      // 2 txs: approve + deposit.
      // X143: Use spike-adjusted APY for minCapital when spike-discounted. Without this,
      // IDAI-IUSDC-IUSDT (headline 238%, spike-adj 71%) used 238% for minCapital ($48)
      // but user expects 71% — minCapital should be based on realistic expected return.
      minCapitalUsd: sameChainMinCapital(p.chain, (() => {
        let effectiveApy = p.clmCapped ? p.apyPassive : p.apy;
        if (p.spikeDiscounted && p.spikeFactor) {
          const spikeAdj = p.apyMean30d ? Math.min(p.apyMean30d, effectiveApy * p.spikeFactor) : effectiveApy * p.spikeFactor;
          effectiveApy = spikeAdj;
        }
        return effectiveApy * (p.realizedApyRatio || 1.0);
      })(), 2),
      profitScore: p.profitScore
    })),
    realizedApyRatios: realizedRatios
  };
}
