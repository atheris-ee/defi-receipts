#!/usr/bin/env node
// DeFi Opportunity Tracker v3.0 — full stack: yields, arb, carry, shortfarm, aggro, liquidation, flasharb

import { scanYields } from './yields.js';
import { scanArbitrage } from './arb.js';
import { scanLoops } from './loops.js';
import { scanCarryTrades } from './carry.js';
import { scanAggressive } from './aggro.js';
import { scanLiquidations, checkHealthFactor } from './liquidator.js';
import { scanFlashloanArbs } from './flasharb.js';
import { scanAlpha } from './alpha.js';
// Phase-0 read-only research collectors (measure off-DefiLlama edges; sign nothing, move no funds).
import { scanIncentives } from './research-incentives.js';
import { scanNav } from './research-nav.js';
import { scanFundingDispersion } from './research-funding.js';
import { scanPoolHistory } from './research-poolhistory.js';
import { scanDecayModel } from './research-decay.js';
import { saveData, loadData, formatPct, formatUSD, log } from './utils.js';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const COMMANDS = {
  scan: runFullScan, top: showTop, yields: runYields, arb: runArb,
  loops: runLoops, carry: runCarry, aggro: runAggro,
  liquidate: runLiquidate, flasharb: runFlashArb, health: runHealthCheck,
  report: generateReport,
  // Phase-0 research CLIs (run individually to inspect output)
  incentives: async () => console.log(JSON.stringify(await scanIncentives(), null, 2)),
  nav: async () => console.log(JSON.stringify(await scanNav(), null, 2)),
  fundingdisp: async () => console.log(JSON.stringify(await scanFundingDispersion(), null, 2)),
  poolhist: async () => console.log(JSON.stringify(await scanPoolHistory(), null, 2)),
  decay: async () => console.log(JSON.stringify(await scanDecayModel(), null, 2)),
};

// --- Realization feedback ----------------------------------------------------------------------
// The scanner reads its own outcome data: opportunity_realization (Postgres matview, refreshed
// ~every 30 min by pool-ingest) keyed by stable_fp = md5(category|stable_stem(action)).slice(0,12).
// The JS stem/fp here MUST stay byte-identical to the SQL functions in realize/realization.sql and
// the dashboard's copy in server.mjs — change all three together or identities diverge.
function stableStemJs(action) {
  let s = String(action || '');
  s = s.replace(/\s+[—–-]\s+current\s[\s\S]*$/, '');
  s = s.replace(/\s+@\s+[\s\S]*$/, '');
  s = s.replace(/\$?\d[\d.,]*\s*[KkMmBb]?%?/g, '');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}
function stableFpJs(cat, action) {
  return createHash('md5').update(String(cat || '') + '|' + stableStemJs(action)).digest('hex').slice(0, 12);
}
function loadRealizationMap() {
  try {
    const out = execSync(
      `${process.env.RECEIPTS_PSQL || 'psql -d defi -U defi'} -tAc "SELECT sfp,tvl_change_pct,apy_retention,days_obs,sightings FROM opportunity_realization WHERE tvl_change_pct IS NOT NULL"`,
      { encoding: 'utf8', timeout: 8000 });
    const m = new Map();
    for (const line of out.split('\n')) {
      const [sfp, tvl, ret, days, sgt] = line.split('|');
      if (sfp) m.set(sfp.trim(), { tvlChangePct: parseFloat(tvl), apyRetention: parseFloat(ret), daysObs: parseFloat(days), sightings: parseInt(sgt) });
    }
    return m;
  } catch (e) {
    log('[REALIZE] feedback unavailable (' + String(e.message || e).split('\n')[0] + ') — ranking without outcome data');
    return null;
  }
}

async function runFullScan() {
  log('=== FULL DEFI SCAN v3.0 ===');
  const results = {};
  const scanModule = async (name, fn, key) => {
    try {
      log('--- ' + name + ' ---');
      results[key] = await fn();
      saveData(key + '.json', results[key]);
    } catch (e) { log(name + ' error: ' + e.message); }
  };

  await scanModule('Yield Farming', scanYields, 'yields');
  await scanModule('Arbitrage', scanArbitrage, 'arb');
  await scanModule('Loops & Spreads', scanLoops, 'loops');
  await scanModule('Carry Trades', () => scanCarryTrades(CAPITAL_USD), 'carry');
  // 'Short-Farm' (scanShortFarms) MERGED INTO CARRY (consolidation 2026-05): shortfarm was a
  // near-clone of carry (same borrow->stake mechanic, imports carry's cost model). Its short-thesis
  // / dumpable-reward signal is now carried as annotation fields on carry entries.
  await scanModule('Aggressive', scanAggressive, 'aggro');
  await scanModule('Liquidation Monitor', scanLiquidations, 'liquidation');
  await scanModule('Flashloan Arb', scanFlashloanArbs, 'flasharb');
  // 'New Liquidity' (scanLiquidity) DROPPED (consolidation 2026-05): liquidity.json was an orphan —
  // never read by buildReport top_strategies nor the dashboard; its new-pairs endpoint was broken
  // (always 0) and boosted_tokens was unfiltered memecoin spam. Early-launch signal moves to alpha.js.
  await scanModule('Alpha Hunter', scanAlpha, 'alpha');

  // --- Phase-0 research collectors (read-only; isolated by scanModule try/catch so a failure
  // here can never affect the core scan/report). Each writes its own JSON for the dashboard +
  // the 5-min archive to time-series.
  await scanModule('Incentive Sniffer (Merkl)', scanIncentives, 'incentives');
  await scanModule('NAV Oracle (LST/stable)', scanNav, 'nav');
  await scanModule('Funding Dispersion (HL/CEX)', scanFundingDispersion, 'funding-dispersion');
  await scanModule('Pool History Capture', scanPoolHistory, 'pool-history');
  // Decay model reads the pool-history JSONL and writes its own decay-model.json — call directly
  // (not via scanModule, which would force a duplicate save of the large result object).
  try { log('--- Decay Model ---'); await scanDecayModel(); } catch (e) { log('Decay Model error: ' + e.message); }

  const report = buildReport(results, CAPITAL_USD);
  saveData('latest_report.json', report);
  printReport(report);
  log('=== SCAN COMPLETE ===');
}

async function runYields() {
  const r = await scanYields(); saveData('yields.json', r);
  for (const s of r.best_strategies.slice(0, 10)) {
    console.log('\n  ' + s.action);
    console.log('  APY: ' + formatPct(s.apy) + ' (' + s.sustainability + ') | Risk: ' + s.risk + '/10 | TVL: ' + formatUSD(s.tvl));
  }
}

async function runArb() {
  const r = await scanArbitrage(); saveData('arb.json', r);
  console.log(JSON.stringify({ cross_dex: r.cross_dex_opportunities.slice(0, 10), jupiter: r.jupiter_circular_arbs }, null, 2));
}

async function runLoops() {
  const r = await scanLoops(); saveData('loops.json', r);
  console.log(JSON.stringify({ spreads: r.lending_spreads.slice(0, 10) }, null, 2));
}

async function runCarry() {
  const r = await scanCarryTrades(CAPITAL_USD); saveData('carry.json', r);
  console.log('\n=== TOP CARRY TRADES ===');
  for (const c of r.top_carries.slice(0, 10)) {
    console.log('\n  ' + c.action);
    console.log('    ' + c.yieldSustainability + ' | Risk: ' + c.risk + '/10 | ' + (c.sameChain ? 'Same chain' : 'Cross-chain'));
  }
  if (r.free_borrow_carries.length) {
    console.log('\n=== FREE BORROW ===');
    for (const c of r.free_borrow_carries.slice(0, 5)) console.log('\n  ' + c.action);
  }
  if (r.top_stable_carries.length) {
    console.log('\n=== STABLECOIN CARRIES ===');
    for (const c of r.top_stable_carries.slice(0, 5)) console.log('\n  ' + c.action);
  }
}

async function runAggro() {
  const r = await scanAggressive(); saveData('aggro.json', r);
  console.log('\n=== AGGRESSIVE STRATEGIES ===');
  console.log('[CLM] ' + (r.clm?.total || 0) + ' concentrated liq opps');
  if (r.clm?.top) for (const c of r.clm.top.slice(0, 5)) console.log('  ' + c.strategy);
  console.log('\n[RECURSIVE LEVERAGE] ' + (r.recursive?.total || 0) + ' loops');
  if (r.recursive?.top) for (const l of r.recursive.top.slice(0, 5)) console.log('  ' + l.strategy);
  console.log('\n[FUNDING RATES] ' + (r.funding?.total || 0) + ' opportunities');
  if (r.funding?.top) for (const f of r.funding.top.slice(0, 5)) console.log('  ' + f.exchange + ' ' + f.symbol + ': ' + f.annualizedPct + '% annualized — ' + f.direction);
}

async function runLiquidate() {
  const r = await scanLiquidations(); saveData('liquidation.json', r);
  console.log('\n=== LIQUIDATION MONITOR ===');
  console.log('Markets: ' + r.summary.total + ' | Critical: ' + r.summary.critical + ' | High: ' + r.summary.high);
  console.log('Est at-risk: $' + (r.summary.totalEstAtRisk / 1e6).toFixed(1) + 'M | Est profit: $' + (r.summary.totalEstProfit / 1e3).toFixed(0) + 'K');
  for (const m of (r.markets || []).slice(0, 15)) {
    console.log('\n  [' + m.urgency + '] ' + m.strategy);
    console.log('    Util: ' + m.utilization + '% | Bonus: ' + m.liqBonusPct + '% | At-risk: $' + (m.estAtRiskVolume / 1e6).toFixed(1) + 'M | Net: $' + (m.netProfitEstimate / 1e3).toFixed(0) + 'K');
  }
  if (r.flashloanParams?.length) {
    console.log('\n--- FLASHLOAN LIQUIDATION PARAMS ---');
    for (const p of r.flashloanParams.slice(0, 5)) {
      console.log('\n  ' + p.protocol + ' ' + p.token + ' (' + p.chain + '):');
      console.log('    Source: ' + p.flashloanSource + ' (fee: ' + p.flashloanFee + ')');
      for (const s of p.steps) console.log('    ' + s);
      console.log('    Est profit per $10K liq: $' + p.estProfitPer10kLiq);
    }
  }
}

async function runFlashArb() {
  const r = await scanFlashloanArbs(); saveData('flasharb.json', r);
  console.log('\n=== FLASHLOAN ARB SCANNER ===');
  console.log('EVM arbs: ' + (r.evmArbs?.length || 0) + ' | Solana arbs: ' + (r.solanaArbs?.length || 0) + ' | Stable depegs: ' + (r.stableDepegs?.length || 0));
  console.log('Total est profit: $' + (r.summary?.totalEstProfit || 0).toFixed(2));
  if (r.evmArbs?.length) {
    console.log('\n--- EVM CROSS-DEX ARBS ---');
    for (const a of r.evmArbs.slice(0, 10)) {
      console.log('\n  ' + a.token + ' (' + a.chain + '): ' + a.buyDex + ' $' + a.buyPrice.toFixed(4) + ' -> ' + a.sellDex + ' $' + a.sellPrice.toFixed(4));
      console.log('    Spread: ' + a.spreadPct + '% | Size: $' + a.maxTradeSize + ' | Net: $' + a.netProfit + ' | Flash: ' + a.execution.flashSource);
    }
  }
  if (r.solanaArbs?.length) {
    console.log('\n--- SOLANA TRIANGLE ARBS ---');
    for (const a of r.solanaArbs.slice(0, 10)) {
      console.log('  ' + a.route + ' (' + a.size + '): ' + a.netProfitSol + ' SOL ($' + a.netProfitUsd + ') = ' + a.profitPct + '%');
    }
  }
  if (r.stableDepegs?.length) {
    console.log('\n--- STABLECOIN DEPEG ARBS ---');
    for (const d of r.stableDepegs.slice(0, 10)) {
      console.log('\n  ' + d.stable + ' on ' + d.dex + ' (' + d.chain + '): ' + d.direction + ' ' + d.deviation + '% | Net: $' + d.netProfit);
      console.log('    ' + d.strategy);
    }
  }
}

async function runHealthCheck() {
  const args = process.argv.slice(3);
  if (args.length < 2) {
    console.log('Usage: node src/index.js health <chain> <address>');
    console.log('Example: node src/index.js health ethereum 0x1234...');
    return;
  }
  const r = await checkHealthFactor(args[0], args[1]);
  console.log('\n=== HEALTH FACTOR CHECK ===');
  console.log(JSON.stringify(r, null, 2));
}

// runShortFarm removed — scanShortFarms is retired (merged into CARRY). Use `carry`.

function showTop() {
  const report = loadData('latest_report.json');
  if (!report) { log('No data. Run: node src/index.js scan'); return; }
  printReport(report);
}

function buildReport(results, capitalUsd = Infinity) {
  const topStrategies = [];

  // Yields
  // X72: Per-protocol diversification — max 2 entries from the same protocol per category.
  // Prevents single-protocol concentration risk (e.g. all 3 YIELD slots = pendle).
  // X109: Skip capital-unaffordable entries before consuming protocol slots. Without this,
  // expensive Ethereum entries consume 2 pendle slots, blocking cheap Base entries. At $200
  // capital, ALL yields were filtered out despite pendle APXUSD(Base) having minCap $0.
  if (results.yields?.best_strategies) {
    const protoCounts = {};
    const protoChainCounts = {}; // X231: per-protocol-per-chain cap
    const protoTokenCounts = {}; // X270: per-protocol-per-token dedup
    // X263: Per-token-per-chain cap — AUSD on stable-jack-v1(Avalanche) + AUSD-USDT on
    // joe-v2.2(Avalanche) consumed 2/3 YIELD slots for same token risk on same chain. If AUSD
    // depegs, both positions fail. Standard stablecoins (USDC, USDT, DAI, etc.) exempted since
    // they're independently managed and ubiquitous across pools.
    const YIELD_COMMON_STABLES = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'FRAX', 'TUSD', 'USDP', 'PYUSD', 'USDS', 'LUSD', 'GUSD', 'SUSD', 'MIM', 'USDD', 'CRVUSD', 'GHO', 'FDUSD', 'USDTB', 'USD₮0']);
    const yieldTokenChainSeen = {};
    let count = 0;
    for (const s of results.yields.best_strategies) {
      if (s.minCapitalUsd && s.minCapitalUsd > capitalUsd) continue;
      // X230: Same-token pair filter — "USDC-USDC" on uniswap-v4(Polygon) is a bridged variant
      // pool (USDC.e↔native USDC). Fees are transient (migration traffic), APY will go to 0%
      // once migration completes. Not a real yield strategy for users.
      const yieldSymMatch = (s.action || '').match(/\S+\s+(\S+)\s+on\s+/);
      if (yieldSymMatch) {
        const parts = yieldSymMatch[1].split('-');
        if (parts.length === 2 && parts[0] === parts[1]) continue;
      }
      // X263: Per-token-per-chain dedup — max 1 YIELD entry per non-stablecoin token per chain.
      // AUSD on stable-jack-v1(Avalanche) + AUSD-USDT on joe-v2.2(Avalanche) = same AUSD risk.
      const yieldChainForToken = (s.action.match(/on\s+(\S+)\s*$/) || [])[1] || 'unknown';
      if (yieldSymMatch) {
        const symParts = yieldSymMatch[1].split('-');
        const nonStableTokens = symParts.filter(t => !YIELD_COMMON_STABLES.has(t.toUpperCase()));
        let tokenDuped = false;
        for (const tok of nonStableTokens) {
          const tokChainKey = tok.toUpperCase() + '@' + yieldChainForToken;
          if (yieldTokenChainSeen[tokChainKey]) { tokenDuped = true; break; }
        }
        if (tokenDuped) continue;
        for (const tok of nonStableTokens) {
          yieldTokenChainSeen[tok.toUpperCase() + '@' + yieldChainForToken] = true;
        }
      }
      // X110: YIELD max risk cap — YIELD is the "simple deposit" category. Risk 6-7 volatile
      // LP entries (WSOL-GRIFFAIN meme LP, WBTC.B-USDC $528k TVL) dominated $200 YIELD slots
      // when safe Ethereum entries were capital-filtered. Safer alternatives existed (onre ONYC
      // risk 3, unitas SUSDU risk 3) but scored lower due to lower raw APY. Cap YIELD at risk
      // 5/10 — higher-risk pools still appear in CARRY/SHORT_FARM with more context.
      if (s.risk > 5) continue;
      // X128: YIELD absolute APY cap — 133,843% morpho-blue CSYUSDC ranked YIELD #10 at risk 5/10.
      // Even with 0.1x spike discount, the displayed APY was the raw 133K% headline — absurd for
      // a "simple deposit" recommendation. No passive deposit sustainably yields >1000% APY.
      // Pools with extreme base APY are transient fee spikes, data artifacts, or new-pool noise.
      // Cap at 1000% — higher APY pools surface in CARRY/SHORT_FARM with borrow context.
      const displayedApy = s.clmCapped ? s.apy : (s.realizedApyRatio && s.realizedApyRatio < 1.0 && !s.noRealizedData ? s.apy * s.realizedApyRatio : s.apy);
      if (displayedApy > 1000) continue;
      // X325: V3 passive-capped YIELD minimum APY (10%) — DAI-USDT uniswap-v4(Polygon) at
      // 7.10% risk 5 (after +1 V3 adj) is dominated by simple deposits (yo-protocol 8.48%
      // risk 2). V3 passive cap has ±30% estimation uncertainty; below 10%, the entry offers
      // worse risk-adjusted returns than non-V3 alternatives and doesn't justify range mgmt.
      if (s.clmCapped && displayedApy < 10) continue;
      // X339: YIELD LOW TVL + unverified (no 7d + no realized) filter — stable-jack-v1 AUSD
      // on Avalanche at 15.37%, $526K TVL, NO 7D, NO REALIZED occupied #9 at $200. Three
      // independent uncertainty signals: thin pool (rate dilutes on any deposit), zero short-term
      // history, zero long-term validation. Shown APY is entirely unvalidated — confidence well
      // below 80% mandate. Swiss cheese model: each signal alone is borderline, combined they
      // make the entry's return essentially a guess. Parity with borrow-farm compound filters.
      if (s.lowTvl && s.no7dData && s.noRealizedData) continue;
      // X343: YIELD FEE SPIKE + unverified (no7d + noRealized) filter — gmtrade USDCHF-USDC
      // at 22.80% spike-adjusted (headline 45.60%) with NO 7D + NO REALIZED at risk 5 occupied
      // #4 at $200. The spike adjustment halves the deviation from historical averages, but
      // without 7d data the baseline is mean30d or absent, and without realized data there's
      // no evidence that even normal-period rates are real. The shown APY is an estimate of an
      // estimate with zero validation — confidence well below 80% mandate. CLM had this filter
      // at risk>=6 (X341); YIELD filters regardless of risk because the spike+double-unverified
      // compound makes the YIELD estimate itself unreliable (no concentration multiplier needed).
      // Entries with realized data (curve-dex, yearn-finance) correctly retained — realized
      // provides partial validation even without 7d tracking.
      if (s.spikeDiscounted && s.no7dData && s.noRealizedData) continue;
      // X344: YIELD nonMajorToken + unverified (no7d + noRealized) filter — iaero-protocol IAERO
      // at 22.28%, risk 5 with NO 7D + NO REALIZED + NON-MAJOR TOKEN at $200 #10. The user must
      // BUY a volatile protocol-native token (token price risk ~50% downside for micro-cap natives)
      // AND the yield is entirely unverified from any timeframe. At 22.28%: a 50% token crash in
      // month 1 wipes a year of yield even if the rate is real — and there's zero evidence it IS
      // real. Same compound pattern as X339 (lowTvl+unverified) and X343 (spike+unverified): two
      // independent risk dimensions (token volatility + data gap) each alone borderline, combined
      // below 80% mandate confidence. Major tokens (USDC, ETH) don't have this filter — their
      // price risk is a known, bounded quantity that doesn't compound with data uncertainty.
      if (s.nonMajorToken && s.no7dData && s.noRealizedData) continue;
      const proto = (s.action.match(/Deposit into (\S+)/) || [])[1] || 'unknown';
      if ((protoCounts[proto] || 0) >= 2) continue;
      // X231: Per-protocol-per-chain cap (1) — pendle APYUSD(Ethereum) + pendle APXUSD(Ethereum)
      // consumed 2/3 YIELD slots for same protocol on same chain. If pendle on Ethereum has a
      // smart contract issue, both entries fail. pendle APXUSD(Base) at position 5 was blocked
      // despite providing chain diversity. Cap 1 per proto+chain ensures multi-chain exposure.
      const yieldChain = (s.action.match(/on\s+(\S+)\s*$/) || [])[1] || 'unknown';
      const protoChainKey = proto + '@' + yieldChain;
      if ((protoChainCounts[protoChainKey] || 0) >= 1) continue;
      // X270: Per-protocol-per-token dedup — yo-protocol USDC on Base (#8) and yo-protocol USDC
      // on Arbitrum (#12) showed identical 8.34% APY occupying 2 YIELD slots. Same protocol +
      // same token across chains = same product (same smart contract logic, same reward mechanism).
      // User picks the better deployment (higher TVL, lower risk). Max 1 per proto+token combo.
      const yieldTokenForDedup = yieldSymMatch ? yieldSymMatch[1].toUpperCase() : 'unknown';
      const protoTokenKey = proto + '|' + yieldTokenForDedup;
      if ((protoTokenCounts[protoTokenKey] || 0) >= 1) continue;
      protoTokenCounts[protoTokenKey] = (protoTokenCounts[protoTokenKey] || 0) + 1;
      protoChainCounts[protoChainKey] = (protoChainCounts[protoChainKey] || 0) + 1;
      protoCounts[proto] = (protoCounts[proto] || 0) + 1;
      // X211: CeDeFi detection for YIELD entries — derive from protocol name in action string
      // for cached-data robustness (yields.json may predate the cedefi field).
      // bitway(BSC) at 12% on stablecoins: centralized custody, no on-chain yield source.
      const CEDEFI_YIELD_PROJS = new Set(['bitway']);
      const isCedefiYield = s.cedefi || CEDEFI_YIELD_PROJS.has(proto.toLowerCase()) || proto.toLowerCase().includes('cedefi');
      // X224: RWA/credit protocol detection for YIELD entries — borrower default risk
      const RWA_CREDIT_YIELD_PROJS = new Set(['goldfinch', 'maple', 'clearpool', 'truefi', 'centrifuge', 'credix', 'huma', 'atlendis', 'ribbon-lend', 'jia', 'florence-finance']);
      const isRwaCreditYield = s.rwaCredit || RWA_CREDIT_YIELD_PROJS.has(proto.toLowerCase());
      // X101: Show realized-adjusted APY for YIELD entries with empirical realized data.
      // yearn YCRV: headline 23.42% but 0.7x realized → user gets ~16.4%. Showing 23.42%
      // is a 30% overstatement (outside ±20% mandate target). CARRY/SHORT_FARM already show
      // adjusted APY inline — YIELD should too for consistency and actionability.
      // Only adjust when we have actual empirical data (not the X63 0.9x default for unknown protocols).
      const hasEmpiricalRealized = s.realizedApyRatio && s.realizedApyRatio < 0.955 && !s.noRealizedData; // X220: suppress ≥96% (noise — ≤4% gap not actionable)
      // X124: Add declining context to YIELD display — parity with carry.js/shortfarm.js.
      // saturn SUSDAT showed "14.41% APY" in YIELD but "(7d 20%) [DECLINING]" in CARRY for same pool.
      // X185: Show declining tag from mean30d when no 7d data. superform SUP had mean30d=47.5%
      // vs current 29.3% — meaningful decline signal without 7d tracking.
      const decliningTag = s.declining7d
        ? (s.apyBase7d ? ' (7d was ' + formatPct(s.apyBase7d) + ') [DECLINING]'
                       : (s.apyMean30d ? ' (30d avg ' + formatPct(s.apyMean30d) + ') [DECLINING]' : ' [DECLINING]'))
        : '';
      // X141: Spike-discounted YIELD display — show spike-adjusted APY as primary when
      // spikeDiscounted is true. IDAI-IUSDC-IUSDT (curve stablecoin 3-pool, 238% headline,
      // spikeFactor 0.3) displayed "238.64% APY" at risk 3/10 — 3.3x overstatement vs the
      // system's own 0.3x valuation. Transient fee spikes are not sustainable yields.
      // Use mean30d as expected APY when available (more stable estimate), else apy*spikeFactor.
      const isSpikeDisplay = s.spikeDiscounted && s.spikeFactor && s.spikeFactor < 1.0;
      // X142: Use min(mean30d, apy*spikeFactor) — when spike persists for weeks, mean30d is
      // also inflated. IDAI mean30d=138.76 but apy*0.3=71.59 — mean30d is 1.9x overstatement.
      const spikeEstFromFactor = s.apy * s.spikeFactor;
      const spikeEstFromMean = (s.apyMean30d && s.apyMean30d < s.apy) ? s.apyMean30d : spikeEstFromFactor;
      const spikeAdjApy = isSpikeDisplay ? Math.min(spikeEstFromMean, spikeEstFromFactor) : null;
      const spikeTag = isSpikeDisplay ? ' [FEE SPIKE]' : '';
      // X248: Rate-elevated YIELD display — show conservative APY (mean30d*1.2 cap) as primary
      // when current >> mean30d. pendle SUPERUSDC: 18.26% current but mean30d 11.17% → show
      // "~13.41% APY (current 18.26%, rate elevated above 30d avg)" to match carry.js X220/X235.
      const isElevatedDisplay = s.rateElevated && s.apyMean30d && s.apyMean30d < s.apy;
      const elevatedConservativeApy = isElevatedDisplay ? Math.min(s.apy * 0.8, s.apyMean30d * 1.2) : null;
      const yieldReturn = s.clmCapped
        ? formatPct(s.apy) + ' APY (passive cap; ' + formatPct(s.apyHeadline) + ' headline)'
        : isSpikeDisplay
          ? 'est. ~' + formatPct(spikeAdjApy) + ' APY (headline ' + formatPct(s.apy) + ') [FEE SPIKE]'
          : isElevatedDisplay
            ? '~' + formatPct(elevatedConservativeApy) + ' APY (current ' + formatPct(s.apy) + ', rate elevated above 30d avg)'
            : hasEmpiricalRealized
              ? formatPct(s.apy * s.realizedApyRatio) + ' APY (headline ' + formatPct(s.apy) + ', realized ' + Math.round(s.realizedApyRatio * 100) + '%)' + decliningTag
              : formatPct(s.apy) + ' APY' + decliningTag;
      // X170/X195: V3 pool YIELD entries (clmCapped) show passive cap APY estimate. +1 risk
      // retained for V3 smart contract complexity + uncertainty in passive cap estimate.
      // Label changed from "active management required" (contradicts passive cap display) to
      // "passive cap estimate, actual yield depends on price range".
      // X211: CeDeFi +2 risk for centralized custody counterparty risk (parity with carry.js/shortfarm.js X171)
      const cedefiRiskAdj = isCedefiYield ? 2 : 0;
      const yieldRisk = Math.min((s.clmCapped ? s.risk + 1 : s.risk) + cedefiRiskAdj, 10);
      if (yieldRisk > 5) continue; // X110 re-check after CeDeFi adjustment
      topStrategies.push({ rank: 0, category: 'YIELD', action: s.action, expectedReturn: yieldReturn, sustainability: s.sustainability, risk: yieldRisk + '/10', tvl: formatUSD(s.tvl), profitScore: Math.min(s.profitScore * (isCedefiYield ? 0.5 : 1.0), 500), minCapitalUsd: s.minCapitalUsd, bagTrap: s.bagTrap, lowTvl: s.lowTvl, microPool: s.microPool, volatileLp: s.volatileLp, declining7d: s.declining7d, rateElevated: isElevatedDisplay || undefined, highYieldApy: isElevatedDisplay ? s.apy : undefined, highYieldHistorical: isElevatedDisplay ? s.apyMean30d : undefined, no7dData: s.no7dData, noRealizedData: s.noRealizedData, nonMajorToken: s.nonMajorToken, cedefi: isCedefiYield || undefined, rwaCredit: isRwaCreditYield || undefined, realizedApyRatio: s.realizedApyRatio, spikeDiscounted: isSpikeDisplay || undefined, concentratedLp: s.clmCapped || undefined });
      if (++count >= 3) break;
    }
  }
  // Farmable 7D (short-term farming on cheap chains)
  if (results.yields?.farmable_7d) {
    for (const p of results.yields.farmable_7d.slice(0, 3)) {
      const displayBlend7d = p.clmAdjBlend7d != null ? p.clmAdjBlend7d : p.apyBlend7d;
      topStrategies.push({ rank: 0, category: 'FARMABLE_7D', action: `Farm ${p.project} ${p.symbol} on ${p.chain} (7d window)`, expectedReturn: formatPct(displayBlend7d) + ' blended 7d APY' + (p.clmAdjBlend7d != null ? ' (passive-LP adj)' : ''), sustainability: p.sustainability, risk: p.risk + '/10', tvl: formatUSD(p.tvlUsd), profitScore: Math.min(p.profitScore * 0.8, 400), bagTrap: p.bagTrap });
    }
  }
  // Arbs
  // X48: ARB risk scoring — cross-DEX arbs require execution timing and compete with MEV bots.
  // Base risk 3/10 (atomic execution possible on same chain), +1 for CHECK_SLIPPAGE feasibility,
  // +2 for LIKELY_STALE (>2% spread), +3 for CERTAINLY_STALE (>5% spread — API data noise),
  // +1 for low net profit (<$100 — gas competition eats into thin margins).
  // X69: LIKELY_STALE score penalty — 0.3x profit score (stale pricing, not executable).
  // X83: CERTAINLY_STALE — >5% spread is not "likely" stale, it's API error territory.
  // X86: VERY_LIKELY_STALE — 3-5% spread between major DEXes is virtually always stale.
  // X121: Stablecoins have tighter staleness thresholds — most arbitraged tokens in DeFi.
  // Stablecoin spreads >0.5% between major DEXes are almost certainly stale data.
  // No 5%+ cross-DEX arb survives seconds on-chain. Score 0.05x (essentially filtered).
  if (results.arb?.cross_dex_opportunities) {
    for (const a of results.arb.cross_dex_opportunities.slice(0, 10)) {
      // X86: Derive staleness tier from actual spread % (handles cached feasibility labels too)
      // X121: Stablecoin-specific thresholds (>0.5% LIKELY_STALE, >1% VERY_LIKELY_STALE, >2% CERTAINLY_STALE)
      // X154: Chain-native token thresholds (>0.75% LIKELY_STALE, >1.5% VERY_LIKELY_STALE, >3% CERTAINLY_STALE)
      // X206: Major volatile token thresholds (>0.75% LIKELY_STALE, >1.5% VERY_LIKELY_STALE, >3% CERTAINLY_STALE)
      // WBTC/CBBTC between curve and uniswap on Ethereum have multi-billion $ liquidity —
      // aggregators and MEV bots capture any real spread within a single block. Same competition
      // level as chain-native tokens, deserves same thresholds.
      // X214: Add major Solana DeFi tokens — deeply liquid on all Solana DEXes, connected via
      // Jupiter aggregator, actively arbed by MEV bots. >0.75% spread is stale pricing.
      // X239: Add BONK/WIF — top Solana meme tokens by DEX volume ($50-100M+/day), Jupiter-routed.
      // BONK showed 1.384% spread in one scan, 0.206% two minutes later — proving staleness.
      // X242: Add major Ethereum DeFi tokens — deeply liquid on Uniswap+Sushiswap+Curve, routed
      // through 1inch/Paraswap/CoW. LINK 1.209% uniswap→sushiswap is stale data.
      const MAJOR_ARB_TOKENS = new Set(['WBTC', 'BTC.B', 'CBBTC', 'TBTC', 'WBTC.B', 'BTCB', 'JTO', 'JUP', 'RAY', 'PYTH', 'BONK', 'WIF', 'LINK', 'UNI', 'AAVE', 'MKR', 'CRV', 'LDO']);
      const spreadPctNum = parseFloat(a.spreadPct) || 0;
      const isStablecoinArb = a.isStablecoin || false;
      // X154: Derive chain-native from token+chain for cached-data robustness
      const CHAIN_NATIVE_TOKENS_IDX = { solana: ['SOL', 'WSOL'], ethereum: ['ETH', 'WETH'], bsc: ['BNB', 'WBNB'], avalanche: ['AVAX', 'WAVAX'], polygon: ['MATIC', 'WMATIC', 'POL'], arbitrum: ['ETH', 'WETH'], base: ['ETH', 'WETH'], optimism: ['ETH', 'WETH'] };
      const arbChain = (a.chain || '').toLowerCase();
      const arbToken = (a.token || '').toUpperCase();
      const isChainNativeArb = a.isChainNative || !!(CHAIN_NATIVE_TOKENS_IDX[arbChain] && CHAIN_NATIVE_TOKENS_IDX[arbChain].includes(arbToken));
      const isMajorVolatileArb = !isChainNativeArb && MAJOR_ARB_TOKENS.has(arbToken);
      const isCertainlyStale = isStablecoinArb ? (spreadPctNum > 2 || a.feasibility === 'CERTAINLY_STALE') : (isChainNativeArb || isMajorVolatileArb) ? (spreadPctNum > 3 || a.feasibility === 'CERTAINLY_STALE') : (spreadPctNum > 5 || a.feasibility === 'CERTAINLY_STALE');
      const isVeryLikelyStale = !isCertainlyStale && (isStablecoinArb ? (spreadPctNum > 1 || a.feasibility === 'VERY_LIKELY_STALE') : (isChainNativeArb || isMajorVolatileArb) ? (spreadPctNum > 1.5 || a.feasibility === 'VERY_LIKELY_STALE') : (spreadPctNum > 3 || a.feasibility === 'VERY_LIKELY_STALE'));
      const isStale = !isCertainlyStale && !isVeryLikelyStale && (isStablecoinArb ? (spreadPctNum > 0.5 || a.feasibility === 'LIKELY_STALE') : (isChainNativeArb || isMajorVolatileArb) ? (spreadPctNum > 0.75 || a.feasibility === 'LIKELY_STALE') : (spreadPctNum > 2 || a.feasibility === 'LIKELY_STALE'));
      const effectiveFeasibility = isCertainlyStale ? 'CERTAINLY_STALE' : isVeryLikelyStale ? 'VERY_LIKELY_STALE' : isStale ? 'LIKELY_STALE' : a.feasibility;
      // X77: ARB minimum capital from gas cost vs spread
      const arbGas = parseFloat(a.estGasCost) || 0;
      const arbSpreadFrac = spreadPctNum / 100 || 0.001;
      const arbMinCapital = arbGas > 0 ? Math.ceil(arbGas / arbSpreadFrac) : 0;
      // X82: Score by capital-adjusted net profit, not theoretical max from $1M+ trades.
      const arbMaxTrade = parseFloat(a.maxTradeSize) || capitalUsd;
      const arbEffectiveTrade = Math.min(capitalUsd, arbMaxTrade);
      // X228: AMM slippage estimation — constant-product AMM price impact = trade²/(2*poolLiq).
      // On thin pools ($100-200K), a $2-5K trade causes 1-2% slippage that exceeds the spread.
      // X268: Slippage on BOTH sides — arb = buy from DEX A + sell to DEX B. Each side has
      // independent price impact. WIF: buyLiq $4.9M (negligible slippage) but sellLiq $103K
      // (sell $2K into $103K pool → 1% impact → $20 slippage > 0.5% spread = net negative).
      // X228 only used buyLiquidity, missing sell-side. Both BONK ($565K sell) and WIF ($103K
      // sell) showed positive net profit that doesn't exist after sell-side slippage.
      const arbBuyLiq = parseFloat(a.buyLiquidity) || 0;
      const arbSellLiq = parseFloat(a.sellLiquidity) || 0;
      const arbBuySlip = arbBuyLiq > 0 ? (arbEffectiveTrade * arbEffectiveTrade) / (2 * arbBuyLiq) : 0;
      const arbSellSlip = arbSellLiq > 0 ? (arbEffectiveTrade * arbEffectiveTrade) / (2 * arbSellLiq) : 0;
      const arbSlippageCost = arbBuySlip + arbSellSlip;
      const arbCapitalNet = arbEffectiveTrade * arbSpreadFrac - arbGas - arbSlippageCost;
      // X112: Skip ARB entries where capital-adjusted net profit < $5 — not worth execution effort
      if (arbCapitalNet < 5) continue;
      // X122: Skip CERTAINLY_STALE ARB entries entirely — >5% spread (non-stablecoin) or >2%
      // (stablecoin) is guaranteed API data noise. No real arb of this magnitude survives even
      // milliseconds on-chain. Showing these wastes report slots and erodes user trust.
      // SOL 19.224% orca→meteora at #14 displayed "Net: $961" — completely non-executable.
      if (isCertainlyStale) continue;
      // X162: Also skip VERY_LIKELY_STALE — >3% spread for volatile tokens between major DEXes
      // has >95% probability of being stale API data. Aggregators (Jupiter, 1inch) route through
      // all DEXes atomically — any real spread of this magnitude is captured within a single block.
      // JTO 4.053% orca→raydium at $200 rank #19: clearly stale, wastes a report slot.
      if (isVeryLikelyStale) continue;
      // X195: Also skip LIKELY_STALE — stablecoin >0.5%, chain-native >0.75%, volatile >2% spreads
      // between major DEXes have <20% probability of being real. Aggregators (Jupiter, 1inch, Paraswap)
      // route across all DEXes — any surviving spread is captured within seconds. Showing these wastes
      // report slots with near-zero actionability. USDC 0.6% curve→balancer: definitely stale.
      if (isStale) continue;
      const staleFactor = isStale ? 0.3 : 1;
      const staleRisk = isStale ? 2 : effectiveFeasibility === 'CHECK_SLIPPAGE' ? 1 : 0;
      const arbRisk = Math.min(10, 3 + staleRisk + (arbCapitalNet < 100 ? 1 : 0));
      let arbScore = arbCapitalNet * staleFactor;
      // Cap at 500 — matching LIQUIDATION cap from X15.
      arbScore = Math.min(arbScore, 500);
      // X154: Label for chain-native token staleness
      const arbNativeLabel = isChainNativeArb && (isStale || isVeryLikelyStale) ? ' [NATIVE LIKELY STALE]' : '';
      topStrategies.push({ rank: 0, category: 'ARB', action: 'Buy ' + a.token + ' on ' + a.buyDex + ', sell on ' + a.sellDex + ' [' + a.chain + ']' + arbNativeLabel, expectedReturn: a.spreadPct + '% per trade', netProfit: '$' + arbCapitalNet.toFixed(2), feasibility: effectiveFeasibility, risk: arbRisk + '/10', profitScore: arbScore, minCapitalUsd: arbMinCapital });
    }
  }
  // X199: Circular LST carry filter — borrowing an LST and depositing into its own staking
  // protocol is not a real trade. The pool's APY is the token's inherent appreciation.
  const LST_ISSUER_MAP = {
    'MSOL': 'marinade', 'JITOSOL': 'jito', 'JUPSOL': 'jupiter-staked',
    'BNSOL': 'binance-staked', 'BSOL': 'blazestake', 'STETH': 'lido', 'WSTETH': 'lido',
    'RETH': 'rocket-pool', 'CBETH': 'coinbase-wrapped', 'SWETH': 'swell',
    'METH': 'mantle-staked', 'ANKRSOL': 'ankr',
  };
  function isCircularLst(token, stakeIn) {
    const prefix = LST_ISSUER_MAP[(token || '').toUpperCase()];
    if (!prefix) return false;
    return (stakeIn || '').toLowerCase().includes(prefix);
  }

  // Carry
  // X72: max 2 entries per destination protocol to diversify recommendations
  if (results.carry?.top_carries) {
    const protoCounts = {};
    const protoChainCounts = {}; // X304: per-dest-protocol-per-chain cap (1)
    // X203: Borrow-source dedup — user borrows token from one protocol once and picks best
    // destination. Parity with FREE_SHORT (X107) and FREE_CARRY borrow-source dedup.
    const borrowSources = {};
    let count = 0;
    for (const c of results.carry.top_carries) {
      if (c.minEconomicalUsd && c.minEconomicalUsd > capitalUsd) continue; // X109
      if (c.risk > 7) continue; // X188: risk cap — risk 8+ carry entries have too many compounding risk factors (spike+decline+lowTvl) to be actionable within ±20% mandate
      if (isCircularLst(c.token, c.stakeIn)) continue; // X199: circular LST carry
      const borrowKey = (c.token + '|' + (c.borrowFrom || '')).toLowerCase();
      if (borrowSources[borrowKey]) continue; // X203
      borrowSources[borrowKey] = true;
      const proto = (c.stakeIn || '').replace(/\s*\(.*\)/, '').toLowerCase();
      const destChain = (c.stakeIn || '').match(/\(([^)]+)\)/)?.[1]?.toLowerCase() || '';
      const protoChainKey = proto + '@' + destChain;
      if ((protoCounts[proto] || 0) >= 2) continue;
      // X304: Per-dest-protocol-per-chain cap (1) — BTC.B and ARB both going to gmx-v2-perps(Arbitrum)
      // share the same smart contract risk. If gmx-v2-perps has an Arbitrum exploit, both fail.
      // Cap 1 per proto@chain, retain per-protocol cap of 2 for cross-chain diversity.
      if ((protoChainCounts[protoChainKey] || 0) >= 1) continue;
      protoCounts[proto] = (protoCounts[proto] || 0) + 1;
      protoChainCounts[protoChainKey] = (protoChainCounts[protoChainKey] || 0) + 1;
      // X103: Use conservativeNet for decaying pools — 7d-based estimate matches ±20% mandate
      const carryDisplayNet = c.conservativeNet != null ? c.conservativeNet : c.netSpread;
      // X164: Skip entries with ≤0% displayed net carry — zero return doesn't justify smart contract risk
      if (carryDisplayNet <= 0) continue;
      // X213: CARRY leverage heading parity with SHORT_FARM (X184) — show leverage multiple + risk in heading
      // Same conditions: same-chain (X79 suppresses cross-chain leverage), maxLeverage > 2, not leveraged protocol dest
      // X262: Suppress leverage for CEDEFI — leveraged deposit into centralized custody means
      // 4x total loss if entity collapses (Celsius, BlockFi, FTX Earn precedent). Showing
      // "up to 4.0x = 22.7%" promotes a catastrophic risk posture. Keep base carry display.
      // X265: Also suppress leverage for nonMajorBorrow — thin lending markets spike 3-5x on
      // utilization events, and at 10x leverage a borrow spike from 9% to 25% wipes the position.
      const carryLevOk = c.sameChain && c.maxLeverage > 2 && !c.leveragedProj && !c.cedefi && !c.nonMajorBorrow;
      const carryExpected = carryLevOk
        ? '+' + carryDisplayNet.toFixed(1) + '% net carry (up to ' + c.maxLeverage.toFixed(1) + 'x = ' + (carryDisplayNet * c.maxLeverage).toFixed(1) + '%, risk ' + (c.leveragedRisk || c.risk) + '/10)'
        : '+' + carryDisplayNet.toFixed(1) + '% net carry';
      // X216: Strip leverage suffix from action string when already shown in heading (X213).
      // X265: Also strip when nonMajorBorrow — don't promote leverage on thin lending markets.
      const stripLev = carryLevOk || c.nonMajorBorrow || c.cedefi;
      const carryAction = stripLev ? c.action.replace(/\s*\(up to [\d.]+x = [\d.]+%, risk \d+\/10 at leverage\)$/, '') : c.action;
      topStrategies.push({ rank: 0, category: c.netBorrowCost < 0 ? 'FREE_CARRY' : 'CARRY', action: carryAction, expectedReturn: carryExpected, sustainability: c.yieldSustainability, risk: c.risk + '/10', tvl: c.stakeTvl ? formatUSD(c.stakeTvl) : undefined, sameChain: c.sameChain, hardBridge: c.hardBridge, nonEvmBridge: c.nonEvmBridge, minCapitalUsd: c.minEconomicalUsd || 0, profitScore: c.score, bagTrap: c.bagTrap, lowTvlDest: c.lowTvlDest, riskyLp: c.riskyLp, volatileLp: c.volatileLp, perpsLp: c.perpsLp || undefined, no7dData: c.no7dData, noRealizedData: c.noRealizedData, declining7d: c.declining, predictedDeclining: c.predictedDeclining, rateElevated: c.rateElevated || undefined, leveragedRisk: c.leveragedRisk, leveragedProj: c.leveragedProj, unverifiedMicroLp: c.unverifiedMicroLp, cedefi: c.cedefi, rwaCredit: c.rwaCredit || undefined, nonMajorBorrow: c.nonMajorBorrow, concentratedLp: c.v3Discounted || undefined, tightCarry: c.tightCarry || undefined, decaying: c.decaying || undefined });
      if (++count >= 5) break;
    }
  }
  // SHORT_FARM + FREE_SHORT report blocks REMOVED (consolidation 2026-05): shortfarm was a
  // near-clone of carry (same borrow->stake mechanic, 63% identical top trades, imports carry's
  // cost model). The scanner no longer runs scanShortFarms; the borrow-and-stake universe is
  // covered by CARRY/FREE_CARRY below, with a short-thesis annotation carried on carry entries.

  // X117: Carry free borrows — 0% borrow rate trades (BTC from sparklend, OSETH from aave-v3, etc.)
  // These were generated by carry.js but never pushed to topStrategies. Shortfarm's free_borrow_farms
  // covers the dump-rewards angle; carry's free_borrow_carries covers the rate-differential angle
  // with leverage info. Cross-dedup (X42) handles overlapping trades.
  if (results.carry?.free_borrow_carries) {
    const protoCounts = {};
    const protoChainCounts = {}; // X304: per-dest-protocol-per-chain cap (1)
    const borrowSources = {};
    let count = 0;
    for (const c of results.carry.free_borrow_carries) {
      if (c.minEconomicalUsd && c.minEconomicalUsd > capitalUsd) continue;
      if (c.risk > 7) continue; // X188: risk cap parity with CARRY
      if (isCircularLst(c.token, c.stakeIn)) continue; // X199: circular LST carry
      const proto = (c.stakeIn || '').replace(/\s*\(.*\)/, '').toLowerCase();
      const destChain = (c.stakeIn || '').match(/\(([^)]+)\)/)?.[1]?.toLowerCase() || '';
      const protoChainKey = proto + '@' + destChain;
      if ((protoCounts[proto] || 0) >= 2) continue;
      // X304: Per-dest-protocol-per-chain cap (1) — parity with CARRY/SHORT_FARM/FREE_SHORT above
      if ((protoChainCounts[protoChainKey] || 0) >= 1) continue;
      const borrowKey = (c.token + '|' + (c.borrowFrom || '')).toLowerCase();
      if (borrowSources[borrowKey]) continue;
      borrowSources[borrowKey] = true;
      protoCounts[proto] = (protoCounts[proto] || 0) + 1;
      protoChainCounts[protoChainKey] = (protoChainCounts[protoChainKey] || 0) + 1;
      const carryDisplayNet = c.conservativeNet != null ? c.conservativeNet : c.netSpread;
      // X164: Skip entries with ≤0% displayed net carry
      if (carryDisplayNet <= 0) continue;
      topStrategies.push({ rank: 0, category: 'FREE_CARRY', action: c.action, expectedReturn: '+' + carryDisplayNet.toFixed(1) + '% net carry (FREE borrow)', sustainability: c.yieldSustainability, risk: c.risk + '/10', tvl: c.stakeTvl ? formatUSD(c.stakeTvl) : undefined, sameChain: c.sameChain, hardBridge: c.hardBridge, nonEvmBridge: c.nonEvmBridge, minCapitalUsd: c.minEconomicalUsd || 0, profitScore: c.score * 1.5, bagTrap: c.bagTrap, lowTvlDest: c.lowTvlDest, riskyLp: c.riskyLp, volatileLp: c.volatileLp, perpsLp: c.perpsLp || undefined, no7dData: c.no7dData, noRealizedData: c.noRealizedData, declining7d: c.declining, predictedDeclining: c.predictedDeclining, rateElevated: c.rateElevated || undefined, leveragedRisk: c.leveragedRisk, leveragedProj: c.leveragedProj, cedefi: c.cedefi, rwaCredit: c.rwaCredit || undefined, nonMajorBorrow: c.nonMajorBorrow, concentratedLp: c.v3Discounted || undefined, tightCarry: c.tightCarry || undefined, decaying: c.decaying || undefined });
      if (++count >= 3) break;
    }
  }
  // Spreads
  // X80: SPREAD category cap (max 5 entries, max 2 per destination protocol) — consistent with
  // CARRY/SHORT_FARM caps. Without this, ~12 spreads flood the report (9 of 43 slots in current
  // snapshot), crowding out more actionable categories. Marginal 1-2% spreads are not worth
  // the smart contract risk of moving funds.
  if (results.loops?.lending_spreads) {
    // Score all spreads first, then sort and cap
    // X140: Non-EVM chains — bridging EVM↔non-EVM requires Wormhole/deBridge (past exploits,
    // different address formats). +1 risk vs EVM↔EVM cross-chain.
    const NON_EVM_SPREAD = new Set(['solana', 'sui', 'aptos', 'bitcoin', 'sei']);
    const scoredSpreads = [];
    for (const s of results.loops.lending_spreads) {
      // X45+X79: SPREAD risk scoring — same-chain lending moves are low risk (2/10),
      // cross-chain adds +1, spike-capped rates add +1, hard bridge adds +2 (complex path, may need CEX)
      // X109: +1 risk for low-TVL destinations (<$1M) — deposit dilutes pool APY (parity with carry.js)
      const isLowTvlDest = (s.highYieldTvl || 0) < 1000000;
      const isMicroTvlDest = (s.highYieldTvl || 0) < 500000;
      // X140: +1 risk for non-EVM bridge (Solana, Sui, Aptos cross-chain — need Wormhole/deBridge)
      // Derive from chain names for robustness (works with cached data that predates loops.js change)
      const spreadHighChain = (s.highYieldChain || '').toLowerCase();
      const spreadLowChain = (s.lowYieldChain || '').toLowerCase();
      const isNonEvmBridge = s.nonEvmBridge || (!s.sameChain && !s.hardBridge && (NON_EVM_SPREAD.has(spreadHighChain) || NON_EVM_SPREAD.has(spreadLowChain)));
      // X174: +1 risk when destination rate is elevated >1.3x above historical average
      // X196: +1 risk when destination rate is declining (historical/current > 1.5) — spread may shrink further
      const spreadRisk = Math.min(10, 2 + (s.sameChain ? 0 : 1) + (s.spikeCapped ? 1 : 0) + (s.hardBridge ? 2 : 0) + (isNonEvmBridge ? 1 : 0) + (isLowTvlDest ? 1 : 0) + (s.rateElevated ? 1 : 0) + (s.rateDeclining ? 1 : 0));
      // X64: Score comparable to carry/shortfarm — incorporate TVL and risk divisor.
      const spreadTvl = Math.max(Math.log10(s.highYieldTvl || 100000), 1);
      // X109: 0.3x score for micro-TVL destinations (<$500k) — $5k deposit = 1%+ of pool, APY compression
      const lowTvlPenalty = isMicroTvlDest ? 0.3 : 1;
      // X198: Compute conservative spread for declining entries when not pre-computed (cached data compatibility)
      if (s.rateDeclining && !s.conservativeNetSpreadPct && s.decliningFactor && s.highYieldApy) {
        const conservativeDeclApy = s.highYieldApy * s.decliningFactor;
        const bridgeCostPct = parseFloat(s.estBridgeCost) || 0;
        s.conservativeNetSpreadPct = Math.max(conservativeDeclApy - (s.lowYieldApy || 0) - bridgeCostPct, 0).toFixed(2);
      }
      // X174/X198: Use conservative spread for scoring when dest rate is elevated or declining
      const spreadForScore = s.conservativeNetSpreadPct ? parseFloat(s.conservativeNetSpreadPct) : parseFloat(s.netSpreadPct);
      // X198: decliningFactor is now baked into conservativeNetSpreadPct (applied to dest rate in loops.js),
      // so spreadForScore already reflects the declining penalty. No separate multiplier needed (avoids double-counting, same as X118).
      const spreadScore = spreadForScore * spreadTvl * lowTvlPenalty / Math.max(spreadRisk / 2, 1);
      scoredSpreads.push({ s, spreadRisk, spreadScore, isLowTvlDest, isNonEvmBridge });
    }
    scoredSpreads.sort((a, b) => b.spreadScore - a.spreadScore);
    const spreadProtoCounts = {};
    const spreadSrcDestSeen = new Set(); // X176: per source→dest protocol@chain dedup
    let spreadCount = 0;
    for (const { s, spreadRisk, spreadScore, isLowTvlDest, isNonEvmBridge } of scoredSpreads) {
      // X192/X198: Use conservative spread for filters when dest rate is elevated OR declining
      const filterSpreadPct = s.conservativeNetSpreadPct ? parseFloat(s.conservativeNetSpreadPct) : parseFloat(s.netSpreadPct);
      // X196: Cross-chain SPREAD minimum 3% — bridging adds risk (potential exploit, delayed finality),
      // operational complexity (manage 2 chains), and time cost (hours). 2.29% DAI OP→Polygon barely
      // justifies same-chain smart contract risk, let alone cross-chain bridge risk. Same-chain keeps 2%.
      // X238: Cross-chain declining minimum 4% — if dest rate is actively declining, the spread will
      // likely shrink further. A 3% cross-chain declining spread that drops to 2% means the user paid
      // bridge costs for a spread that no longer justifies the bridge risk. User gets stuck on unfamiliar
      // chain (especially non-EVM) with sub-threshold returns. At 4%, even a 25% further decline still
      // leaves 3% (above the cross-chain floor). Same-chain declining: unchanged at 2% (no bridge lock-in).
      const spreadMinPct = s.sameChain ? 2.0 : (s.rateDeclining && !s.sameChain) ? 4.0 : 3.0;
      if (filterSpreadPct < spreadMinPct) continue;
      if (s.minEconomicalUsd && s.minEconomicalUsd > capitalUsd) continue; // X109
      // X185: Minimum annual dollar return filter — $10/year floor.
      // At $200, 2.06% spread = $4.12/year, not worth cognitive overhead of new protocol.
      // Cross-chain entries are even worse after bridge costs. Same principle as ARB $5 min (X112).
      const spreadAnnualReturn = capitalUsd * filterSpreadPct / 100;
      if (spreadAnnualReturn < 10) continue;
      const destMatch = (s.action || '').match(/→\s+([\w.-]+)\s*\(/i);
      const destProto = destMatch ? destMatch[1].toLowerCase() : 'unknown';
      if ((spreadProtoCounts[destProto] || 0) >= 2) continue;
      // X176: Max 1 entry per source→dest protocol pair on same chain. Moving AL and DEEP from
      // navi→scallop is one migration decision — showing both wastes a slot.
      const srcMatch = (s.action || '').match(/from\s+([\w.-]+)\s*\(([^)]+)\)/i);
      const srcProto = srcMatch ? srcMatch[1].toLowerCase() : 'unknown';
      const srcChain = srcMatch ? srcMatch[2].toLowerCase() : '';
      const destChain = (s.action || '').match(/→\s+[\w.-]+\s*\(([^)]+)\)/i);
      const dChain = destChain ? destChain[1].toLowerCase() : '';
      const srcDestKey = srcProto + '@' + srcChain + '>' + destProto + '@' + dChain;
      if (spreadSrcDestSeen.has(srcDestKey)) continue;
      spreadSrcDestSeen.add(srcDestKey);
      spreadProtoCounts[destProto] = (spreadProtoCounts[destProto] || 0) + 1;
      // X174/X198: Show conservative spread when dest rate is elevated OR declining
      const spreadReturn = s.conservativeNetSpreadPct
        ? '+' + s.conservativeNetSpreadPct + '% net APY (current +' + s.netSpreadPct + '%' + (s.rateElevated ? ', dest rate elevated' : ', dest rate declining') + ')'
        : '+' + s.netSpreadPct + '% net APY';
      // X179/X198: Fix action string to use conservative spread
      const spreadAction = s.conservativeNetSpreadPct
        ? s.action.replace(/for \+[\d.]+% net APY/, 'for +' + s.conservativeNetSpreadPct + '% net APY')
        : s.action;
      // X226: Strip residual inline [DEST RATE ELEVATED/DECLINING] labels from action — metadata covers this
      // X244: Strip inline [NON-EVM BRIDGE] and [COMPLEX BRIDGE] tags — metadata covers bridge type via hardBridge/nonEvmBridge fields
      const cleanAction = spreadAction.replace(/ \[DEST RATE (?:ELEVATED|DECLINING):[^\]]*\]/g, '').replace(/ \[(?:NON-EVM|COMPLEX) BRIDGE\]/g, '');
      topStrategies.push({ rank: 0, category: 'SPREAD', action: cleanAction, expectedReturn: spreadReturn, feasibility: s.feasibility, sameChain: s.sameChain, hardBridge: s.hardBridge || undefined, nonEvmBridge: isNonEvmBridge || s.nonEvmBridge || undefined, minCapitalUsd: s.minEconomicalUsd || 0, profitScore: spreadScore, risk: spreadRisk + '/10', lowTvlDest: isLowTvlDest, tvl: s.highYieldTvl ? formatUSD(s.highYieldTvl) : undefined, rateElevated: s.rateElevated || undefined, rateDeclining: s.rateDeclining || undefined, no7dData: s.no7dData || undefined, highYieldApy: s.highYieldApy, highYieldHistorical: s.highYieldApy7d || s.highYieldMean30d });
      if (++spreadCount >= 5) break;
    }
  }
  // Liquidation — monitoring alerts, not directly actionable strategies.
  // Cap profitScore so these don't dominate actionable carry/yield entries.
  if (results.liquidation?.markets) {
    // X130: Dedup by protocol+chain — a liquidation bot monitors an entire protocol on a chain,
    // not individual markets. aave-v3 USDT + USDC on Ethereum is one bot setup, not two.
    // Max 1 per protocol+chain, keeping highest-scored market per combo.
    const seenLiqProtoChain = new Set();
    let liqCount = 0;
    for (const m of results.liquidation.markets.filter(m => m.urgency === 'CRITICAL')) {
      const liqKey = (m.protocol || '') + '|' + (m.chain || '');
      if (seenLiqProtoChain.has(liqKey)) continue;
      seenLiqProtoChain.add(liqKey);
      if (++liqCount > 3) break;
      // X103: +1 risk for MEV competition — executing liquidations requires competing with
      // professional MEV searchers, not just having capital. Risk reflects execution difficulty.
      const baseRisk = m.utilization >= 99 ? 4 : 5;
      const risk = (baseRisk + 1) + '/10';
      // X98: Liquidation min capital from chain gas costs.
      const liqChain = (m.chain || '').toLowerCase();
      const LIQ_GAS_PER_TX = { ethereum: 50, bsc: 1, linea: 5, plasma: 2, mantle: 2, arbitrum: 3, optimism: 3, base: 1, polygon: 3 };
      const liqGasPerTx = LIQ_GAS_PER_TX[liqChain] || 3;
      // X149: Capital-adjusted profitScore — old formula used total market profit ($780K for USDT
      // Ethereum) giving ps=232 at $5000, ranking #2 above all YIELD/CARRY. But a $5000 user earns
      // $200 per liquidation call, not $780K. Running a liq bot requires smart contract dev, 24/7
      // infra, and competing with professional MEV firms — categorically harder than depositing into
      // a yield pool. Base on capital-adjusted per-call profit, 0.5x MEV discount, cap at 45.
      // X159: Cap 75→45. At cap 75, 3 LIQUIDATION entries ranked #7-9 at $5000 above SPREAD
      // JUPSOL #10 (+6.28%, risk 2/10, EASY same-chain, profitScore ~48). LIQUIDATION requires
      // smart contract deployment, 24/7 monitoring, and MEV competition (retail success <10%).
      // SPREAD is a 2-minute same-chain lending move (>95% success). Cap 45 ranks LIQUIDATION
      // near or below same-chain SPREADs (40-55) but above most CARRY/SHORT_FARM (15-30).
      const liqProfitPerCallRaw = capitalUsd * (m.liqBonusPct / 100) - liqGasPerTx;
      const liqScore = Math.min(45, Math.max(0, liqProfitPerCallRaw) * 0.5);
      // X138: Minimum viable per-call profit — $20 min to justify bot setup, monitoring, and MEV
      // competition overhead. At $200 capital with 5% bonus: profit = $10-8 = not worth it.
      // Formula: (minProfit + gas) / bonusPct ensures capital is enough for $20+ per call.
      const MIN_LIQ_PROFIT_PER_CALL = 20;
      const minCapitalForProfit = Math.ceil((MIN_LIQ_PROFIT_PER_CALL + liqGasPerTx) / (m.liqBonusPct / 100));
      const liqMinCapital = Math.max(liqGasPerTx * 10, minCapitalForProfit);
      // X129: Capital-adjusted liquidation profit display — show per-liquidation profit at user's
      // capital level instead of total theoretical market profit. Same pattern as ARB (X78),
      // DEPEG_ARB (X123). User repays up to capitalUsd of debt, earns liqBonus% on that.
      const liqProfitPerCall = capitalUsd * (m.liqBonusPct / 100) - liqGasPerTx;
      const liqReturnStr = m.liqBonusPct + '% per liq ($' + Math.max(0, liqProfitPerCall).toFixed(0) + ' at your capital, ~$' + (m.netProfitEstimate / 1e3).toFixed(0) + 'K total mkt)';
      topStrategies.push({ rank: 0, category: 'LIQUIDATION', action: m.strategy + ' [MEV COMPETITIVE]', expectedReturn: liqReturnStr, risk, profitScore: liqScore, minCapitalUsd: liqMinCapital });
    }
  }
  // Flashloan arbs
  // X148: LST (Liquid Staking Token) detection for tighter staleness thresholds.
  // LSTs trade near ETH parity with deep liquidity — like stablecoins trade near $1.
  // A 3.76% WSTETH spread between balancer and curve is just as implausible as a 2% USDC spread.
  const LST_TOKENS = new Set(['WSTETH', 'STETH', 'RETH', 'CBETH', 'METH', 'SWETH', 'OETH', 'SFRXETH', 'STMATIC', 'MSOL', 'JITOSOL', 'BNSOL', 'JITOMSOL']);
  // X201: Highly liquid major tokens — same-chain spreads >1% between established DEXes are
  // almost certainly stale. MEV bots capture BTC/ETH/SOL arb in milliseconds on chains with
  // deep DEX liquidity. Parity with LST_TOKENS (X148) and stablecoin ARB staleness (X121).
  // X242: Add major Ethereum DeFi tokens — same aggregator-routing guarantee as native tokens.
  // LINK 1.242% uniswap→sushiswap on Ethereum: aggregated by 1inch/Paraswap/CoW within blocks.
  // X253: Add BTC variants (CBBTC, TBTC, BTC.B, BTCB) — same deep liquidity + aggregator routing
  // as WBTC on their respective chains. CBBTC is THE dominant BTC token on Base ($24M+ CLM TVL
  // alone), routed through 1inch/0x/Matcha on every Base DEX. 1.099% CBBTC spread between
  // uniswap and aerodrome on Base is stale data — same structural guarantee as WBTC on Ethereum.
  const MAJOR_FLASH_TOKENS = new Set(['WBTC', 'CBBTC', 'TBTC', 'BTC.B', 'WBTC.B', 'BTCB', 'WETH', 'ETH', 'WSOL', 'SOL', 'WBNB', 'BNB', 'WMATIC', 'MATIC', 'WAVAX', 'AVAX', 'LINK', 'UNI', 'AAVE', 'MKR', 'CRV', 'LDO']);
  if (results.flasharb?.evmArbs) {
    // X202: Widen candidate window from 3 to 10 — aggressive staleness filtering (LST X148,
    // major tokens X201, raw >2% X189) can discard most of the top 3, blocking legitimate
    // entries at positions 4+. POST_DEDUP_CAPS {FLASH_ARB: 2} handles final count.
    for (const a of results.flasharb.evmArbs.slice(0, 10)) {
      const isLstArb = LST_TOKENS.has((a.token || '').toUpperCase());
      // X148: Skip LST FLASH_ARB with rawSpreadPct > 3% — DexScreener artifact from comparing
      // LST/ETH pools (near-parity) vs LST/USD pools (different USD conversion). Same logic as
      // X121 stablecoin staleness + X122 CERTAINLY_STALE filter.
      if (isLstArb && (a.rawSpreadPct || 0) > 3) continue;
      let cappedLabel = a.spreadCapped ? ' [SPREAD CAPPED from ' + a.rawSpreadPct + '%]' : '';
      // X70→X153: FLASH_ARB risk scoring. X70 set base 2/10, but flash arb requires deploying
      // custom smart contracts + competing with professional MEV searchers (Flashbots, co-located
      // infra). Risk 2/10 was identical to same-chain SPREAD (simple lending move), misleading
      // users about execution difficulty. X153: base 4 for flash-loanable (smart contract + MEV
      // competition), base 2 + 2 = 4 for non-flash-loanable (capital risk + MEV risk, unchanged).
      // +1 for spread-capped (stale data signal), +1 for large original spread >3%
      // X81: +2 risk, 0.3x score for non-capped spreadPct > 2% (matching ARB X69 LIKELY_STALE penalty)
      // X89: +2 risk, 0.5x score for non-flash-loanable chains (own capital at risk, not atomic)
      let faRisk = 4;
      let faScore = a.netProfit;
      // X92: Capital-adjust profit for non-flash-loanable entries (user needs own capital).
      // Flash-loanable entries: profit independent of user capital (flash loan provides it).
      // Non-flash-loanable: profit limited by min(capitalUsd, maxTradeSize).
      let faDisplayProfit = a.netProfit;
      let faMinCapital = 0;
      if (a.flashLoanable === false) {
        faRisk += 2; // capital at risk (not atomic), MEV frontrunning risk
        const tradeSize = Math.min(capitalUsd, a.maxTradeSize || capitalUsd);
        const ratio = a.maxTradeSize > 0 ? tradeSize / a.maxTradeSize : 1;
        faDisplayProfit = (a.grossProfit || 0) * ratio - (a.slippageEst || 0) * ratio - (a.gasCost || 0);
        faScore = Math.max(faDisplayProfit, 0) * 0.5;
        // X150: Skip non-flash-loanable FLASH_ARB with negative or zero profit after gas.
        // CBBTC uniswap->aerodrome(base) at 1.052% spread showed "$-0.53 per trade" for $200
        // users — gas ($2) exceeds capital-adjusted gross profit ($1.47). Negative profit entries
        // are never actionable. Same principle as X112 (ARB minimum $5 net profit filter).
        if (faDisplayProfit <= 0) continue;
        faMinCapital = a.gasCost > 0 && a.spreadPct > 0 ? Math.ceil(a.gasCost / (a.spreadPct / 100)) : 0;
        cappedLabel += ' [NO FLASH LOAN]';
      } else {
        // X99/X170: Flash-loanable arbs require deploying a custom smart contract + competing
        // with professional MEV searchers. The real barrier isn't gas ($3 on Arbitrum) but the
        // infrastructure: contract deployment ($50-200), testing, Flashbots integration.
        // $500 floor ensures only users with MEV development capability see these entries.
        faMinCapital = a.gasCost > 0 ? Math.ceil(Math.max(a.gasCost * 3, 500)) : 500;
        // X100: Flash-loanable arbs are MEV-competitive (parity with DEPEG_ARB X93).
        // Professional searchers monitor the same DEX pairs and execute atomic arbs within blocks.
        // 0.7x baseline discount reflects that by report time, the opportunity is likely captured.
        faScore *= 0.7;
        cappedLabel += ' [MEV COMPETITIVE]';
      }
      if (a.spreadCapped) {
        faRisk += 1; // capped = data unreliable
        faScore *= 0.5; // lower confidence in profit estimate
      }
      if (a.rawSpreadPct > 3) {
        faRisk += 1; // >3% original spread = almost certainly stale API data
        faScore *= 0.5; // compound with cap penalty
      }
      // X122: Skip FLASH_ARB entries with >5% effective or raw spread — same logic as ARB
      // CERTAINLY_STALE filter. These are API data noise, not real opportunities.
      if (a.spreadPct > 5 || (a.rawSpreadPct || 0) > 5) continue;
      // X148: LST-specific staleness thresholds (parity with X121 stablecoin ARB staleness).
      // LSTs trade near ETH parity — rawSpreadPct >1% is LIKELY_STALE, >2% skip entirely.
      // For effective spread: >0.5% LIKELY_STALE (spread-capped LSTs with high raw = stale data).
      if (isLstArb) {
        if ((a.rawSpreadPct || 0) > 2) continue; // CERTAINLY_STALE for LSTs
        if ((a.rawSpreadPct || 0) > 1) {
          faRisk += 2;
          faScore *= 0.2;
          cappedLabel += ' [LST LIKELY STALE]';
        } else if (a.spreadPct > 0.5) {
          faRisk += 1;
          faScore *= 0.5;
          cappedLabel += ' [LST CHECK SLIPPAGE]';
        }
      }
      // X201: Major volatile token staleness — WBTC/WETH/SOL between established DEXes shouldn't
      // have >1% spreads. These are the most actively arbed tokens; professional MEV searchers
      // capture same-chain spreads within a single block. A 1.442% WBTC spread uniswap→camelot
      // on Arbitrum is DexScreener stale pricing, not a real opportunity.
      // Filter at >1% (not just penalize) per X195 reasoning: <20% execution probability entries
      // should be filtered rather than shown with warnings. FLASH_ARB is MORE competitive than
      // regular ARB (atomic same-block), so threshold should be at least as strict.
      // X208: Low sell-side liquidity filter — DEXes with <$500K liquidity have stale/unreliable
      // price data (low volume = infrequent trades = outdated quotes). A $182K liquidity DEX on
      // Arbitrum showing a WBTC spread that professional MEV bots haven't captured strongly suggests
      // the quote is stale. Additionally, trading against thin liquidity means significant price
      // impact beyond the flat slippage estimate. Same principle as bag-trap detection for LP pools.
      if ((a.sellLiquidity || 0) < 500000) continue;
      const isMajorFlash = MAJOR_FLASH_TOKENS.has((a.token || '').toUpperCase());
      // X264: Major flash token hard filter 1.0%→0.75% — parity with ARB LIKELY_STALE threshold.
      // FLASH_ARB is MORE competitive than regular ARB (atomic same-block flash loan execution),
      // so stale data thresholds should be at least as strict. WETH 0.951% between uniswap and
      // pancakeswap on Arbitrum is stale API data — professional MEV bots capture any real WETH
      // spread within a single block. ARB filters chain-native/major at >0.75% (X195/X214).
      if (isMajorFlash && (a.rawSpreadPct || a.spreadPct) > 0.75) continue;
      // X255: Major flash token graduated staleness at 0.5-1% — CBBTC at 0.681% between
      // pancakeswap and aerodrome (the two biggest Base DEXes) is suspicious. Professional MEV
      // bots and aggregators (1inch, 0x) capture CBBTC/WBTC/WETH spreads within blocks.
      // Parity with LST_TOKENS at 0.5% (line 744): +1 risk, 0.5x score, CHECK SLIPPAGE label.
      // X313: Filter entirely — FLASH_ARB already requires MEV infrastructure (smart contract,
      // Flashbots). Adding "spread is probably stale API data" (0.5-1% for major tokens where
      // aggregators close real spreads within blocks) makes retail execution probability ~0%.
      // Previous approach (0.5x score, +1 risk) still surfaced these entries in the report,
      // misleading users into thinking the arb is real. Parity with ARB LIKELY_STALE filter (X195).
      // X315: Use rawSpreadPct (pre-cap original) when available. CBBTC at 0.626% raw was
      // capped to 0.5%, passing the >0.5 check. But the system already flagged it as suspicious
      // (that's why it was capped). The cap + filter interaction created a loophole where the
      // most suspicious entries (those needing capping) survived the filter designed to catch them.
      // Parity with lines 1019/1039 which already use (a.rawSpreadPct || a.spreadPct).
      if (isMajorFlash && !isLstArb && (a.rawSpreadPct || a.spreadPct) > 0.5) continue;
      // X81/X163/X189: >2% raw spread = LIKELY_STALE → filter entirely.
      // MEV bots on Arbitrum/Ethereum capture >2% spreads in blocks — these are DexScreener
      // API artifacts, not real opportunities. Same logic as ARB X162 (filter VERY_LIKELY_STALE).
      // FLASH_ARB is MORE competitive than regular ARB (atomic same-block execution with flash loans),
      // so stale data threshold should be at least as strict.
      // X189: Capped entries with rawSpreadPct > 2% are equally stale — the cap masks the
      // staleness without fixing it. WETH pancakeswap→uniswap(arbitrum) at 2.411% raw (capped
      // to 1%) survived because only non-capped >2% was filtered. A 2.4% WETH spread between
      // major DEXes is certainly stale regardless of capping.
      if ((a.rawSpreadPct || a.spreadPct) > 2) continue;
      // X100→X151→X166→X312: Cap profitScore at 20 (parity with LIQUIDATION cap from X311).
      // Flash arb requires custom smart contract deployment + competing with professional
      // MEV searchers using Flashbots/co-located infra. Retail success rate <10%.
      // X166 set cap at 40 (below SPREAD ~46). X311 lowered LIQUIDATION cap 30→20 to position
      // MEV-competitive entries below reliably executable borrow-farm. FLASH_ARB is MORE
      // competitive than LIQUIDATION (atomic same-block, Flashbots-native) — should be at most
      // equal. At cap 40, FLASH_ARB ranked #6 above FUNDING 12.6% (#7) and CARRY 11.9% (#8).
      // Hierarchy: CLM > YIELD (81-99) > SPREAD (top ~46) > LIQUIDATION (20) = FLASH_ARB (20).
      faScore = Math.min(faScore, 20);
      // X150: Skip FLASH_ARB with display profit < $1 (parity with X112 ARB $5 min).
      // Lower threshold than ARB because flash arbs can be repeated, but sub-$1 entries
      // like "$-0.53" or "$0.30" are never worth executing regardless of strategy type.
      if (faDisplayProfit < 1) continue;
      topStrategies.push({ rank: 0, category: 'FLASH_ARB', action: a.token + ' ' + a.buyDex + '->' + a.sellDex + ' (' + a.chain + ')' + cappedLabel, expectedReturn: '$' + faDisplayProfit.toFixed(2) + ' per trade (' + a.spreadPct + '%)', risk: faRisk + '/10', profitScore: faScore, minCapitalUsd: faMinCapital || undefined });
    }
  }
  if (results.flasharb?.stableDepegs) {
    // X170: Per-token-per-chain dedup. Both USDC entries on Arbitrum (uniswap $52, deltaswap $13)
    // represent the same depeg opportunity on different DEXes. A depeg arbitrageur monitors all
    // pools for a token — showing 2 DEXes for the same token/chain wastes a report slot.
    // Keep highest-profit entry per token+chain. Analogous to LIQUIDATION protocol+chain dedup (X130).
    const seenDepegTokenChain = new Set();
    for (const d of results.flasharb.stableDepegs.slice(0, 4)) {
      const depegKey = `${d.stable}|${d.chain}`;
      if (seenDepegTokenChain.has(depegKey)) continue;
      seenDepegTokenChain.add(depegKey);
      // X132: Deviation-based staleness filter for DEPEG_ARB.
      // Major stablecoins (USDT, USDC, DAI) almost never have real depegs >2% — even the
      // USDC SVB event (Mar 2023) peaked at ~12% and was captured by bots within minutes.
      // A 4.3% USDT premium on pancakeswap(BSC) with $1M+ liquidity is a DexScreener pricing
      // artifact (comparing different pool types/quote paths), not a real opportunity.
      // Analogous to ARB stablecoin-specific staleness (X121) applied to DEPEG_ARB.
      const deviation = d.deviation || 0;
      if (deviation > 3) continue; // >3% deviation: certainly stale pricing artifact
      // X71+X93: DEPEG_ARB staleness risk scoring.
      // MEV bots capture stablecoin depegs within blocks on any chain with active searchers.
      // X93: Flash-loanable depegs are ALWAYS MEV-competitive — bots can atomically arb with
      // zero capital risk. Base risk 2/10 (was 1) reflects that by report time (even seconds later),
      // professional searchers have likely captured the depeg. Non-flash: base 5/10 (manual, slower).
      // +1 for liquidity > $1M (bots definitely watching, depeg likely already captured)
      // +1 for net profit > $500 (extremely attractive to bots, almost certainly stale by report time)
      // X153: Flash-loanable base risk 2→4 (smart contract + MEV competition required).
      // Non-flash-loanable unchanged at 5 (capital risk + slower execution).
      let depegRisk = d.flashLoanable ? 4 : 5;
      let depegScore = d.netProfit;
      // X123: Capital-adjust profit for non-flash-loanable DEPEG_ARB entries.
      // Flash-loanable: profit independent of user capital (flash loan provides trade size).
      // Non-flash-loanable: user needs own capital, profit limited by min(capitalUsd, arbSize).
      // Parity with FLASH_ARB (X92) and ARB (X78) capital-adjusted display.
      let depegDisplayProfit = d.netProfit;
      if (!d.flashLoanable && d.arbSize > 0) {
        const effectiveSize = Math.min(capitalUsd, d.arbSize);
        const ratio = effectiveSize / d.arbSize;
        depegDisplayProfit = parseFloat(((d.grossProfit || 0) * ratio - (d.gas || 0)).toFixed(2));
        depegScore = Math.max(depegDisplayProfit, 0) * 0.3; // 0.3x for non-flash (existing penalty)
      }
      const highLiq = (d.liquidity || 0) > 1_000_000;
      const highProfit = d.netProfit > 500;
      // X132: Deviation-based staleness (applied to both flash and non-flash).
      // >1.5% deviation on any stablecoin is highly suspicious — real depegs this large are
      // captured in seconds by MEV bots or corrected by market makers.
      if (deviation > 1.5) { depegRisk += 1; depegScore *= 0.3; } // [LIKELY STALE]
      if (d.flashLoanable) {
        // X93: All flash-loanable depegs get minimum 0.7x score (MEV competition baseline)
        depegScore *= 0.7;
        if (highLiq) { depegRisk += 1; depegScore *= 0.5; }
        if (highProfit) { depegRisk += 1; depegScore *= 0.5; }
      } else if (d.arbSize <= 0) {
        depegScore *= 0.3;
      }
      const isLikelyStale = deviation > 1.5;
      const staleLabel = isLikelyStale ? ' [LIKELY STALE]' : '';
      // X161: Skip entries that are BOTH flash-loanable (likely captured by MEV bots) AND likely
      // stale (deviation >1.5%). The combination means: (1) price snapshot is old enough to be
      // unreliable, AND (2) even if accurate, professional searchers captured it within blocks.
      // Zero actionable information for any user. USDC aerodrome(base) at 2.7% deviation: the
      // $874 profit was captured by MEV bots minutes before the DexScreener API returned this
      // snapshot. Showing it wastes a report slot that could go to an executable strategy.
      if (d.flashLoanable && isLikelyStale) continue;
      // X221: Filter ALL [LIKELY STALE] DEPEG_ARB entries (not just flash-loanable).
      // A >1.5% stablecoin deviation is almost certainly a pricing artifact (DexScreener API
      // comparing different pool types/quote paths). If the data is stale, the depeg doesn't
      // exist — going to the DEX and finding no premium wastes user time. The stale vs captured
      // distinction only matters when the depeg IS real (captured = real but taken, stale = not
      // real). Parity with ARB LIKELY_STALE filter (X195): <20% execution probability → filter.
      // USDT pancakeswap(BSC) at 2.3% deviation: eliminated.
      if (isLikelyStale) continue;
      // X170: Filter all flash-loanable DEPEG_ARB entries entirely. These are [LIKELY CAPTURED]
      // — MEV bots capture stablecoin depegs within blocks using flash loans. The DexScreener API
      // snapshot is minutes old; by report time, the depeg is already arbitraged. Showing these
      // entries violates the mandate's >80% confidence requirement (<10% execution probability)
      // and wastes report slots that could go to actionable strategies. Previous approach (X157/X158)
      // capped profitScore at 30 but they still ranked above SHORT_FARM entries (profitScore 3-15),
      // misleading users into attempting already-captured arbs. Non-flash-loanable entries retained
      // — they have less MEV competition because they require capital commitment and slower execution.
      if (d.flashLoanable) continue;
      const likelyCaptured = false; // X170: flash-loanable entries now filtered above
      const label = !d.flashLoanable ? ' [NO FLASH LOAN]' + staleLabel : ' [LIKELY CAPTURED]' + staleLabel;
      // X143/X147/X157: DEPEG_ARB profitScore caps. All flash-loanable entries are [LIKELY
      // CAPTURED] (cap 30). Non-flash-loanable entries retain cap 75.
      depegScore = Math.min(depegScore, likelyCaptured ? 30 : 75);
      // X99/X170: DEPEG_ARB minimum capital. Flash-loanable: max(gas*3, 500) — deploying a flash
      // loan smart contract + competing with MEV bots requires meaningful capital and infrastructure.
      // A $200 user cannot realistically execute flash loan arbitrage ($9 gas doesn't reflect the
      // contract deployment + testing + multiple attempt costs). $500 floor aligns with the technical
      // barrier of MEV development. Non-flash-loanable: max(gas*3, 500) same floor (own capital needed).
      const depegMinCapital = d.flashLoanable ? Math.ceil(Math.max((d.gas || 50) * 3, 500)) : Math.ceil(Math.max((d.gas || 50) * 3, 500));
      // X168/X236: Minimum capital-adjusted profit filter for non-flash-loanable DEPEG_ARB entries.
      // X236: raised from $5 to $15 — DEPEG_ARB has higher execution complexity than simple ARB:
      // time-sensitive (premium disappears within blocks), requires sourcing stablecoin at par from
      // a separate venue, and competes with MEV bots even without flash loans. $10 profit for this
      // effort is not actionable — cognitive load + execution risk exceeds the reward. ARB minimum
      // remains $5 (quick same-chain swap, lower complexity). At $5000: USDT pancakeswap(BSC) $10
      // profit eliminated. At $10000+: passes ($20+).
      if (!d.flashLoanable && depegDisplayProfit < 15) continue;
      topStrategies.push({ rank: 0, category: 'DEPEG_ARB', action: d.stable + ' ' + d.direction + ' on ' + d.dex + ' (' + d.chain + ')' + label, expectedReturn: '$' + depegDisplayProfit.toFixed(2) + ' per trade', risk: depegRisk + '/10', profitScore: depegScore, flashLoanable: d.flashLoanable, minCapitalUsd: depegMinCapital });
    }
  }
  // Aggressive CLM/recursive/funding
  if (results.aggro) {
    if (results.aggro.clm?.top) {
      // X87: Sort by risk-adjusted profitScore before slicing. Previously slice(0,3) used raw
      // score (no risk adjustment), excluding stable CLM pairs like SUSDE-USDT (risk 3, profitScore
      // 443) because their raw score (665) was below volatile pairs (1100+) despite higher
      // risk-adjusted profitScore. Compute profitScore first, sort, then take top 5 candidates.
      const clmScored = results.aggro.clm.top.map(c => {
        const clmRisk = c.risk || (c.stablePair ? 3 : 6);
        // X146: Non-major token CLM score discount — meme/micro-cap tokens have asymmetric
        // downside (permanent crash vs mean-reversion for majors). SOL-FARTCOIN (risk 7,
        // nonMajor) ranked above WSOL-USD1 (risk 5, major) due to inflated meme APY.
        // 0.5x score ensures major-token CLMs are preferred when APYs are comparable.
        const nonMajorDiscount = c.nonMajorToken ? 0.5 : 1.0;
        return { c, clmRisk, ps: Math.min(c.score * nonMajorDiscount / Math.max(clmRisk / 2, 1), 800) };
      }).sort((a, b) => b.ps - a.ps);
      // X89: CLM category cap (max 3 entries, max 2 per protocol) — consistent with
      // YIELD(3), FREE_SHORT(3), LIQUIDATION(3). Without a cap, all 5 CLM candidates
      // (profitScores 370-652) monopolize report slots #1-5, leaving no passive strategy
      // until #6. Most users can't execute active range management.
      const clmProtoCounts = {};
      const clmProtoChainCounts = {}; // X267: per-protocol-per-chain cap
      const clmSeenPairs = new Set(); // X172: per-pair-per-chain dedup
      // X247: Per-base-asset-per-chain dedup — SOL-USDC and SOL-USDT on Solana are the same
      // base asset exposure (SOL volatility). Stablecoins are interchangeable quote tokens in
      // concentrated LP — the dominant risk factor is the volatile side. Max 1 per base@chain.
      const CLM_STABLES = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'FRAX', 'TUSD', 'PYUSD', 'USDS', 'LUSD', 'GHO', 'CRVUSD', 'USDP', 'UST', 'FDUSD', 'USD1']);
      const clmSeenBase = new Set();
      let clmCount = 0;
      for (const { c, clmRisk, ps } of clmScored) {
        if (clmCount >= 3) break;
        // X127: CLM risk cap — risk > 7 entries are volatile pairs with multiple compounding
        // penalties (declining fees + prediction down + low TVL). These indicate high confidence
        // the opportunity is unreliable. At $200, risk 8 CLM with [FEES PREDICTED DOWN] was #1.
        // X185: Non-major CLM risk cap >= 7 — meme/micro-cap tokens at risk 7 (5 base + 1 TVL
        // + 1 non-major) have <80% confidence due to transient trading volume and crash risk.
        // WETH-GITLAWB at 273% and risk 7 ranked #2 above safer major-token CLMs.
        if (clmRisk > 7 || (c.nonMajorToken && clmRisk >= 7)) continue;
        if (c.minCapitalUsd && c.minCapitalUsd > capitalUsd) continue; // capital filter before protocol cap
        // X172: Per-pair-per-chain dedup — WETH-USDC on uniswap-v3(Base) and WETH-USDC on
        // aerodrome(Base) are the same LP pair; user picks the better protocol. Having 2/3
        // CLM slots on the same pair reduces diversity. Normalize WETH→ETH for dedup.
        const pairMatch = c.strategy?.match(/:\s*(\S+)\s+on\s/);
        if (pairMatch) {
          const rawPair = pairMatch[1];
          const normalized = rawPair.replace(/\bWETH\b/gi, 'ETH').replace(/\bWSOL\b/gi, 'SOL');
          const tokens = normalized.split('-').sort();
          const pairKey = tokens.join('-') + '@' + (c.chain || '').toLowerCase();
          if (clmSeenPairs.has(pairKey)) continue;
          clmSeenPairs.add(pairKey);
          // X247: If one side is a stablecoin, the base asset (volatile side) defines the
          // user's exposure. SOL-USDC and SOL-USDT are both "SOL concentrated LP on Solana".
          // Crypto-crypto pairs (ETH-BTC) skip this — the specific pair defines the exposure.
          // X248: Cross-chain base-asset dedup — ETH-USDC on Base and ETH-USDC on OP Mainnet
          // are the same directional exposure and active management burden. Having 2/3 CLM
          // slots be ETH-stablecoin pairs on different L2s reduces recommendation diversity.
          // Max 1 per base asset globally (no @chain suffix for volatile-stable pairs).
          const stableCount = tokens.filter(t => CLM_STABLES.has(t.toUpperCase())).length;
          if (stableCount === 1) {
            const baseToken = tokens.find(t => !CLM_STABLES.has(t.toUpperCase()));
            const baseKey = baseToken.toUpperCase();
            if (clmSeenBase.has(baseKey)) continue;
            clmSeenBase.add(baseKey);
          }
        }
        const proto = (c.project || c.strategy?.match(/on\s+([\w.-]+)/)?.[1] || 'unknown').toLowerCase();
        // X267: Per-protocol-per-chain cap (1) — aerodrome-slipstream WETH-USDC(Base) #2 and
        // USDC-CBBTC(Base) #3 consumed 2/3 CLM slots from same protocol on same chain. If
        // aerodrome on Base has a smart contract exploit, both entries fail. Same fix as YIELD
        // X231: cap 1 per proto@chain, retain per-protocol cap of 2 for cross-chain diversity.
        const clmChain = (c.chain || '').toLowerCase();
        const clmProtoChainKey = proto + '@' + clmChain;
        if ((clmProtoChainCounts[clmProtoChainKey] || 0) >= 1) continue;
        clmProtoChainCounts[clmProtoChainKey] = (clmProtoChainCounts[clmProtoChainKey] || 0) + 1;
        if ((clmProtoCounts[proto] || 0) >= 2) continue;
        clmProtoCounts[proto] = (clmProtoCounts[proto] || 0) + 1;
        clmCount++;
        topStrategies.push({ rank: 0, category: 'CLM', action: c.strategy, expectedReturn: c.tightRangeProjectedApy + '% at ' + c.tightRangeMultiplier, risk: clmRisk + '/10', tvl: formatUSD(c.tvl), minCapitalUsd: c.minCapitalUsd || 0, nonMajorToken: c.nonMajorToken || false, no7dData: c.no7dData, sameChain: c.sameChain, spikeDiscounted: c.spikeAdjusted || undefined, decliningFees: c.decliningFees || undefined, predictedDown: c.predictedDown || undefined, profitScore: ps });
      }
    }
    if (results.aggro.recursive?.top) {
      // X131: Per-protocol diversification + capital-aware filtering for RECURSIVE/FREE_LOOP.
      // JLP + PST both on jupiter-lend(Solana) occupied 2 of 3 slots (100% protocol concentration).
      // Same pattern as X72 (YIELD pendle monopoly). Capital filter before protocol cap ensures
      // expensive Ethereum entries don't consume protocol slots that block cheaper entries.
      const recProtoCounts = {};
      // X209: Correlated-token dedup for RECURSIVE — JUPSOL and WSOL on jupiter-lend(Solana)
      // are both SOL-exposure recursive leverage. User picks the higher-returning one.
      // Same principle as X183 (wrapped token dedup) but extended to LSTs for RECURSIVE
      // because the leverage risk dominates the LST-specific risk difference.
      const REC_TOKEN_NORM = { 'WSOL': 'SOL', 'JUPSOL': 'SOL', 'JITOSOL': 'SOL', 'MSOL': 'SOL', 'BNSOL': 'SOL', 'INF': 'SOL', 'WETH': 'ETH', 'STETH': 'ETH', 'WSTETH': 'ETH', 'CBETH': 'ETH', 'RETH': 'ETH', 'METH': 'ETH', 'WBTC': 'BTC', 'CBBTC': 'BTC', 'BTC.B': 'BTC', 'TBTC': 'BTC' };
      const recNormTok = (t) => REC_TOKEN_NORM[t] || t;
      const recSeenTokenProto = new Set();
      let recCount = 0;
      for (const l of results.aggro.recursive.top.slice(0, 10)) {
        if (recCount >= 3) break;
        // X132: Pre-filter risk >= 9 before consuming slot. X67 filters risk >= 9 post-dedup,
        // but that's too late — WETH curvance(Monad) at risk 10 consumed a slot, got filtered,
        // blocking EURC blend-pools-v2(Stellar) at risk 7. Same pattern as CLM (clmRisk > 7).
        const recRisk = l.risk || (l.stablecoin ? 4 : 6);
        // X186: Non-major RECURSIVE at risk >= 8 filtered — leveraged micro-cap tokens at 4x+
        // have extreme crash-to-liquidation risk. CLM filters non-major at >= 7 (X185).
        // RECURSIVE base risk is higher (leverage inherent), so threshold is >= 8.
        if (recRisk >= 9 || (l.nonMajorToken && recRisk >= 8)) continue;
        if (l.minCapitalUsd && l.minCapitalUsd > capitalUsd) continue;
        const proto = (l.project || 'unknown').toLowerCase();
        if ((recProtoCounts[proto] || 0) >= 2) continue;
        // X209: Max 1 entry per normalized token per protocol — JUPSOL/WSOL on same protocol
        // is the same user decision (leverage SOL on jupiter-lend). Keep highest-scored.
        const recTokenKey = recNormTok(l.token) + '|' + proto;
        if (recSeenTokenProto.has(recTokenKey)) continue;
        recSeenTokenProto.add(recTokenKey);
        recProtoCounts[proto] = (recProtoCounts[proto] || 0) + 1;
        recCount++;
        topStrategies.push({ rank: 0, category: l.netBorrowCost <= 0 ? 'FREE_LOOP' : 'RECURSIVE', action: l.strategy.replace(/ \[SPIKE ADJ\]/g, ''), expectedReturn: l.netApyAtSafeLev + '% at ' + l.safeLeverage + 'x', risk: recRisk + '/10', tvl: formatUSD(l.tvl), profitScore: Math.min(l.score, 600), emissionHeavy: l.emissionHeavy, baseSpreadNegative: l.baseSpreadNegative, minCapitalUsd: l.minCapitalUsd || 0, lowTvl: l.lowTvl, no7dData: l.no7dData, sameChain: l.sameChain, nonMajorToken: l.nonMajorToken, spikeDiscounted: (l.spikeDiscount && l.spikeDiscount < 1.0) || undefined });
      }
    }
    if (results.aggro.funding?.top) {
      // X209: widen candidate window from 5→15 so major-token entries (ETH, HYPE at positions 9+)
      // get evaluated — first 5-9 slots consumed by extreme meme tokens that get sub-capped to 1.
      for (const fr of results.aggro.funding.top.slice(0, 15)) {
        const fundReturn = fr.sustainableApy || (Math.abs(fr.annualizedPct) * (fr.sustainFactor || 1)).toFixed(1);
        // X215: FUNDING minimum adjusted APY threshold — delta-neutral funding trades require
        // spot purchase + perp position + monitoring + exit. At <6%, operational complexity and
        // entry/exit slippage (especially [SPOT THIN]) consume most of the return. Simple YIELD
        // deposits give 10-16% at risk 1-2. SPREAD gives 3-7% at risk 2 with a 2-minute move.
        // 6% threshold ensures FUNDING entries offer meaningful premium over simpler alternatives.
        // X222: [SPOT THIN] tokens need higher threshold (10%) — entry/exit slippage 2-5% each way
        // means 4-10% round-trip cost, consuming most of a sub-10% APY. SAGA at 7.3% [SPOT THIN]
        // → effective ~2-3% after slippage, worse than passive YIELD at 14-16% risk 1.
        const isFundSpotThin = (fr.strategy || '').includes('[SPOT THIN]');
        const fundMinApy = isFundSpotThin ? 10 : 6;
        if (parseFloat(fundReturn) < fundMinApy) continue;
        // X219: BORROW HARD LONG_PERP entries require borrowing a token with no lending market.
        // "Short spot (borrow+sell) TOKEN" is 0% executable when no lending market exists.
        // The 0.4x execFactor reduces score but the entry still appears — filter entirely.
        // SHORT_PERP [BORROW HARD] doesn't exist (SHORT_PERP = buy spot, no borrow needed).
        if ((fr.strategy || '').includes('[BORROW HARD]')) continue;
        const fundRawNote = (fr.sustainFactor || 1) < 0.9 ? ' (raw ' + Math.abs(fr.annualizedPct).toFixed(0) + '%)' : '';
        // X47: include risk divisor (was missing — risk 4 MAVIA ranked same as risk 2 opps)
        const fundRisk = fr.risk || 2;
        // X105: apply X57 LONG_PERP 0.4x and X60 SHORT_PERP non-major 0.85x score penalties
        // (aggro.js applies these to its own score field, but index.js was recomputing without them)
        const isLongPerp = (fr.direction || '').includes('LONG_PERP');
        const isNonMajor = (fr.strategy || '').includes('[BORROW HARD]') || (fr.strategy || '').includes('[SPOT THIN]');
        const execFactor = isLongPerp ? (isNonMajor ? 0.4 : 0.7) : (!isLongPerp && isNonMajor ? 0.85 : 1);
        // X124: FUNDING minimum capital — delta-neutral requires split capital (spot + perp margin)
        // Base $500 ($250 spot + $250 margin). Non-major tokens $1000 (thin liquidity / borrow complexity).
        // LONG_PERP non-major $2000 (need borrow market + spot sale + perp position).
        const fundMinCapital = isLongPerp ? (isNonMajor ? 2000 : 1000) : (isNonMajor ? 1000 : 500);
        // X191: FUNDING metadata — non-major tokens with extreme rates need warnings (parity with other categories)
        const absRaw = Math.abs(fr.annualizedPct);
        const fundExtremeRate = isNonMajor && absRaw >= 50; // X187/X194 threshold (80→50)
        const fundSpotThin = (fr.strategy || '').includes('[SPOT THIN]');
        const fundBorrowHard = (fr.strategy || '').includes('[BORROW HARD]');
        // X250: EXTREME RATE + SPOT THIN = structurally unprofitable for non-bot users.
        // Extreme rates persist ~3-7 days max (label says "reversal likely within days").
        // At 94% annualized, 7 days gives 94% * 7/365 = 1.8% gain.
        // SPOT THIN round-trip slippage: 2-5% each way = 4-10% cost.
        // Net: always negative. Filter entirely. Non-extreme SPOT THIN (like PROMPT at 24%)
        // persists longer (weeks-months), making slippage cost amortizable.
        if (fundExtremeRate && fundSpotThin) continue;
        // X191: profitScore cap 40 for EXTREME RATE entries — speculative frenzy rates (<30% persistence probability)
        const fundPsCap = fundExtremeRate ? 40 : 500;
        // X225: Strip [SPOT THIN] from action — metadata "SPOT THIN: slippage..." already shows it (X218 pattern)
        const fundAction = fr.strategy.replace(' [SPOT THIN]', '');
        topStrategies.push({ rank: 0, category: 'FUNDING', action: fundAction, expectedReturn: fundReturn + '% annualized (delta-neutral)' + fundRawNote, risk: fundRisk + '/10', profitScore: Math.min(absRaw * 3 * (fr.sustainFactor || 1) * execFactor / Math.max(fundRisk / 2, 1), fundPsCap), minCapitalUsd: fundMinCapital, extremeRate: fundExtremeRate || undefined, spotThin: fundSpotThin || undefined, borrowHard: fundBorrowHard || undefined });
      }
    }
  }


  // ALPHA — novel / asymmetric plays from alpha.js hunter (added 2026-04-24).
  // These bypass the risk>=9 filter and protocol-diversification caps because
  // they represent structural edges the risk-adjusted scorer intentionally suppresses.
  if (results.alpha?.all_alpha) {
    for (const a of results.alpha.all_alpha.slice(0, 6)) {
      topStrategies.push({
        rank: 0,
        category: a.category || "ALPHA",
        action: a.action,
        expectedReturn: a.expectedReturn,
        risk: a.risk,
        tvl: a.tvl,
        profitScore: a.profitScore,
        minCapitalUsd: a.minCapitalUsd || 0,
        alphaReason: a.alphaReason,
        alphaType: a.alphaType,
      });
    }
  }

  // Realization feedback: penalize TVL-flight BEFORE the score sort so the demotion moves rank.
  // Yield-held-while-liquidity-fled is the exit-liquidity signature bagTrap can't see (pendle
  // APYUSD sat at #4, risk 1/10, while the system's own matview showed TVL −72%). The entry stays
  // visible (flag + risk floor + score cut) rather than hidden — traps are information.
  // Thresholds: ≥1 day observed and ≥12 sightings so a single bad TVL read can't demote anything.
  const realMap = loadRealizationMap();
  if (realMap && realMap.size) {
    let flagged = 0;
    for (const st of topStrategies) {
      const r = realMap.get(stableFpJs(st.category, st.action));
      if (!r || !(r.daysObs >= 1) || !(r.sightings >= 12)) continue;
      if (!(r.tvlChangePct <= -50)) continue;
      const severe = r.tvlChangePct <= -80;
      st.tvlFlight = r.tvlChangePct;
      st.risk = Math.max(parseInt(st.risk) || 0, severe ? 9 : 7) + '/10';
      st.profitScore = Math.round((st.profitScore || 0) * (severe ? 0.1 : 0.25) * 100) / 100;
      flagged++;
    }
    if (flagged) log('[REALIZE] TVL-flight penalty applied to ' + flagged + ' entries');
  }

  // PATCH: dedupe near-duplicate strategies (same destination + similar return).
  // Example: 8 CARRY entries all pointing to the same uniswap-v3 pool with different borrow sources.
  topStrategies.sort((a, b) => (b.profitScore || 0) - (a.profitScore || 0));
  const seenKeys = new Set();
  const seenBorrowDest = new Set(); // X42: cross-category dedup for same borrow→dest trade
  const seenLendingMove = new Set(); // X113: cross-category dedup for SPREAD vs CARRY/SHORT_FARM same token+source→dest
  const seenArbMispricing = new Set(); // X54: cross-category dedup for DEPEG_ARB + ARB overlap
  const seenArbDexPair = new Set(); // X296: ARB per-buyDex→sellDex@chain dedup — same setup monitors all tokens
  const seenDestPool = new Set(); // X155: cross-category dedup for same token+dest pool across CARRY/SHORT_FARM
  const seenBorrowSource = new Set(); // X303: per-borrow-source dedup — same token+protocol@chain = same borrow position
  const seenTokenDestProto = new Set(); // X180: same token+dest protocol across chains dedup (yo-protocol USDC on 3 chains → keep best)
  // X183: Normalize wrapped token variants for dedup — BTC.B, WBTC, CBBTC are all Bitcoin;
  // user exposure is identical. NOT LSTs (STETH, RETH) — different risk profiles.
  const DEDUP_TOKEN_NORM = { 'WBTC': 'BTC', 'BTC.B': 'BTC', 'WBTC.B': 'BTC', 'BTCB': 'BTC', 'TBTC': 'BTC', 'CBBTC': 'BTC', 'WETH': 'ETH', 'WSOL': 'SOL' };
  const normTok = (s) => DEDUP_TOKEN_NORM[s] || s;
  // X170: YIELD→CARRY/SHORT_FARM dedup — if user can deposit directly via YIELD, borrowing first
  // is redundant. Pre-scan all YIELD entries before dedup loop because YIELD profitScore may be
  // lower than CARRY/SHORT_FARM (sorting doesn't guarantee YIELD comes first).
  const seenYieldDest = new Set();
  for (const s of topStrategies) {
    if (s.category === 'YIELD' || s.category === 'FARMABLE_7D') {
      const yieldDestParse = (s.action || '').match(/(?:Deposit|Farm)\s+into\s+([\w.-]+)\s+\S+\s+on\s+(\S+)/i);
      if (yieldDestParse) {
        seenYieldDest.add(yieldDestParse[1].toLowerCase() + '@' + yieldDestParse[2].trim().toLowerCase());
      }
    }
  }
  // X134: Cross-category destination protocol cap — pendle appeared 4x at $5000
  // (YIELD×2, CARRY, FREE_SHORT) — all user funds in one protocol's contracts.
  // If pendle has an exploit, all 4 entries fail simultaneously.
  const crossCatDestProto = {};
  const crossCatDestProtoChain = {}; // X300: per-protocol-per-chain sub-cap
  const CROSS_CAT_DEST_MAX = 3;
  const CROSS_CAT_DEST_CHAIN_MAX = 2; // X300: max 2 entries per dest protocol on same chain
  const DEPOSIT_CATS = new Set(['YIELD', 'FARMABLE_7D', 'CARRY', 'SHORT_FARM', 'FREE_SHORT', 'FREE_CARRY', 'SPREAD', 'RECURSIVE']);
  const deduped = [];
  for (const s of topStrategies) {
    // Signature: category + destination-project-chain (extract from action text)
    const destMatch = (s.action || '').match(/(?:->|→|in|on)\s+([\w.-]+)\s*\(([\w\s]+?)\)/i);
    const destKey = destMatch ? destMatch[1] + '@' + destMatch[2].trim() : s.action?.slice(0, 60);
    // X65: SPREAD entries include token in dedup key — different tokens at the same protocol
    // are independent opportunities (ETH vs USD₮0 on fluid-lending are different markets).
    // Without this, higher-scored cross-chain entry claims the slot, gets capital-filtered,
    // and blocks a viable same-chain entry for a different token.
    let key = s.category + '|' + destKey;
    if (s.category === 'SPREAD') {
      const tokenMatch = (s.action || '').match(/^Move\s+(\S+)\s+from/i);
      if (tokenMatch) key = s.category + '|' + tokenMatch[1] + '|' + destKey;
      // X113: SPREAD "Move TOKEN from SRC(chain) → DEST(chain)" registers token+source→dest
      // so identical CARRY/SHORT_FARM entries are deduped (same rate differential, 2 report slots)
      const srcMatch = (s.action || '').match(/from\s+([\w.-]+)\s*\(([\w\s]+?)\)/i);
      if (tokenMatch && srcMatch && destMatch) {
        const moveKey = tokenMatch[1] + '|' + srcMatch[1] + '@' + srcMatch[2].trim() + '>' + destKey;
        seenLendingMove.add(moveKey);
      }
    }
    // X74: CLM entries for different pairs on the same protocol+chain are distinct opportunities
    // (AAVE-WETH vs AETHWETH-WETH on uniswap-v3 Ethereum). Without pair in key, second pair deduped.
    if (s.category === 'CLM') {
      const pairMatch = (s.action || '').match(/:\s+([\w-]+)\s+on\s+/i);
      if (pairMatch) key = s.category + '|' + pairMatch[1] + '|' + destKey;
    }
    // X74: RECURSIVE entries for different tokens on the same protocol+chain are distinct loops
    if (s.category === 'RECURSIVE' || s.category === 'FREE_LOOP') {
      const tokenMatch = (s.action || '').match(/loop\s+(\w+)\s+on/i);
      if (tokenMatch) key = s.category + '|' + tokenMatch[1] + '|' + destKey;
    }
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    // X170: Track YIELD destination protocol+chain. If a user can deposit directly via YIELD
    // (simple, no borrow), CARRY/SHORT_FARM to the same protocol+chain adds borrow complexity
    // for equal or worse net return. bitway(BSC) YIELD 11% dominates SHORT_FARM U→bitway 10.06%.
    if (s.category === 'YIELD' || s.category === 'FARMABLE_7D') {
      const yieldDestParse = (s.action || '').match(/(?:Deposit|Farm)\s+into\s+([\w.-]+)\s+\S+\s+on\s+(\S+)/i);
      if (yieldDestParse) {
        seenYieldDest.add(yieldDestParse[1].toLowerCase() + '@' + yieldDestParse[2].trim().toLowerCase());
      }
    }
    // X42: CARRY and SHORT_FARM/FREE_SHORT to the same borrow source + destination are the
    // same trade (borrow asset, deposit, earn yield). Keep only the higher-scored entry.
    const borrowCats = new Set(['CARRY', 'SHORT_FARM', 'FREE_SHORT', 'FREE_CARRY']);
    if (borrowCats.has(s.category)) {
      const borrowMatch = (s.action || '').match(/(?:Borrow|BORROW)\s+(\S+)\s+from\s+([\w.-]+)\s*\(([\w\s]+?)\)/i);
      if (borrowMatch && destMatch) {
        // X127: Include borrowed token in crossKey. Without it, borrowing APYUSD from morpho-blue→pendle
        // blocks USP from morpho-blue→pendle (different tokens, different trades, different risk profiles).
        const crossKey = borrowMatch[1] + '|' + borrowMatch[2] + '@' + borrowMatch[3].trim() + '>' + destKey;
        if (seenBorrowDest.has(crossKey)) continue;
        seenBorrowDest.add(crossKey);
        // X113: check if a SPREAD already covers this token+source→dest lending move
        // crossKey already starts with token (borrowMatch[1]), so use it directly
        const moveKey = crossKey;
        if (seenLendingMove.has(moveKey)) continue;
        // X155: Same dest pool dedup — BTC.B→gmx-v2-perps(Arbitrum) from aave-v3 and silo-v2
        // are the same user action (deposit into gmx-v2-perps WBTC.B-USDC). Different borrow
        // sources are interchangeable; user picks cheapest. Keep higher-scored entry.
        const destPoolKey = normTok(borrowMatch[1]) + '|' + destKey;
        if (seenDestPool.has(destPoolKey)) continue;
        seenDestPool.add(destPoolKey);
        // X180: Same token + dest protocol across chains — yo-protocol USDC on Ethereum/Base/Arbitrum
        // all offer identical 11.7%. User picks the chain with best economics; multiple entries for
        // the same token+protocol wastes slots. Max 1 per token+destProtocol (chain-agnostic).
        // X183: normalize wrapped variants (BTC.B/WBTC/CBBTC→BTC) — same underlying exposure.
        const tokenProtoKey = normTok(borrowMatch[1]) + '|' + destMatch[1];
        if (seenTokenDestProto.has(tokenProtoKey)) continue;
        seenTokenDestProto.add(tokenProtoKey);
        // X303: Per-borrow-source dedup — USDC compound-v3(Ethereum) → csigma-finance and
        // USDC compound-v3(Ethereum) → fusion-by-ipor are the same borrow position (same collateral,
        // same protocol, same chain). User picks best destination; 2nd entry wastes a slot.
        const borrowSourceKey = normTok(borrowMatch[1]) + '|' + borrowMatch[2].toLowerCase() + '@' + borrowMatch[3].trim().toLowerCase();
        if (seenBorrowSource.has(borrowSourceKey)) continue;
        seenBorrowSource.add(borrowSourceKey);
      }
      // X170: If a YIELD entry already covers this dest protocol+chain, the CARRY/SHORT_FARM
      // is redundant — user can deposit directly instead of borrowing first. YIELD is simpler,
      // lower risk, and often higher net return (no borrow cost). Only applies when dest is
      // on the same protocol+chain as an accepted YIELD entry.
      if (destMatch) {
        const yieldDestKey = destMatch[1].toLowerCase() + '@' + destMatch[2].trim().toLowerCase();
        if (seenYieldDest.has(yieldDestKey)) continue;
      }
    }
    // X54: DEPEG_ARB and ARB entries that exploit the same token mispricing on the same DEX+chain
    // are the same underlying opportunity. Keep only the higher-scored entry.
    // DEPEG_ARB action: "USDC PREMIUM on balancer (ethereum)"
    // ARB action: "Buy USDC on uniswap, sell on balancer [ethereum]"
    if (s.category === 'DEPEG_ARB') {
      const depegMatch = (s.action || '').match(/^(\w+)\s+\w+\s+on\s+([\w.-]+)\s*\((\w+)\)/i);
      if (depegMatch) {
        const arbKey = depegMatch[1] + '|' + depegMatch[2] + '|' + depegMatch[3];
        if (seenArbMispricing.has(arbKey)) continue;
        seenArbMispricing.add(arbKey);
      }
    }
    if (s.category === 'ARB') {
      const arbMatch = (s.action || '').match(/^Buy\s+(\S+)\s+on\s+([\w.-]+),\s+sell\s+on\s+([\w.-]+)\s+\[(\w+)\]/i);
      if (arbMatch) {
        const arbKey = arbMatch[1] + '|' + arbMatch[3] + '|' + arbMatch[4];
        if (seenArbMispricing.has(arbKey)) continue;
        seenArbMispricing.add(arbKey);
        // X296/X297: Per-DEX-pair@chain dedup — a manual arbitrageur monitors ALL tokens on a
        // DEX pair in BOTH directions. raydium→pumpswap and pumpswap→raydium are the same setup.
        // Normalize by sorting DEX names so direction doesn't matter.
        const dexPairSorted = [arbMatch[2], arbMatch[3]].sort().join('|');
        const dexPairKey = dexPairSorted + '|' + arbMatch[4];
        if (seenArbDexPair.has(dexPairKey)) continue;
        seenArbDexPair.add(dexPairKey);
      }
    }
    // X61: FLASH_ARB entries that sell the same token on the same DEX+chain as an ARB or DEPEG_ARB
    // exploit the same mispricing. "WBTC uniswap->curve (ethereum)" = same as "Buy WBTC on sushi, sell on curve [ethereum]"
    if (s.category === 'FLASH_ARB') {
      const flashMatch = (s.action || '').match(/^(\w+)\s+[\w.-]+->([\w.-]+)\s+\((\w+)\)/i);
      if (flashMatch) {
        const arbKey = flashMatch[1] + '|' + flashMatch[2] + '|' + flashMatch[3];
        if (seenArbMispricing.has(arbKey)) continue;
        seenArbMispricing.add(arbKey);
      }
    }
    // X134: Cross-category destination protocol cap
    if (DEPOSIT_CATS.has(s.category)) {
      let destProto = null;
      if (s.category === 'YIELD' || s.category === 'FARMABLE_7D') {
        const yieldMatch = (s.action || '').match(/(?:Deposit|Farm)\s+into\s+([\w.-]+)/i);
        destProto = yieldMatch ? yieldMatch[1].toLowerCase() : null;
      } else if (s.category === 'RECURSIVE') {
        const recMatch = (s.action || '').match(/on\s+([\w.-]+)\s*\(/i);
        destProto = recMatch ? recMatch[1].toLowerCase() : null;
      } else if (destMatch) {
        destProto = destMatch[1].toLowerCase();
      }
      // X260: CEDEFI per-protocol cap 1 — centralized custody means ALL deposits share the same
      // counterparty. Different tokens at bitway(BSC) offer zero diversification. At $200, bitway
      // SHORT_FARM USDT (#11) + CARRY U (#12) consumed 2/14 slots for identical counterparty risk.
      const cedefiDestMax = s.cedefi ? 1 : CROSS_CAT_DEST_MAX;
      if (destProto && (crossCatDestProto[destProto] || 0) >= cedefiDestMax) continue;
      // X300: Per-destination-protocol-per-chain sub-cap (2) — convex-finance(Ethereum) ×3 means
      // if convex has an exploit, all 3 positions fail simultaneously. Allow 3 total per protocol
      // (cross-chain diversity) but max 2 from the same chain (same contract set).
      const destProtoChainKey = destProto && destMatch ? destProto + '@' + destMatch[2].trim().toLowerCase() : null;
      if (destProtoChainKey && (crossCatDestProtoChain[destProtoChainKey] || 0) >= CROSS_CAT_DEST_CHAIN_MAX) continue;
      if (destProto) crossCatDestProto[destProto] = (crossCatDestProto[destProto] || 0) + 1;
      if (destProtoChainKey) crossCatDestProtoChain[destProtoChainKey] = (crossCatDestProtoChain[destProtoChainKey] || 0) + 1;
    }
    deduped.push(s);
  }
  // G2 FIX: filter out strategies whose minimum economical capital exceeds the user's capital.
  // Strategies without minCapitalUsd (or 0) are always included — they don't require bridging.
  // X67: filter out entries with risk >= 9/10 — too dangerous for actionable recommendations.
  // Risk 8/10 is the highest shown (aggressive, user's choice). Risk 9-10 = "do not touch".
  const riskFiltered = deduped.filter(s => {
    if (s.category === "ALPHA") return true; // asymmetric plays bypass risk cap
    const r = parseInt(s.risk);
    return isNaN(r) || r <= 8;
  });
  // X93: FUNDING category cap — 5 entries pushed (wide candidate window for risk-adjusted scoring)
  // but only 3 survive to report (matching YIELD/CLM/LIQUIDATION caps). Without this cap, 4-5 meme
  // token funding entries with [SPOT THIN]/[BORROW HARD] warnings dominated 13% of report.
  // Array already sorted by profitScore, so top 3 by risk-adjusted score survive.
  // X156: FLASH_ARB + DEPEG_ARB category caps. At $200, 3 FLASH_ARB entries consumed 15% of the
  // 20-entry report — all [MEV COMPETITIVE] requiring smart contract deployment + MEV competition.
  // A user who can execute flash arbs will find the best one; 3 entries for the same skill set is
  // redundant. Cap 2 for FLASH_ARB and DEPEG_ARB (parity with CLM max 3, FUNDING max 3, but lower
  // because MEV categories have <10% retail success rate — fewer slots for lower-confidence entries).
  // X165→X351: LIQUIDATION cap 2→1 — liquidation is a binary decision (run a bot or don't).
  // Both entries at $5000 (#12, #13) are [MEV COMPETITIVE] with $200/$247 profit (<10% retail
  // capture). The 2nd entry doesn't change the user's decision — it's the same skill set, same
  // infrastructure, same <10% probability. One entry informs the opportunity class exists;
  // two wastes a slot for a zero-probability category.
  // X170: RECURSIVE cap 2 — recursive leverage requires same infrastructure (flash loan contracts,
  // health factor monitoring, liquidation risk management) regardless of protocol. 3 entries at
  // $5000 all require identical skill set. User picks best risk/return; 3 wastes a slot.
  const POST_DEDUP_CAPS = { FUNDING: 3, FLASH_ARB: 2, DEPEG_ARB: 2, LIQUIDATION: 1, RECURSIVE: 2, ARB: 2 };
  const catCounts = {};
  // X204: EXTREME RATE FUNDING sub-cap — max 1 per report. Both entries explicitly say
  // "rate reversal likely within days" (<30% persistence). A user who wants to farm extreme
  // funding needs ONE example and will explore alternatives themselves. Two EXTREME RATE entries
  // occupying 2 report slots for the same speculative strategy adds no decision value.
  let extremeFundingCount = 0;
  // X278: NON-MAJOR TOKEN YIELD sub-cap (2) — these entries require buying volatile tokens where
  // APY is in token terms. Token price moves (±30-50%/year) dominate the yield, making the shown
  // APY unreliable in USD terms. 2 entries provide exposure to best non-major opportunities without
  // saturating the report with uncertain-return entries that violate >80% confidence mandate.
  let nonMajorYieldCount = 0;
  const catCapped = riskFiltered.filter(s => {
    const cap = POST_DEDUP_CAPS[s.category];
    if (cap) {
      // X204: sub-cap extreme rate funding at 1
      if (s.category === 'FUNDING' && s.extremeRate) {
        if (++extremeFundingCount > 1) return false;
      }
      catCounts[s.category] = (catCounts[s.category] || 0) + 1;
      if (catCounts[s.category] > cap) return false;
    }
    // X278: cap non-major token YIELD at 2 per report
    if ((s.category === 'YIELD' || s.category === 'FARMABLE_7D') && s.nonMajorToken) {
      if (++nonMajorYieldCount > 2) return false;
    }
    return true;
  });
  // X276: Filter entries requiring >80% of user capital — deploying nearly all capital into one
  // position is impractical (no diversification, no gas buffer, one failure = total loss).
  const capitalThreshold = capitalUsd * 0.8;
  const capitalFiltered = catCapped.filter(s => !s.minCapitalUsd || s.minCapitalUsd <= capitalThreshold);
  capitalFiltered.forEach((s, i) => s.rank = i + 1);
  topStrategies.length = 0;
  topStrategies.push(...capitalFiltered);

  return {
    timestamp: new Date().toISOString(), version: 'v3.0',
    capitalUsd,
    summary: {
      total_yield: results.yields?.opportunities_found || 0,
      total_arb: results.arb?.total_found || 0,
      total_carry: results.carry?.total_found || 0,
      free_borrows: results.carry?.free_borrow_carries?.length || 0,
      total_spreads: results.loops?.total_opportunities || 0,
      total_aggro: (results.aggro?.clm?.total || 0) + (results.aggro?.recursive?.total || 0) + (results.aggro?.funding?.total || 0),
      total_funding: results.aggro?.funding?.total || 0,
      total_liquidation: results.liquidation?.summary?.total || 0,
      total_flasharb: (results.flasharb?.evmArbs?.length || 0) + (results.flasharb?.solanaArbs?.length || 0) + (results.flasharb?.stableDepegs?.length || 0),
    },
    top_strategies: topStrategies,
  };
}

function printReport(report) {
  console.log('\n' + '='.repeat(100));
  console.log('  DEFI OPPORTUNITY REPORT ' + report.version + ' — ' + report.timestamp + (Number.isFinite(report.capitalUsd) ? " — Capital: $" + report.capitalUsd : " — Capital: unlimited"));
  console.log('='.repeat(100));
  const s = report.summary;
  console.log('  Yields: ' + s.total_yield + ' | Arbs: ' + s.total_arb + ' | Carry: ' + s.total_carry + ' | Aggro: ' + (s.total_aggro || 0));
  console.log('  Funding: ' + (s.total_funding || 0) + ' | Liquidation: ' + (s.total_liquidation || 0) + ' | Flash arb: ' + (s.total_flasharb || 0) + ' | Free borrows: ' + s.free_borrows + ' | Spreads: ' + s.total_spreads);
  console.log('-'.repeat(100));
  for (const st of report.top_strategies.slice(0, 30)) {
    console.log('\n  #' + st.rank + ' [' + st.category + '] ' + st.expectedReturn);
    console.log('     ' + st.action);
    const meta = [];
    if (st.risk) meta.push('Risk: ' + st.risk);
    if (st.sustainability) meta.push(st.sustainability);
    if (st.feasibility) meta.push(st.feasibility);
    if (st.netProfit) meta.push('Net: ' + st.netProfit);
    if (st.tvl) meta.push('TVL: ' + st.tvl);
    if (st.minCapitalUsd > 0) meta.push('Min capital: $' + st.minCapitalUsd);
    if (st.sameChain !== undefined) meta.push(st.sameChain ? 'Same chain' : st.hardBridge ? 'Cross-chain [COMPLEX BRIDGE]' : st.nonEvmBridge ? 'Cross-chain [NON-EVM BRIDGE]' : 'Cross-chain');
    if (st.realizedApyRatio && st.realizedApyRatio < 0.8) meta.push('Realized: ' + Math.round(st.realizedApyRatio * 100) + '% of headline');
    if (st.bagTrap) meta.push('⚠ BAG TRAP: TVL<$500k + IL exposed');
    if (st.tvlFlight != null) meta.push('⚠ TVL FLIGHT: ' + st.tvlFlight + '% since first sighting — exit-liquidity risk');
    if (st.lowTvlDest && !st.bagTrap) meta.push('LOW TVL: dest pool <$1M');
    if (st.lowTvl && !st.bagTrap) meta.push('LOW TVL: pool <$1M');
    if (st.microPool) meta.push('MICRO POOL: TVL <$500K, capital dilution risk');
    if (st.riskyLp) meta.push('⚠ RISKY LP: meme/micro-cap counterparty token');
    if (st.perpsLp) meta.push('PERPS LP: counterparty risk to leveraged traders (not AMM IL)');
    if (st.volatileLp) meta.push('IL EXPOSED: volatile LP pair');
    if (st.unverifiedMicroLp) meta.push('UNVERIFIED MICRO LP: low TVL + no 7d data, APY likely transient');
    if (st.declining7d) meta.push('DECLINING: recent APY significantly above current');
    if (st.decaying) meta.push('DECAYING: current APY above 7d avg, shown rate uses conservative 7d-based estimate');
    if (st.predictedDeclining) meta.push('PREDICTED DECLINING: DefiLlama predicts rate decline, shown APY is conservative estimate');
    if (st.rateElevated) {
      const elevDetail = st.highYieldApy && st.highYieldHistorical ? ` (${st.highYieldApy.toFixed(1)}% now vs ${st.highYieldHistorical.toFixed(1)}% avg)` : '';
      meta.push('RATE ELEVATED: dest rate above historical avg, yield may revert' + elevDetail);
    }
    if (st.rateDeclining) {
      const declDetail = st.highYieldApy && st.highYieldHistorical ? ` (${st.highYieldHistorical.toFixed(1)}% avg → ${st.highYieldApy.toFixed(1)}% now)` : '';
      meta.push('DEST RATE DECLINING: dest rate dropped 33%+ from avg, spread may shrink further' + declDetail);
    }
    if (st.emissionHeavy) meta.push('EMISSION-DEPENDENT LOOP');
    if (st.baseSpreadNegative) meta.push('BASE SPREAD NEGATIVE: unprofitable without rewards');
    if (st.no7dData) meta.push('NO 7D TRACK RECORD');
    if (st.noRealizedData) meta.push('NO REALIZED APY DATA');
    if (st.leveragedProj) meta.push('LEVERAGED PROTOCOL: APY includes internal leverage');
    if (st.cedefi) meta.push('CEDEFI: centralized custody — counterparty risk (Celsius/BlockFi precedent)');
    if (st.rwaCredit) meta.push('RWA CREDIT: real-world lending — borrower default risk (Goldfinch/Maple precedent)');
    if (st.nonMajorBorrow) meta.push('NON-MAJOR BORROW: thin lending market, borrow rate spike risk');
    if (st.tightCarry) meta.push('TIGHT CARRY: borrow cost >50% of dest yield, small rate changes eliminate return');
    if (st.nonMajorToken) meta.push(st.category === 'YIELD' ? 'NON-MAJOR TOKEN: must buy volatile token, yield in token terms' : 'NON-MAJOR TOKEN: meme/micro-cap crash risk');
    if (st.spikeDiscounted) meta.push('FEE SPIKE: current APY likely transient, shown rate is spike-adjusted estimate');
    if (st.decliningFees) meta.push('DECLINING FEES: fee revenue dropping, projected APY may not persist');
    if (st.predictedDown) meta.push('FEES PREDICTED DOWN: DefiLlama predicts fee decline, projected APY is conservative');
    if (st.concentratedLp) meta.push(st.category === 'YIELD' ? 'V3 POOL: passive cap estimate, actual yield depends on price range' : 'CONCENTRATED LP: active position management required');
    if (st.extremeRate) meta.push('EXTREME RATE: speculative frenzy, rate reversal likely within days');
    if (st.spotThin) meta.push('SPOT THIN: slippage entering/exiting spot position');
    if (st.borrowHard) meta.push('BORROW HARD: no reliable lending market for this token');
    console.log('     ' + meta.join(' | '));
  }
  console.log('\n' + '='.repeat(100));
}

async function generateReport() {
  const results = {
    yields: loadData('yields.json'), arb: loadData('arb.json'), loops: loadData('loops.json'),
    carry: loadData('carry.json'), aggro: loadData('aggro.json'),
    liquidation: loadData('liquidation.json'), flasharb: loadData('flasharb.json'),
  };
  if (!results.yields && !results.arb) { return runFullScan(); }
  const report = buildReport(results, CAPITAL_USD); saveData('latest_report.json', report); printReport(report);
}

// G2: Parse --capital flag for capital-based filtering
const capitalFlag = process.argv.find(a => a.startsWith('--capital='));
const CAPITAL_USD = capitalFlag ? parseFloat(capitalFlag.split("=")[1]) : 10000;

const cmd = process.argv[2] || 'scan';
if (COMMANDS[cmd]) {
  COMMANDS[cmd]().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
} else {
  console.log('Usage: node src/index.js [scan|top|yields|arb|loops|carry|aggro|liquidate|flasharb|health|report] [--capital=AMOUNT]');
}
