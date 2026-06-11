// Read every raw category file the scanner drops to disk and merge into one
// flat opportunity list. The scanner's curated `top_strategies` (latest_report.json)
// is shown separately by server.mjs as "top picks"; THIS module builds the broader
// "everything else" pool (~150-250 entries depending on the scan).
//
// Two things this layer is responsible for that the raw category files are NOT:
//   1. Cross-category dedup by underlying TRADE IDENTITY. The same destination pool
//      (or the same DEX mispricing) is reported by several scanners under different
//      framings — e.g. gmtrade ETH-USDC shows up as a YIELD deposit, a CARRY, and a
//      SHORT_FARM. We collapse those to ONE card (highest risk-adjusted score wins),
//      mirroring the intent of index.js's X42/X54/X155/X170 cross-category dedup which
//      the report applies but the raw files do not carry.
//   2. A NORMALIZED, risk-adjusted profitScore so a single global sort is meaningful.
//      The raw per-category scores are incomparable (liquidation in the millions, arb
//      in dollars, yield ~an APY index, alpha pinned at a flat cap). Here every entry's
//      profitScore is a risk-adjusted annualized-return index on a common ~0-600 scale,
//      with per-trade categories (arb/depeg/liquidation) capped low because they are
//      one-shot, not annualized.

import { readFileSync } from 'node:fs';
import { classifyOpportunity } from './classify.mjs';

let DATA_DIR = process.env.RECEIPTS_DATA_DIR || process.env.DASH_DATA_DIR || new URL('../scanner/data', import.meta.url).pathname;
export function setDataDir(d) { DATA_DIR = d; bustOpportunitiesCache(); }

function readJSON(name) {
  try { return JSON.parse(readFileSync(`${DATA_DIR}/${name}.json`, 'utf8')); } catch { return null; }
}

function fmtUsd(n) {
  if (!n || isNaN(n)) return '';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}
const num = (v) => v == null || isNaN(Number(v)) ? 0 : Number(v);
const safePct = (v) => `${num(v).toFixed(2)}%`;

// Parse the leading risk integer out of either a number or a "7/10" string. The raw
// files are inconsistent: some carry numeric risk, some (alpha) already carry "7/10".
function riskNum(v) {
  if (v == null) return 5;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 5;
}
// Render risk uniformly as "N/10" from whatever the source provided (never "7/10/10").
function riskStr(v, fallback = 5) {
  return `${Math.round(riskNum(v ?? fallback))}/10`;
}

// Carry/shortfarm encode protocol+chain as "kamino-lend (Solana)" — split that.
function splitProtoChain(s) {
  const m = String(s || '').match(/^([^()]+?)\s*\(([^)]+)\)\s*$/);
  return m ? { project: m[1].trim(), chain: m[2].trim() } : { project: String(s || '').trim(), chain: '' };
}

// Pull the first signed number out of an expectedReturn/action string (e.g. "+30.3% net",
// "77.0% APY headline", "$1381.97"). Used to score ALPHA by its real magnitude.
function returnMagnitude(s) {
  const m = String(s || '').match(/-?[\d.]+/);
  return m ? Math.abs(parseFloat(m[0])) : 0;
}

// Normalize a pool symbol to a canonical, order-independent form so the same pool keys
// identically across scanners (e.g. "USDC-ETH" and "ETH-USDC" → "ETH-USDC"). Used to build
// the cross-category `dest:` dedup key: the deposit/borrow family (YIELD/CARRY/SHORT_FARM)
// each carry the pool symbol under a different field (symbol / lpPairSymbol / stakeSymbol)
// and shortfarm carries no pool id at all, so project|chain|symbol is the common identity.
function normSymbol(s) {
  return String(s || '').toUpperCase().split(/[-/]/).map((t) => t.trim()).filter(Boolean).sort().join('-');
}
function destKey(project, chain, symbol) {
  return `dest:${String(project || '').trim()}|${String(chain || '').trim()}|${normSymbol(symbol)}`;
}

// ---- normalized scoring --------------------------------------------------
// Risk-adjusted annualized-return index. ann is an APY-style % (e.g. 18.4 for +18.4%).
// riskAdj maps risk 1->1.0 ... risk 10->0.1 (floored), so safer same-return entries rank
// higher. Returns >600% are clamped (data-artifact guard). risk>=9 non-convex entries are
// heavily demoted (mirrors index.js dropping risk>7 meme pools from the curated report)
// so a 395% APY risk-9 meme pair can't dominate a clean 100% risk-5 pair.
function normYield(ann, risk, { convex = false } = {}) {
  const r = Math.max(0, Math.min(num(ann), 600));
  const rk = riskNum(risk);
  const riskAdj = Math.max(0.1, Math.min(1, (11 - rk) / 10));
  let s = r * riskAdj;
  if (!convex && rk >= 9) s *= 0.25; // demote junk-risk
  return s;
}
// Per-trade (one-shot) categories: dollar-denominated, not annualized. Capped low so a
// $1.4k flash-arb can't outrank a real 50% APY yield. cap=40 for arb-family, 45 liquidation.
function normPerTrade(usd, cap) {
  return Math.min(Math.max(0, num(usd)) / 4, cap);
}

// ---- per-category extractors --------------------------------------------
// Every emitted opportunity carries:
//   _dedupKey : category-agnostic trade-identity key. One card survives per key.
//   profitScore: normalized risk-adjusted score (see above).
//   _open     : structured hints for the links/pool-resolver layer (preserved as-is).

function fromYields() {
  const d = readJSON('yields'); if (!d) return [];
  const out = [];
  const seen = new Set();
  for (const e of (d.top_50 || [])) {
    const id = e.pool || `${e.project}|${e.symbol}|${e.chain}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tvl = num(e.tvlUsd);
    const risk = e.risk ?? (e.stablecoin ? 3 : 5);
    out.push({
      category: 'YIELD',
      action: `Deposit into ${e.project} ${e.symbol} on ${e.chain}`,
      expectedReturn: safePct(e.apy),
      risk: riskStr(risk),
      tvl: fmtUsd(tvl),
      minCapitalUsd: 0,
      profitScore: normYield(e.apy, risk),
      isStable: !!e.stablecoin,
      _source: 'yields.top_50',
      _dedupKey: destKey(e.project, e.chain, e.symbol),
      _open: { project: e.project, chain: e.chain, symbol: e.symbol },
    });
  }
  return out;
}

function fromCarry() {
  const d = readJSON('carry'); if (!d) return [];
  const out = [];
  const all = [
    ...(d.top_carries || []).map((c) => [c, 'CARRY']),
    ...(d.top_stable_carries || []).map((c) => [c, 'CARRY']),
    ...(d.top_volatile_carries || []).map((c) => [c, 'CARRY']),
    ...(d.free_borrow_carries || []).map((c) => [c, 'FREE_CARRY']),
  ];
  const seen = new Set();
  for (const [c, cat] of all) {
    const localKey = `${c.token}|${c.borrowFrom}|${c.stakeIn}`;
    if (seen.has(localKey)) continue;
    seen.add(localKey);
    const stake = splitProtoChain(c.stakeIn);
    const borrow = splitProtoChain(c.borrowFrom);
    // Conservative display: prefer conservativeNet (post-spike-revert) over the
    // optimistic netSpread, matching index.js displayNet. Avoids ~2x overstatement.
    const net = c.conservativeNet != null ? c.conservativeNet : c.netSpread;
    const shortTag = c.dumpableReward > 0 ? ' [SHORT/DUMP]' : '';
    const action = (c.action || `Borrow ${c.token} from ${c.borrowFrom} at ${c.borrowRate}% → stake in ${c.stakeIn} at ${c.stakeApy}% = +${num(net).toFixed(2)}% net`) + shortTag;
    out.push({
      category: cat,
      action,
      expectedReturn: `+${num(net).toFixed(2)}% net`,
      risk: riskStr(c.risk),
      tvl: fmtUsd(c.stakeTvl || c.borrowTvl),
      minCapitalUsd: num(c.minEconomicalUsd),
      profitScore: normYield(net, c.risk),
      _source: 'carry',
      // Collapse against the YIELD/SHORT_FARM card for the same destination pool.
      _dedupKey: destKey(stake.project, stake.chain, c.lpPairSymbol || c.stakeSymbol || c.token),
      _open: { project: stake.project, chain: stake.chain, secondaryProject: borrow.project, token: c.token },
    });
  }
  return out;
}

// fromShortFarm removed: shortfarm was merged into CARRY (the scanner no longer produces a fresh
// shortfarm.json). Its borrow-and-stake trades are carried by fromCarry, with the short-thesis /
// dumpable-reward signal preserved as annotation fields (carry.js singleSided/dumpableReward/
// shortThesis). Reading the now-frozen shortfarm.json would serve stale data, so we drop it.

function fromLoops() {
  // SPREAD only. The leverage_loops branch is intentionally NOT read here: that feed is a
  // broken second implementation of recursive leverage (fabricated borrow rate, applied to
  // LP/AMM pools that can't be looped, 200000% APY artifacts) which index.js already
  // ignores. RECURSIVE is sourced solely from aggro.recursive (real LTV + borrow rates).
  const d = readJSON('loops'); if (!d) return [];
  const out = [];
  for (const s of (d.lending_spreads || [])) {
    const net = s.conservativeNetSpreadPct != null ? s.conservativeNetSpreadPct : s.netSpreadPct;
    const risk = s.spikeCapped ? 4 : 3; // FIX: field is spikeCapped, not spreadCapped
    out.push({
      category: 'SPREAD',
      action: s.action,
      expectedReturn: `+${num(net).toFixed(2)}% net APY`,
      risk: riskStr(risk),
      tvl: fmtUsd(s.highYieldTvl),
      minCapitalUsd: num(s.minEconomicalUsd),
      profitScore: normYield(net, risk),
      _source: 'loops.spreads',
      _dedupKey: `spread:${s.token}|${s.highYieldProtocol}|${s.highYieldChain}`,
      _open: { project: s.highYieldProtocol, chain: s.highYieldChain, secondaryProject: s.lowYieldProtocol, token: s.token },
    });
  }
  return out;
}

function fromAggro() {
  const d = readJSON('aggro'); if (!d) return [];
  const out = [];
  for (const c of (d.clm?.top || [])) {
    const risk = c.risk ?? 5;
    if (riskNum(risk) > 7) continue; // mirror index.js X89: keep risk>7 meme pairs off the board
    out.push({
      category: 'CLM',
      action: c.strategy,
      expectedReturn: `${num(c.tightRangeProjectedApy).toFixed(0)}% at ${c.tightRangeMultiplier}`,
      risk: riskStr(risk),
      tvl: fmtUsd(c.tvl),
      minCapitalUsd: num(c.minCapitalUsd),
      profitScore: normYield(c.tightRangeProjectedApy, risk) * (c.nonMajorToken ? 0.5 : 1),
      _source: 'aggro.clm',
      _dedupKey: c.pool ? `pool:${c.pool}` : `clm:${c.pair}|${c.project}|${c.chain}`,
      _open: { project: c.project, chain: c.chain, pair: c.pair },
    });
  }
  for (const r of (d.recursive?.top || [])) {
    const ann = r.netApyAtSafeLev;
    out.push({
      category: r.netBorrowCost <= 0 ? 'FREE_LOOP' : 'RECURSIVE',
      action: r.strategy,
      expectedReturn: `${num(ann).toFixed(2)}% at ${r.safeLeverage}x`,
      risk: riskStr(r.risk),
      tvl: fmtUsd(r.tvl),
      minCapitalUsd: num(r.minCapitalUsd),
      profitScore: normYield(ann, r.risk),
      _source: 'aggro.recursive',
      _dedupKey: r.pool ? `pool:${r.pool}` : `rec:${r.token}|${r.project}|${r.chain}`,
      _open: { project: r.project, chain: r.chain, token: r.token },
    });
  }
  for (const f of (d.funding?.top || [])) {
    const ann = f.sustainableApy;
    out.push({
      category: 'FUNDING',
      action: f.strategy,
      expectedReturn: `${num(ann).toFixed(1)}% annualized`,
      risk: riskStr(f.risk),
      tvl: f.oiUsd ? fmtUsd(f.oiUsd) + ' OI' : '',
      minCapitalUsd: num(f.minCapitalUsd) || 500,
      profitScore: normYield(ann, f.risk),
      _source: 'aggro.funding',
      _dedupKey: `fund:${f.exchange}|${f.symbol}`,
      _open: { exchange: f.exchange, symbol: f.symbol },
    });
  }
  return out;
}

function fromLiquidation() {
  // Sourced from the standalone liquidator.js (liquidation.json) — the richer, filtered,
  // capital-adjusted model — NOT aggro.json.liquidation (which lacks a protocol whitelist,
  // produces protocol:undefined, and uses cruder scoring). This also fixes the NaN render
  // bug: the old fromAggro path read aggro data with liquidator field names.
  const d = readJSON('liquidation'); if (!d) return [];
  const out = [];
  for (const m of (d.markets || [])) {
    const atRiskK = num(m.estAtRiskVolume) / 1000;
    out.push({
      category: 'LIQUIDATION',
      action: `Monitor ${m.protocol} ${m.token} on ${m.chain} — ${num(m.utilization).toFixed(0)}% util, ${num(m.liqBonusPct).toFixed(1)}% bonus, $${atRiskK.toFixed(0)}K at risk`,
      expectedReturn: `${num(m.liqBonusPct).toFixed(1)}% per liq`,
      risk: '7/10',
      tvl: fmtUsd(m.totalBorrowUsd),
      minCapitalUsd: 500,
      // Per-trade SURVEILLANCE signal (passive "monitor this market", not a deployable position
      // and not retail-executable without a liquidation bot + flashloan contract). Scored low and
      // capped at 18 so it sits in the mid-pack — a watch-signal must NOT out-rank a deployable
      // low-risk yield (a clean ~20% risk-1 Pendle deposit scores ~20). Differentiated by urgency.
      profitScore: Math.min(num(m.liqBonusPct) * (m.urgency === 'CRITICAL' ? 3 : m.urgency === 'HIGH' ? 2 : 1.2), 18),
      _source: 'liquidation',
      _dedupKey: `liq:${m.protocol}|${m.token}|${m.chain}`,
      _open: { project: m.protocol, chain: m.chain, token: m.token },
    });
  }
  return out;
}

function fromNav() {
  // NAV redemption-arb (research-nav.js). Only the actionable set: edge clears threshold AND is
  // capturable (a discount on a redeemable token, or a premium you can mint+sell into). When calm
  // this is empty — by design, no fake near-NAV "opportunities".
  const d = readJSON('nav'); if (!d) return [];
  const out = [];
  for (const a of (d.actionable || [])) {
    // Defensive across nav.json shape revisions: prefer executable edge, fall back to spot/legacy.
    const bps = num(a.effDiscountBps ?? a.spotDiscountBps ?? a.discountBps);
    if (!bps) continue; // skip malformed / zero-edge entries
    const buy = bps > 0;
    const conf = a.execDiscountBps != null ? 'exec-confirmed' : 'spot-only';
    const redeem = a.redemption || 'check redemption path';
    const action = buy
      ? `Buy ${a.sym} on DEX → redeem at NAV (+${Math.abs(bps).toFixed(0)}bps) [${redeem}]`
      : `Mint ${a.sym} at NAV → sell on DEX (premium ${Math.abs(bps).toFixed(0)}bps) [${redeem}]`;
    out.push({
      category: 'NAV_ARB',
      action,
      expectedReturn: `${bps > 0 ? '+' : ''}${bps.toFixed(0)}bps (${conf})`,
      risk: riskStr(a.redeemable ? 3 : 5),
      tvl: a.execSizeUsd ? '~' + fmtUsd(a.execSizeUsd) + ' depth' : '',
      minCapitalUsd: 1000,
      // small repeatable near-arb scored on bps, capped at 60 so a big NAV edge sits mid-pack
      // (visible, but a 30bps arb shouldn't outrank a real 100%+ APY).
      profitScore: Math.min(Math.abs(bps), 60),
      _source: 'nav',
      _dedupKey: `nav:${a.sym}`,
      _open: { token: a.sym, chain: a.net },
    });
  }
  return out;
}

// Unified spot-mispricing extractor: ARB (own-capital, incl. Solana) + FLASH_ARB +
// DEPEG_ARB all chase the same DEX dislocations. They share one `arb:` dedup namespace so
// the same token+chain mispricing shows once (highest net wins) instead of 2-3 cards.
function fromArb() {
  const d = readJSON('arb'); if (!d) return [];
  return (d.cross_dex_opportunities || []).map((a) => ({
    category: 'ARB',
    action: `Buy ${a.token} on ${a.buyDex}, sell on ${a.sellDex} [${a.chain}]`,
    expectedReturn: `$${num(a.netProfitUsd).toFixed(2)} (${num(a.spreadPct).toFixed(2)}%)`,
    risk: '4/10',
    tvl: fmtUsd(a.maxTradeSize),
    minCapitalUsd: 100,
    profitScore: normPerTrade(a.netProfitUsd, 40),
    _source: 'arb',
    _dedupKey: `arb:${a.token}|${a.chain}`,
    _open: { chain: a.chain, token: a.token, buyDex: a.buyDex, sellDex: a.sellDex, buyUrl: a.buyUrl, sellUrl: a.sellUrl },
  }));
}

function fromFlashArb() {
  const d = readJSON('flasharb'); if (!d) return [];
  const out = [];
  for (const a of (d.evmArbs || [])) {
    // FIX: the old [LIKELY CAPTURED]/[MEV COMPETITIVE] split relied on a.highLiquidity which
    // the scanner never sets. Derive a capture label from buyLiquidity directly so deep-pool
    // arbs (almost certainly MEV-captured) are honestly labelled.
    const deep = num(a.buyLiquidity) > 5e6;
    const label = a.flashLoanable ? (deep ? '[LIKELY CAPTURED]' : '[MEV COMPETITIVE]') : '[NO FLASH LOAN]';
    out.push({
      category: 'FLASH_ARB',
      action: `${a.token} ${a.buyDex}→${a.sellDex} (${a.chain}) ${label}`,
      expectedReturn: `$${num(a.netProfit || a.grossProfit).toFixed(2)} (${num(a.spreadPct).toFixed(2)}%)`,
      risk: '5/10',
      tvl: fmtUsd(a.buyLiquidity),
      minCapitalUsd: a.flashLoanable ? 500 : 1000,
      profitScore: normPerTrade(a.netProfit || a.grossProfit, 40),
      _source: 'flasharb.evm',
      _dedupKey: `arb:${a.token}|${a.chain}`,
      _open: { chain: a.chain, token: a.token, buyDex: a.buyDex, sellDex: a.sellDex },
    });
  }
  for (const d2 of (d.stableDepegs || [])) {
    out.push({
      category: 'DEPEG_ARB',
      action: `${d2.stable} ${d2.direction} on ${d2.dex} (${d2.chain}) — ${num(d2.deviation).toFixed(2)}% deviation`,
      expectedReturn: `$${num(d2.netProfit || d2.grossProfit).toFixed(2)} per trade`,
      risk: riskStr(d2.flashLoanable ? 4 : 5),
      tvl: fmtUsd(d2.liquidity),
      minCapitalUsd: d2.flashLoanable ? 500 : 1000,
      profitScore: normPerTrade(d2.netProfit || d2.grossProfit, 40),
      _source: 'flasharb.depeg',
      _dedupKey: `arb:${d2.stable}|${d2.chain}`,
      _open: { chain: d2.chain, token: d2.stable, buyDex: d2.dex },
    });
  }
  return out;
}

function fromAlpha() {
  const d = readJSON('alpha'); if (!d) return [];
  return (d.all_alpha || []).map((a, i) => {
    // a.risk is already a string like "7/10" — FIX: do not append "/10" again.
    const rk = riskNum(a.risk);
    // a.tvl is a preformatted string like "$1.05M" — FIX: pass through, do not coerce to NaN.
    const tvl = typeof a.tvl === 'string' ? a.tvl : fmtUsd(num(a.tvl));
    // ALPHA is convex/asymmetric: score on its real headline return (no longer pinned at a
    // flat 400 cap, so a 197% bet differentiates from a 77% one), risk-adjusted but exempt
    // from the junk-risk demotion since these are intentionally high-risk convex plays.
    const ann = returnMagnitude(a.expectedReturn) || returnMagnitude(a.action);
    return {
      category: a.category || 'ALPHA',
      action: a.action,
      expectedReturn: a.expectedReturn,
      risk: riskStr(rk),
      tvl,
      minCapitalUsd: num(a.minCapitalUsd),
      // blue-chip gate: scanner-side ×0.2 demotion is on a.profitScore which we discard here,
      // so reapply it to the normalized score and carry the flag for board/alert exclusion.
      profitScore: normYield(ann, rk, { convex: true }) * 1.3 * (a.nonMajorToken ? 0.2 : 1),
      nonMajorToken: a.nonMajorToken || undefined,
      _source: 'alpha',
      // alpha.js (P2.9) now emits a canonical _dedupKey so ALPHA collapses against the source
      // carry/yield card; fall back to a per-entry key for any legacy entry without one.
      _dedupKey: a._dedupKey || `alpha:${i}:${String(a.action || '').slice(0, 40)}`,
      _open: a._open || undefined,
    };
  });
}

// ---- combined ------------------------------------------------------------

// Cache: opportunities are derived from JSON files that change every 5 min (defi-tracker.timer).
// Cache for 30s so the dashboard renders fast on auto-refresh.
let cache = null;
let cacheTs = 0;
const TTL_MS = 30 * 1000;

export function collectAllOpportunities() {
  const now = Date.now();
  if (cache && now - cacheTs < TTL_MS) return cache;
  const all = [
    ...fromYields(),
    ...fromCarry(),
    ...fromLoops(),
    ...fromAggro(),
    ...fromLiquidation(),
    ...fromNav(),
    ...fromArb(),
    ...fromFlashArb(),
    ...fromAlpha(),
  ];
  all.forEach((o) => Object.assign(o, classifyOpportunity(o)));
  // Cross-category dedup by underlying trade identity. Sort by score desc first, then keep
  // the first (highest-scored) entry per _dedupKey — so each pool/mispricing/market shows
  // once, as whichever framing scores best after risk-adjustment.
  all.sort((a, b) => (b.profitScore || 0) - (a.profitScore || 0) || (a.category < b.category ? -1 : 1));
  const seenKey = new Set();
  const deduped = [];
  for (const o of all) {
    const k = o._dedupKey;
    if (k) {
      if (seenKey.has(k)) continue;
      seenKey.add(k);
    }
    deduped.push(o);
  }
  deduped.forEach((o, i) => { o.rank = i + 1; });
  cache = deduped;
  cacheTs = now;
  return deduped;
}

export function bustOpportunitiesCache() { cache = null; cacheTs = 0; }
