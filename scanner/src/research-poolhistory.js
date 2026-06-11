// PHASE-0 DATA CAPTURE (read-only): de-censored, UUID-keyed pool history.
//
// The SQL diagnostic proved the existing `strategies` archive CANNOT train a forward-decay model:
// it stores only the capped top-N, and its fingerprint embeds volatile rate text, so a pool's
// fingerprint churns out in ~hours (CARRY avg lifespan 0.12 days) — the +7d label is censored.
// To build Strategy #5 we need to track the SAME pool across days by its stable DefiLlama `pool`
// UUID, for a broad universe (not just the top-N). This module snapshots that universe HOURLY to a
// compact daily JSONL. It is time-sensitive: forward-realized history cannot be backfilled, so we
// start capturing now. Writes outside the 5-min archive to avoid bloat.

import { fetchJSON, saveData, loadData, log } from './utils.js';
import { mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';

const HIST_DIR = '/var/lib/defi-research/pool-history';
const STATE = 'pool-history-state.json';   // {lastSnapshotMs}
const MIN_INTERVAL_MS = 55 * 60 * 1000;    // hourly gate
const TVL_FLOOR = 1_000_000;               // trackable universe
const APY_FLOOR = 8;

const num = (v) => (v == null || isNaN(Number(v)) ? 0 : Number(v));

export async function scanPoolHistory() {
  const now = Date.now();
  const nowMs = now;
  const state = loadData(STATE) || {};
  const dueForSnapshot = !state.lastSnapshotMs || (nowMs - state.lastSnapshotMs) >= MIN_INTERVAL_MS;

  let pools;
  try {
    const r = await fetchJSON('https://yields.llama.fi/pools', { timeout: 20000 });
    pools = Array.isArray(r?.data) ? r.data : [];
  } catch (e) { log(`[POOL-HIST] fetch error: ${e.message}`); return { timestamp: new Date().toISOString(), captured: 0, note: 'fetch failed' }; }

  const universe = pools.filter((p) => num(p.tvlUsd) >= TVL_FLOOR && num(p.apy) >= APY_FLOOR);

  if (!dueForSnapshot) {
    return { timestamp: new Date().toISOString(), universe_size: universe.length, captured: 0,
      note: `within hourly gate (${Math.round((nowMs - state.lastSnapshotMs) / 60000)}min since last) — universe sized only` };
  }

  // Append compact rows to today's JSONL, keyed on the stable pool UUID.
  const day = new Date().toISOString().slice(0, 10);
  const tsIso = new Date().toISOString();
  let written = 0;
  try {
    mkdirSync(HIST_DIR, { recursive: true });
    const lines = universe.map((p) => JSON.stringify({
      ts: tsIso, pool: p.pool, project: p.project, chain: p.chain, symbol: p.symbol,
      apy: +num(p.apy).toFixed(3), apyBase: +num(p.apyBase).toFixed(3), apyReward: +num(p.apyReward).toFixed(3),
      apyMean30d: +num(p.apyMean30d).toFixed(3), apyBase7d: p.apyBase7d != null ? +num(p.apyBase7d).toFixed(3) : null,
      tvlUsd: Math.round(num(p.tvlUsd)), ilRisk: p.ilRisk, stablecoin: !!p.stablecoin,
      predClass: p.predictions?.predictedClass || null, outlier: !!p.outlier,
    })).join('\n') + '\n';
    appendFileSync(`${HIST_DIR}/${day}.jsonl`, lines);
    written = universe.length;
  } catch (e) { log(`[POOL-HIST] write error: ${e.message}`); }

  // 30-day rotation (parity with the archive timer) so the JSONL store stays bounded.
  try {
    const cutoff = nowMs - 30 * 86400 * 1000;
    for (const f of readdirSync(HIST_DIR)) {
      if (f.endsWith('.jsonl') && statSync(`${HIST_DIR}/${f}`).mtimeMs < cutoff) unlinkSync(`${HIST_DIR}/${f}`);
    }
  } catch { /* best-effort */ }

  state.lastSnapshotMs = nowMs;
  state.lastSnapshotIso = tsIso;
  state.lastUniverseSize = universe.length;
  saveData(STATE, state);

  log(`[POOL-HIST] snapshotted ${written} pools (UUID-keyed) to ${HIST_DIR}/${day}.jsonl`);
  return {
    timestamp: tsIso, universe_size: universe.length, captured: written,
    file: `${HIST_DIR}/${day}.jsonl`,
    note: 'Hourly UUID-keyed snapshot of pools tvl>=$1M & apy>=8%, for the de-censored decay model (Strategy #5). Forward-realized history accumulates from here — not backfillable.',
  };
}
