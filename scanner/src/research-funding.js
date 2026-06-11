// PHASE-0 MEASUREMENT (read-only): cross-venue funding-rate dispersion.
//
// DefiLlama carries no perp data at all. Hyperliquid's predictedFundings returns, per coin, the
// upcoming funding on Hyperliquid + Binance + Bybit in ONE keyless call. The edge (Strategy #6) is
// the DISPERSION between venues: short the perp where funding is high (you receive), long the perp
// where it is low/negative (you also receive) — net delta-neutral, harvest the spread. This is a
// settlement-cadence trade (1-8h), NOT a latency race, so a non-co-located operator can capture it.
// This module measures the dispersion distribution + (over time) its period-to-period persistence.
// EXECUTION would need one KYC'd account per venue — measurement here is keyless.

import { fetchJSON, log } from './utils.js';

const VENUE = { HlPerp: 'Hyperliquid', BinPerp: 'Binance', BybitPerp: 'Bybit' };
// Shared interest-rate baseline both CEX/HL clamp to when premium ~= 0 (0.01%/8h-equivalent ~= 10.95%/yr).
// A reading within this band of the baseline is the structural floor, not a real funding edge — flag it.
const BASELINE_APR = 10.95;
const BASELINE_TOL = 0.06; // 6%

function annualize(fundingRate, intervalHours) {
  const r = parseFloat(fundingRate);
  if (isNaN(r) || !intervalHours) return null;
  return r * (24 / intervalHours) * 365 * 100;
}
const isBaseline = (apr) => apr != null && Math.abs(Math.abs(apr) - BASELINE_APR) < BASELINE_APR * BASELINE_TOL;

export async function scanFundingDispersion() {
  log('[FUNDING-DISP] Pulling Hyperliquid predictedFundings (HL/Binance/Bybit)...');
  let data;
  try {
    data = await fetchJSON('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'predictedFundings' }), timeout: 15000,
    });
  } catch (e) { log(`[FUNDING-DISP] error: ${e.message}`); return { timestamp: new Date().toISOString(), coins: [], note: 'fetch failed' }; }
  if (!Array.isArray(data)) return { timestamp: new Date().toISOString(), coins: [], note: 'unexpected shape' };

  const coins = [];
  for (const [coin, venueArr] of data) {
    if (!Array.isArray(venueArr)) continue;
    const venues = {};
    for (const [vkey, info] of venueArr) {
      const name = VENUE[vkey] || vkey;
      const apr = annualize(info?.fundingRate, info?.fundingIntervalHours);
      if (apr != null) venues[name] = { apr: +apr.toFixed(2), baseline: isBaseline(apr), intervalH: info.fundingIntervalHours };
    }
    const present = Object.entries(venues);
    if (present.length < 2) continue; // need >=2 venues to have a dispersion
    const aprs = present.map(([, v]) => v.apr);
    const hi = Math.max(...aprs), lo = Math.min(...aprs);
    const dispersion = +(hi - lo).toFixed(2);
    const hiVenue = present.find(([, v]) => v.apr === hi)[0];
    const loVenue = present.find(([, v]) => v.apr === lo)[0];
    // If BOTH legs are the structural baseline, there is no real edge — mark it.
    const allBaseline = present.every(([, v]) => v.baseline);
    coins.push({
      coin, venues, dispersionPct: dispersion,
      harvest: `short ${hiVenue} (${hi.toFixed(1)}%) + long ${loVenue} (${lo.toFixed(1)}%)`,
      baselineArtifact: allBaseline,
      realEdge: !allBaseline && dispersion >= 10, // >=10% annualized spread to clear 2-venue execution/fees
    });
  }
  coins.sort((a, b) => b.dispersionPct - a.dispersionPct);
  const real = coins.filter((c) => c.realEdge);
  const filtered = coins.filter((c) => c.baselineArtifact).length;
  log(`[FUNDING-DISP] ${coins.length} multi-venue coins; ${real.length} real-edge (>=10% spread); ${filtered} baseline-artifact`);
  return {
    timestamp: new Date().toISOString(),
    total_multi_venue: coins.length,
    real_edge: real.slice(0, 30),
    top_dispersion: coins.slice(0, 40),
    summary: { multi_venue: coins.length, real_edge: real.length, baseline_filtered: filtered, max_dispersion: coins.length ? coins[0].dispersionPct : 0 },
    note: 'Cross-venue funding dispersion (Strategy #6). realEdge = >=10% annualized spread after dropping baseline-vs-baseline artifacts. Delta-neutral: short the high-funding venue, long the low. Execution needs one KYC account per venue. Persistence measured by comparing snapshots over time.',
  };
}
