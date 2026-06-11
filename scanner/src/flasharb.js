// Flashloan Arbitrage Scanner v1.0
// Scans DEX aggregator prices across chains for atomic arb opportunities
// Uses Jupiter (Solana), DexScreener (multi-chain), and direct RPC price checks
import { fetchJSON, log, cached, setCache } from "./utils.js";

const MAJOR_TOKENS = {
  ethereum: {
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
  },
  arbitrum: {
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    LINK: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
  },
  base: {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    CBBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  },
  bsc: {
    WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    USDT: "0x55d398326f99059fF775485246999027B3197955",
    BTCB: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
  },
  solana: {
    SOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    JITOSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    MSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  },
};

// Flash-loan availability by chain (Aave v3 deployments + Venus on BSC)
// Only tokens with confirmed flashLoanEnabled=true are listed
const FLASH_LOAN_AVAILABLE = {
  ethereum: new Set(["USDC", "USDT", "DAI", "WETH", "WBTC", "WSTETH", "LINK", "UNI", "AAVE"]),
  arbitrum: new Set(["USDC", "USDT", "WETH", "WBTC", "ARB", "LINK", "WSTETH", "DAI"]),
  base:     new Set(["USDC", "WETH", "CBBTC", "CBETH", "WSTETH"]),  // Aave v3 on Base expanded 2024-25
  // BSC: No Aave v3. Venus flash loans exist but only for supplied tokens with sufficient liquidity.
  // Conservatively mark BSC stablecoins as non-flash-loanable for atomic arb purposes.
  bsc:      new Set([]),
  optimism: new Set(["USDC", "USDT", "WETH", "WBTC", "OP", "WSTETH", "DAI"]),
  avalanche: new Set(["USDC", "USDT", "WETH", "WAVAX", "BTC.B"]),
};

function isFlashLoanable(chain, symbol) {
  const available = FLASH_LOAN_AVAILABLE[chain];
  return available ? available.has(symbol) : false;
}

const GAS_COSTS = {
  ethereum: { simple: 15, complex: 60, flashloan: 80 },
  arbitrum: { simple: 0.5, complex: 2, flashloan: 3 },
  base: { simple: 0.3, complex: 1.5, flashloan: 2 },
  bsc: { simple: 0.3, complex: 1, flashloan: 1.5 },
  optimism: { simple: 0.5, complex: 2, flashloan: 3 },
  avalanche: { simple: 1, complex: 3, flashloan: 5 },
  solana: { simple: 0.01, complex: 0.05, flashloan: 0.05 },
};

// Get token prices from multiple DEXes via DexScreener
async function getDexPrices(tokenAddress, chain) {
  try {
    const data = await fetchJSON("https://api.dexscreener.com/latest/dex/tokens/" + tokenAddress, { timeout: 10000 });
    if (!data || !data.pairs) return [];

    return data.pairs
      .filter(p => p.chainId === chain && (p.liquidity?.usd || 0) > 100000)
      .map(p => ({
        dex: p.dexId,
        price: parseFloat(p.priceUsd),
        liquidity: p.liquidity?.usd || 0,
        volume24h: p.volume?.h24 || 0,
        pair: p.baseToken.symbol + "/" + p.quoteToken.symbol,
        pairAddress: p.pairAddress,
      }))
      .filter(p => p.price > 0)
      // X145: Skip DEXes with raw contract address as dexId — non-actionable
      .filter(p => !/^0x[0-9a-fA-F]{10,}$/.test(p.dex))
      .sort((a, b) => b.liquidity - a.liquidity);
  } catch (e) {
    return [];
  }
}

// Jupiter quote for Solana arb
async function getJupiterQuote(inputMint, outputMint, amount) {
  try {
    // lite-api.jup.ag is the live keyless host (same response shape); quote-api.jup.ag/v6 is
    // DNS-dead since ~May 2026 and silently produced [] for every Solana triangle.
    const q = await fetchJSON(
      "https://lite-api.jup.ag/swap/v1/quote?inputMint=" + inputMint +
      "&outputMint=" + outputMint + "&amount=" + amount + "&slippageBps=10",
      { headers: { "User-Agent": "defi-tracker/1.0" }, timeout: 12000 }
    );
    return q;
  } catch (e) {
    log("[FLASH] Jupiter quote failed: " + String(e.message || e).slice(0, 100));
    return null;
  }
}

// Scan EVM cross-DEX arbs using DexScreener
async function scanEvmArbs() {
  log("[FLASH] Scanning EVM cross-DEX price discrepancies...");
  const opportunities = [];

  for (const [chain, tokens] of Object.entries(MAJOR_TOKENS)) {
    if (chain === "solana") continue;

    for (const [symbol, address] of Object.entries(tokens)) {
      if (["USDC", "USDT", "DAI"].includes(symbol)) continue; // skip stables as base token

      const dexscreenerChain = chain === "bsc" ? "bsc" : chain;
      const prices = await getDexPrices(address, dexscreenerChain);
      if (prices.length < 2) continue;

      // Find best buy and best sell across DEXes
      const sorted = [...prices].sort((a, b) => a.price - b.price);
      const cheapest = sorted[0];
      const mostExpensive = sorted[sorted.length - 1];

      if (cheapest.dex === mostExpensive.dex) continue;
      // Skip unknown DEXes (raw contract addresses) — users can't act on them
      if (cheapest.dex.startsWith("0x") || mostExpensive.dex.startsWith("0x")) continue;

      const spread = (mostExpensive.price - cheapest.price) / cheapest.price;
      if (spread < 0.001) continue; // < 0.1% not worth it

      // Cap credible spread by combined liquidity — high-liquidity tokens on major DEXes
      // cannot sustain large spreads (MEV bots close them in seconds). Large apparent
      // spreads are DexScreener artifacts from comparing different pair contexts
      // (e.g. WSTETH/WETH vs WSTETH/USDC use different USD conversion rates).
      const combinedLiq = cheapest.liquidity + mostExpensive.liquidity;
      const maxCredibleSpread = combinedLiq > 10_000_000 ? 0.005  // >$10M: max 0.5%
                              : combinedLiq > 1_000_000  ? 0.01   // >$1M:  max 1%
                              :                            0.03;   // <$1M:  max 3%
      const effectiveSpread = Math.min(spread, maxCredibleSpread);

      const maxTradeSize = Math.min(cheapest.liquidity, mostExpensive.liquidity) * 0.02; // 2% of pool
      const grossProfit = maxTradeSize * effectiveSpread;
      const flashFee = maxTradeSize * 0.0009; // Aave 0.09%
      const gas = GAS_COSTS[chain]?.flashloan || 50;
      const slippageEst = maxTradeSize * effectiveSpread * 0.3; // 30% of spread lost to slippage
      const netProfit = grossProfit - flashFee - gas - slippageEst;

      if (netProfit > 5) { // minimum $5 profit
        const spreadCapped = effectiveSpread < spread;
        // X89: Check flash-loan availability — BSC has no Aave v3, so WBNB/WBTC/etc.
        // can't be flash-loaned. Without flash loans, arber uses own capital (not atomic,
        // capital at risk during 2-block execution window).
        const flashLoanable = isFlashLoanable(chain, symbol);
        opportunities.push({
          chain,
          token: symbol,
          buyDex: cheapest.dex,
          buyPrice: cheapest.price,
          buyLiquidity: Math.round(cheapest.liquidity),
          sellDex: mostExpensive.dex,
          sellPrice: mostExpensive.price,
          sellLiquidity: Math.round(mostExpensive.liquidity),
          spreadPct: parseFloat((effectiveSpread * 100).toFixed(3)),
          rawSpreadPct: parseFloat((spread * 100).toFixed(3)),
          spreadCapped,
          flashLoanable,
          maxTradeSize: Math.round(maxTradeSize),
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          flashloanFee: flashLoanable ? parseFloat(flashFee.toFixed(2)) : 0,
          gasCost: gas,
          slippageEst: parseFloat(slippageEst.toFixed(2)),
          netProfit: flashLoanable ? parseFloat(netProfit.toFixed(2)) : parseFloat((grossProfit - gas - slippageEst).toFixed(2)),
          profitable: netProfit > 0,
          execution: {
            type: flashLoanable ? "flashloan_arb" : "own_capital_arb",
            steps: flashLoanable ? [
              "Flashloan " + symbol + " from " + (chain === "ethereum" ? "Aave v3/Balancer" : "Aave v3"),
              "Swap on " + cheapest.dex + " (buy cheap)",
              "Swap on " + mostExpensive.dex + " (sell expensive)",
              "Repay flashloan + fee",
            ] : [
              "Buy " + symbol + " on " + cheapest.dex + " with own capital",
              "Sell on " + mostExpensive.dex,
              "No flash loan available on " + chain,
            ],
            flashSource: flashLoanable ? (chain === "ethereum" ? "Balancer (0% fee) or Aave (0.09%)" : "Aave v3 (0.09%)") : "none",
            contractRequired: flashLoanable,
          },
          score: netProfit * (chain === "ethereum" ? 1 : 1.5) * (flashLoanable ? 1 : 0.5), // prefer L2 + penalize non-flash
        });
      }
    }

    // Rate limit DexScreener
    await new Promise(r => setTimeout(r, 200));
  }

  opportunities.sort((a, b) => b.score - a.score);
  return opportunities;
}

// Scan Solana Jupiter triangle arbs
async function scanSolanaArbs() {
  log("[FLASH] Scanning Solana triangle arbs via Jupiter...");
  const routes = [];
  const SOL = MAJOR_TOKENS.solana.SOL;
  const USDC = MAJOR_TOKENS.solana.USDC;
  const USDT = MAJOR_TOKENS.solana.USDT;
  const JITOSOL = MAJOR_TOKENS.solana.JITOSOL;

  const triangles = [
    { name: "SOL->USDC->SOL", path: [SOL, USDC, SOL], amounts: ["10000000000", "100000000000", "1000000000000"] },
    { name: "SOL->USDT->USDC->SOL", path: [SOL, USDT, USDC, SOL], amounts: ["10000000000", "100000000000"] },
    { name: "SOL->JitoSOL->USDC->SOL", path: [SOL, JITOSOL, USDC, SOL], amounts: ["10000000000", "100000000000"] },
    { name: "SOL->mSOL->USDC->SOL", path: [SOL, MAJOR_TOKENS.solana.MSOL, USDC, SOL], amounts: ["10000000000", "100000000000"] },
  ];

  for (const tri of triangles) {
    for (const startAmount of tri.amounts) {
      try {
        let currentAmount = startAmount;
        let currentMint = tri.path[0];
        let viable = true;
        const hops = [];

        for (let i = 1; i < tri.path.length; i++) {
          const nextMint = tri.path[i];
          const q = await getJupiterQuote(currentMint, nextMint, currentAmount);
          if (!q || !q.outAmount) { viable = false; break; }
          hops.push({
            from: currentMint.slice(0, 6),
            to: nextMint.slice(0, 6),
            inAmount: currentAmount,
            outAmount: q.outAmount,
            routes: q.routePlan?.length || 0,
          });
          currentAmount = q.outAmount;
          currentMint = nextMint;
        }

        if (!viable) continue;

        const inSol = parseInt(startAmount) / 1e9;
        const outSol = parseInt(currentAmount) / 1e9;
        const profitSol = outSol - inSol;
        const gasSol = 0.005 * tri.path.length; // ~0.005 SOL per hop
        const netProfitSol = profitSol - gasSol;

        if (netProfitSol > 0.001) {
          // Get SOL price for USD conversion
          const solPrice = 85; // approximate, update from feed
          routes.push({
            route: tri.name,
            size: inSol + " SOL",
            inputSol: inSol,
            outputSol: parseFloat(outSol.toFixed(6)),
            profitSol: parseFloat(profitSol.toFixed(6)),
            gasSol: gasSol,
            netProfitSol: parseFloat(netProfitSol.toFixed(6)),
            netProfitUsd: parseFloat((netProfitSol * solPrice).toFixed(2)),
            profitPct: parseFloat((netProfitSol / inSol * 100).toFixed(4)),
            hops: hops.length,
            execution: {
              type: "atomic_arb",
              flashSource: "Solend or MarginFi (0% fee)",
              steps: ["Flashloan SOL", ...hops.map((h, i) => "Swap hop " + (i+1)), "Repay flashloan"],
              contractRequired: false, // Jupiter CPI handles it
              note: "Can execute via Jupiter swap with exact output routing, or flashloan for zero capital",
            },
            score: netProfitSol * 1000,
          });
        }
      } catch (e) { /* skip */ }
    }
  }

  routes.sort((a, b) => b.score - a.score);
  return routes;
}

// Scan stablecoin depegs for arb
async function scanStableDepegs() {
  log("[FLASH] Scanning stablecoin depegs...");
  const stables = [
    { symbol: "USDC", expected: 1.0, addresses: { ethereum: MAJOR_TOKENS.ethereum.USDC, arbitrum: MAJOR_TOKENS.arbitrum.USDC, base: MAJOR_TOKENS.base.USDC, bsc: MAJOR_TOKENS.bsc.USDC } },
    { symbol: "USDT", expected: 1.0, addresses: { ethereum: MAJOR_TOKENS.ethereum.USDT, arbitrum: MAJOR_TOKENS.arbitrum.USDT, bsc: MAJOR_TOKENS.bsc.USDT } },
    { symbol: "DAI", expected: 1.0, addresses: { ethereum: MAJOR_TOKENS.ethereum.DAI } },
  ];

  const depegs = [];

  for (const stable of stables) {
    for (const [chain, address] of Object.entries(stable.addresses)) {
      const dexChain = chain === "bsc" ? "bsc" : chain;
      const prices = await getDexPrices(address, dexChain);
      if (prices.length < 2) continue;

      for (const p of prices) {
        const deviation = Math.abs(p.price - stable.expected) / stable.expected;
        if (deviation > 0.002 && deviation < 0.05) { // 0.2% - 5% depeg (above 5% = fake/exotic pair)
          const arbSize = Math.min(p.liquidity * 0.05, 500000);
          const grossProfit = arbSize * deviation;
          const gas = GAS_COSTS[chain]?.flashloan || 50;
          // X132: Add slippage + flash fee parity with EVM cross-DEX arb scanner.
          // AMM trades lose ~30% of spread to price impact on 5%-of-pool trades.
          const slippageEst = grossProfit * 0.3;
          const flashLoanable = isFlashLoanable(chain, stable.symbol);
          const flashFee = flashLoanable ? arbSize * 0.0009 : 0; // Aave v3 0.09% flash loan fee
          const netProfit = grossProfit - gas - slippageEst - flashFee;

          if (netProfit > 10 && p.dex && !p.dex.startsWith("0x")) {
            const direction = p.price > stable.expected ? "PREMIUM" : "DISCOUNT";
            let strategy;
            if (flashLoanable) {
              strategy = direction === "PREMIUM"
                ? "Flashloan " + stable.symbol + " -> sell on " + p.dex + " at premium -> repay"
                : "Flashloan counterpart -> buy " + stable.symbol + " on " + p.dex + " at discount -> sell elsewhere -> repay";
            } else {
              strategy = direction === "PREMIUM"
                ? "Manual arb: sell " + stable.symbol + " on " + p.dex + " at premium (no flash loan on " + chain + ")"
                : "Manual arb: buy " + stable.symbol + " on " + p.dex + " at discount (no flash loan on " + chain + ")";
            }
            depegs.push({
              stable: stable.symbol,
              chain,
              dex: p.dex,
              price: p.price,
              deviation: parseFloat((deviation * 100).toFixed(3)),
              direction,
              liquidity: Math.round(p.liquidity),
              arbSize: Math.round(arbSize),
              grossProfit: parseFloat(grossProfit.toFixed(2)),
              slippageEst: parseFloat(slippageEst.toFixed(2)),
              flashFee: parseFloat(flashFee.toFixed(2)),
              gas,
              netProfit: parseFloat(netProfit.toFixed(2)),
              flashLoanable,
              strategy,
            });
          }
        }
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }

  depegs.sort((a, b) => b.netProfit - a.netProfit);
  return depegs;
}

export async function scanFlashloanArbs() {
  log("=== FLASHLOAN ARB SCANNER v1.0 ===");
  const results = {};

  try {
    results.evmArbs = await scanEvmArbs();
    log("[FLASH] " + results.evmArbs.length + " EVM cross-DEX arbs found");
  } catch (e) {
    log("[FLASH] EVM scan error: " + e.message);
    results.evmArbs = [];
  }

  try {
    results.solanaArbs = await scanSolanaArbs();
    log("[FLASH] " + results.solanaArbs.length + " Solana triangle arbs found");
  } catch (e) {
    log("[FLASH] Solana scan error: " + e.message);
    results.solanaArbs = [];
  }

  try {
    results.stableDepegs = await scanStableDepegs();
    log("[FLASH] " + results.stableDepegs.length + " stablecoin depeg arbs found");
  } catch (e) {
    log("[FLASH] Stable depeg scan error: " + e.message);
    results.stableDepegs = [];
  }

  results.summary = {
    totalArbs: (results.evmArbs?.length || 0) + (results.solanaArbs?.length || 0),
    totalDepegs: results.stableDepegs?.length || 0,
    totalEstProfit: [
      ...(results.evmArbs || []),
      ...(results.stableDepegs || []),
    ].reduce((s, a) => s + (a.netProfit || 0), 0) + (results.solanaArbs || []).reduce((s, a) => s + (a.netProfitUsd || 0), 0),
  };

  return { timestamp: new Date().toISOString(), ...results };
}
