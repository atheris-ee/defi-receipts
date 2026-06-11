// PHASE-0 → ACTIONABLE: empirical APY-decay model (Strategy #5).
//
// Built on the de-censored, UUID-keyed pool history (research-poolhistory.js). The Phase-0 readout
// showed headline APY reverts monotonically by band (8-15% pools hold ~100%; >80% pools lose ~28%
// of their APY within a day, mostly at flat TVL = the headline spiking and reverting, not dilution).
// This module turns that into a usable signal:
//   1. builds an EMPIRICAL decay table: realized/headline APY ratio by (APY band x horizon), from
//      every (pool, t)->(pool, t+H) pair observed in the history (tracked by stable pool UUID);
//   2. scores the CURRENT pool universe: predicted forward APY + decay-risk per pool, so a held or
//      candidate position can be flagged "APY likely to revert" BEFORE it does.
// Read-only. Recomputed hourly (the table is slow-moving and the history file grows).

import { fetchJSON, saveData, loadData, log } from './utils.js';
import { readFileSync, readdirSync } from 'node:fs';

const HIST_DIR = '/var/lib/defi-research/pool-history';
const STATE = 'decay-model-state.json';
const MIN_INTERVAL_MS = 55 * 60 * 1000; // hourly

const num = (v) => (v == null || isNaN(Number(v)) ? 0 : Number(v));
// APY bands (lower bound inclusive). Matches the Phase-0 readout buckets.
const BANDS = [[8, 15], [15, 30], [30, 80], [80, 1e9]];
const bandLabel = (apy) => { for (const [lo, hi] of BANDS) if (apy >= lo && apy < hi) return `${lo}-${hi >= 1e9 ? '∞' : hi}`; return apy < 8 ? '<8' : '?'; };
// Candidate horizons (hours). Only those <= observed span are computed; populates 1d/3d/7d over time.
const HORIZONS = [6, 12, 24, 72, 168];
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pctile = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const normSym = (s) => String(s || '').toUpperCase().split(/[-/]/).map((t) => t.trim()).filter(Boolean).sort().join('-');

function loadHistory() {
  let rows = [];
  let files = [];
  try { files = readdirSync(HIST_DIR).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  for (const f of files) {
    try {
      for (const line of readFileSync(`${HIST_DIR}/${f}`, 'utf8').trim().split('\n')) {
        if (line) rows.push(JSON.parse(line));
      }
    } catch { /* skip bad file */ }
  }
  return rows;
}

export async function scanDecayModel() {
  const nowMs = Date.now();
  const state = loadData(STATE) || {};
  if (state.lastMs && (nowMs - state.lastMs) < MIN_INTERVAL_MS && loadData('decay-model')) {
    return { ...(loadData('decay-model') || {}), _cached: true };
  }

  const rows = loadHistory();
  if (rows.length < 100) { log(`[DECAY] only ${rows.length} history rows — model not ready yet`); return { timestamp: new Date().toISOString(), ready: false, rows: rows.length, note: 'accumulating history' }; }

  // group by UUID, time-ordered
  const byPool = {};
  for (const r of rows) { (byPool[r.pool] = byPool[r.pool] || []).push(r); }
  for (const p in byPool) byPool[p].sort((a, b) => a.ts.localeCompare(b.ts));
  // No spread over the history array: V8's argument limit (~125k) crashes Math.max(...) once the
  // 30-day history exceeds it (it did on 2026-06-08 at ~120k rows). Loop instead.
  let tsMin = Infinity, tsMax = -Infinity;
  for (const r of rows) { const t = Date.parse(r.ts); if (t < tsMin) tsMin = t; if (t > tsMax) tsMax = t; }
  const spanH = (tsMax - tsMin) / 3.6e6;
  const horizons = HORIZONS.filter((h) => h <= spanH * 1.1);
  if (!horizons.length) horizons.push(Math.max(2, Math.floor(spanH))); // at least the span itself

  // Build table: pairs (t -> closest to t+H within +/-30%), bucket by EARLIER band.
  const table = {}; // band -> horizon -> {medianRatio, pctFell, n, p25, p75}
  for (const [lo] of BANDS) table[bandLabel(lo)] = {};
  for (const H of horizons) {
    const Hms = H * 3.6e6, tol = Hms * 0.3;
    const bucketRatios = {}; // band -> [ratios]
    for (const p in byPool) {
      const series = byPool[p];
      for (let i = 0; i < series.length; i++) {
        const a0 = series[i]; if (num(a0.apy) <= 0) continue;
        // find a later snap closest to t+H within tolerance
        const target = Date.parse(a0.ts) + Hms;
        let best = null, bestErr = Infinity;
        for (let j = i + 1; j < series.length; j++) {
          const err = Math.abs(Date.parse(series[j].ts) - target);
          if (err < bestErr) { bestErr = err; best = series[j]; }
          if (Date.parse(series[j].ts) > target + tol) break;
        }
        if (!best || bestErr > tol) continue;
        const band = bandLabel(num(a0.apy));
        (bucketRatios[band] = bucketRatios[band] || []).push(num(best.apy) / num(a0.apy));
      }
    }
    for (const band in bucketRatios) {
      const r = bucketRatios[band];
      table[band][`${H}h`] = {
        medianRatio: +median(r).toFixed(3),
        p25: +pctile(r, 0.25).toFixed(3), p75: +pctile(r, 0.75).toFixed(3),
        pctFell10: +(100 * r.filter((x) => x < 0.9).length / r.length).toFixed(0),
        n: r.length,
      };
    }
  }

  // Score the CURRENT universe (latest snapshot per pool) with the longest well-sampled horizon.
  const scoreH = [...horizons].reverse().find((H) => Object.values(table).some((b) => b[`${H}h`] && b[`${H}h`].n >= 10)) || horizons[horizons.length - 1];
  const latestByPool = Object.values(byPool).map((s) => s[s.length - 1]);
  let maxTs = -Infinity;
  for (const r of latestByPool) { const t = Date.parse(r.ts); if (t > maxTs) maxTs = t; }
  const current = latestByPool.filter((r) => Date.parse(r.ts) >= maxTs - 2 * 3.6e6); // latest ~snapshot
  const scored = [];
  for (const r of current) {
    const band = bandLabel(num(r.apy));
    const cell = table[band] && table[band][`${scoreH}h`];
    if (!cell || cell.n < 10 || num(r.apy) <= 0) continue;
    const ratio = cell.medianRatio;
    const predicted = num(r.apy) * ratio;
    const decayRiskPct = +((1 - ratio) * 100).toFixed(1);
    // Flag on PROBABILITY of degradation (pctFell10) — for exit-timing, "how likely is this APY to
    // drop >10% over the horizon" is the actionable question. decayRiskPct (median move) + predictedApy
    // give the expected magnitude alongside it.
    scored.push({
      pool: r.pool, project: r.project, chain: r.chain, symbol: r.symbol,
      key: `${r.project}|${r.chain}|${normSym(r.symbol)}`,
      apy: +num(r.apy).toFixed(1), predictedApy: +predicted.toFixed(1), decayRiskPct,
      band, horizon: `${scoreH}h`, pctFell10: cell.pctFell10, n: cell.n,
      flag: cell.pctFell10 >= 55 ? 'HIGH' : cell.pctFell10 >= 35 ? 'MED' : 'LOW',
    });
  }
  scored.sort((a, b) => b.decayRiskPct - a.decayRiskPct);

  state.lastMs = nowMs; saveData(STATE, state);
  const result = {
    timestamp: new Date().toISOString(),
    ready: true,
    span_hours: +spanH.toFixed(1),
    horizons_computed: horizons.map((h) => `${h}h`),
    scoring_horizon: `${scoreH}h`,
    table,
    scored,
    high_risk: scored.filter((s) => s.flag === 'HIGH').slice(0, 40),
    summary: {
      history_rows: rows.length, pools_tracked: Object.keys(byPool).length, span_hours: +spanH.toFixed(1),
      scored: scored.length, high_risk: scored.filter((s) => s.flag === 'HIGH').length,
    },
    note: `Empirical decay table from UUID-keyed pool history. ratio<1 = APY reverts. Scoring uses the ${scoreH}h horizon (longest with >=10 samples/band). Confidence grows as history accumulates (1d/3d/7d horizons populate over time).`,
  };
  saveData('decay-model.json', result);
  log(`[DECAY] table built over ${spanH.toFixed(0)}h; scored ${scored.length} pools (${result.summary.high_risk} HIGH-risk) @ ${scoreH}h horizon`);
  return result;
}
