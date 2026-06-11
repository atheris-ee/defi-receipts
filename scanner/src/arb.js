// Cross-DEX and cross-chain arbitrage scanner
// Fixed: chain-aware filtering, no cross-chain false positives
import { fetchJSON, cached, setCache, loadConfig, log } from './utils.js';

const MAJOR_TOKENS = {
  solana: {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  },
  ethereum: {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  }
};

// Canonical chain IDs from dexscreener — used to validate same-chain arbs
const CHAIN_ALIASES = {
  ethereum: new Set(['ethereum']),
  solana: new Set(['solana']),
  bsc: new Set(['bsc']),
  arbitrum: new Set(['arbitrum']),
  base: new Set(['base']),
  polygon: new Set(['polygon']),
  avalanche: new Set(['avalanche']),
  optimism: new Set(['optimism']),
};

// X121: Stablecoins have tighter staleness thresholds — most arbitraged tokens in DeFi.
// Jupiter aggregator and MEV bots close stablecoin spreads within a single block.
const STABLECOIN_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'FRAX', 'TUSD', 'USDP', 'PYUSD', 'USDS', 'UST', 'LUSD', 'GUSD', 'SUSD', 'RAI', 'MIM', 'USDD', 'CRVUSD', 'EURC', 'GHO']);

// X154: Chain-native tokens have deepest DEX liquidity on their home chain.
// Aggregators (Jupiter, 1inch) capture any real spread within a single block.
// A >0.75% cross-DEX spread for the native token is almost certainly stale API data.
const CHAIN_NATIVE_TOKENS = {
  solana: new Set(['SOL', 'WSOL']),
  ethereum: new Set(['ETH', 'WETH']),
  bsc: new Set(['BNB', 'WBNB']),
  avalanche: new Set(['AVAX', 'WAVAX']),
  polygon: new Set(['MATIC', 'WMATIC', 'POL', 'WPOL']),
  arbitrum: new Set(['ETH', 'WETH']),
  base: new Set(['ETH', 'WETH']),
  optimism: new Set(['ETH', 'WETH']),
};

// Chains that look like our target but are NOT (forks, L2s with different state)
const EXCLUDED_CHAINS = new Set([
  'pulsechain', 'fogo', 'dogechain', 'ethereumpow',
  'polygon-zkevm', 'mantle', 'manta', 'scroll', 'linea', 'blast',
  'zksync', 'mode', 'merlin', 'boba', 'celo', 'harmony',
]);

function isSameChain(pairChainId, expectedChain) {
  const pid = (pairChainId || '').toLowerCase();
  if (EXCLUDED_CHAINS.has(pid)) return false;
  const aliases = CHAIN_ALIASES[expectedChain];
  if (!aliases) return false;
  return aliases.has(pid);
}

// Sanity check: reject prices that are wildly off from reference
function priceIsReasonable(price, symbol) {
  const refs = {
    WETH: [800, 10000], SOL: [10, 500], USDC: [0.95, 1.05],
    USDT: [0.95, 1.05], WBTC: [20000, 200000], LINK: [3, 100],
    JUP: [0.01, 10], JTO: [0.05, 50], BONK: [0.0000001, 0.001],
    WIF: [0.01, 50],
  };
  const range = refs[symbol];
  if (!range) return true;
  return price >= range[0] && price <= range[1];
}

async function getDexscreenerPairs(tokenAddr) {
  const key = `dex_${tokenAddr}`;
  let data = cached(key, 120);
  if (!data) {
    data = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`);
    setCache(key, data);
  }
  return data.pairs || [];
}

async function getJupiterQuote(inputMint, outputMint, amount) {
  try {
    // lite-api.jup.ag is the live keyless host (same response shape); quote-api.jup.ag/v6 is
    // DNS-dead since ~May 2026 and silently produced [] for every Solana arb.
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;
    return await fetchJSON(url, { headers: { 'User-Agent': 'defi-tracker/1.0' }, timeout: 12000 });
  } catch (e) { log('[ARB] Jupiter quote failed: ' + String(e.message || e).slice(0, 100)); return null; }
}

export async function scanArbitrage() {
  const config = loadConfig();
  log('Scanning cross-DEX arbitrage (chain-aware)...');

  const opportunities = [];

  for (const [chain, tokens] of Object.entries(MAJOR_TOKENS)) {
    for (const [symbol, addr] of Object.entries(tokens)) {
      try {
        const pairs = await getDexscreenerPairs(addr);
        if (pairs.length < 2) continue;

        // ONLY include pairs on the correct chain
        const samechainPairs = pairs.filter(p => isSameChain(p.chainId, chain));

        const priceByDex = {};
        for (const pair of samechainPairs.slice(0, 30)) {
          if (!pair.priceUsd || parseFloat(pair.priceUsd) === 0) continue;
          const dex = pair.dexId;
          // X145: Skip DEXes where dexId is a raw contract address (0x...) — DexScreener returns
          // these for unrecognized protocols. Users can't identify or verify the DEX, making the
          // arb recommendation non-actionable.
          if (/^0x[0-9a-fA-F]{10,}$/.test(dex)) continue;
          const price = parseFloat(pair.priceUsd);
          const liq = pair.liquidity?.usd || 0;
          if (liq < 50000) continue;
          if (!priceIsReasonable(price, symbol)) continue;

          if (!priceByDex[dex] || liq > priceByDex[dex].liquidity) {
            priceByDex[dex] = { price, liquidity: liq, pairAddr: pair.pairAddress, url: pair.url };
          }
        }

        const dexes = Object.entries(priceByDex);
        if (dexes.length < 2) continue;

        let minDex = dexes[0], maxDex = dexes[0];
        for (const d of dexes) {
          if (d[1].price < minDex[1].price) minDex = d;
          if (d[1].price > maxDex[1].price) maxDex = d;
        }

        const spread = (maxDex[1].price - minDex[1].price) / minDex[1].price;
        const spreadBps = spread * 10000;

        if (spreadBps >= config.min_arb_profit_bps) {
          // Estimate realistic max trade (2% of lesser liquidity side)
          const maxTrade = Math.min(minDex[1].liquidity, maxDex[1].liquidity) * 0.02;
          // Estimate gas cost — manual arb requires 2 swap txs (buy on DEX A + sell on DEX B)
          const gasCost = chain === 'solana' ? 0.02 : chain === 'ethereum' ? 30 : 1;
          const grossProfit = maxTrade * spread;
          const netProfit = grossProfit - gasCost;

          if (netProfit <= 0) continue;

          opportunities.push({
            type: 'same_chain_arb',
            token: symbol,
            chain,
            buyDex: minDex[0],
            buyPrice: minDex[1].price,
            sellDex: maxDex[0],
            sellPrice: maxDex[1].price,
            spreadBps: Math.round(spreadBps),
            spreadPct: (spread * 100).toFixed(3),
            grossProfitUsd: grossProfit.toFixed(2),
            estGasCost: gasCost.toFixed(2),
            netProfitUsd: netProfit.toFixed(2),
            maxTradeSize: maxTrade.toFixed(2),
            buyLiquidity: minDex[1].liquidity,
            sellLiquidity: maxDex[1].liquidity,
            buyUrl: minDex[1].url,
            sellUrl: maxDex[1].url,
            // X121: Stablecoin-specific staleness — any >50bps stablecoin spread between major DEXes is likely stale
            isStablecoin: STABLECOIN_SYMBOLS.has(symbol),
            // X154: Chain-native token staleness — deepest liquidity on home chain, aggregators capture instantly
            isChainNative: !!(CHAIN_NATIVE_TOKENS[chain] && CHAIN_NATIVE_TOKENS[chain].has(symbol)),
            feasibility: STABLECOIN_SYMBOLS.has(symbol)
              ? (spreadBps > 200 ? 'CERTAINLY_STALE' : spreadBps > 100 ? 'VERY_LIKELY_STALE' : spreadBps > 50 ? 'LIKELY_STALE' : spreadBps > 20 ? 'CHECK_SLIPPAGE' : 'VIABLE')
              : (CHAIN_NATIVE_TOKENS[chain] && CHAIN_NATIVE_TOKENS[chain].has(symbol))
              ? (spreadBps > 300 ? 'CERTAINLY_STALE' : spreadBps > 150 ? 'VERY_LIKELY_STALE' : spreadBps > 75 ? 'LIKELY_STALE' : spreadBps > 20 ? 'CHECK_SLIPPAGE' : 'VIABLE')
              : (spreadBps > 500 ? 'CERTAINLY_STALE' : spreadBps > 300 ? 'VERY_LIKELY_STALE' : spreadBps > 200 ? 'LIKELY_STALE' : spreadBps > 50 ? 'CHECK_SLIPPAGE' : 'VIABLE'),
          });
        }
      } catch (e) {
        log(`Error scanning ${symbol}: ${e.message}`);
      }
    }
  }

  // Jupiter circular route arb
  log('Scanning Jupiter circular route arbitrage...');
  const jupArbs = [];
  const SOL = MAJOR_TOKENS.solana.SOL;

  const midTokens = [
    { symbol: 'JTO', mint: MAJOR_TOKENS.solana.JTO },
    { symbol: 'JUP', mint: MAJOR_TOKENS.solana.JUP },
    { symbol: 'BONK', mint: MAJOR_TOKENS.solana.BONK },
    { symbol: 'WIF', mint: MAJOR_TOKENS.solana.WIF },
  ];

  for (const mid of midTokens) {
    try {
      const q1 = await getJupiterQuote(SOL, mid.mint, '1000000000');
      if (!q1 || !q1.outAmount) continue;
      const q2 = await getJupiterQuote(mid.mint, SOL, q1.outAmount);
      if (!q2 || !q2.outAmount) continue;

      const inAmount = 1000000000;
      const outAmount = parseInt(q2.outAmount);
      const profitLamports = outAmount - inAmount;
      const profitPct = (profitLamports / inAmount) * 100;
      // Subtract ~0.005 SOL gas + 0.001 SOL priority fee
      const gasSol = 0.006;
      const netProfitSol = (profitLamports / 1e9) - gasSol;

      if (netProfitSol > 0.001) {
        jupArbs.push({
          type: 'jupiter_circular',
          route: `SOL → ${mid.symbol} → SOL`,
          inputSol: 1,
          outputSol: (outAmount / 1e9).toFixed(6),
          grossProfitPct: profitPct.toFixed(4),
          gasSol: gasSol,
          netProfitSol: netProfitSol.toFixed(6),
          netProfitPct: ((netProfitSol / 1) * 100).toFixed(4),
          note: 'Atomic via Jupiter — but MEV bots compete for these'
        });
      }
    } catch (e) {
      log(`Jupiter arb scan error for ${mid.symbol}: ${e.message}`);
    }
  }

  opportunities.sort((a, b) => parseFloat(b.netProfitUsd) - parseFloat(a.netProfitUsd));
  jupArbs.sort((a, b) => parseFloat(b.netProfitSol) - parseFloat(a.netProfitSol));

  return {
    timestamp: new Date().toISOString(),
    cross_dex_opportunities: opportunities,
    jupiter_circular_arbs: jupArbs,
    total_found: opportunities.length + jupArbs.length,
    note: 'All arbs are same-chain only. Cross-chain pairs excluded.'
  };
}
