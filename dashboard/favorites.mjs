// Favorites = a global watchlist of strategies (no wallet attachment, vs `pins` which are
// wallet-scoped). Each favorite carries an embedded history snapshot per scan so we can
// chart its return / risk / score over time.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const STATE_DIR = process.env.DASH_STATE_DIR || new URL('../state', import.meta.url).pathname;
const FILE = join(STATE_DIR, 'favorites.json');
const HISTORY_MAX = 1000; // ~3.5 days at 5-min scan cadence

function ensureDir() { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); }
function read() { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; } }
function write(data) { ensureDir(); const tmp = FILE + '.tmp'; writeFileSync(tmp, JSON.stringify(data, null, 2)); renameSync(tmp, FILE); }

export function returnPct(expectedReturn) {
  const m = String(expectedReturn || '').match(/-?[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

export function listFavorites() { return read(); }

export function favoriteFpSet() {
  return new Set(read().map((f) => f.fingerprint));
}

export function addFavorite(strategy) {
  const favs = read();
  // Keyed on the STABLE fingerprint (_sfp): the volatile _fp churns whenever live numbers in the
  // action text change (~53 min median), which orphaned favorites into endless null snapshots.
  if (favs.some((f) => f.fingerprint === strategy._sfp)) return favs; // idempotent
  const now = new Date().toISOString();
  favs.push({
    id: randomBytes(4).toString('hex'),
    fingerprint: strategy._sfp,
    addedAt: now,
    label: '',
    initialSnapshot: {
      category: strategy.category,
      action: strategy.action,
      expectedReturn: strategy.expectedReturn,
      risk: strategy.risk,
      tvl: strategy.tvl,
      chain: strategy._chain || null,
      minCapitalUsd: strategy.minCapitalUsd || 0,
      profitScore: typeof strategy.profitScore === 'number' ? Number(strategy.profitScore.toFixed(2)) : null,
      returnPct: returnPct(strategy.expectedReturn),
    },
    history: [],
  });
  write(favs);
  return favs;
}

export function removeFavorite(fingerprint) {
  write(read().filter((f) => f.fingerprint !== fingerprint));
}

// Capture one snapshot per favorite per scan. Idempotent if called multiple times
// within a single scan (keyed on scanTs).
export function snapshotFavorites(strategies, scanTimestamp) {
  if (!scanTimestamp) return read();
  const favs = read();
  if (!favs.length) return favs;
  const byFp = new Map(strategies.map((s) => [s._sfp, s]));
  const now = new Date().toISOString();
  let changed = false;
  for (const fav of favs) {
    const last = fav.history[fav.history.length - 1];
    if (last && last.scanTs === scanTimestamp) continue;
    const s = byFp.get(fav.fingerprint);
    fav.history.push({
      ts: now,
      scanTs: scanTimestamp,
      present: !!s,
      expectedReturn: s ? s.expectedReturn : null,
      returnPct: s ? returnPct(s.expectedReturn) : null,
      risk: s ? (parseInt(s.risk) || null) : null,
      profitScore: s && typeof s.profitScore === 'number' ? Number(s.profitScore.toFixed(2)) : null,
      tvl: s ? s.tvl : null,
    });
    if (fav.history.length > HISTORY_MAX) fav.history.splice(0, fav.history.length - HISTORY_MAX);
    changed = true;
  }
  if (changed) write(favs);
  return favs;
}

// SVG sparkline of a metric over a favorite's history. Null values create gaps.
export function sparkline(values, { w = 180, h = 32, stroke = '#4ea1ff' } = {}) {
  const nums = values.map((v) => v == null || isNaN(v) ? null : Number(v));
  const real = nums.filter((v) => v !== null);
  if (real.length < 2) return `<span class="meta">${real.length} pt</span>`;
  const min = Math.min(...real), max = Math.max(...real);
  const range = max - min || 1;
  const stepX = w / Math.max(nums.length - 1, 1);
  // Build a polyline broken on null gaps
  const segments = [];
  let cur = [];
  nums.forEach((v, i) => {
    if (v === null) { if (cur.length > 1) segments.push(cur); cur = []; return; }
    const x = i * stepX;
    const y = h - ((v - min) / range) * h;
    cur.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (cur.length > 1) segments.push(cur);
  const polys = segments.map((seg) =>
    `<polyline fill="none" stroke="${stroke}" stroke-width="1.5" points="${seg.join(' ')}"/>`
  ).join('');
  // Endpoint dot
  const lastReal = [...nums].reverse().findIndex((v) => v !== null);
  let dot = '';
  if (lastReal !== -1) {
    const idx = nums.length - 1 - lastReal;
    const v = nums[idx];
    const x = idx * stepX, y = h - ((v - min) / range) * h;
    dot = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="${stroke}"/>`;
  }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="vertical-align:middle">
    ${polys}${dot}
  </svg>`;
}

// Summary stats over a history series.
export function summarize(history) {
  const scores = history.map((h) => h.profitScore).filter((v) => v != null);
  const returns = history.map((h) => h.returnPct).filter((v) => v != null);
  return {
    snaps: history.length,
    presentSnaps: history.filter((h) => h.present).length,
    minScore: scores.length ? Math.min(...scores) : null,
    maxScore: scores.length ? Math.max(...scores) : null,
    minReturn: returns.length ? Math.min(...returns) : null,
    maxReturn: returns.length ? Math.max(...returns) : null,
  };
}
