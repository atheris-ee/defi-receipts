// Pool resolver — turns (project, chain, symbol) into a one-click deposit URL
// by reading on-chain state (or a static template, for protocols where chain+
// underlying-token is enough). No reliance on DefiLlama's paid pool-URL routing.
//
// Resolvers implemented:
//   - aave-v3      : reserve-overview URL keyed by underlying token address
//                    (no RPC needed — Aave reserves are addressed by underlying)
//   - uniswap-v3   : factory.getPool(t0, t1, fee) → exact pool address
//                    → app.uniswap.org/explore/pools/<chain>/<pool>
//
// Cache:
//   /var/lib/defi-tracker-dashboard/pool-resolver-cache.json
//   Positive resolutions never expire (pool addresses don't change).
//   Negative resolutions expire after 1h (the pool may be created later).
//
// CLI:
//   node pool-resolver.mjs aave-v3 base USDC
//   node pool-resolver.mjs uniswap-v3 base WETH-USDC
//   node pool-resolver.mjs --warm
//   node pool-resolver.mjs --dump

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHAINS, CHAIN_NAME_TO_KEY } from './chains.mjs';
import { ethCall, ethCallBatch, encAddr, encUint, decAddr, decUint, sortTokens, ZERO_ADDR } from './rpc.mjs';

const CACHE_PATH = process.env.RESOLVER_CACHE
  || new URL('../state/pool-resolver-cache.json', import.meta.url).pathname;
const NEG_TTL_MS = 60 * 60 * 1000;   // retry negatives every hour
const WARM_INTERVAL_MS = 60 * 1000;  // warmer tick
const INFLIGHT = new Map();          // dedupe concurrent resolutions

// ---- protocol resolver registry -----------------------------------------

const RESOLVERS = {
  'aave':                  resolveAaveV3,
  'aave-v3':               resolveAaveV3,
  'aave-v2':               resolveAaveV3,   // best-effort; v3 market URL is usually still right
  'uniswap':               resolveUniswapV3,
  'uniswap-v3':            resolveUniswapV3,
  'aerodrome':             resolveAerodromeV1,
  'aerodrome-v1':          resolveAerodromeV1,
  'aerodrome-slipstream':  resolveAerodromeSlipstream,
  'pendle':                resolvePendle,    // search-pre-filtered list; no RPC
};

// Aave V3 market URL parameter per chain key (CHAINS.<key>.label-derived).
const AAVE_MARKET = {
  ethereum:  'proto_mainnet_v3',
  polygon:   'proto_polygon_v3',
  arbitrum:  'proto_arbitrum_v3',
  optimism:  'proto_optimism_v3',
  base:      'proto_base_v3',
  avalanche: 'proto_avalanche_v3',
  bsc:       'proto_bnb_v3',
};

// Uniswap V3 factory per chain. Most chains share the canonical address;
// Base, BNB, Avalanche, Celo are exceptions.
const UNIV3_FACTORY = {
  ethereum:  '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  polygon:   '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  arbitrum:  '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  optimism:  '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  base:      '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  avalanche: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
  bsc:       '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
};

// Uniswap interface chain slug (the path segment in /explore/pools/<slug>/...).
const UNIV3_SLUG = {
  ethereum: 'ethereum', polygon: 'polygon', arbitrum: 'arbitrum',
  optimism: 'optimism', base: 'base', avalanche: 'avalanche', bsc: 'bnb',
};

// Symbol → CHAINS.<chain>.tokens key aliases. Order: per-chain override beats global.
const GLOBAL_ALIASES = { ETH: 'WETH', BTC: 'WBTC', WBNB: 'WBNB' };
const CHAIN_ALIASES = {
  base:      { BTC: 'CBBTC' },
  avalanche: { BTC: 'BTC.B', AVAX: 'WAVAX' },
  polygon:   { MATIC: 'WMATIC' },
  bsc:       { BTC: 'BTCB', BNB: 'WBNB', ETH: 'ETH' /* BSC ETH = bridged 0x2170 */ },
};

// Tokens not in CHAINS.<chain>.tokens (which is portfolio-focused) but needed
// for one-click protocol deposits. Layered on top of CHAINS at lookup time.
const EXTRA_TOKENS = {
  ethereum: {
    LINK:   '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    GHO:    '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f',
    FDUSD:  '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
    USDG:   '0xe343167631d89B6Ffc58B88d6b7fB0228795491D',
    OSETH:  '0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38',
    CBBTC:  '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    AAVE:   '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    RPL:    '0xD33526068D116cE69F19A9ee46F0bd304F21A51f',
    USDE:   '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
    SUSDE:  '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    AERO:   '0x940181a94A35A4569E4529A3CDfB74e38FD98631',   // bridged from Base, not used much
    WEETH:  '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee',
    PYUSD:  '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',
    CRVUSD: '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E',
  },
  arbitrum: {
    LINK:   '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    GHO:    '0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33',
    CBBTC:  '0xa8E0e2A3aaf45b6F25b5e1c3b3D7F7B5db2A1E5a',  // confirm before relying on it
  },
  base: {
    GHO:    '0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee',
    AERO:   '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    USDBC:  '0xd9aAEC86B65D86f6A7B5B1b0c42FFA531710b6CA',
    EURC:   '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
  },
  polygon: {
    LINK:   '0xb0897686c545045aFc77CF20eC7A532E3120E0F1',
    MATIC:  '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',   // alias for WMATIC
    AAVE:   '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
  },
  optimism: {
    LINK:   '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6',
  },
  avalanche: {
    AVAX:   '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',   // WAVAX
    SAVAX:  '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE',
  },
  bsc: {
    FDUSD:  '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
    CAKE:   '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
  },
};

// Aerodrome on Base.
const AERO_V1_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';   // sAMM/vAMM pools
const AERO_CL_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A';   // Slipstream (concentrated)
const AERO_CL_TICK_SPACINGS = [1, 50, 100, 200, 2000];                 // probe order

// Function selectors (4-byte keccak256 prefix). Verified via 4byte.directory
// against multiple candidates — earliest registered = canonical.
const SEL_GET_POOL_U24 = '0x1698ee82';   // getPool(address,address,uint24)  — Uniswap V3 fee tier
const SEL_GET_POOL_I24 = '0x28af8d0b';   // getPool(address,address,int24)   — Aerodrome Slipstream tick spacing
const SEL_GET_POOL_BOOL = '0x393bf3ae';  // getPool(address,address,bool)    — Aerodrome V1 stable flag
const SEL_LIQUIDITY    = '0x1a686502';   // liquidity()                       — UniV3 / Aero Slipstream pools
const SEL_RESERVES     = '0x0902f1ac';   // getReserves()                     — Aero V1 / UniV2 pools

// Uniswap V3 fee tiers in probe order. Mixed-stable pools usually 500/100,
// volatile 3000, exotic 10000. We resolve them all and pick max-liquidity.
const FEE_TIERS = [100, 500, 3000, 10000];

// ---- core ---------------------------------------------------------------

function chainKeyOf(chainName) {
  if (!chainName) return null;
  const lc = String(chainName).toLowerCase();
  return CHAIN_NAME_TO_KEY[lc] || (CHAINS[lc] ? lc : null);
}

function tokenAddrOf(chainKey, symbolRaw) {
  const tokens = CHAINS[chainKey]?.tokens || {};
  const extras = EXTRA_TOKENS[chainKey] || {};
  const sym = String(symbolRaw || '').trim().toUpperCase();
  if (!sym) return null;
  // Direct hit in CHAINS or EXTRA_TOKENS
  if (tokens[sym]) return tokens[sym].addr;
  if (extras[sym]) return extras[sym];
  // Per-chain alias
  const chainAlias = CHAIN_ALIASES[chainKey]?.[sym];
  if (chainAlias) {
    if (tokens[chainAlias]) return tokens[chainAlias].addr;
    if (extras[chainAlias]) return extras[chainAlias];
  }
  // Global alias
  const globAlias = GLOBAL_ALIASES[sym];
  if (globAlias) {
    if (tokens[globAlias]) return tokens[globAlias].addr;
    if (extras[globAlias]) return extras[globAlias];
  }
  // Try mixed case keys (e.g. CHAINS has "USDC.e" / "BTC.B")
  for (const k of Object.keys(tokens)) {
    if (k.toUpperCase() === sym) return tokens[k].addr;
  }
  for (const k of Object.keys(extras)) {
    if (k.toUpperCase() === sym) return extras[k];
  }
  return null;
}

// "WETH-USDC" → ["WETH","USDC"]; "USDC" → ["USDC"]; "PT-SUSDE-7MAY2026" → null
function parsePairSymbol(symbol) {
  if (!symbol) return null;
  const s = String(symbol).trim();
  if (!s.includes('-')) return [s];
  const parts = s.split('-');
  // Reject Pendle PT/YT tickers, dates, and anything 3+ segments.
  if (parts.length !== 2) return null;
  if (parts.some((p) => /^(PT|YT|LP)$/i.test(p) || /^\d/.test(p))) return null;
  return parts;
}

// ---- Aave V3 (no RPC; underlying-token → reserve URL) -------------------

async function resolveAaveV3({ chain, symbol }) {
  const key = chainKeyOf(chain);
  if (!key) return null;
  const market = AAVE_MARKET[key];
  if (!market) return null;
  // Aave only supports single-asset reserves; reject LP symbols.
  if (String(symbol).includes('-')) return null;
  const underlying = tokenAddrOf(key, symbol);
  if (!underlying) return null;
  return {
    source: 'aave-v3',
    chain: key,
    poolAddress: null,
    depositUrl: `https://app.aave.com/reserve-overview/?underlyingAsset=${underlying}&marketName=${market}`,
    label: `aave ${symbol}`,
  };
}

// ---- Uniswap V3 (on-chain getPool + liquidity probe) --------------------

async function resolveUniswapV3({ chain, symbol }) {
  const key = chainKeyOf(chain);
  if (!key) return null;
  const factory = UNIV3_FACTORY[key];
  if (!factory) return null;
  const pair = parsePairSymbol(symbol);
  if (!pair || pair.length !== 2) return null;
  const aAddr = tokenAddrOf(key, pair[0]);
  const bAddr = tokenAddrOf(key, pair[1]);
  if (!aAddr || !bAddr) return null;
  const [t0, t1] = sortTokens(aAddr, bAddr);
  // 1) Resolve pool address for each fee tier in one batched RPC.
  const getPoolData = (fee) =>
    SEL_GET_POOL_U24 + encAddr(t0) + encAddr(t1) + encUint(fee);
  const poolResults = await ethCallBatch(key, FEE_TIERS.map((fee) => ({
    to: factory, data: getPoolData(fee),
  })));
  const candidates = [];
  poolResults.forEach((r, i) => {
    if (r.result) {
      const addr = decAddr(r.result);
      if (addr) candidates.push({ fee: FEE_TIERS[i], pool: addr });
    }
  });
  if (!candidates.length) return null;
  // 2) Probe liquidity for each candidate; pick the highest.
  if (candidates.length > 1) {
    const liqResults = await ethCallBatch(key, candidates.map((c) => ({
      to: c.pool, data: SEL_LIQUIDITY,
    })));
    candidates.forEach((c, i) => {
      c.liquidity = liqResults[i]?.result ? decUint(liqResults[i].result) : 0n;
    });
    candidates.sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  } else {
    candidates[0].liquidity = 0n;
  }
  const best = candidates[0];
  const slug = UNIV3_SLUG[key] || key;
  return {
    source: 'uniswap-v3',
    chain: key,
    poolAddress: best.pool,
    feeTier: best.fee,
    liquidity: best.liquidity.toString(),
    depositUrl: `https://app.uniswap.org/explore/pools/${slug}/${best.pool}`,
    label: `uniswap ${symbol}`,
  };
}

// ---- Aerodrome V1 (Base; vAMM/sAMM) -------------------------------------
// NOTE 2026-05-28: the address constant below is the Aerodrome PoolFactory
// proxy; calls revert via DRPC even with the canonical getPool(a,a,bool)
// selector, suggesting the real V1 factory lives elsewhere on Base. Almost
// all scanner Aerodrome strategies surface as `aerodrome-slipstream` so we
// haven't dug deeper. Resolver is a graceful no-op for now.

async function resolveAerodromeV1({ chain, symbol }) {
  const key = chainKeyOf(chain);
  if (key !== 'base') return null;
  const pair = parsePairSymbol(symbol);
  if (!pair || pair.length !== 2) return null;
  const a = tokenAddrOf(key, pair[0]); const b = tokenAddrOf(key, pair[1]);
  if (!a || !b) return null;
  const [t0, t1] = sortTokens(a, b);
  // Probe both pool variants (stable=true and volatile=false). Pick non-zero.
  const calls = [false, true].map((stable) => ({
    to: AERO_V1_FACTORY,
    data: SEL_GET_POOL_BOOL + encAddr(t0) + encAddr(t1) + encUint(stable ? 1 : 0),
  }));
  const results = await ethCallBatch(key, calls);
  const candidates = [];
  results.forEach((r, i) => {
    if (r.result) {
      const addr = decAddr(r.result);
      if (addr) candidates.push({ stable: i === 1, pool: addr });
    }
  });
  if (!candidates.length) return null;
  // Pick the one with deepest reserves (getReserves returns [r0, r1, ts]).
  if (candidates.length > 1) {
    const reserveCalls = candidates.map((c) => ({ to: c.pool, data: SEL_RESERVES }));
    const reserveResults = await ethCallBatch(key, reserveCalls);
    candidates.forEach((c, i) => {
      const hex = reserveResults[i]?.result || '0x';
      // First 32 bytes of return data = uint reserve0
      c.reserve0 = hex.length > 66 ? decUint('0x' + hex.slice(2, 66)) : 0n;
    });
    candidates.sort((a, b) => (b.reserve0 > a.reserve0 ? 1 : b.reserve0 < a.reserve0 ? -1 : 0));
  } else {
    candidates[0].reserve0 = 0n;
  }
  const best = candidates[0];
  return {
    source: 'aerodrome-v1',
    chain: key,
    poolAddress: best.pool,
    stable: best.stable,
    depositUrl: `https://aerodrome.finance/deposit?token0=${t0}&token1=${t1}&type=${best.stable ? -1 : 0}`,
    label: `aerodrome ${symbol}`,
  };
}

// ---- Aerodrome Slipstream (Base; concentrated) --------------------------

async function resolveAerodromeSlipstream({ chain, symbol }) {
  const key = chainKeyOf(chain);
  if (key !== 'base') return null;
  const pair = parsePairSymbol(symbol);
  if (!pair || pair.length !== 2) return null;
  const a = tokenAddrOf(key, pair[0]); const b = tokenAddrOf(key, pair[1]);
  if (!a || !b) return null;
  const [t0, t1] = sortTokens(a, b);
  // Slipstream factory uses int24 tickSpacing in place of uint24 fee.
  const calls = AERO_CL_TICK_SPACINGS.map((ts) => ({
    to: AERO_CL_FACTORY,
    data: SEL_GET_POOL_I24 + encAddr(t0) + encAddr(t1) + encUint(ts),
  }));
  const results = await ethCallBatch(key, calls);
  const candidates = [];
  results.forEach((r, i) => {
    if (r.result) {
      const addr = decAddr(r.result);
      if (addr) candidates.push({ tickSpacing: AERO_CL_TICK_SPACINGS[i], pool: addr });
    }
  });
  if (!candidates.length) return null;
  if (candidates.length > 1) {
    const liqResults = await ethCallBatch(key, candidates.map((c) => ({ to: c.pool, data: SEL_LIQUIDITY })));
    candidates.forEach((c, i) => {
      c.liquidity = liqResults[i]?.result ? decUint(liqResults[i].result) : 0n;
    });
    candidates.sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  } else {
    candidates[0].liquidity = 0n;
  }
  const best = candidates[0];
  return {
    source: 'aerodrome-slipstream',
    chain: key,
    poolAddress: best.pool,
    tickSpacing: best.tickSpacing,
    depositUrl: `https://aerodrome.finance/deposit?token0=${t0}&token1=${t1}&type=${best.tickSpacing}`,
    label: `aerodrome-cl ${symbol}`,
  };
}

// ---- Pendle (markets search; no RPC) ------------------------------------
// Pendle markets are addressed by SY/PT/YT triplets, identified by maturity.
// Without a maturity we can't pick a specific market, so link to their markets
// page pre-filtered by symbol — one click → list of matching markets, second
// click → the market's trade page.

async function resolvePendle({ chain, symbol }) {
  const key = chainKeyOf(chain);
  // Pendle is on Ethereum, Arbitrum, BNB, Optimism, Mantle, Base.
  const PENDLE_CHAINS = { ethereum: 1, arbitrum: 42161, bsc: 56, optimism: 10, base: 8453 };
  if (!PENDLE_CHAINS[key]) return null;
  // Strip "PT-" / "YT-" prefixes and date suffixes so the search matches the
  // underlying market. "PT-SUSDE-7MAY2026" → "SUSDE".
  const cleaned = String(symbol).replace(/^(PT|YT|LP)-/i, '').replace(/-\d.*$/, '');
  if (!cleaned) return null;
  return {
    source: 'pendle',
    chain: key,
    poolAddress: null,
    depositUrl: `https://app.pendle.finance/trade/markets?search=${encodeURIComponent(cleaned)}&chainId=${PENDLE_CHAINS[key]}`,
    label: `pendle ${cleaned}`,
  };
}

// ---- cache (disk + memory) ----------------------------------------------

let CACHE = null;
function loadCache() {
  if (CACHE) return CACHE;
  try {
    CACHE = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (!CACHE.entries) CACHE.entries = {};
    if (!CACHE.negatives) CACHE.negatives = {};
  } catch {
    CACHE = { version: 1, entries: {}, negatives: {} };
  }
  return CACHE;
}
function persistCache() {
  if (!CACHE) return;
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = CACHE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(CACHE, null, 2));
  renameSync(tmp, CACHE_PATH);
}
let persistTimer = null;
function scheduleCachePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistCache(); }, 1000);
}
function cacheKey(project, chain, symbol) {
  return `${normalizeProject(project)}|${chainKeyOf(chain) || chain}|${String(symbol || '').toUpperCase()}`;
}
function normalizeProject(p) { return String(p || '').toLowerCase().trim(); }

// ---- public sync API (called from links.mjs during render) --------------

export function resolveSync({ project, chain, symbol }) {
  if (!project || !chain || !symbol) return null;
  const c = loadCache();
  const k = cacheKey(project, chain, symbol);
  const hit = c.entries[k];
  if (hit) return hit;
  return null;
}

// ---- public async API (warmer + on-demand) ------------------------------

export async function resolveAsync({ project, chain, symbol }) {
  if (!project || !chain || !symbol) return null;
  const k = cacheKey(project, chain, symbol);
  const c = loadCache();
  if (c.entries[k]) return c.entries[k];
  const neg = c.negatives[k];
  if (neg && Date.now() - neg.at < NEG_TTL_MS) return null;
  if (INFLIGHT.has(k)) return INFLIGHT.get(k);
  const fn = RESOLVERS[normalizeProject(project)];
  if (!fn) {
    c.negatives[k] = { at: Date.now(), reason: 'no-resolver' };
    scheduleCachePersist();
    return null;
  }
  const p = (async () => {
    try {
      const result = await fn({ chain, symbol });
      if (result) {
        c.entries[k] = { ...result, resolvedAt: Date.now() };
        delete c.negatives[k];
        scheduleCachePersist();
        return c.entries[k];
      }
      c.negatives[k] = { at: Date.now(), reason: 'unresolved' };
      scheduleCachePersist();
      return null;
    } catch (err) {
      c.negatives[k] = { at: Date.now(), reason: 'error', error: String(err.message || err) };
      scheduleCachePersist();
      return null;
    } finally {
      INFLIGHT.delete(k);
    }
  })();
  INFLIGHT.set(k, p);
  return p;
}

// ---- key extraction from a scanner strategy -----------------------------

// Given a strategy object, return one or more (project, chain, symbol) tuples
// to attempt resolution against. Most strategies have a single tuple; carry/
// shortfarm/loops have a primary + secondary protocol.
export function strategyKeys(s) {
  const out = [];
  const o = s?._open || {};
  if (o.project && o.chain) {
    const sym = o.symbol || o.pair || o.token;
    if (sym) out.push({ project: o.project, chain: o.chain, symbol: sym });
  }
  if (o.secondaryProject && o.chain && o.token) {
    out.push({ project: o.secondaryProject, chain: o.chain, symbol: o.token });
  }
  if (out.length) return out;
  // Fallback for top-pick rows that have no _open: parse the action.
  const parsed = parseActionForKey(s?.action);
  if (parsed) out.push(parsed);
  return out;
}

function parseActionForKey(action) {
  const a = String(action || '');
  // "Deposit into <project> <symbol> on <chain>"
  let m = a.match(/Deposit into\s+([A-Za-z][\w-]+)\s+([A-Za-z0-9.+-]+?)\s+on\s+([A-Za-z][\w .-]+?)(?:[,.]|$)/);
  if (m) return { project: m[1], chain: m[3].trim(), symbol: m[2] };
  // "<adjective?>: <pair> on <project>(<chain>)"
  m = a.match(/:\s*([A-Z0-9.]+(?:-[A-Z0-9.]+)?)\s+on\s+([A-Za-z][\w-]+)\(([A-Za-z][\w .-]+?)\)/);
  if (m) return { project: m[2], chain: m[3].trim(), symbol: m[1] };
  return null;
}

// ---- background warmer --------------------------------------------------

let warmTimer = null;

export function startResolverWarmer(getStrategies) {
  if (warmTimer) return;
  const tick = async () => {
    try {
      const strategies = getStrategies() || [];
      let resolved = 0, skipped = 0, failed = 0;
      const tuples = new Map(); // dedupe within one tick
      for (const s of strategies) {
        for (const k of strategyKeys(s)) {
          const ck = cacheKey(k.project, k.chain, k.symbol);
          if (!tuples.has(ck)) tuples.set(ck, k);
        }
      }
      const c = loadCache();
      const todo = [];
      for (const [ck, k] of tuples) {
        if (c.entries[ck]) { skipped++; continue; }
        const neg = c.negatives[ck];
        if (neg && Date.now() - neg.at < NEG_TTL_MS) { skipped++; continue; }
        todo.push(k);
      }
      // Cap parallelism — keep within DRPC sane limits.
      const PAR = 4;
      for (let i = 0; i < todo.length; i += PAR) {
        const batch = todo.slice(i, i + PAR);
        const results = await Promise.all(batch.map((k) => resolveAsync(k)));
        for (const r of results) (r ? resolved++ : failed++);
      }
      if (resolved || failed) {
        console.log(`[pool-resolver] warm: ${resolved} resolved, ${failed} failed, ${skipped} cached, ${tuples.size} total`);
      }
    } catch (err) {
      console.error('[pool-resolver] warm error:', err.message);
    }
  };
  // Kick off once immediately, then on interval.
  setTimeout(tick, 5000).unref();
  warmTimer = setInterval(tick, WARM_INTERVAL_MS);
  warmTimer.unref();
}

// ---- CLI entrypoint -----------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--dump') {
    const c = loadCache();
    process.stdout.write(JSON.stringify({
      entries: Object.keys(c.entries).length,
      negatives: Object.keys(c.negatives).length,
      sample: Object.entries(c.entries).slice(0, 3),
    }, null, 2) + '\n');
    process.exit(0);
  }
  if (args[0] === '--warm') {
    const { collectAllOpportunities } = await import('./opportunities.mjs');
    const strats = collectAllOpportunities();
    const tuples = new Map();
    for (const s of strats) {
      for (const k of strategyKeys(s)) {
        const ck = cacheKey(k.project, k.chain, k.symbol);
        if (!tuples.has(ck)) tuples.set(ck, k);
      }
    }
    console.log(`probing ${tuples.size} unique (project, chain, symbol) tuples...`);
    let ok = 0, no = 0;
    const PAR = 4;
    const list = [...tuples.values()];
    for (let i = 0; i < list.length; i += PAR) {
      const batch = list.slice(i, i + PAR);
      const results = await Promise.all(batch.map((k) => resolveAsync(k)));
      results.forEach((r) => (r ? ok++ : no++));
      process.stdout.write(`  ${i + batch.length}/${list.length}  ok=${ok} no=${no}\r`);
    }
    persistCache();
    console.log(`\ndone. ${ok} resolved, ${no} unresolved.`);
    process.exit(0);
  }
  if (args.length < 3) {
    console.error('usage: pool-resolver.mjs <project> <chain> <symbol>');
    console.error('       pool-resolver.mjs --warm');
    console.error('       pool-resolver.mjs --dump');
    process.exit(2);
  }
  const [project, chain, symbol] = args;
  const result = await resolveAsync({ project, chain, symbol });
  persistCache();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
