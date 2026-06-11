// Liquidation Monitor & Executor v1.0
// Monitors lending protocol utilization, estimates at-risk volume, generates flashloan liquidation params
import { fetchJSON, log, saveData, cached, setCache } from "./utils.js";

const AAVE_POOLS = {
  ethereum: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  base: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  optimism: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
};

const RPC_URLS = {
  ethereum: "https://1rpc.io/eth",
  arbitrum: "https://1rpc.io/arb",
  base: "https://mainnet.base.org",
  optimism: "https://mainnet.optimism.io",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  bsc: "https://1rpc.io/bnb",
};

async function rpcCall(chain, data, to) {
  const url = RPC_URLS[chain];
  if (!url) return null;
  try {
    return (await fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }),
      timeout: 10000,
    })).result;
  } catch (e) { return null; }
}

async function getAtRiskMarkets() {
  log("[LIQ] Fetching lending market utilization...");

  const borrowKey = "liq_borrow";
  let borrow = cached(borrowKey, 120);
  if (!borrow) {
    borrow = await fetchJSON("https://yields.llama.fi/lendBorrow");
    setCache(borrowKey, borrow);
  }

  const supplyKey = "liq_supply";
  let supply = cached(supplyKey, 120);
  if (!supply) {
    const resp = await fetchJSON("https://yields.llama.fi/pools");
    supply = resp.data || resp;
    setCache(supplyKey, supply);
  }

  const supplyById = {};
  for (const p of supply) if (p.pool) supplyById[p.pool] = p;

  const lendingProtos = ["aave-v3", "aave-v2", "compound-v3", "morpho-v1", "spark", "benqi", "venus"];
  const results = [];

  for (const b of borrow) {
    const s = supplyById[b.pool];
    if (!s) continue;
    if (!lendingProtos.some(p => (s.project || "").includes(p))) continue;

    const totalSupply = b.totalSupplyUsd || 0;
    const totalBorrow = b.totalBorrowUsd || 0;
    if (totalSupply < 1000000 || totalBorrow < 500000) continue;

    const utilization = totalBorrow / totalSupply;
    if (utilization < 0.65) continue;

    // Data artifact filter: DefiLlama sometimes reports totalBorrow == totalSupply
    // (100% utilization) for large Aave v3 markets. Real 100% util would cause
    // borrow rates >50% from the interest rate curve. Skip if util >= 99.5% but
    // rate is moderate — confirms data is wrong, not a genuine crisis.
    const borrowRate = b.apyBaseBorrow || 0;
    if (utilization >= 0.995 && borrowRate < 50) continue;

    const ltv = b.ltv || 0;
    // Skip tokens with ltv=0 — these cannot be used as collateral, so no liquidation
    // opportunity exists. DefiLlama reports ltv=0 for borrow-only assets (USDE, USDT
    // on some chains, etc.). Without a real liquidation threshold, the scanner would
    // compute a fake 5% threshold producing nonsensical negative priceDropToLiq values.
    if (ltv === 0) continue;
    const liqThreshold = Math.min(ltv + 0.05, 0.95);
    const liqBonus = ltv >= 0.85 ? 4 : ltv >= 0.75 ? 5 : ltv >= 0.65 ? 7.5 : 10;
    const riskFactor = Math.pow(utilization, 3);
    // Probability discount: pool utilization != individual position health.
    // Even at 100% utilization, only a fraction of borrowers are close to liquidation.
    // Scale by 0.01 (1% of borrows realistically at-risk) instead of 0.15.
    const estAtRiskVolume = totalBorrow * riskFactor * 0.01;
    const estLiqProfit = estAtRiskVolume * (liqBonus / 100);
    const chain = (s.chain || "").toLowerCase();
    const gasPerLiq = chain === "ethereum" ? 50 : chain === "bsc" ? 1 : 3;
    const totalGas = gasPerLiq * 100;
    const netProfit = estLiqProfit - totalGas;
    const priceDropNeeded = ((1 - utilization / liqThreshold) * 100);

    // X56: Stablecoin markets with low borrow rates are in normal operation.
    // High utilization on stablecoins (90-97%) is routine — these are the most-borrowed
    // assets. Only when borrowRate exceeds 25% has the interest rate curve passed its
    // kink, indicating genuine stress. Discount score 0.2x for pre-kink stablecoins.
    const STABLECOIN_SYMS = /^(USDC|USDT|USDT0|USD₮0|DAI|FRAX|LUSD|GHO|CRVUSD|TUSD|BUSD|USDCE|USDBC|PYUSD|USDS|EURC|USDG|USP|FDUSD)$/i;
    const isStablecoin = STABLECOIN_SYMS.test((s.symbol || '').replace(/[.\s]/g, ''));
    const stablecoinDiscount = (isStablecoin && borrowRate < 25) ? 0.2 : 1.0;

    results.push({
      protocol: s.project, chain: s.chain, token: s.symbol,
      totalSupplyUsd: totalSupply, totalBorrowUsd: totalBorrow,
      utilization: parseFloat((utilization * 100).toFixed(1)),
      ltv: parseFloat((ltv * 100).toFixed(0)),
      liqThreshold: parseFloat((liqThreshold * 100).toFixed(0)),
      liqBonusPct: liqBonus,
      estAtRiskVolume: Math.round(estAtRiskVolume),
      estLiqProfit: Math.round(estLiqProfit),
      stablecoinDiscount,
      gasEstimate: totalGas, netProfitEstimate: Math.round(netProfit),
      borrowRate: parseFloat((b.apyBaseBorrow || 0).toFixed(2)),
      priceDropToLiq: parseFloat(priceDropNeeded.toFixed(1)),
      urgency: utilization > 0.9 ? "CRITICAL" : utilization > 0.8 ? "HIGH" : "MEDIUM",
      strategy: utilization > 0.85
        ? "IMMINENT: " + s.project + " " + s.symbol + "(" + s.chain + ") " + (utilization * 100).toFixed(0) + "% util. ~$" + (estAtRiskVolume / 1e6).toFixed(1) + "M at risk. " + liqBonus + "% bonus = ~$" + (estLiqProfit / 1e3).toFixed(0) + "K profit"
        : "MONITOR: " + s.project + " " + s.symbol + "(" + s.chain + ") " + (utilization * 100).toFixed(0) + "% util. Need " + priceDropNeeded.toFixed(0) + "% price drop",
      score: netProfit * (utilization > 0.85 ? 3 : utilization > 0.8 ? 2 : 1) * stablecoinDiscount,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function buildFlashloanLiqParams(market) {
  const chain = (market.chain || "").toLowerCase();
  const pool = AAVE_POOLS[chain];
  return {
    chain: market.chain, protocol: market.protocol, token: market.token,
    flashloanSource: pool ? "Aave v3 (" + pool + ")" : "Balancer (0% fee) or protocol-specific",
    flashloanFee: pool ? "0.09%" : "0%",
    steps: [
      "1. Flashloan debt token from " + (pool ? "Aave v3" : "Balancer"),
      "2. liquidationCall(collateral, debt, user, amount, false) on " + market.protocol,
      "3. Receive collateral + " + market.liqBonusPct + "% bonus",
      "4. Swap collateral -> debt via 1inch/Paraswap/CowSwap",
      "5. Repay flashloan + fee",
    ],
    profitFormula: "debt * " + market.liqBonusPct + "% - flash_fee - gas - slippage",
    estProfitPer10kLiq: Math.round(10000 * market.liqBonusPct / 100 - (chain === "ethereum" ? 50 : 3)),
    contractRequired: true,
    note: "Deploy IFlashLoanReceiver contract with liquidation + DEX swap logic",
  };
}

export async function checkHealthFactor(chain, address) {
  const pool = AAVE_POOLS[chain];
  if (!pool) return { error: "No Aave pool for " + chain };

  const paddedAddr = address.toLowerCase().replace("0x", "").padStart(64, "0");
  const result = await rpcCall(chain, "0xbf92857c" + paddedAddr, pool);
  if (!result || result === "0x" || result.length < 386) return { error: "RPC call failed" };

  const hex = result.replace("0x", "");
  const totalCollateral = parseInt(hex.slice(0, 64), 16) / 1e8;
  const totalDebt = parseInt(hex.slice(64, 128), 16) / 1e8;
  const healthFactor = parseInt(hex.slice(320, 384), 16) / 1e18;

  return {
    address, chain,
    totalCollateralUsd: parseFloat(totalCollateral.toFixed(2)),
    totalDebtUsd: parseFloat(totalDebt.toFixed(2)),
    healthFactor: parseFloat(healthFactor.toFixed(4)),
    liquidatable: healthFactor < 1.0,
    status: healthFactor < 1.0 ? "LIQUIDATABLE" : healthFactor < 1.05 ? "CRITICAL" : healthFactor < 1.1 ? "DANGER" : "SAFE",
    profitIfLiquidated: healthFactor < 1.0 ? Math.round(totalDebt * 0.5 * 0.05) : 0,
  };
}

export async function scanLiquidations() {
  log("=== LIQUIDATION MONITOR v1.0 ===");
  const results = {};

  try {
    results.markets = await getAtRiskMarkets();
    log("[LIQ] " + results.markets.length + " high-utilization markets found");
  } catch (e) {
    log("[LIQ] Error: " + e.message);
    results.markets = [];
  }

  results.flashloanParams = [];
  for (const m of (results.markets || []).slice(0, 10)) {
    results.flashloanParams.push(buildFlashloanLiqParams(m));
  }

  const critical = results.markets.filter(m => m.urgency === "CRITICAL");
  const high = results.markets.filter(m => m.urgency === "HIGH");
  results.summary = {
    total: results.markets.length,
    critical: critical.length,
    high: high.length,
    totalEstAtRisk: results.markets.reduce((s, m) => s + m.estAtRiskVolume, 0),
    totalEstProfit: results.markets.reduce((s, m) => s + Math.max(0, m.netProfitEstimate), 0),
  };

  return { timestamp: new Date().toISOString(), ...results };
}
