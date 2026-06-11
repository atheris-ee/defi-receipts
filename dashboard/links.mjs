// Build "open this position" links per strategy.
// Direct protocol UI only — no DefiLlama. Unknown protocols → no link, by design.
//
// A strategy carries either:
//   _open: { project?, chain?, secondaryProject?, exchange?, symbol?,
//            token?, pair?, buyDex?, sellDex?, buyUrl?, sellUrl? }
// or nothing (top picks from latest_report.json) — in that case we try to
// parse `on <project>(<chain>)` out of the action text.
//
// For protocols where the pool-resolver knows the exact deposit URL
// (Aave V3 reserves, Uniswap V3 pools), we prepend a "↗ deposit" chip that
// is true one-click — straight to the protocol's deposit form for that pool.

import { resolveSync, strategyKeys } from './pool-resolver.mjs';

// ---- protocol registry ---------------------------------------------------
// Keys are normalized DefiLlama-style slugs (lowercase, hyphenated).
// Values are either a string URL or a function (chain, token, pair) => url.

const PROTOCOL_UI = {
  // EVM lending
  'aave':            (c) => aaveMarket(c),
  'compound':        'https://app.compound.finance/markets',
  'morpho':          'https://app.morpho.org/?network=mainnet',
  'morpho-blue':     'https://app.morpho.org/?network=mainnet',
  'spark':           'https://app.spark.fi/markets',
  'sparklend':       'https://app.spark.fi/markets',
  'silo':            'https://v2.silo.finance/',
  'venus':           'https://app.venus.io/markets',
  'benqi':           'https://app.benqi.fi/markets',
  'radiant':         'https://app.radiant.capital/',
  'moonwell':        'https://moonwell.fi/markets',
  'fluid':           'https://fluid.io/lending',
  'fluid-dex':       'https://fluid.io/dex',
  'dolomite':        'https://app.dolomite.io/balances',
  'euler':           'https://app.euler.finance/',
  'hyperlend':       'https://app.hyperlend.finance/markets',
  'lista':           'https://lista.org/lending',
  'mainstreet':      'https://app.mainstreet.fi/',
  'jupiter-lend':    'https://jup.ag/lend',
  'justlend':        'https://justlend.just.network/',
  'resupply':        'https://app.resupply.fi/',
  'wildcat':         'https://wildcat.finance/',

  // EVM DEX / LP / CLM
  'uniswap':         (c) => `https://app.uniswap.org/explore/pools/${chainToUniswap(c)}`,
  'pancakeswap':     'https://pancakeswap.finance/liquidity/pools',
  'sushiswap':       'https://www.sushi.com/pool',
  'curve':           (c) => `https://curve.finance/dex/#/${chainToCurve(c)}/pools`,
  'curve-dex':       (c) => `https://curve.finance/dex/#/${chainToCurve(c)}/pools`,
  'curve-llamalend': 'https://curve.finance/llamalend/',
  'balancer':        'https://balancer.fi/pools',
  'aerodrome':       'https://aerodrome.finance/liquidity',
  'aerodrome-slipstream': 'https://aerodrome.finance/liquidity?type=concentrated',
  'velodrome':       'https://velodrome.finance/liquidity',
  'camelot':         'https://app.camelot.exchange/pools',
  'thena':           'https://thena.fi/pools',
  'quickswap':       'https://quickswap.exchange/#/pools',
  'shadow':          'https://www.shadow.so/liquidity',
  'shadow-exchange': 'https://www.shadow.so/liquidity',
  'blackhole':       'https://blackhole.exchange/liquidity',
  'convex':          'https://www.convexfinance.com/stake',
  'convex-finance':  'https://www.convexfinance.com/stake',
  'yearn':           'https://yearn.fi/v3',
  'yearn-finance':   'https://yearn.fi/v3',
  'beefy':           'https://app.beefy.com/',
  'harvest':         'https://harvest.finance/',
  'harvest-finance': 'https://harvest.finance/',
  'penpie':          'https://www.pendle.magpiexyz.io/stake',

  // Pendle-ish (PT/YT)
  'pendle':          'https://app.pendle.finance/trade/markets',
  'spectra':         'https://app.spectra.finance/',
  'fira':            'https://app.fira.fi/',

  // Solana
  'raydium':         'https://raydium.io/liquidity-pools/',
  'raydium-amm':     'https://raydium.io/liquidity-pools/',
  'raydium-clmm':    'https://raydium.io/clmm-pools/',
  'orca':            'https://www.orca.so/pools',
  'orca-dex':        'https://www.orca.so/pools',
  'meteora':         'https://app.meteora.ag/pools',
  'gmtrade':         'https://app.gmtrade.io/',
  'kamino-lend':     'https://app.kamino.finance/lending',
  'kamino-liquidity':'https://app.kamino.finance/liquidity',
  'kamino':          'https://app.kamino.finance/',
  'marginfi':        'https://app.marginfi.com/',
  'drift':           'https://app.drift.trade/earn',
  'drift-lending':   'https://app.drift.trade/earn',
  'solend':          'https://save.finance/dashboard',
  'save':            'https://save.finance/dashboard',
  'gmxperps':        'https://app.gmx.io/#/trade',
  'gmx':             'https://app.gmx.io/#/trade',
  'jupiter':         'https://jup.ag/',
  'avantis':         'https://avantisfi.com/trade',

  // Sui
  'scallop':         'https://app.scallop.io/lending',
  'scallop-lend':    'https://app.scallop.io/lending',
  'navi':            'https://app.naviprotocol.io/market',
  'navi-lending':    'https://app.naviprotocol.io/market',
  'suilend':         'https://suilend.fi/dashboard',
};

const EXCHANGE_UI = {
  'hyperliquid': (sym) => `https://app.hyperliquid.xyz/trade/${encodeURIComponent(sym)}`,
  'binance':     (sym) => `https://www.binance.com/en/futures/${encodeURIComponent(sym)}USDT`,
  'bybit':       (sym) => `https://www.bybit.com/trade/usdt/${encodeURIComponent(sym)}USDT`,
  'okx':         (sym) => `https://www.okx.com/trade-swap/${encodeURIComponent(sym).toLowerCase()}-usdt-swap`,
  'dydx':        (sym) => `https://dydx.trade/trade/${encodeURIComponent(sym)}-USD`,
};

// ---- chain helpers -------------------------------------------------------

function aaveMarket(chain) {
  const c = String(chain || '').toLowerCase();
  const m = { 'ethereum': 'proto_mainnet_v3', 'mainnet': 'proto_mainnet_v3',
              'polygon': 'proto_polygon_v3', 'arbitrum': 'proto_arbitrum_v3',
              'optimism': 'proto_optimism_v3', 'base': 'proto_base_v3',
              'avalanche': 'proto_avalanche_v3', 'bnb': 'proto_bnb_v3', 'bsc': 'proto_bnb_v3',
              'gnosis': 'proto_gnosis_v3', 'scroll': 'proto_scroll_v3',
              'metis': 'proto_metis_v3', 'zksync': 'proto_zksync_v3' }[c];
  return m ? `https://app.aave.com/markets/?marketName=${m}` : 'https://app.aave.com/markets/';
}
function chainToUniswap(c) {
  return ({ 'ethereum':'ethereum','polygon':'polygon','arbitrum':'arbitrum','optimism':'optimism',
            'base':'base','bnb':'bnb','bsc':'bnb','avalanche':'avalanche','celo':'celo',
            'blast':'blast','zksync':'zksync','zora':'zora' }[String(c||'').toLowerCase()]) || 'ethereum';
}
function chainToCurve(c) {
  return ({ 'ethereum':'ethereum','arbitrum':'arbitrum','optimism':'optimism','polygon':'polygon',
            'base':'base','fraxtal':'fraxtal','avalanche':'avalanche','gnosis':'xdai','xdai':'xdai',
            'bnb':'bsc','bsc':'bsc' }[String(c||'').toLowerCase()]) || 'ethereum';
}

// ---- slug normalization --------------------------------------------------

function slug(raw) {
  return String(raw || '').toLowerCase().trim().replace(/\s+/g, '-');
}
// Drop suffix variants like "-v3", "-perps", "-amm", "-clmm", "-pooled",
// "-staked-avax", "-core-pool", "-flux". Iterate so "gmx-v2-perps" -> "gmx".
const SUFFIX_RE = /-(v\d+(?:\.\d+)?|perps?|amm|clmm|cl|dex|lend(?:ing)?|pooled|earn|core-pool|flux|slipstream|staked-[a-z]+|pools?)$/;
function rootSlug(raw) {
  let s = slug(raw);
  for (let i = 0; i < 4; i++) {
    const next = s.replace(SUFFIX_RE, '');
    if (next === s) break;
    s = next;
  }
  return s;
}
function lookupProtocol(raw) {
  const s = slug(raw);
  if (PROTOCOL_UI[s]) return [s, PROTOCOL_UI[s]];
  const r = rootSlug(raw);
  if (r && PROTOCOL_UI[r]) return [r, PROTOCOL_UI[r]];
  return null;
}

// ---- action-text fallback ------------------------------------------------
// Walk the action text looking for any known protocol slug. Top picks use
// many wordings: "on uniswap(BSC)", "stake in orca-dex (Solana)",
// "Deposit into pendle SUSDAT", "perp on Hyperliquid". Try them all.
const VERBS = ['on', 'in', 'into', 'from', 'via'];
function* parseActionCandidates(action) {
  const a = String(action || '');
  // Match "<verb> <slug>" optionally followed by "(chain)" or " (chain)".
  const re = new RegExp(
    `\\b(?:${VERBS.join('|')})\\s+([a-zA-Z][\\w-]+)(?:\\s*\\(([A-Za-z][\\w .-]{0,29})\\))?`,
    'g'
  );
  for (const m of a.matchAll(re)) {
    yield { project: m[1], chain: (m[2] || '').trim() };
  }
}
function parseActionContext(action) {
  // Return the first candidate whose slug resolves to a known protocol.
  for (const c of parseActionCandidates(action)) {
    if (lookupProtocol(c.project)) return c;
  }
  return null;
}

// ---- public API ----------------------------------------------------------

export function buildLinks(strategy) {
  const links = [];
  const o = strategy._open || {};

  // Tier 0: pool-resolver deposit URL (on-chain-derived, exact pool).
  // Try every (project, chain, symbol) tuple this strategy resolves to —
  // catches both stake and borrow legs for carry/shortfarm rows.
  for (const key of strategyKeys(strategy)) {
    const hit = resolveSync(key);
    if (hit && hit.depositUrl) {
      links.push({ label: `deposit: ${hit.label || key.project}`, url: hit.depositUrl, primary: true });
    }
  }

  // Arb already carries its own URLs from the scanner
  if (o.buyUrl)  links.push({ label: `buy: ${o.buyDex || 'DEX'}`,  url: o.buyUrl });
  if (o.sellUrl) links.push({ label: `sell: ${o.sellDex || 'DEX'}`, url: o.sellUrl });
  if (links.length) return links;

  // Flasharb: only DEX names + chain. Resolve each through the protocol registry.
  if (o.buyDex || o.sellDex) {
    for (const [dex, role] of [[o.buyDex, 'buy'], [o.sellDex, 'sell']]) {
      if (!dex) continue;
      const hit = lookupProtocol(dex);
      if (hit) {
        const [name, target] = hit;
        const url = typeof target === 'function' ? target(o.chain, o.token) : target;
        if (!links.some((l) => l.url === url)) links.push({ label: `${role}: ${name}`, url });
      }
    }
    if (links.length) return links;
  }

  // Funding: perps exchange + ticker
  if (o.exchange && o.symbol) {
    const fn = EXCHANGE_UI[slug(o.exchange)];
    if (fn) {
      links.push({ label: `open ${o.exchange}`, url: fn(o.symbol) });
      return links;
    }
  }

  // Primary protocol (stake target / pool host)
  const primary = o.project ? lookupProtocol(o.project) : null;
  if (primary) {
    const [name, target] = primary;
    const url = typeof target === 'function' ? target(o.chain, o.token, o.pair) : target;
    links.push({ label: `open ${name}`, url });
  }

  // Secondary (borrow source for carry/shortfarm, low-yield protocol for spreads)
  if (o.secondaryProject) {
    const sec = lookupProtocol(o.secondaryProject);
    if (sec) {
      const [name, target] = sec;
      const url = typeof target === 'function' ? target(o.chain) : target;
      // Only add if it's a distinct URL
      if (!links.some((l) => l.url === url)) {
        links.push({ label: `borrow: ${name}`, url });
      }
    }
  }

  if (links.length) return links;

  // Fallback A: exchange-style funding action — "long perp on Hyperliquid".
  const exMatch = String(strategy.action || '').match(
    /\b([A-Z][A-Z0-9-]{1,15})\b[^]*?\bperp\s+on\s+([A-Za-z][\w]+)/i
  );
  if (exMatch) {
    const fn = EXCHANGE_UI[slug(exMatch[2])];
    if (fn) {
      links.push({ label: `open ${exMatch[2]}`, url: fn(exMatch[1]) });
      return links;
    }
  }

  // Fallback B: walk the action text for any known protocol slug.
  const parsed = parseActionContext(strategy.action);
  if (parsed) {
    const hit = lookupProtocol(parsed.project);
    if (hit) {
      const [name, target] = hit;
      const url = typeof target === 'function' ? target(parsed.chain) : target;
      links.push({ label: `open ${name}`, url });
    }
  }
  return links;
}
