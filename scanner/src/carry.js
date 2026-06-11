// Borrow-and-stake carry trade scanner v2
// Uses DeFi Llama /lendBorrow for real borrow rates + /pools for yield destinations
import { fetchJSON, cached, setCache, log } from './utils.js';
import { fetchRewardTokenDecay, rewardDecayFactor, fetchRealizedApyRatios } from './yields.js';

const LOW_LIQ_CHAINS = new Set(['flare','celo','harmony','aurora','moonbeam','moonriver','fuse','boba','velas','telos','kava']);

// X176: Known stablecoins + major tokens — used to detect non-major stablecoin LP pairs.
// Non-major stablecoins (THUSD, etc.) have depeg risk that invalidates stable pair concentration assumptions.
const KNOWN_MAJORS = new Set([
  'USDC','USDT','DAI','BUSD','FRAX','TUSD','PYUSD','USDS','LUSD','GHO','USDT0','USD₮0',
  'EURC','CRVUSD','USDD','USDP','MIM','SUSD','RAI','GUSD','USD1','AUSD','SUSDE','USDE','SDAI','USDTB',
  'BTC','ETH','SOL','BNB','AVAX','MATIC','ARB','OP','LINK','UNI','AAVE','DOGE','SUI',
  'WETH','WBTC','WSOL','WAVAX','WBNB','CBBTC','WBTC.B','BTC.B','WHYPE',
  'STETH','WSTETH','CBETH','RETH','EETH','WEETH','EZETH','METH','RSETH','SWETH','OSETH',
  'MSOL','JSOL','JUPSOL','BSOL','JITOSOL',
]);
function hasNonMajorStable(sym) {
  const tokens = sym.split('-');
  return tokens.some(t => t.length > 0 && !KNOWN_MAJORS.has(t));
}

// X166: Tiered bridge risk — parity with loops.js SPREAD risk tiers (X140).
// CARRY/SHORT_FARM cross-chain trades had flat +1 risk regardless of bridge complexity.
// Bridging to Osmosis (Axelar/IBC) or Stellar is far riskier than Ethereum→Arbitrum canonical bridge.
const HARD_BRIDGE_CHAINS = new Set(['tron', 'stellar', 'starknet', 'ton', 'near', 'cosmos', 'osmosis', 'injective']);
const NON_EVM_CHAINS = new Set(['solana', 'sui', 'aptos', 'bitcoin', 'sei']);

// X199: Circular LST carry filter — borrowing an LST and "depositing" into its own staking
// protocol is not a real trade. The pool's APY represents the token's inherent appreciation
// (exchange-rate model), not additional yield from depositing. Net carry is actually -borrowRate.
const LST_ISSUER_MAP = {
  'MSOL': 'marinade',
  'JITOSOL': 'jito',
  'JUPSOL': 'jupiter-staked',
  'BNSOL': 'binance-staked',
  'BSOL': 'blazestake',
  'STETH': 'lido',
  'WSTETH': 'lido',
  'RETH': 'rocket-pool',
  'CBETH': 'coinbase-wrapped',
  'SWETH': 'swell',
  'METH': 'mantle-staked',
  'ANKRSOL': 'ankr',
};
function isCircularLstCarry(tokenSymbol, destProject) {
  const issuerPrefix = LST_ISSUER_MAP[tokenSymbol.toUpperCase()];
  if (!issuerPrefix) return false;
  return (destProject || '').toLowerCase().startsWith(issuerPrefix);
}

// X109: Leveraged farming protocols — reported APY already includes internal leverage.
const LEVERAGED_PROJS = new Set([
  'extra-finance-leverage-farming',
  'openleverage',
  'gearbox',
  'alpaca-finance',
  'francium',
]);

// X211: CeDeFi protocols — centralized custody yield products that don't self-label as "cedefi".
// bitway(BSC): 10-12% on stablecoins (U, USDT) with 100% base APY, 0% emissions, no 7d data,
// no realized data. Hallmarks of off-chain yield management (similar to Celsius/BlockFi model).
// Counterparty risk: total fund loss if operator is compromised/insolvent.
const CEDEFI_PROJS = new Set([
  'bitway',       // BSC — stablecoin yield with no on-chain yield source
]);

// X224: RWA/credit protocols — yield from real-world lending (under/uncollateralized).
// Principal loss from borrower default (Goldfinch $7M default 2023, Maple $36M defaults 2022).
// Locked capital (loan terms prevent immediate withdrawal). No on-chain recourse.
const RWA_CREDIT_PROJS = new Set([
  'goldfinch', 'maple', 'clearpool', 'truefi', 'centrifuge', 'credix',
  'huma', 'atlendis', 'ribbon-lend', 'jia', 'florence-finance',
]);

// X232: Perps LP protocols — liquidity providers for perpetual/derivatives trading venues.
// Risk is counterparty exposure to leveraged traders (if traders profit, LPs lose), NOT AMM IL.
// DefiLlama marks these as ilRisk='yes' (multi-asset pools), but the mechanism is fundamentally
// different: no x*y=k rebalancing, no impermanent loss curve. Risk: tail events where traders
// are collectively correct (e.g., trending markets) cause LP drawdowns.
const PERPS_LP_PROJS = new Set([
  'gmx-v2-perps', 'gmx', 'jupiter-perps', 'gains-network', 'gains-network-v3',
  'synthetix-perps', 'vertex-protocol', 'hyperliquid-perps', 'dydx',
  'mux-protocol', 'level-finance', 'hmx',
  'avantis', // X245: single-sided USDC perps liquidity on Base
]);

// G6 FIX: Chain-specific bridge + gas cost models.
// bridgeFeePercent = protocol fee (% of value), gasFixedUsd = fixed gas cost in USD.
// Used to replace the flat 0.3% bridgeCost for cross-chain carry trades.
const CHAIN_COSTS = {
  ethereum:  { bridgeFeePercent: 0.10, gasFixedUsd: 15.00 },
  arbitrum:  { bridgeFeePercent: 0.10, gasFixedUsd: 0.30 },
  optimism:  { bridgeFeePercent: 0.10, gasFixedUsd: 0.30 },
  base:      { bridgeFeePercent: 0.10, gasFixedUsd: 0.10 },
  polygon:   { bridgeFeePercent: 0.15, gasFixedUsd: 0.50 },
  bsc:       { bridgeFeePercent: 0.10, gasFixedUsd: 0.40 },
  avax:      { bridgeFeePercent: 0.15, gasFixedUsd: 0.50 },
  avalanche: { bridgeFeePercent: 0.15, gasFixedUsd: 0.50 },
  fantom:    { bridgeFeePercent: 0.20, gasFixedUsd: 0.10 },
  gnosis:    { bridgeFeePercent: 0.20, gasFixedUsd: 0.05 },
  linea:     { bridgeFeePercent: 0.15, gasFixedUsd: 0.30 },
  zksync:    { bridgeFeePercent: 0.15, gasFixedUsd: 0.25 },
  scroll:    { bridgeFeePercent: 0.15, gasFixedUsd: 0.30 },
  mantle:    { bridgeFeePercent: 0.20, gasFixedUsd: 0.20 },
  blast:     { bridgeFeePercent: 0.15, gasFixedUsd: 0.15 },
  manta:     { bridgeFeePercent: 0.20, gasFixedUsd: 0.15 },
  solana:    { bridgeFeePercent: 0.25, gasFixedUsd: 0.01, relayerFeeUsd: 1.00 },
  sui:       { bridgeFeePercent: 0.30, gasFixedUsd: 0.01, relayerFeeUsd: 1.50 },
  aptos:     { bridgeFeePercent: 0.30, gasFixedUsd: 0.01, relayerFeeUsd: 1.50 },
  // X79: Non-standard bridge chains — limited bridge infrastructure, higher fees
  tron:      { bridgeFeePercent: 0.40, gasFixedUsd: 1.00, relayerFeeUsd: 3.00 },
  stellar:   { bridgeFeePercent: 0.50, gasFixedUsd: 0.01, relayerFeeUsd: 5.00 },
  starknet:  { bridgeFeePercent: 0.30, gasFixedUsd: 0.10, relayerFeeUsd: 2.00 },
  'hyperliquid l1': { bridgeFeePercent: 0.20, gasFixedUsd: 0.10, relayerFeeUsd: 2.00 },
  megaeth:   { bridgeFeePercent: 0.20, gasFixedUsd: 0.10, relayerFeeUsd: 2.00 },
  monad:     { bridgeFeePercent: 0.20, gasFixedUsd: 0.10, relayerFeeUsd: 2.00 },
  plasma:    { bridgeFeePercent: 0.25, gasFixedUsd: 0.15, relayerFeeUsd: 2.00 },
};
const DEFAULT_CHAIN_COST = { bridgeFeePercent: 0.20, gasFixedUsd: 1.00 };

// X79: same-chain operation gas cost — compute minCapitalUsd where gas < 25% of annual return.
// numTxs: estimated transaction count (carry=4, yield=2, shortfarm=4).
export function sameChainMinCapital(chain, annualReturnPct, numTxs = 4) {
  const chainGas = (CHAIN_COSTS[(chain || '').toLowerCase()] || DEFAULT_CHAIN_COST).gasFixedUsd;
  const totalGas = chainGas * numTxs;
  if (annualReturnPct <= 0 || totalGas < 1) return 0; // negligible gas or no return
  // X246: threshold 0.25→0.15 — at 25%, max overstatement = 25/75 = 33% (outside ±20% mandate).
  // At 15%, max overstatement = 15/85 = 17.6% (within ±20%). Matches CLM (X193) and RECURSIVE (X229).
  return Math.ceil(totalGas / (annualReturnPct / 100 * 0.15)); // gas < 15% of year-1 return
}

// Compute bridge cost as percentage of a given capital amount, and return min economical size.
// Returns { bridgeCostPercent, minEconomicalUsd }
export function crossChainCost(srcChain, destChain, capitalUsd = 5000) {
  const src = CHAIN_COSTS[(srcChain || '').toLowerCase()] || DEFAULT_CHAIN_COST;
  const dst = CHAIN_COSTS[(destChain || '').toLowerCase()] || DEFAULT_CHAIN_COST;
  // Total fixed cost = gas on both chains + bridge relayer fees (Wormhole etc. for non-EVM)
  const srcRelay = src.relayerFeeUsd || 0;
  const dstRelay = dst.relayerFeeUsd || 0;
  const totalFixedGas = src.gasFixedUsd * 2 + dst.gasFixedUsd * 2 + srcRelay + dstRelay;
  // Bridge protocol fee = max of the two chains (conservative)
  const bridgeFee = Math.max(src.bridgeFeePercent, dst.bridgeFeePercent);
  // Total cost as % of capital
  const bridgeCostPercent = bridgeFee + (totalFixedGas / capitalUsd) * 100;
  // Min economical = amount where gas alone eats < 1% of capital
  const minEconomicalUsd = Math.ceil(totalFixedGas / 0.01); // gas < 1%
  return { bridgeCostPercent, minEconomicalUsd, totalFixedGas, bridgeFee };
}

// V3-style concentrated liquidity projects — headline APY assumes active range management.
// A passive LP captures only a fraction of the displayed APY.
// X9: added steer-protocol (automated V3 vault) and gamma (V3 vault manager).
// Vault depositors get active range management but still suffer vault fees (10-20%),
// rebalancing costs, and suboptimal range width — same over-promise dynamic as raw V3.
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
// e.g. beefy poolMeta="Uniswap V3 WETH-USDC", troves poolMeta="Ekubo ETH/USDC".
// First word of poolMeta is checked against these patterns (case-insensitive).
const CLM_META_PATTERNS = /^(uniswap|aerodrome|velodrome|pancakeswap|camelot|quickswap|thena|sushiswap|ekubo|maverick|gamma|steer|orca|meteora|raydium|cetus|ambient|project-x|hyperion|bluefin|turbos|nest|ramses|etherex|supernova|fluxion|flowx|concentrated)/i;

function isClmPool(pool) {
  if (CLM_PROJS.has(pool.project)) return true;
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

// Discount factor for passive LP in CLM pools (G1 fix).
// Stable pairs stay in range more; volatile pairs drift out quickly.
function clmRealizedFactor(pool) {
  if (!isClmPool(pool)) return 1.0;
  const sym = (pool.symbol || '').toUpperCase();
  // X124+X173: cross-currency stablecoins (EURC-USDC, CADC-USDC) → correlated (0.5), not stable (0.6)
  if (isCrossCurrencyStable(pool)) return 0.5;
  // X176: Non-major stablecoin pairs (USDC-THUSD etc.) → correlated (0.5) — depeg risk
  if (pool.stablecoin || /USD.*USD|DAI.*USD|FRAX.*USD|EUR.*EUR/i.test(sym)) {
    if (hasNonMajorStable(sym)) return 0.5;
    return 0.6;
  }
  // Correlated pairs (e.g. ETH-WSTETH, ETH-AARBWETH) stay in range reasonably well
  // X8: extended regex to catch wrapped/bridged ETH variants (aToken, bridged, etc.)
  if (/STETH|CBETH|RETH|SETH|METH|ARBWETH|AARBWETH|WBETH|EETH|EZETH|WEETH|RSETH|SWETH|OSETH|ANKETH/i.test(sym) && /ETH/i.test(sym)) return 0.5;
  // DefiLlama ilRisk='no' on ETH-ETH derivative pairs not caught above
  if (pool.ilRisk === 'no' && /ETH.*ETH/i.test(sym)) return 0.5;
  return 0.2; // volatile pairs — passive LP captures ~20% of headline
}

// X8 FIX: Maximum realistic APY for passive V3 LPs in carry destinations.
// Extremely high raw APYs (>1000%) indicate very narrow concentration — a passive LP
// with a wide range captures a vanishing fraction. Even after the 0.2x discount,
// 3656% → 731% is unrealistic. Cap at tier-specific ceilings.
const V3_PASSIVE_APY_CAP = { stable: 80, correlated: 150, volatile: 200 };

function v3PassiveApyCap(pool) {
  // X124+X173: cross-currency stablecoins get correlated cap, not stable cap
  if (isCrossCurrencyStable(pool)) return V3_PASSIVE_APY_CAP.correlated;
  const sym = (pool.symbol||'').toUpperCase();
  if (pool.stablecoin || /USD.*USD|DAI.*USD|FRAX.*USD|EUR.*EUR/i.test(sym)) {
    // X176: non-major stablecoin pairs get correlated cap (depeg risk)
    return hasNonMajorStable(sym) ? V3_PASSIVE_APY_CAP.correlated : V3_PASSIVE_APY_CAP.stable;
  }
  if (pool.ilRisk === 'no') return V3_PASSIVE_APY_CAP.correlated;
  return V3_PASSIVE_APY_CAP.volatile;
}

async function getSupplyPools() {
  const key = 'carry_supply';
  let data = cached(key, 300);
  if (!data) {
    const resp = await fetchJSON('https://yields.llama.fi/pools');
    data = resp.data || resp;
    setCache(key, data);
  }
  return data;
}

async function getBorrowPools() {
  const key = 'carry_borrow';
  let data = cached(key, 300);
  if (!data) {
    data = await fetchJSON('https://yields.llama.fi/lendBorrow');
    setCache(key, data);
  }
  return data;
}

function normalizeSymbol(sym) {
  if (!sym) return '';
  return sym.split('-')[0].replace(/^W/, '').toUpperCase();
}

// X24: Detect whether a carry destination LP pair exposes the user to a volatile/meme counterparty.
// When borrowing token X and LPing into X-Y, the user needs to buy Y and faces IL risk from Y's volatility.
// Major assets (ETH, BTC, SOL, stables, etc.) are acceptable counterparties; meme/micro-cap tokens are not.
const MAJOR_ASSETS = new Set([
  'ETH','WETH','STETH','WSTETH','CBETH','RETH','SETH','METH','WEETH','EZETH','RSETH','EETH','WBETH','SWETH',
  'BTC','WBTC','CBBTC','TBTC','BTCB','SOLVBTC',
  'SOL','WSOL','MSOL','JITOSOL','BSOL',
  'USDC','USDT','DAI','FRAX','LUSD','TUSD','BUSD','PYUSD','USDP','GUSD','SUSD','CUSD','UST','GHO','CRVUSD','MKUSD','EUSD','USD1','USDT0','USDS',
  'AVAX','WAVAX','BNB','WBNB','MATIC','WMATIC','FTM','WFTM','OP','ARB','LINK','UNI','AAVE','MKR','CRV','CVX','LDO','RPL','SNX',
  'ATOM','DOT','ADA','NEAR','APT','SUI','SEI','TIA','INJ','DYDX','JUP','RAY','ORCA','BONK',
]);

function lpCounterpartyRisk(borrowedSymbol, poolSymbol) {
  if (!poolSymbol || !poolSymbol.includes('-')) return { isLpPair: false };
  const parts = poolSymbol.toUpperCase().split('-');
  if (parts.length < 2) return { isLpPair: false };
  const normBorrow = borrowedSymbol.toUpperCase().replace(/^W/, '');
  // Find the "other" token(s) — the one(s) the user didn't borrow
  const others = parts.filter(t => {
    const normT = t.replace(/^W/, '');
    return normT !== normBorrow;
  });
  if (others.length === 0) return { isLpPair: false }; // single-sided or self-paired
  const riskyOthers = others.filter(t => !MAJOR_ASSETS.has(t.replace(/^W/, '')));
  return {
    isLpPair: true,
    fullSymbol: poolSymbol,
    otherTokens: others,
    hasRiskyCounterparty: riskyOthers.length > 0,
    riskyTokens: riskyOthers,
  };
}

export async function scanCarryTrades(capitalUsd = 5000) {
  log('Scanning borrow-and-stake carry trades (v2 with real borrow rates, capital=$' + capitalUsd + ')...');

  const [supplyPools, borrowRaw] = await Promise.all([getSupplyPools(), getBorrowPools()]);

  // Build borrow index: pool ID -> borrow data
  const borrowByPool = {};
  for (const b of borrowRaw) {
    borrowByPool[b.pool] = b;
  }

  // Build supply pool index with full data
  const supplyIndex = {};
  for (const p of supplyPools) {
    if (!p.pool) continue;
    supplyIndex[p.pool] = p;
  }

  // Find pools that are borrowable (have borrow data) from real lending protocols
  const LENDING_PROJS = new Set(['aave-v3','aave-v2','compound-v3','compound-v2','morpho-v1','morpho-blue','sparklend','spark-savings','kamino-lend','drift','marginfi','solend','benqi-lending','venus-core-pool','venus-flux','radiant-v2','dforce-lending','lista-lending','fraxlend','curve-llamalend','silo-v2','silo-finance','extra-finance-xlend']);

  // X112 (audit C3): borrowable headroom check. The borrow rate sourced from
  // DefiLlama is the *current* rate at *current* utilization — but it doesn't
  // tell us whether there's actually liquidity left to draw. A 99%-utilized
  // market reverts on borrow even though the headline rate looks fine.
  // 85% leaves ~15% headroom under the kink rate, which keeps execution
  // realistic. Markets with missing totalSupply data are skipped: we cannot
  // verify headroom, so we don't recommend.
  const MAX_BORROW_UTILIZATION = 0.85;
  let droppedHighUtil = 0;
  let droppedHighUtilSamples = [];
  let droppedNoSupplyData = 0;

  const borrowable = [];
  for (const [poolId, bData] of Object.entries(borrowByPool)) {
    const supply = supplyIndex[poolId];
    if (!supply) continue;
    if (!LENDING_PROJS.has(supply.project)) continue;
    const chain = (supply.chain || '').toLowerCase();
    if (LOW_LIQ_CHAINS.has(chain)) continue;
    if ((supply.tvlUsd || 0) < 100000) continue;

    const borrowRate = bData.apyBaseBorrow || 0;
    const borrowReward = bData.apyRewardBorrow || 0;
    const netBorrowCost = borrowRate - borrowReward;
    const ltv = bData.ltv || 0;
    const totalBorrow = bData.totalBorrowUsd || 0;
    const totalSupply = bData.totalSupplyUsd || 0;

    if (borrowRate <= 0 || borrowRate > 50) continue;

    if (totalSupply <= 0) {
      droppedNoSupplyData++;
      continue;
    }
    const utilization = totalBorrow / totalSupply;
    if (utilization > MAX_BORROW_UTILIZATION) {
      droppedHighUtil++;
      if (droppedHighUtilSamples.length < 5) {
        droppedHighUtilSamples.push(`${supply.project} ${supply.symbol} ${supply.chain}: ${(utilization*100).toFixed(0)}% util`);
      }
      continue;
    }

    borrowable.push({
      poolId,
      symbol: normalizeSymbol(supply.symbol),
      fullSymbol: supply.symbol,
      chain: supply.chain,
      project: supply.project,
      borrowRate,
      borrowReward,
      netBorrowCost,
      ltv,
      supplyApy: supply.apy || 0,
      tvl: supply.tvlUsd,
      totalBorrow,
      totalSupply,
      utilization: parseFloat(utilization.toFixed(4)),
    });
  }
  if (droppedHighUtil > 0 || droppedNoSupplyData > 0) {
    log(`X112: dropped ${droppedHighUtil} high-utilization (>${(MAX_BORROW_UTILIZATION*100).toFixed(0)}%) + ${droppedNoSupplyData} missing supply data` + (droppedHighUtilSamples.length ? ` (samples: ${droppedHighUtilSamples.join(' | ')})` : ''));
  }

  log('Found ' + borrowable.length + ' real borrowable markets from lending protocols');

  // G7: fetch per-token reward decay for destination pools
  // X5: fetch per-protocol realized-APY ratios for destination yield correction
  const [decayMap, realizedRatios] = await Promise.all([
    fetchRewardTokenDecay(supplyPools),
    fetchRealizedApyRatios(supplyPools),
  ]);

  // Build yield destination index by symbol
  const yieldBySymbol = {};
  for (const p of supplyPools) {
    const chain = (p.chain || '').toLowerCase();
    if (LOW_LIQ_CHAINS.has(chain)) continue;
    if ((p.tvlUsd || 0) < 200000) continue;
    const apy = p.apy || 0;
    if (apy < 3) continue;
    const sym = normalizeSymbol(p.symbol);
    if (!sym || sym.length > 15) continue;
    if (!yieldBySymbol[sym]) yieldBySymbol[sym] = [];
    yieldBySymbol[sym].push(p);
  }

  // Match borrows to yield destinations
  const carries = [];

  for (const b of borrowable) {
    const destinations = yieldBySymbol[b.symbol];
    if (!destinations) continue;

    for (const dest of destinations) {
      // Skip self (same pool)
      if (dest.pool === b.poolId) continue;
      // Skip same project+chain (can't usually borrow and lend same place)
      if (dest.project === b.project && dest.chain === b.chain) continue;
      // X199: Skip circular LST carry (borrow LST → deposit into its own staking protocol)
      if (isCircularLstCarry(b.symbol, dest.project)) continue;

      const destApy = dest.apy || 0;
      const destBase = dest.apyBase || 0;
      const destReward = dest.apyReward || 0;
      // Skip emission-only destinations (0% base = pure token farming, will dump)
      if (destBase < 0.5 && destReward > 0) continue;
      // Skip micro-cap meme pools
      if ((dest.tvlUsd || 0) < 200000) continue;
      // X59: skip destinations with empty/missing symbol — unidentifiable for users
      if (!dest.symbol || dest.symbol.trim() === '') continue;

      // PATCH: cap destApy by 7d base + current reward (farmable-week frame).
      // G7: per-token reward discount instead of flat 0.6
      const destTokenDecay = rewardDecayFactor(dest, decayMap);
      const destRewardDiscount = Math.min(destTokenDecay + 0.2, 1.0);
      // X23+X28: fall back to min(mean30d, destBase) when no 7d data.
      // X23 used mean30d alone to avoid spikes, but over-ranks crashed pools.
      // min() is conservative: picks mean30d for spikes, current for crashes.
      const destBase7d = dest.apyBase7d != null ? dest.apyBase7d : Math.min(dest.apyMean30d || destBase, destBase);
      const destBlend7d = destBase7d + destReward * destRewardDiscount;
      const destApyBlended = Math.min(destApy, Math.max(destBlend7d, (dest.apyMean30d || destApy) * 1.5));
      // X199: Cap blended APY at reward-discounted total — mean30d*1.5 override was negating
      // tokenDecay for emission-heavy pools (e.g., 67% rewards → 37% overstatement).
      const rewardAdjDestApy = destBase + destReward * destRewardDiscount;
      const destApyBlendedCapped = Math.min(destApyBlended, rewardAdjDestApy);

      // G1 FIX: discount V3 concentrated LP headline APY to passive-LP realized APY.
      // X37: Apply CLM discount to BOTH base and rewards — CLM reward distribution
      // is concentration-dependent (passive LP earns proportionally less).
      const v3Factor = clmRealizedFactor(dest);
      let destApyCapped = v3Factor < 1.0
        ? destBase * v3Factor + destReward * v3Factor * destRewardDiscount
        : destApyBlendedCapped;

      // X8 FIX: cap post-V3-discount APY at realistic passive-LP ceiling.
      // Extremely concentrated V3 pools (3000%+ raw) still show 600%+ after 0.2x discount.
      // No passive LP sustainably earns >200% on volatile pairs or >80% on stables.
      if (v3Factor < 1.0) {
        destApyCapped = Math.min(destApyCapped, v3PassiveApyCap(dest));
      }

      // X7 FIX: spike/outlier discount using DefiLlama prediction data.
      // Carry trades need sustained yield — pools predicted to crash are worthless.
      // Uses DefiLlama's own ML predictions + outlier flag + 1d spike magnitude.
      const pred = dest.predictions || {};
      const isDown = pred.predictedClass === 'Down';
      const downProb = pred.predictedProbability || 0;
      const isOutlier = dest.outlier === true;
      const apyPct1D = Math.abs(dest.apyPct1D || 0);
      // X58: extreme outlier = outlier + no predictions + absurd base APY (>200%)
      const isExtremeOutlier = isOutlier && !pred.predictedClass && destBase > 200;
      let spikeFactor = 1.0;
      if (isExtremeOutlier) {
        spikeFactor = 0.1; // X58: data artifact — 298,000% vaults etc.
      } else if (isDown && downProb >= 80) {
        // Predicted to decline with high confidence
        spikeFactor = isOutlier ? 0.1 : 0.3;
      } else if (isOutlier && isDown) {
        // X52: outlier + Down below 80% — moderate discount. Previously got 1.0x,
        // worse than outlier+noPrediction (0.5x). Inversion fix.
        spikeFactor = 0.4;
      } else if (isOutlier && apyPct1D > 200) {
        // Not predicted Down but spiked hard and is an outlier
        spikeFactor = 0.4;
      } else if (isOutlier && !pred.predictedClass) {
        // X10: outlier with no prediction data = too new for DefiLlama to assess.
        // Brand-new outlier pools are unproven — apply moderate discount.
        spikeFactor = 0.5;
      }
      const preSpikeApy = destApyCapped; // X163: save for display — show headline, not factor
      if (spikeFactor < 1.0) {
        destApyCapped = destApyCapped * spikeFactor;
      }

      // X5+X6 FIX: apply per-protocol realized-APY ratio from empirical 30d data.
      // X6: Only apply full realized discount to emission-dependent destinations (reward > base).
      // Base-yield destinations in heterogeneous protocols (curve, convex) get floor of 0.7
      // since their base yields aren't driven by the emission over-promise pattern.
      const destProj = (dest.project || '').toLowerCase();
      const hasRealizedData = destProj in realizedRatios;
      const rawRealizedFactor = hasRealizedData ? realizedRatios[destProj] : 0.9; // X63: unknown protocols get 0.9x uncertainty discount
      const destEmissionPct = destApy > 0 ? (destReward / destApy) * 100 : 0;
      const realizedFactor = destEmissionPct > 50 ? rawRealizedFactor : Math.max(rawRealizedFactor, 0.7);
      const noRealizedData = !hasRealizedData;
      const preRealizedApy = destApyCapped; // X170: save for display — show headline alongside adjusted
      if (realizedFactor < 1.0) {
        destApyCapped = destApyCapped * realizedFactor;
      }

      const grossSpread = destApyCapped - b.netBorrowCost;
      if (grossSpread < 3) continue;

      const sameChain = b.chain.toLowerCase() === dest.chain.toLowerCase();
      // G6 FIX: chain-specific bridge + gas costs instead of flat 0.3%
      // X79: same-chain gas cost — Ethereum carry requires ~4 txs ($60 gas), making
      // small-capital trades net-negative. Compute minEconomicalUsd from chain gas.
      let bridgeInfo;
      if (sameChain) {
        const sameChainMinCap = sameChainMinCapital(dest.chain, grossSpread, 4);
        bridgeInfo = { bridgeCostPercent: 0, minEconomicalUsd: sameChainMinCap > 10 ? sameChainMinCap : 0, totalFixedGas: 0, bridgeFee: 0 };
      } else {
        bridgeInfo = crossChainCost(b.chain, dest.chain, capitalUsd);
      }
      const bridgeCost = bridgeInfo.bridgeCostPercent;
      const netSpread = grossSpread - bridgeCost;
      if (netSpread < 2) continue;

      const sustainability = destBase > destReward ? 'REAL_YIELD' : destReward > destBase * 3 ? 'EMISSION_HEAVY' : 'MIXED';
      const decayRatio = (dest.apyMean30d || destApy) > 0 ? destApy / (dest.apyMean30d || destApy) : 1;

      // X23: 7d stability discount — when recent 7d APY is significantly below adjusted headline,
      // the yield is decaying and the headline over-promises. Penalize score to favor stable yields.
      // Only applies when we have real 7d data (not fallback) and destApyCapped > 2% (avoid div-by-zero noise).
      // X88: Apply same CLM + spike adjustments to 7d data for apples-to-apples comparison.
      // Raw 7d vs adjusted headline makes CLM pools look like they're always growing (raw >> adjusted by definition).
      const has7dData = dest.apyBase7d != null;
      const adjBase7d = v3Factor < 1.0
        ? Math.min(destBase7d * v3Factor, v3PassiveApyCap(dest)) * (spikeFactor < 1.0 ? spikeFactor : 1.0)
        : destBase7d * (spikeFactor < 1.0 ? spikeFactor : 1.0);
      const decayRatio7d = destApyCapped > 2 ? adjBase7d / destApyCapped : 1.0;
      let stabilityFactor = 1.0;
      // X105: detect BOTH directions of instability:
      // - 7d < headline (existing): headline over-promises, 7d is worse → decay penalty
      // - 7d > headline (new): pool recently dropped, 7d lags behind → declining label + risk
      const isDeclining = has7dData && decayRatio7d >= 1.3; // X117: lowered from 1.5 — 7d avg 30%+ above current = recent drop. X170: >= not > (boundary fix, same as X125)
      const isRapidlyDeclining = has7dData && decayRatio7d >= 2.0; // 7d avg 2x+ current = pool halved
      // X107: predicted-declining detection for no-7d-data pools.
      // When has7dData=false, X105 declining detection is blind. Use DefiLlama prediction
      // + mean30d/current ratio as fallback. Both signals must agree (prediction AND trend).
      const mean30dRatio = (dest.apyMean30d && destBase > 0) ? dest.apyMean30d / destBase : 1.0;
      const isPredictedDeclining = !has7dData && isDown && mean30dRatio > 1.3;
      // X220: rate-elevated detection for no-7d-data pools. When current APY > 1.5x mean30d,
      // the rate is anomalously high and likely to revert. Without 7d data to verify sustainability,
      // mean30d is the best estimate of "normal" rate. BTC.B gmx-v2-perps: 38% current vs 17% mean30d
      // (2.2x elevation) → displayed +25.6% net carry, but mean reversion gives +11.6% (55% overstatement).
      const isElevatedRate = !has7dData && dest.apyMean30d > 0 && mean30dRatio < 0.83; // X252: widened from 0.65 — any ratio <0.83 means headline overstates by >20% if rate reverts to mean (±20% mandate)
      if (has7dData && decayRatio7d < 0.4) {
        stabilityFactor = 0.5; // severe decay: 7d < 40% of headline
      } else if (has7dData && decayRatio7d < 0.65) {
        stabilityFactor = 0.7; // moderate decay: 7d is 40-65% of headline
      } else if (has7dData && decayRatio7d < 0.83) {
        // X116: mild decay tier — 7d is 65-83% of headline. Headline overstates by >20%,
        // violating ±20% mandate. WSOL-PIPPIN: 48% headline, 32% 7d (ratio 0.67) showed
        // +42.3% net carry when conservative gives +26.3% — 61% overstatement.
        stabilityFactor = 0.9;
      } else if (!has7dData && isPredictedDeclining) {
        // X107: no 7d data but DefiLlama predicts Down AND mean30d confirms decline.
        // Stronger than X53 (0.85x) because we have active evidence of decline.
        stabilityFactor = 0.7;
      } else if (isRapidlyDeclining) {
        // X115: pool halved recently (7d avg > 2x current) — high chance of continued decline
        stabilityFactor = 0.7;
      } else if (has7dData && decayRatio7d >= 1.5) {
        // X115: pool dropped 50%+ from 7d avg — moderate decline, conservative display
        stabilityFactor = 0.85;
      } else if (isDeclining) {
        // X117: mild decline — 7d avg 30-50% above current. Pool dropped recently,
        // may continue declining. fluid-dex USDC-ETH (ratio 1.47) fell in the gap
        // between isDeclining=1.5 and no penalty — no [DECLINING] label despite 32% drop.
        stabilityFactor = 0.9;
      } else if (!has7dData && isElevatedRate && mean30dRatio < 0.5) {
        // X220: severe elevation — current > 2x mean30d. Rate likely anomalous spike.
        stabilityFactor = 0.7;
      } else if (!has7dData && isElevatedRate && mean30dRatio < 0.65) {
        // X220: moderate elevation — current 1.5-2x mean30d. Rate above historical norm.
        stabilityFactor = 0.8;
      } else if (!has7dData && isElevatedRate) {
        // X252: mild elevation — current 1.2-1.5x mean30d. Headline overstates by 20-54%.
        // Mirrors X116 mild decay tier. BTC.B gmx-v2-perps: 29% current vs 19% mean30d (ratio 0.65)
        // displayed +27.4% carry when mean-reversion gives +18.9% — 45% overstatement.
        stabilityFactor = 0.9;
      } else if (!has7dData) {
        // X53: no 7d track record — can't verify stability, mild uncertainty discount.
        // Prevents new/untracked pools from systematically outranking established ones.
        stabilityFactor = 0.85;
      }

      // X22: bag-trap detection — low-TVL IL-exposed destinations are liquidity traps.
      // $5k into a $200k pool = 2.5% of pool; exit slippage in downturns = devastating.
      const isBagTrap = (dest.tvlUsd || 0) < 500000 && dest.ilRisk === 'yes';
      const bagTrapFactor = isBagTrap ? 0.3 : 1.0;

      // X197: Micro-TVL destination score discount — parity with YIELD (X97) and SPREAD (X109).
      // maxapy at $409K TVL scored above established pools because log10 TVL scaling is too weak
      // (28x TVL difference → 1.26x score difference). Single-sided micro-TVL dests escape bagTrap.
      const isMicroDest = !isBagTrap && (dest.tvlUsd || 0) < 500000;
      const microDestFactor = isMicroDest ? 0.3 : 1.0;


      // X109: Leveraged farming protocol detection
      const isLeveragedProj = LEVERAGED_PROJS.has(dest.project);
      const isLeveragedLp = isLeveragedProj && dest.ilRisk === 'yes'; // LP pools have leveraged APY baked in

      // X170+X211: CeDeFi (Centralized DeFi) counterparty risk detection.
      // Protocols managing user funds via centralized entities with off-chain yield strategies.
      // Counterparty risk: Celsius, BlockFi, FTX Earn, Babel Finance all collapsed with total fund loss.
      // X211: Curated CEDEFI_PROJS set — substring "cedefi" only catches self-labeling protocols
      // (zerobase-cedefi). bitway(BSC) at 12% on stablecoins with no emissions/7d/realized data
      // is centralized custody but escaped detection. Set also catches future CeDeFi additions.
      const isCedefi = CEDEFI_PROJS.has((dest.project || '').toLowerCase()) ||
                       (dest.project || '').toLowerCase().includes('cedefi');

      // X224: RWA/credit protocol — real-world lending with borrower default risk
      const isRwaCredit = RWA_CREDIT_PROJS.has((dest.project || '').toLowerCase());

      // X24: LP counterparty risk — when destination is an LP pair, the user needs both
      // tokens. If the "other" token is a meme/micro-cap, IL risk is extreme.
      // SOL borrow → SOL-FARTCOIN LP means buying FARTCOIN; if FARTCOIN dumps 90%,
      // IL destroys the position regardless of the headline APY.
      const lpRisk = lpCounterpartyRisk(b.symbol, dest.symbol);
      const hasRiskyLp = lpRisk.isLpPair && lpRisk.hasRiskyCounterparty;
      const riskyLpFactor = hasRiskyLp ? 0.3 : 1.0;

      // X41: IL risk penalty for volatile LP destinations.
      // LP pairs with different-asset types (USDC-ETH, SOL-USDC) have real IL risk
      // even when both are major assets. Stablecoin pairs and correlated pairs are exempt.
      const isVolatileLpRaw = lpRisk.isLpPair && dest.ilRisk === 'yes' &&
        !dest.stablecoin && !/USD.*USD|DAI.*USD|FRAX.*USD|EUR.*EUR/i.test((dest.symbol||'').toUpperCase()) &&
        !(/STETH|CBETH|RETH|SETH|METH|ARBWETH|AARBWETH|WBETH|EETH|EZETH|WEETH|RSETH|SWETH|OSETH|ANKETH/i.test((dest.symbol||'').toUpperCase()) && /ETH.*ETH/i.test((dest.symbol||'').toUpperCase())) &&
        !(dest.ilRisk === 'no');

      // X245: Perps LP detection — any deposit into a perps protocol has counterparty risk
      // to leveraged traders. Applies to both volatile LP (WBTC-USDC on gmx) and single-sided
      // (USDC on avantis). X232 originally required isVolatileLpRaw but that missed single-sided.
      const isPerpsLp = PERPS_LP_PROJS.has(dest.project);
      const isVolatileLp = isVolatileLpRaw && !isPerpsLp;

      // X161: Unverified micro volatile LP penalty — low-TVL volatile LP pools with no 7d data
      // have APY driven by temporary trading volume spikes. gmx-v2-perps WBTC.B-USDC ($510k TVL,
      // 29.9% APY, no 7d) — fee APY from 1-2 days of high volume; unsustainable at that TVL.
      // Without 7d tracking we can't verify stability, and low TVL means user deposit dilutes APY.
      const isUnverifiedMicroLp = !isBagTrap && isVolatileLp && (dest.tvlUsd || 0) < 1000000 && !has7dData;
      const unverifiedMicroLpFactor = isUnverifiedMicroLp ? 0.5 : 1.0;

      // X178: Non-major borrowed token risk — borrowing non-major tokens (AVLT, MON, etc.)
      // has thin borrow market risk: rate spikes (utilization jumps), TVL evaporation,
      // and protocol-specific risk. AVLT at $2M borrow TVL, risk 3/10 = same as USDC carry.
      const isNonMajorBorrow = !KNOWN_MAJORS.has(b.symbol);

      // X279: tightCarry score penalty — borrow cost >50% of dest yield means a 20% borrow
      // rate increase eliminates >20% of net carry (±20% mandate violation). Non-major borrow
      // compounds this: thin markets spike 50-100% intra-day, making tight carry near-certain to fail.
      const isTightCarry = b.netBorrowCost > 8 && destApyCapped > 0 && b.netBorrowCost / destApyCapped > 0.5;
      const tightCarryFactor = isTightCarry ? (isNonMajorBorrow ? 0.5 : 0.7) : 1.0;

      let risk = 3;
      // X166: Tiered cross-chain bridge risk (parity with SPREAD in loops.js/index.js X140).
      // EVM↔EVM +1 (canonical bridges), EVM↔non-EVM +2 (Wormhole/deBridge), EVM↔hard-bridge +3 (Axelar/IBC/CEX).
      if (!sameChain) {
        const srcLc = b.chain.toLowerCase();
        const dstLc = dest.chain.toLowerCase();
        if (HARD_BRIDGE_CHAINS.has(srcLc) || HARD_BRIDGE_CHAINS.has(dstLc)) risk += 3;
        else if (NON_EVM_CHAINS.has(srcLc) || NON_EVM_CHAINS.has(dstLc)) risk += 2;
        else risk += 1;
      }
      if (sustainability === 'EMISSION_HEAVY') risk += 1;
      if (decayRatio > 2) risk += 1;
      if (Math.min(b.tvl, dest.tvlUsd) < 500000) risk += 1;
      if ((dest.tvlUsd || 0) < 1000000) risk += 1; // X50: small dest pool = liquidity + smart contract risk
      if (isBagTrap) risk += 2; // X22: bag-trap destination = high IL + slippage risk
      if (hasRiskyLp) risk += 2; // X24: meme/micro-cap counterparty = extreme IL risk
      if (isVolatileLp) risk += 1; // X41: volatile LP pair = meaningful IL risk
      if (isPerpsLp) risk += 1; // X232: perps LP = trader counterparty risk (same magnitude as IL)
      if (b.netBorrowCost > (isNonMajorBorrow ? 8 : 15)) risk += 1; // X236: high borrow cost risk — non-major tokens spike faster (thin lending markets), lower threshold
      if (spikeFactor < 1.0) risk += 2; // X7: spiking/outlier destination = high risk of APY reversion
      if (spikeFactor < 1.0 && isDown) risk += 1; // X169: predicted-to-decline spike — even discounted APY unlikely to persist
      if (noRealizedData && !has7dData) risk += 1; // X79: zero empirical data = unverified protocol
      if (isDeclining) risk += 1; // X170: mild decline (7d avg 30%+ above current) — rate dropping, label says [DECLINING] but risk should reflect it
      if (isRapidlyDeclining) risk += 1; // X105: pool recently halved — current rate may continue dropping (stacks with isDeclining)
      if (isPredictedDeclining) risk += 1; // X107: DefiLlama predicts Down + mean30d confirms decline
      if (isElevatedRate) risk += 1; // X236: rate elevated above historical avg — likely to revert (parity with isDeclining/isPredictedDeclining)
      if (isLeveragedLp) risk += 2; // X109: leveraged LP = APY includes leverage + internal liquidation risk
      else if (isLeveragedProj) risk += 1; // X109: leveraged protocol = higher smart contract complexity
      if (isCedefi) risk += 2; // X171: CeDeFi = centralized custody (Celsius/BlockFi/FTX Earn precedent)
      if (isRwaCredit) risk += 2; // X224: RWA credit = borrower default risk (Goldfinch/Maple precedent)
      if (v3Factor < 1.0) risk += 1; // X173: V3/concentrated LP destination requires active range management — not passive staking
      if (isNonMajorBorrow) risk += 1; // X178: non-major borrow token = thin market, rate spike risk
      // X88: Removed risk -= 1 for borrowReward. Borrow rewards reduce net cost (already
      // captured in netBorrowCost and score) but don't reduce destination counterparty risk.
      // zerobase-cedefi (unknown protocol, no 7d data) was showing risk 2/10 — same as
      // proven pendle yields — because compound-v3 USDT has COMP borrow rewards.

      const maxLeverage = b.ltv > 0 ? 1 / (1 - b.ltv) : 1;
      // X181: Cap displayed leverage at 10x (parity with shortfarm.js). At >10x the liquidation
      // buffer is <10% — a single bad block can liquidate. 33.6x showing "294.6%" is unrealistic.
      // Raw maxLeverage kept for leveragedRisk computation (risk should reflect true leverage).
      const displayMaxLeverage = Math.min(maxLeverage, 10);

      // X103: Conservative display APY for decaying pools.
      // When stabilityFactor < 1.0, show 7d-based estimate as primary to prevent
      // displaying "+31% carry" when 7d reality is ~15% (±20% mandate violation).
      // Rewards preserved as separate emission stream (don't track base fee decay).
      // X105: Only use conservative DISPLAY for real 7d decay, NOT for no-data uncertainty (X53).
      // No-data pools get 0.85x in score (correct) but showing conservativeDestApy
      // as primary is confusing — the 0.85x value is arbitrary, not empirical.
      // X115: Only use conservative (lower) display for actual decay (7d < headline).
      // Declining pools (7d > headline, ratio > 1.5) have stabilityFactor < 1.0 too,
      // but using adjBase7d as primary would INFLATE the display (7d is higher than current).
      // fluid-dex USDC-ETH: showed +18.0% net (from 7d=24%) instead of +10.8% (from current 14%).
      const isDecayDisplay = has7dData && stabilityFactor < 1.0 && decayRatio7d < 1.0;
      // X208: predicted-declining display — isPredictedDeclining pools have stabilityFactor 0.7
      // but display showed full headline (43% overstatement, violating ±20% mandate).
      // Conservative estimate: destApyCapped * stabilityFactor (same belief encoded in score).
      const isPredDeclDisplay = isPredictedDeclining && stabilityFactor < 1.0;
      // X220: rate-elevated display — current >> mean30d, no 7d data to verify.
      // Conservative estimate: destApyCapped * stabilityFactor (same as isPredDeclDisplay).
      const isElevatedDisplay = isElevatedRate && stabilityFactor < 1.0;
      const conservativeReward = destReward * destRewardDiscount * (v3Factor < 1.0 ? v3Factor : 1.0) * (spikeFactor < 1.0 ? spikeFactor : 1.0) * (realizedFactor < 1.0 ? realizedFactor : 1.0);
      // X212: Cap conservative at headline — conservativeReward uses raw destReward with per-factor
      // discounts but misses v3PassiveApyCap. V3 pools with huge raw rewards (82094%) get
      // conservative = adjBase7d + 1478 >> destApyCapped = 20 (after v3Cap+spike+realized).
      // X235: Rate-elevated conservative cap — destApyCapped * stabilityFactor can still be
      // >20% above mean30d (e.g. 27% * 0.7 = 18.9% but mean30d = 15% → 26% overstatement).
      // Cap at mean30d * 1.2 to stay within ±20% mandate. mean30d is the best predictor of
      // where the rate will settle after the elevated period ends.
      const elevatedConservative = isElevatedDisplay
        ? Math.min(destApyCapped * stabilityFactor, dest.apyMean30d * 1.2)
        : destApyCapped * stabilityFactor;
      const conservativeDestApy = isDecayDisplay ? Math.min((adjBase7d * (realizedFactor < 1.0 ? realizedFactor : 1.0)) + conservativeReward, destApyCapped)
        : (isPredDeclDisplay || isElevatedDisplay) ? elevatedConservative : destApyCapped;
      const conservativeNet = (isDecayDisplay || isPredDeclDisplay || isElevatedDisplay) ? (conservativeDestApy - b.netBorrowCost - bridgeCost) : netSpread;
      // X153: Round to 2dp ONCE and reuse — avoids title/body mismatch where
      // raw float.toFixed(1) differs from parseFloat(float.toFixed(2)).toFixed(1)
      // due to IEEE 754 edge cases (e.g. 12.8501 → "12.9" raw, but 12.85 → "12.8" rounded)
      const conservativeNetR = parseFloat(conservativeNet.toFixed(2));
      const netSpreadR = parseFloat(netSpread.toFixed(2));

      carries.push({
        token: b.symbol,
        borrowFrom: b.project + ' (' + b.chain + ')',
        borrowRate: parseFloat(b.borrowRate.toFixed(2)),
        borrowReward: parseFloat(b.borrowReward.toFixed(2)),
        netBorrowCost: parseFloat(b.netBorrowCost.toFixed(2)),
        ltv: parseFloat((b.ltv * 100).toFixed(0)),
        maxLeverage: parseFloat(displayMaxLeverage.toFixed(1)),
        stakeIn: dest.project + ' (' + dest.chain + ')',
        stakePool: dest.pool,
        stakeApy: parseFloat(destApyCapped.toFixed(2)),
        stakeApyRaw: parseFloat(destApy.toFixed(2)),
        stakeBaseApy: parseFloat(destBase.toFixed(2)),
        stakeBase7d: parseFloat(adjBase7d.toFixed(2)),
        stakeBase7dRaw: v3Factor < 1.0 || spikeFactor < 1.0 ? parseFloat(destBase7d.toFixed(2)) : undefined,
        stakeRewardApy: parseFloat(destReward.toFixed(2)),
        yieldSustainability: sustainability,
        grossSpread: parseFloat(grossSpread.toFixed(2)),
        netSpread: parseFloat(netSpread.toFixed(2)),
        // X103: conservative net spread for decaying pools — uses 7d-based APY estimate
        // X208: pass conservativeNet for both decay AND predicted-declining display
        conservativeNet: (isDecayDisplay || isPredDeclDisplay || isElevatedDisplay) ? conservativeNetR : undefined,
        rateElevated: isElevatedRate || undefined, // X220: current >> mean30d, rate likely to revert
        leveragedSpread: parseFloat((netSpread * displayMaxLeverage).toFixed(2)),
        sameChain,
        // X166: bridge type for tiered risk display
        hardBridge: !sameChain && (HARD_BRIDGE_CHAINS.has(b.chain.toLowerCase()) || HARD_BRIDGE_CHAINS.has(dest.chain.toLowerCase())) || undefined,
        nonEvmBridge: !sameChain && !HARD_BRIDGE_CHAINS.has(b.chain.toLowerCase()) && !HARD_BRIDGE_CHAINS.has(dest.chain.toLowerCase()) && (NON_EVM_CHAINS.has(b.chain.toLowerCase()) || NON_EVM_CHAINS.has(dest.chain.toLowerCase())) || undefined,
        bridgeCostPercent: sameChain ? 0 : parseFloat(bridgeCost.toFixed(2)),
        minEconomicalUsd: bridgeInfo.minEconomicalUsd,
        risk: Math.max(1, Math.min(10, risk)),
        borrowTvl: b.tvl,
        stakeTvl: dest.tvlUsd,
        stablecoin: dest.stablecoin || false,
        v3Discounted: v3Factor < 1.0,
        v3Factor: v3Factor < 1.0 ? v3Factor : undefined,
        realizedApyRatio: realizedFactor < 0.955 ? realizedFactor : undefined, // X220: suppress ≥96% (noise — ≤4% gap not actionable)
        noRealizedData: noRealizedData || undefined,
        spikeDiscounted: spikeFactor < 1.0,
        spikeFactor: spikeFactor < 1.0 ? spikeFactor : undefined,
        bagTrap: isBagTrap,
        riskyLp: hasRiskyLp,
        riskyLpTokens: hasRiskyLp ? lpRisk.riskyTokens : undefined,
        volatileLp: isVolatileLp,
        perpsLp: isPerpsLp || undefined, // X232: perps LP = trader counterparty risk, not IL
        lpPairSymbol: lpRisk.isLpPair ? dest.symbol : undefined,
        // SHORT_FARM MERGE (consolidation 2026-05): the retired shortfarm scanner's signal is
        // preserved here as annotations. Borrowing a volatile asset is implicitly a short of it,
        // so a carry that borrows a non-stable token IS a "short-farm". singleSided +
        // dumpableReward flag the destinations shortfarm used to prioritize (single-stake venues
        // whose reward emissions can be dumped for stables). No score change — annotation only.
        singleSided: !lpRisk.isLpPair || undefined,
        dumpableReward: destReward > 0 ? parseFloat(destReward.toFixed(2)) : undefined,
        shortThesis: !/^(USD|DAI|FRAX|PYUSD|USDE|GHO|LUSD|SUSD|TUSD|USDS|FDUSD|USD1|EUR|MIM|CRVUSD)/i.test(b.symbol || '')
          ? `Borrowing ${b.symbol} is implicitly short ${b.symbol}: if it drops you profit on the borrow leg AND keep the yield.`
          : undefined,
        lowTvlDest: (dest.tvlUsd || 0) < 1000000 || undefined,
        stabilityFactor: stabilityFactor < 1.0 ? stabilityFactor : undefined,
        no7dData: !has7dData || undefined,
        decayRatio7d: has7dData ? parseFloat(decayRatio7d.toFixed(2)) : undefined,
        declining: isDeclining || undefined, // X105: 7d avg >> current = pool recently dropped
        decaying: isDecayDisplay || undefined, // X256: 7d < current, yield decaying from headline
        predictedDeclining: isPredictedDeclining || undefined, // X107: DefiLlama predicts Down + mean30d confirms
        leveragedProj: isLeveragedProj || undefined, // X109: leveraged farming protocol destination
        cedefi: isCedefi || undefined, // X171: CeDeFi = centralized custody counterparty risk
        rwaCredit: isRwaCredit || undefined, // X224: RWA credit = borrower default risk
        nonMajorBorrow: isNonMajorBorrow || undefined, // X178: non-major borrow token = thin market risk
        tightCarry: (b.netBorrowCost > 8 && destApyCapped > 0 && b.netBorrowCost / destApyCapped > 0.5) || undefined, // X236: high borrow cost relative to dest yield — small rate changes eliminate return
        // X88+X102: Compute leveraged risk for display when leverage > 2x
        // Same formula as RECURSIVE X39: +1 >3x, +2 >5x, +3 >8x
        // X102: removed Math.min(maxLeverage, 5) from penalty tiers — was capping leverage at 5
        // before checking >5x and >8x tiers, making those penalties unreachable (dead code).
        leveragedRisk: sameChain && maxLeverage > 2 ? Math.min(10, Math.max(1, Math.min(10, risk)) + (maxLeverage > 15 ? 4 : maxLeverage > 8 ? 3 : maxLeverage > 5 ? 2 : maxLeverage > 3 ? 1 : 0) + 1) : undefined,
        // X103: When decaying, show conservative (7d-based) APY as primary with headline in parens
        // Matches shortfarm.js approach — prevents "+31% carry" when 7d reality is ~15%
        // X104: Don't show fake "7d=X%" when has7dData is false — adjBase7d is a fallback estimate
        action: 'Borrow ' + b.symbol + ' from ' + b.project + '(' + b.chain + ') at ' + b.netBorrowCost.toFixed(1) + '% -> stake in ' + dest.project + '(' + dest.chain + ')' + (lpRisk.isLpPair ? ' ' + dest.symbol : '') + ' at ' + (isDecayDisplay ? conservativeDestApy.toFixed(1) + '% (headline ' + destApyCapped.toFixed(0) + '%' + ', 7d=' + adjBase7d.toFixed(0) + '%' + ')' : isPredDeclDisplay ? conservativeDestApy.toFixed(1) + '% (current ' + destApyCapped.toFixed(0) + '%, predicted declining)' : isElevatedDisplay ? conservativeDestApy.toFixed(1) + '% (current ' + destApyCapped.toFixed(0) + '%, rate elevated above 30d avg)' : destApyCapped.toFixed(1) + '%') + (v3Factor < 1.0 ? ' (passive-LP adjusted from ' + destApy.toFixed(0) + '%)' : '') + (spikeFactor < 1.0 ? ' (spike-adjusted from ' + preSpikeApy.toFixed(0) + '%' + (isDown ? ' — predicted to decline' : isExtremeOutlier ? ' — likely data artifact' : ' — outlier spike') + ')' : '') + (realizedFactor < 0.955 && !noRealizedData ? ' (headline ' + preRealizedApy.toFixed(0) + '%, realized ' + (realizedFactor * 100).toFixed(0) + '%)' : '') + (isPredDeclDisplay ? '' : isElevatedDisplay ? '' : !has7dData ? '' : isDecayDisplay ? '' : ' (7d ' + adjBase7d.toFixed(0) + '%)') + ' = +' + ((isDecayDisplay || isPredDeclDisplay || isElevatedDisplay) ? conservativeNetR.toFixed(1) : netSpreadR.toFixed(1)) + '% carry' + (sameChain && maxLeverage > 2 ? (() => { const dispLevRisk = Math.min(10, Math.max(1, Math.min(10, risk)) + (maxLeverage > 15 ? 4 : maxLeverage > 8 ? 3 : maxLeverage > 5 ? 2 : maxLeverage > 3 ? 1 : 0) + 1); return ' (up to ' + displayMaxLeverage.toFixed(1) + 'x = ' + (((isDecayDisplay || isPredDeclDisplay || isElevatedDisplay) ? conservativeNetR : netSpreadR) * displayMaxLeverage).toFixed(1) + '%, risk ' + dispLevRisk + '/10 at leverage)'; })() : ''),
        // X118: Use conservativeNet for decaying pool score — netSpread uses headline APY but
        // display shows 7d-based conservativeNet. Using netSpread * stabilityFactor(0.9) still
        // overrates by up to 43% (WSOL-PIPPIN: scored on 40.86*0.9=36.8, displayed 25.7).
        // ±20% mandate requires score to reflect displayed value.
        // X160: removed realizedFactor and spikeFactor from score — already baked into
        // destApyCapped (line 355 spike, line 369 realized) which flows into netSpread.
        // Double-counting penalized entries with known realized data (pendle 0.96, yo-protocol
        // 0.87) by factor^2 instead of factor^1, under-ranking established protocols.
        unverifiedMicroLp: isUnverifiedMicroLp || undefined, // X162: low-TVL volatile LP with no 7d data
        score: ((isDecayDisplay || isPredDeclDisplay || isElevatedDisplay) ? conservativeNet : netSpread) * Math.log10(Math.min(b.tvl, dest.tvlUsd || 1)) * (sustainability === 'REAL_YIELD' ? 1.5 : sustainability === 'MIXED' ? 1.0 : 0.5) * bagTrapFactor * microDestFactor * riskyLpFactor * ((isDecayDisplay || isPredDeclDisplay || isElevatedDisplay) ? 1.0 : stabilityFactor) * (isLeveragedLp ? 0.3 : 1.0) * unverifiedMicroLpFactor * tightCarryFactor / Math.max(risk, 1),
      });
    }
  }

  carries.sort((a, b) => b.score - a.score);

  // PATCH: dedupe by destination pool — keep only best borrow-source per dest.
  // Prevents "top 10 carry" being the same destination pool with 10 different borrow sources.
  const seenDests = new Set();
  const dedupedByPool = carries.filter(c => {
    const key = c.stakePool || (c.stakeIn + '|' + c.fullSymbol);
    if (seenDests.has(key)) return false;
    seenDests.add(key);
    return true;
  });

  // PATCH X46: dedupe by token+borrow+destProject — different pools on the same
  // destination protocol (e.g. Pendle maturities, Raydium pairs for the same token)
  // waste carry slots. Keep only the highest-scored entry per trade concept.
  const seenTrades = new Set();
  const deduped = dedupedByPool.filter(c => {
    const key = c.token + '|' + c.borrowFrom + '|' + c.stakeIn;
    if (seenTrades.has(key)) return false;
    seenTrades.add(key);
    return true;
  });

  const stableCarries = deduped.filter(c => c.stablecoin);
  const volatileCarries = deduped.filter(c => !c.stablecoin);
  const freeBorrow = deduped.filter(c => c.netBorrowCost <= 0);

  return {
    timestamp: new Date().toISOString(),
    total_found: carries.length,
    borrowable_markets: borrowable.length,
    top_carries: deduped.slice(0, 30),
    top_stable_carries: stableCarries.slice(0, 15),
    top_volatile_carries: volatileCarries.slice(0, 15),
    free_borrow_carries: freeBorrow.slice(0, 15),
    note: 'Real borrow rates from Aave/Compound/Morpho/etc. Net spread after borrow cost and bridge fees. LTV and max leverage shown.',
  };
}
