#!/usr/bin/env node
// defi-tracker dashboard — live web service on VPS3.
// Reads scan state fresh on every request, plus per-wallet on-chain portfolio fetch.
// SSH-tunnel only: bound to 127.0.0.1, no token required.

import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fetchPortfolio, symbolSet } from './portfolio.mjs';
import {
  listWallets, addWallet, removeWallet, findWallet,
  listPins, addPin, updatePinStatus, removePin, fingerprintOf,
} from './storage.mjs';
import { CHAIN_NAME_TO_KEY } from './chains.mjs';
import { collectAllOpportunities } from './opportunities.mjs';
import { SECTIONS, classifyOpportunity } from './classify.mjs';
import crypto from 'node:crypto';
import { buildLinks } from './links.mjs';
import { startResolverWarmer } from './pool-resolver.mjs';
import {
  listFavorites, favoriteFpSet, addFavorite, removeFavorite,
  snapshotFavorites, sparkline, returnPct,
} from './favorites.mjs';

const PORT = process.env.DASHBOARD_PORT || 8847;
const TOKEN = process.env.DASHBOARD_TOKEN || ''; // optional gate
const REPO_ROOT = new URL('..', import.meta.url).pathname;
const PSQL = process.env.RECEIPTS_PSQL || `psql -d defi -U defi`;
const RESEARCH_DIR = process.env.RECEIPTS_DATA_DIR || `${REPO_ROOT}scanner/data`;
const REPORT   = `${RESEARCH_DIR}/latest_report.json`;
const AGENT_DIR = process.env.RECEIPTS_AGENT_DIR || `${REPO_ROOT}agent`;
const REVIEW   = `${AGENT_DIR}/review-staging/REVIEW-LOG.md`;
const TODO     = `${AGENT_DIR}/state/TODO.md`;
const WORKSPACE = `${AGENT_DIR}/workspace`;
const STAGING   = `${AGENT_DIR}/review-staging`;

const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', timeout: 4000 }).trim(); } catch { return ''; } };
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmtUsd = (n) => n == null ? '—' : (n >= 1000 ? '$' + Math.round(n).toLocaleString() : '$' + n.toFixed(n >= 10 ? 1 : 2));
const num = (v) => (v == null || isNaN(Number(v)) ? 0 : Number(v));

// Decay-model exit-timing overlay (module-level so both strategiesTable and renderResearch can use
// it). Matches a strategy's destination pool by project|chain|symbol to the decay model and renders
// a warning tag for pools whose APY is empirically likely to revert. Cached 30s.
let _decayCache = null, _decayCacheTs = 0;
function decayMap() {
  if (_decayCache && Date.now() - _decayCacheTs < 30000) return _decayCache;
  const dm = readJSON(`${RESEARCH_DIR}/decay-model.json`);
  const m = new Map();
  // Staleness gate: when the scanner's decay pass freezes (it did for 2 days in June 2026 while
  // the file kept claiming ready:true), serving old pills as current is worse than none. The
  // model regenerates every 5-min scan, so >60 min old = the pipeline is broken.
  const fresh = dm && dm.timestamp && (Date.now() - Date.parse(dm.timestamp)) < 3600_000;
  if (fresh && Array.isArray(dm.scored)) for (const sc of dm.scored) m.set(sc.key, sc);
  _decayCache = m; _decayCacheTs = Date.now();
  return m;
}
const dNormSym = (x) => String(x || '').toUpperCase().split(/[-/]/).map((t) => t.trim()).filter(Boolean).sort().join('-');
function decayTag(s) {
  const o = (s && s._open) || {}; const sym = o.symbol || o.pair;
  if (!o.project || !o.chain || !sym) return '';
  const dc = decayMap().get(`${o.project}|${o.chain}|${dNormSym(sym)}`);
  if (!dc || dc.flag === 'LOW') return '';
  const cls = dc.flag === 'HIGH' ? 'bad' : 'warn';
  return ` <span class="pill ${cls}" title="Decay model: ${dc.pctFell10}% of comparable pools fell >10% over ${dc.horizon}; predicted →${dc.predictedApy}%">⚠ decay →${Math.round(dc.predictedApy)}%</span>`;
}
// --- Realization overlay (durability/decay) from the opportunity_realization Postgres view.
// Keyed by stable_fp(category, action) replicated in JS to match the view's sfp. Cached 60s, best-effort.
function stableStemJs(action) {
  let s = String(action || '');
  s = s.replace(/\s+[—–-]\s+current\s[\s\S]*$/, '');
  s = s.replace(/\s+@\s+[\s\S]*$/, '');
  s = s.replace(/\$?\d[\d.,]*\s*[KkMmBb]?%?/g, '');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}
function stableFpJs(cat, action) {
  return crypto.createHash('md5').update(String(cat || '') + '|' + stableStemJs(action)).digest('hex').slice(0, 12);
}
let _realCache = null, _realTs = 0;
function realizationMap() {
  if (_realCache && Date.now() - _realTs < 60000) return _realCache;
  const m = new Map();
  try {
    const out = execSync(`${PSQL} -tAc "SELECT sfp,apy_retention,tvl_change_pct,still_live,days_obs,sightings FROM opportunity_realization"`, { encoding: 'utf8', timeout: 6000 });
    for (const line of out.split('\n')) {
      const [sfp, ret, tvl, live, days, sight] = line.split('|');
      if (sfp) m.set(sfp, { ret: ret === '' ? null : parseFloat(ret), tvl: tvl === '' ? null : parseFloat(tvl), live: live === 't', days: parseFloat(days) || 0, sight: parseInt(sight) || 0 });
    }
  } catch { /* psql/view unavailable -> no badges */ }
  _realCache = m; _realTs = Date.now();
  return m;
}
function realizationTag(s) {
  const r = realizationMap().get(stableFpJs(s.category, s.action));
  if (!r || r.sight < 3) return '';
  const out = [];
  if (r.tvl != null && r.tvl <= -50) out.push(`<span class="pill bad" title="TVL fell ${r.tvl}% since first seen — liquidity is leaving this pool">🩸 TVL ${Math.round(r.tvl)}%</span>`);
  else if (r.tvl != null && r.tvl >= 25) out.push(`<span class="pill ok" title="TVL grew ${r.tvl}% since first seen">📈 TVL +${Math.round(r.tvl)}%</span>`);
  if (r.ret != null && r.ret >= 0.9 && r.live && r.days >= 3) out.push(`<span class="pill ok" title="APY held (${r.ret}x of entry) over ${Math.round(r.days)}d, still live">✓ held ${Math.round(r.days)}d</span>`);
  else if (r.ret != null && r.ret < 0.6) out.push(`<span class="pill warn" title="APY decayed to ${Math.round(r.ret * 100)}% of entry">↓ decaying</span>`);
  return out.length ? ' ' + out.join(' ') : '';
}

// decayInfo: same lookup decayTag uses, but returns the raw row for gating logic.
function decayInfo(s) {
  const o = (s && s._open) || {}; const sym = o.symbol || o.pair;
  if (!o.project || !o.chain || !sym) return null;
  return decayMap().get(`${o.project}|${o.chain}|${dNormSym(sym)}`) || null;
}

// ---- Today-page helpers ------------------------------------------------------------------------
// Category actionability from the 21-day dataset (median lifespans: LIQUIDATION 20.9d, ARB 17.7d,
// FUNDING 13.7d, CLM 8.5d vs CARRY 1.3d, NAV_ARB 0.5d, SHORT_FARM 0.3d). A once-a-day visitor
// cannot act on sub-2-day opportunities — those surface as events/ticker lines, never ranked picks.
const DURABLE_CATS = new Set(['ALPHA', 'CLM', 'ARB', 'LIQUIDATION', 'YIELD', 'RECURSIVE', 'FREE_LOOP', 'DEPEG_ARB']);
const isTrap = (r) => !!(r && r.tvl != null && r.tvl <= -50);
const isSurvivor = (r) => !!(r && r.live && r.days >= 7 && r.ret != null && r.ret >= 0.85 && (r.tvl == null || r.tvl >= -10));

// 24h diff via Postgres — the strategies table holds every scan's full pool keyed by stable_fp,
// so the diff is one query instead of re-running collectors over archived files (which would
// conflate collector-code changes with market changes). Action is the LAST select column so
// embedded '|' in action text can't break the parse.
let _diffCache = null, _diffTs = 0;
function diff24() {
  if (_diffCache && Date.now() - _diffTs < 300000) return _diffCache;
  const res = { ok: false, basis: '', now: new Map(), past: new Map() };
  try {
    const q = `SELECT side, stable_fp, category, score, ret, ts, action FROM ( SELECT 'now' AS side, stable_fp, min(category) AS category, max(profit_score) AS score, max(return_pct) AS ret, min(scan_ts)::text AS ts, min(action) AS action FROM strategies WHERE scan_ts = (SELECT max(scan_ts) FROM strategies) AND stable_fp IS NOT NULL GROUP BY stable_fp UNION ALL SELECT 'past', stable_fp, min(category), max(profit_score), max(return_pct), min(scan_ts)::text, min(action) FROM strategies WHERE scan_ts = (SELECT max(scan_ts) FROM strategies WHERE scan_ts <= now() - interval '24 hours') AND stable_fp IS NOT NULL GROUP BY stable_fp ) u`;
    const out = execSync(`${PSQL} -c "${q}"`, { encoding: 'utf8', timeout: 10000 });
    for (const line of out.split('\n')) {
      if (!line) continue;
      const parts = line.split('|');
      if (parts.length < 7) continue;
      const [side, sfp, category, score, ret, ts] = parts;
      const action = parts.slice(6).join('|');
      const row = { sfp, category, score: score === '' ? null : parseFloat(score), ret: ret === '' ? null : parseFloat(ret), action };
      if (side === 'now') res.now.set(sfp, row);
      else { res.past.set(sfp, row); if (!res.basis) res.basis = ts.replace('T', ' ').slice(0, 16); }
    }
    res.ok = res.now.size > 0 && res.past.size > 0;
  } catch { /* psql unavailable -> section renders its degraded state */ }
  _diffCache = res; _diffTs = Date.now();
  return res;
}

// The gmtrade rule, badge-only (n=1 evidence for the underlying collapse pattern, so no score
// multiplier): identities camping in rank<=3 for >40% of the last 72h of scans get a CROWDED chip.
let _crowdCache = null, _crowdTs = 0;
function crowdedSet() {
  if (_crowdCache && Date.now() - _crowdTs < 300000) return _crowdCache;
  const s = new Set();
  try {
    const out = execSync(`${PSQL} -c "SELECT stable_fp FROM strategies WHERE scan_ts > now() - interval '72 hours' AND rank <= 3 AND stable_fp IS NOT NULL GROUP BY stable_fp HAVING count(*) >= 0.4 * (SELECT count(DISTINCT scan_ts) FROM strategies WHERE scan_ts > now() - interval '72 hours')"`, { encoding: 'utf8', timeout: 8000 });
    for (const l of out.split('\n')) if (l.trim()) s.add(l.trim());
  } catch { /* badge silently absent */ }
  _crowdCache = s; _crowdTs = Date.now();
  return s;
}

// Module freshness for the status strip: any scanner data file >30 min old means a collector is
// silently dead (the exact failure mode that hid the FLASH_ARB drop and the decay crash).
function staleModules() {
  const out = [];
  for (const f of ['yields', 'carry', 'loops', 'aggro', 'arb', 'flasharb', 'liquidation', 'alpha', 'incentives', 'nav', 'funding-dispersion', 'decay-model']) {
    try { if (Date.now() - statSync(`${RESEARCH_DIR}/${f}.json`).mtimeMs > 30 * 60 * 1000) out.push(f); }
    catch { out.push(f + '(missing)'); }
  }
  return out;
}

const safeLinks = (s) => { try { return renderOpenLinks(s); } catch { return '<span class="dim">—</span>'; } };

const fmtAmt = (n) => n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(n >= 1 ? 3 : 6).replace(/\.?0+$/, '');
const shortAddr = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';

function ago(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ---- chain extraction (reused by filter dropdown + pin matching) -----------

const KNOWN_CHAINS = new Set([
  'ethereum','polygon','arbitrum','base','optimism','avalanche','bsc','binance',
  'solana','sui','aptos','bitcoin','litecoin','tron','ton','near','cosmos',
  'osmosis','injective','starknet','stellar','sei',
  'hyperliquid l1','hyperliquid','hyperevm','fantom','sonic','gnosis','cronos',
  'kava','celo','harmony','moonbeam','moonriver','aurora','fuse','boba','velas','telos',
  'mantle','linea','scroll','plasma','op mainnet','arbitrum nova','manta','blast',
  'mode','metis','zksync era','polygon zkevm','berachain','monad','hemi','katana',
  'plume','tac','unichain','flare','rootstock','world chain','ink','soneium',
]);
function chainOf(s) {
  const a = String(s.action || '');
  for (const m of a.matchAll(/[\(\[]([A-Za-z][A-Za-z0-9 .-]{0,29})[\)\]]/g)) {
    const c = m[1].trim();
    if (KNOWN_CHAINS.has(c.toLowerCase())) return c;
  }
  return '';
}
function returnMagnitude(s) {
  const m = String(s || '').match(/-?[\d.]+/);
  return m ? Math.abs(parseFloat(m[0])) : 0;
}

// ---- data collection (scan state + review state) --------------------------

function collectScan() {
  const report = readJSON(REPORT) || {};
  const scanTs = report.timestamp ? new Date(report.timestamp).getTime() : 0;
  const scanAgeMs = scanTs ? Date.now() - scanTs : -1;
  const svc = {
    trackerTimer:  sh('systemctl is-active defi-tracker.timer'),
    devAgentEnabled: sh('systemctl is-enabled defi-tracker-dev-agent.timer'),
    executorTimer: sh('systemctl is-active defi-executor-dryrun.timer'),
  };
  const reviewRaw = readText(REVIEW);
  const batches = [];
  for (const line of reviewRaw.split('\n')) {
    const m = line.match(/^## (Batch \d+) \(commits ([\d-]+)[^)]*\)\s*—\s*(.+)$/);
    if (m) batches.push({ name: m[1], range: m[2], status: m[3].trim() });
  }
  const acceptedCommits = batches
    .filter((b) => /ACCEPT/i.test(b.status))
    .reduce((n, b) => { const [a, z] = b.range.split('-').map(Number); return n + (z - a + 1); }, 0);
  const todoOpen = (readText(TODO).match(/^- \[ \]/gm) || []).length;
  const todoDone = (readText(TODO).match(/^- \[x\]/gm) || []).length;
  const wsCommits = sh(`git -C ${WORKSPACE} rev-list --count HEAD 2>/dev/null`);
  const stagingCommits = sh(`git -C ${STAGING} rev-list --count HEAD 2>/dev/null`);

  // Full opportunity pool from raw category files (yields top_50, carry, shortfarm, loops,
  // aggro CLM/recursive/funding/liquidation, arb, flasharb, alpha) — ~250-300 entries vs
  // the scanner's curated 28. The curated top_strategies stays in report.top_strategies
  // and is appended after so users see both "top picks" and "everything else".
  const topPicks = (report.top_strategies || []).map((s) => ({
    ...s,
    ...classifyOpportunity(s),
    _chain: chainOf(s),
    _fp: fingerprintOf(s),
    _sfp: stableFpJs(s.category, s.action),
    _topPick: true,
  }));
  // Dedupe on the STABLE fingerprint: the curated report and the raw pool word the same
  // opportunity with different live numbers, so the volatile _fp missed the match and the
  // strategies page showed duplicate rows (~3 live pairs at any time).
  const topPickSfps = new Set(topPicks.map((s) => s._sfp));
  const pool = collectAllOpportunities().map((o) => ({
    ...o,
    _chain: chainOf(o),
    _fp: fingerprintOf(o),
    _sfp: stableFpJs(o.category, o.action),
  })).filter((o) => !topPickSfps.has(o._sfp)); // dedupe vs the curated list

  // Combine: top picks first (carry their existing ranks), then pool ranked by profitScore.
  // Reassign ranks 1..N over the union for stable display.
  const strategies = [...topPicks, ...pool];
  strategies.forEach((s, i) => { s.rank = i + 1; });

  return { report, strategies, scanAgeMs, svc, batches, acceptedCommits,
           todoOpen, todoDone, wsCommits, stagingCommits };
}

// ---- shared styles + page chrome -------------------------------------------

const STYLE = `
  :root{--bg:#0e1116;--panel:#171b22;--line:#2a2f3a;--fg:#d6dae0;--dim:#7d8590;--acc:#4ea1ff;--ok:#3fb950;--warn:#d29922;--bad:#f85149}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
  a{color:var(--acc);text-decoration:none}
  a:hover{text-decoration:underline}
  h1{font-size:15px;margin:0;letter-spacing:.5px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:0 0 10px}
  h3{font-size:13px;margin:0 0 8px;color:var(--fg)}
  .wrap{max-width:1320px;margin:0 auto;padding:18px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:16px}
  .top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
  .row{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
  .pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .pill.ok{background:#103a24;color:var(--ok)}
  .pill.warn{background:#3a2f10;color:var(--warn)}
  .pill.bad{background:#3a1518;color:var(--bad)}
  .pill.dim{background:var(--bg);color:var(--dim);border:1px solid var(--line)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
  .wallets{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
  .wcard{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:12px}
  .wcard .wtop{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .wcard .wval{font-size:18px;font-weight:700;color:var(--acc)}
  .wcard .waddr{color:var(--dim);font-size:11px}
  .wcard .wholdings{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}
  .wcard .htoken{font-size:11px;background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:1px 6px}
  .wcard .wactions{margin-top:10px;display:flex;gap:6px;font-size:11px}
  .stat{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;text-align:center}
  .snum{font-size:17px;font-weight:700;color:var(--acc)}
  .slbl{font-size:10px;color:var(--dim);text-transform:uppercase}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:6px 8px;border-bottom:1px solid var(--line)}
  td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .r{text-align:right;white-space:nowrap}
  .dim{color:var(--dim)}
  .act{max-width:560px}
  .ret{color:var(--ok);font-weight:600}
  .cat{font-size:10px;font-weight:700;color:var(--acc);background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 6px}
  .chain{font-size:10px;color:var(--dim);background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 6px;white-space:nowrap}
  .bar{height:6px;background:var(--bg);border:1px solid var(--line);border-radius:4px;overflow:hidden;margin-top:6px}
  .bar>div{height:100%;background:var(--acc)}
  .meta{color:var(--dim);font-size:11px}
  .filters{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)}
  .filters label{display:flex;flex-direction:column;gap:3px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)}
  .filters select,.filters input[type=text]{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 6px;font:12px ui-monospace,Menlo,monospace}
  .filters button,.btn{background:var(--acc);color:#06121f;border:0;border-radius:5px;padding:5px 14px;font-weight:700;cursor:pointer;font:12px ui-monospace,Menlo,monospace}
  .btn.sec{background:transparent;color:var(--fg);border:1px solid var(--line)}
  .btn.danger{background:#3a1518;color:var(--bad);border:1px solid #5a2025}
  .filters .clear{color:var(--dim);align-self:center}
  .err{background:#3a1518;color:var(--bad);border:1px solid #5a2025;border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:12px}
  .ok-msg{background:#103a24;color:var(--ok);border:1px solid #1f5235;border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:12px}
  .pinrow{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-top:6px;font-size:12px}
  .pinrow .pstatus{margin-right:6px}
  .pinrow form{display:inline}
  .pinrow .ptiny{background:transparent;border:1px solid var(--line);color:var(--dim);padding:1px 7px;border-radius:4px;cursor:pointer;font-size:10px;margin-left:4px}
  .pinrow .ptiny:hover{color:var(--fg);border-color:var(--acc)}
  .holdings-table td{padding:4px 8px}
  .add-wallet{display:flex;gap:8px;align-items:flex-end;margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)}
  .add-wallet input[type=text]{flex:1}
  .pin-link{font-size:13px;opacity:.5}
  .pin-link:hover{opacity:1;text-decoration:none}
  .open-cell{white-space:nowrap;font-size:11px}
  .open-link{display:inline-block;padding:1px 6px;margin:0 2px 0 0;border:1px solid var(--line);border-radius:3px;color:var(--acc);text-decoration:none;opacity:.85}
  .open-link:hover{opacity:1;border-color:var(--acc);text-decoration:none}
  .open-link.primary{border-color:var(--ok);color:var(--ok);opacity:1;font-weight:600}
  .open-link.primary:hover{background:rgba(63,185,80,.08);border-color:var(--ok)}
  .nav{display:flex;align-items:center;gap:18px;padding:6px 0 14px;margin-bottom:6px;border-bottom:1px solid var(--line)}
  .navtitle{font-weight:700;letter-spacing:.8px;color:var(--acc);font-size:13px}
  .nav a,.nav .navactive{font-size:11px;text-transform:uppercase;letter-spacing:.8px;padding-bottom:2px}
  .nav a{color:var(--dim)}
  .nav a:hover{color:var(--fg);text-decoration:none}
  .nav .navactive{color:var(--fg);border-bottom:2px solid var(--acc)}
  .fav-btn{background:none;border:0;color:var(--dim);cursor:pointer;font-size:14px;padding:0 3px;line-height:1;opacity:.5}
  .fav-btn:hover{opacity:1;color:var(--warn)}
  .fav-btn.on{color:var(--warn);opacity:1}
  .spark-cell{min-width:200px}
  .sectabs{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
  .sectab{font-size:11px;padding:3px 10px;border:1px solid var(--line);border-radius:14px;color:var(--fg);background:var(--bg);white-space:nowrap}
  .sectab:hover{border-color:var(--acc);text-decoration:none}
  .subhead td{background:var(--bg);color:var(--dim);font-size:11px;font-weight:700;letter-spacing:.5px}
  .nav-spacer{flex:1}
  .wstat{font-size:11px;color:var(--dim)}
  .wstat strong{color:var(--fg)}
  tr:target td{background:rgba(210,153,34,.14)}
  .strip{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin-bottom:16px;font-size:11px}
  .strip a{color:inherit}
  .strip .sv{font-weight:700;color:var(--fg)}
  .strip .red{color:var(--bad);font-weight:700}
  .strip .grn{color:var(--ok)}
  .card{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin-bottom:8px}
  .card .chead{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
  .card .creason{color:var(--dim);font-size:11px;margin-top:4px;font-style:italic}
  .evt{padding:4px 8px;border-left:3px solid var(--line);margin-bottom:4px;font-size:12px}
  .evt.born{border-left-color:var(--ok)}
  .evt.gone{border-left-color:var(--dim);color:var(--dim)}
  .evt.move{border-left-color:var(--warn)}
  .evt.trapd{border-left-color:var(--bad)}
  .evt .delta{font-weight:700}
  details.fold summary{cursor:pointer;color:var(--dim);font-size:12px;padding:4px 0}
  details.fold summary:hover{color:var(--fg)}
  .badge-new{background:#103a24;color:var(--ok);font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px}
  .badge-crowd{background:#3a2f10;color:var(--warn);font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px}
  .ticker{font-size:12px;padding:3px 0;border-bottom:1px dashed var(--line)}
  .ticker:last-child{border-bottom:none}
`;

function page(title, body) {
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta http-equiv="refresh" content="60">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

function pill(label, kind) {
  return `<span class="pill ${kind}">${esc(label)}</span>`;
}

function headerNav(active, extra = '') {
  const item = (id, label, href) => active === id
    ? `<span class="navactive">${label}</span>`
    : `<a href="${href}">${label}</a>`;
  return `<div class="nav">
    <span class="navtitle">DEFI-TRACKER</span>
    ${item('home', 'Today', '/')}
    ${item('all', 'All opportunities', '/all')}
    ${item('portfolio', 'Portfolio', '/portfolio')}
    ${item('favorites', 'Favorites', '/favorites')}
    ${item('research', 'Research', '/research')}
    <span class="nav-spacer"></span>${extra}
  </div>`;
}

function walletStat(wallets, portfolios) {
  if (!wallets.length) return `<span class="wstat"><a href="/portfolio">+ add wallet</a></span>`;
  const total = portfolios.reduce((s, p) => s + (p?.totalUsd || 0), 0);
  return `<span class="wstat">${wallets.length} wallet${wallets.length === 1 ? '' : 's'} · <strong>${esc(fmtUsd(total))}</strong> · <a href="/portfolio">manage</a></span>`;
}

// ---- Portfolio panel + wallet rendering ----------------------------------

function portfolioPanel(wallets, portfolios) {
  const total = portfolios.reduce((s, p) => s + (p?.totalUsd || 0), 0);
  const cards = wallets.map((w) => {
    const p = portfolios.find((x) => x && x.wallet.toLowerCase() === w.address.toLowerCase());
    const totalUsd = p?.totalUsd || 0;
    const topTokens = (p?.chains || []).flatMap((c) => c.balances.map((b) => ({ ...b, chain: c.label })))
      .sort((a, b) => (b.usd || 0) - (a.usd || 0))
      .slice(0, 6);
    const tokenChips = topTokens.length
      ? topTokens.map((t) => `<span class="htoken" title="${esc(t.chain)}">${esc(t.symbol)} ${esc(fmtUsd(t.usd))}</span>`).join('')
      : '<span class="meta">no holdings detected</span>';
    return `<div class="wcard">
      <div class="wtop">
        <div>
          <div><strong>${esc(w.label)}</strong> <span class="waddr">${esc(shortAddr(w.address))}</span></div>
          <div class="meta">added ${esc(w.addedAt.slice(0, 10))}</div>
        </div>
        <div class="wval">${esc(fmtUsd(totalUsd))}</div>
      </div>
      <div class="wholdings">${tokenChips}</div>
      <div class="wactions">
        <a href="/wallet?addr=${encodeURIComponent(w.address)}" class="btn sec">details →</a>
        <form method="post" action="/wallets/remove" style="display:inline" onsubmit="return confirm('Stop tracking ${esc(w.label)}?')">
          <input type="hidden" name="address" value="${esc(w.address)}">
          <button class="btn danger" type="submit">remove</button>
        </form>
      </div>
    </div>`;
  }).join('');
  const empty = wallets.length === 0
    ? `<div class="meta" style="margin-bottom:10px">No wallets tracked. Add one below to see balances and pin strategies.</div>`
    : '';
  return `<div class="panel">
    <div class="top"><h2 style="margin:0">Portfolio — ${wallets.length} wallet${wallets.length === 1 ? '' : 's'} · ${esc(fmtUsd(total))}</h2></div>
    ${empty}
    <div class="wallets">${cards}</div>
    <form class="add-wallet" method="post" action="/wallets/add">
      <label style="flex:1;display:flex;flex-direction:column;gap:3px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)">Address
        <input type="text" name="address" placeholder="0x…" pattern="0x[a-fA-F0-9]{40}" required></label>
      <label style="width:180px;display:flex;flex-direction:column;gap:3px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)">Label
        <input type="text" name="label" placeholder="main / cold / etc."></label>
      <button class="btn" type="submit">add wallet</button>
    </form>
  </div>`;
}

// ---- Strategies table -----------------------------------------------------

function strategiesTable(strategies, allStrategies, walletCount, filters, cats, chains, fiats, favoriteFps = new Set(), realMap = new Map()) {
  const { fCat, fChain, fMaxRisk, fMaxCap, fMinRet, fSort, fView, fStable, fFiat } = filters;
  const opt = (val, cur, label) => `<option value="${esc(val)}"${val === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const filterBar = `<form method="get" class="filters">
    <label>View
      <select name="view">${opt('', fView, 'all (' + allStrategies.length + ')')}${opt('top', fView, 'top picks only (★)')}${opt('pool', fView, 'pool only (rest)')}</select></label>
    <label>Stablecoins
      <select name="stable">${opt('', fStable, 'all assets')}${opt('yes', fStable, 'stable only')}</select></label>
    <label>Fiat peg
      <select name="fiat">${opt('', fFiat, 'any')}${fiats.map((c) => opt(c, fFiat, c)).join('')}</select></label>
    <label>Category
      <select name="cat">${opt('', fCat, 'all')}${cats.map((c) => opt(c, fCat, c)).join('')}</select></label>
    <label>Chain
      <select name="chain">${opt('', fChain, 'all')}${chains.map((c) => opt(c, fChain, c)).join('')}</select></label>
    <label>Max risk
      <select name="maxRisk">${opt('', String(fMaxRisk || ''), 'any')}${[3,5,7].map((n) => opt(String(n), String(fMaxRisk || ''), '≤ ' + n)).join('')}</select></label>
    <label>Capital fits
      <select name="maxCap">${opt('', String(fMaxCap || ''), 'any')}${[200,1000,5000,10000].map((n) => opt(String(n), String(fMaxCap || ''), '≤ $' + n)).join('')}</select></label>
    <label>Min return %
      <select name="minRet">${opt('', String(fMinRet || ''), 'any')}${[5,10,20,50,100].map((n) => opt(String(n), String(fMinRet || ''), '≥ ' + n + '%')).join('')}</select></label>
    <label>Sort
      <select name="sort">${['rank','score','return','risk'].map((s) => opt(s, fSort, s)).join('')}</select></label>
    <button type="submit">apply</button>
    <a href="/all" class="clear">clear</a>
  </form>`;
  const activeFilter = (fCat || fChain || fMaxRisk || fMaxCap || fMinRet || fSort !== 'rank' || fView || fStable || fFiat);

  const headerRow = `<tr><th>#</th><th>Cat</th><th>Chain</th><th>Action</th><th>Return</th><th>Risk</th><th>TVL</th><th>Min</th><th>Score</th><th>Open</th><th></th></tr>`;
  const renderRow = (s) => {
    const riskN = parseInt(s.risk) || 0;
    const riskCls = riskN <= 3 ? 'ok' : riskN <= 6 ? 'warn' : 'bad';
    const pinCell = walletCount > 0
      ? `<a href="/pin?fp=${encodeURIComponent(s._fp)}" class="pin-link" title="Pin to wallet">📌</a>`
      : `<span class="pin-link" title="Add a wallet first" style="cursor:default">📌</span>`;
    const isFav = favoriteFps.has(s._sfp);
    const favCell = `<form method="post" action="/favorites/${isFav ? 'remove' : 'add'}" style="display:inline"><input type="hidden" name="fp" value="${esc(s._sfp)}"><button class="fav-btn${isFav ? ' on' : ''}" type="submit" title="${isFav ? 'Unfavorite' : 'Add to favorites'}">★</button></form>`;
    const star = s._topPick ? ' <span title="curated top pick" style="color:var(--warn)">★</span>' : '';
    return `<tr id="r-${esc(s._sfp)}"${s._topPick ? ' style="background:rgba(78,161,255,.04)"' : ''}>
      <td class="r">${esc(s.rank)}${star}</td>
      <td><span class="cat">${esc(s.category)}</span></td>
      <td><span class="chain">${esc(s._chain || '—')}</span></td>
      <td class="act">${esc(s.action)}${decayTag(s)}${realizationTag(s)}</td>
      <td class="r ret">${esc(s.expectedReturn || '')}</td>
      <td class="r"><span class="pill ${riskCls}">${esc(s.risk || '')}</span></td>
      <td class="r">${esc(s.tvl || '')}</td>
      <td class="r">${s.minCapitalUsd ? '$' + esc(s.minCapitalUsd) : '—'}</td>
      <td class="r dim">${s.profitScore != null ? esc(Number(s.profitScore).toFixed(0)) : ''}</td>
      <td class="r open-cell">${renderOpenLinks(s)}</td>
      <td class="r">${favCell}${pinCell}</td>
    </tr>`;
  };

  const bySection = new Map();
  for (const s of strategies) { const sec = s._section || 'other'; if (!bySection.has(sec)) bySection.set(sec, []); bySection.get(sec).push(s); }
  const fiatMeta = { USD: '🇺🇸 USD', EUR: '🇪🇺 EUR', CHF: '🇨🇭 CHF', GBP: '🇬🇧 GBP', CAD: '🇨🇦 CAD', FX: '🌐 FX', MIXED: '🌐 Cross-fiat' };
  const fiatOrder = ['USD', 'EUR', 'CHF', 'GBP', 'CAD', 'FX', 'MIXED'];

  const sectionHtml = SECTIONS.map((sec) => {
    const items = bySection.get(sec.id) || [];
    if (!items.length) return '';
    const best = Math.max(0, ...items.map((s) => returnMagnitude(s.expectedReturn)));
    let body;
    if (sec.fiatGroups) {
      const groups = new Map();
      for (const s of items) { const fp = s._fiatPeg || 'USD'; if (!groups.has(fp)) groups.set(fp, []); groups.get(fp).push(s); }
      const keys = [...fiatOrder.filter((f) => groups.has(f)), ...[...groups.keys()].filter((f) => !fiatOrder.includes(f))];
      body = keys.map((f) => `<tr class="subhead"><td colspan="11">${esc(fiatMeta[f] || f)} · ${groups.get(f).length}</td></tr>${groups.get(f).map(renderRow).join('')}`).join('');
    } else {
      body = items.map(renderRow).join('');
    }
    return `<div class="panel" id="sec-${sec.id}">
      <h2 style="margin:0 0 2px">${sec.emoji} ${esc(sec.label)} <span class="dim">· ${items.length}</span></h2>
      <div class="meta" style="margin:2px 0 10px">${esc(sec.blurb)}${best > 0 ? ` · best ~${best.toFixed(0)}%` : ''}</div>
      <table>${headerRow}${body}</table>
    </div>`;
  }).join('');

  const tabs = SECTIONS.filter((sec) => (bySection.get(sec.id) || []).length)
    .map((sec) => `<a class="sectab" href="#sec-${sec.id}">${sec.emoji} ${esc(sec.label)} <span class="dim">${(bySection.get(sec.id) || []).length}</span></a>`).join('');

  return `<div class="panel">
    <h2>Opportunities by intent — ${strategies.length}${activeFilter ? ' of ' + allStrategies.length + ' (filtered)' : ''} shown
      <span class="meta" style="font-weight:400;text-transform:none;letter-spacing:0">· ${allStrategies.filter((s) => s._topPick).length} curated picks (★) + full pool, grouped by what you'd do with capital</span></h2>
    ${filterBar}
    <div class="sectabs">${tabs || '<span class="meta">no opportunities match the current filters</span>'}</div>
  </div>
  ${sectionHtml}`;

}

// Render up to ~2 click-through links per strategy. Returns "—" if we have no
// template for the protocol — by design (Direct protocol UI only mode).
//   primary chips (deposit:* — from the on-chain pool resolver) use a green
//     outline and a different glyph; one click → exact pool's deposit form.
//   secondary chips (everything else) use the muted style; one click → the
//     protocol's app, user still has to find the pool.
function renderOpenLinks(s) {
  const links = buildLinks(s);
  if (!links.length) return '<span class="dim">—</span>';
  return links.map((l) => {
    const cls = l.primary ? 'open-link primary' : 'open-link';
    const glyph = l.primary ? '⚡' : '↗';
    const text = String(l.label).replace(/^(?:deposit|open|buy|sell|borrow|stake):\s*/, '').replace(/^open\s+/i, '');
    return `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" class="${cls}" title="${esc(l.label)}">${esc(glyph + ' ' + text)}</a>`;
  }).join(' ');
}

// ---- Today page (/) ---------------------------------------------------------------------------
// The decision page for a once-a-day visit: trust strip → entry windows (asymmetric headline,
// per recorded preference) → 24h diff → exit radar → retention-gated board → collapsed safe
// anchor. The full sortable table lives on /all; every row here deep-links into it (#r-<sfp>).

async function renderToday(d, msg) {
  const all = d.strategies || [];
  const realMap = realizationMap();
  const crowded = crowdedSet();
  const diff = diff24();
  const stale = staleModules();
  snapshotFavorites(all, d.report?.timestamp);
  const favs = listFavorites();
  const favFps = favoriteFpSet();
  const wallets = listWallets();
  const portfolios = await Promise.all(wallets.map((w) => fetchPortfolio(w.address).catch(() => ({ totalUsd: 0 }))));
  const portTotal = portfolios.reduce((n, p) => n + (p.totalUsd || 0), 0);

  const realOf = (s) => realMap.get(s._sfp);
  const matched = all.filter((s) => realMap.has(s._sfp)).length;
  const poolTraps = all.filter((s) => isTrap(realOf(s)));
  const poolSurvivors = all.filter((s) => isSurvivor(realOf(s)));
  const focusLink = (sfp) => `<a href="/all#r-${encodeURIComponent(sfp)}" class="dim" title="open in full table">⤷</a>`;
  const favForm = (sfp) => {
    const on = favFps.has(sfp);
    return `<form method="post" action="/favorites/${on ? 'remove' : 'add'}" style="display:inline"><input type="hidden" name="fp" value="${esc(sfp)}"><button class="fav-btn${on ? ' on' : ''}" type="submit">★</button></form>`;
  };

  // --- 1. Entry windows: fresh Merkl incentives -------------------------------------------------
  const inc = readJSON(`${RESEARCH_DIR}/incentives.json`) || {};
  const freshAll = Array.isArray(inc.fresh_high_apr) ? inc.fresh_high_apr : [];
  const passes = (c) => (+c.apr || 0) >= 20 && (+c.dailyRewards || 0) >= 50 && (+c.tvl || 0) >= 10000 && (+c.ageHoursSinceFirstSeen || 0) <= 72;
  const freshQual = freshAll.filter(passes)
    .sort((a, b) => (+a.ageHoursSinceFirstSeen || 0) - (+b.ageHoursSinceFirstSeen || 0)).slice(0, 6);
  const failedFloor = (c) => (+c.dailyRewards || 0) < 50 ? `$${(+c.dailyRewards || 0).toFixed(2)}/day < $50 floor`
    : (+c.tvl || 0) < 10000 ? `TVL $${Math.round(+c.tvl || 0)} < $10k floor`
    : (+c.apr || 0) < 20 ? `APR ${(+c.apr || 0).toFixed(1)}% < 20% floor` : `${Math.round(+c.ageHoursSinceFirstSeen || 0)}h > 72h window`;
  const nearMisses = freshAll.filter((c) => !passes(c))
    .sort((a, b) => (+b.dailyRewards || 0) - (+a.dailyRewards || 0)).slice(0, 3);
  const freshHtml = freshQual.length
    ? `<table><tr><th>Age</th><th>Campaign</th><th>APR</th><th>$/day</th><th>TVL</th><th>Open</th></tr>` + freshQual.map((c) =>
        `<tr><td class="r"><b style="color:${(+c.ageHoursSinceFirstSeen || 0) < 24 ? 'var(--bad)' : 'var(--warn)'}">${Math.round(+c.ageHoursSinceFirstSeen || 0)}h</b><span class="dim">/72h</span></td>
        <td>${esc(c.name)} <span class="chain">${esc(c.protocol)}/${esc(c.chain)}</span></td>
        <td class="r ret">${(+c.apr || 0).toFixed(1)}%</td><td class="r">$${Math.round(+c.dailyRewards || 0)}</td><td class="r">${fmtUsd(+c.tvl || 0)}</td>
        <td>${c.depositUrl ? `<a href="${esc(c.depositUrl)}" target="_blank" rel="noopener" class="open-link primary">⚡ deposit</a>` : '—'}</td></tr>`).join('') + `</table>`
    : `<div class="meta">No fresh incentive window above floors right now (${freshAll.length} candidates, all below). Floors: APR ≥20%, ≥$50/day rewards, TVL ≥$10k, age ≤72h — being early is the edge, but dust pays nothing.</div>`
      + (nearMisses.length ? `<div style="opacity:.55;margin-top:6px">${nearMisses.map((c) => `<div class="ticker">${esc(c.name)} [${esc(c.protocol)}/${esc(c.chain)}] ${(+c.apr || 0).toFixed(0)}% APR — <span class="dim">${esc(failedFloor(c))}</span></div>`).join('')}</div>` : '');

  // --- 2. Entry windows: alpha plays -------------------------------------------------------------
  const alphaData = readJSON(`${RESEARCH_DIR}/alpha.json`) || {};
  const TYPE_ORDER = { FRESH_INCENTIVE: 0, RESURRECTED_EXTREME: 1, PENDLE_BASIS: 2, SYNTHETIC_SHORT: 3, COMPOSABLE_STACK: 4 };
  const alphaEligible = (alphaData.all_alpha || [])
    .filter((a) => { const r = realMap.get(stableFpJs(a.category, a.action)); return !isTrap(r) || a.alphaType === 'RESURRECTED_EXTREME'; });
  // Blue-chip preference (2026-06-11): non-major pairs never headline — auditable on /all only.
  const alphaHiddenN = alphaEligible.filter((a) => a.nonMajorToken).length;
  const alphaRows = alphaEligible.filter((a) => !a.nonMajorToken)
    .sort((a, b) => (TYPE_ORDER[a.alphaType] ?? 9) - (TYPE_ORDER[b.alphaType] ?? 9) || (b.profitScore || 0) - (a.profitScore || 0))
    .slice(0, 8);
  const alphaHtml = alphaRows.length ? alphaRows.map((a) => {
    const sfp = stableFpJs(a.category, a.action);
    const r = realMap.get(sfp);
    const evidence = r ? `seen ${Math.round(r.days)}d · ${r.sight}× · ret ${r.ret ?? '—'}` : 'no history';
    const trapBadge = isTrap(r) ? ` <span class="pill bad" title="prior TVL flight — that IS the resurrection thesis, size accordingly">prior trap ${Math.round(r.tvl)}%</span>` : '';
    const open = a.depositUrl ? `<a href="${esc(a.depositUrl)}" target="_blank" rel="noopener" class="open-link primary">⚡ deposit</a>` : safeLinks(a);
    return `<div class="card"><div class="chead">
      <span><span class="cat">${esc(a.alphaType || 'ALPHA')}</span> ${esc(a.action)}${trapBadge}</span>
      <span class="r"><span class="ret">${esc(a.expectedReturn || '')}</span> · risk ${esc(a.risk || '?')} ${open} ${favForm(sfp)} ${focusLink(sfp)}</span></div>
      <div class="creason">${esc(a.alphaReason || '')} <span style="font-style:normal" class="dim">· ${evidence}</span></div></div>`;
  }).join('') : '<div class="meta">no alpha plays surfaced this scan</div>';
  const alphaHtmlFull = alphaHtml + (alphaHiddenN ? `<div class="meta" style="margin-top:6px">${alphaHiddenN} non-major-pair play${alphaHiddenN === 1 ? '' : 's'} hidden (blue-chip preference) — visible on <a href="/all">/all</a></div>` : '');

  // --- 3. Changed in 24h -------------------------------------------------------------------------
  let changedHtml, changedCounts = { born: 0, gone: 0, moved: 0 };
  if (!diff.ok) {
    changedHtml = '<div class="meta">24h diff unavailable (Postgres offline or <24h of history)</div>';
  } else {
    const bornAllN = [...diff.now.keys()].filter((k) => !diff.past.has(k)).length;
    const goneAllN = [...diff.past.keys()].filter((k) => !diff.now.has(k)).length;
    if (bornAllN + goneAllN > 0.75 * Math.max(diff.now.size, diff.past.size) * 2) {
      changedHtml = `<div class="err">identity-churn anomaly: ${bornAllN} born + ${goneAllN} gone vs pool ${diff.now.size} — diff unreliable (likely an action-string/fingerprint change in the scanner, not the market)</div>`;
    } else {
      const scores = [...diff.now.values()].map((x) => x.score || 0).sort((a, b) => a - b);
      const p75 = scores[Math.floor(scores.length * 0.75)] || 0;
      const born = [...diff.now.values()].filter((x) => !diff.past.has(x.sfp))
        .filter((x) => DURABLE_CATS.has(x.category) || (x.score || 0) >= p75)
        .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);
      const gone = [...diff.past.values()].filter((x) => !diff.now.has(x.sfp))
        .filter((x) => favFps.has(x.sfp) || (realMap.get(x.sfp) || {}).days >= 7)
        .sort((a, b) => ((realMap.get(b.sfp) || {}).days || 0) - ((realMap.get(a.sfp) || {}).days || 0)).slice(0, 8);
      const movers = [...diff.now.values()].filter((x) => diff.past.has(x.sfp))
        .map((x) => ({ x, p: diff.past.get(x.sfp) }))
        .filter(({ x, p }) => Math.abs((x.score || 0) - (p.score || 0)) >= 15 || (p.ret && x.ret != null && p.ret !== 0 && (x.ret / p.ret <= 0.75 || x.ret / p.ret >= 1.33)))
        .sort((a, b) => Math.abs((b.x.score || 0) - (b.p.score || 0)) - Math.abs((a.x.score || 0) - (a.p.score || 0))).slice(0, 8);
      changedCounts = { born: born.length, gone: gone.length, moved: movers.length };
      changedHtml = (born.length || gone.length || movers.length)
        ? born.map((x) => `<div class="evt born">+ <span class="cat">${esc(x.category)}</span> ${esc(x.action)} <span class="delta">score ${Math.round(x.score || 0)}</span> ${focusLink(x.sfp)}</div>`).join('')
          + movers.map(({ x, p }) => `<div class="evt move">± <span class="cat">${esc(x.category)}</span> ${esc(x.action)} <span class="delta">score ${Math.round(p.score || 0)}→${Math.round(x.score || 0)}${p.ret != null && x.ret != null ? ` · ret ${p.ret}→${x.ret}` : ''}</span> ${focusLink(x.sfp)}</div>`).join('')
          + gone.map((x) => `<div class="evt gone">− <span class="cat">${esc(x.category)}</span> ${esc(x.action)} <span class="delta">gone${(realMap.get(x.sfp) || {}).days ? ` after ${Math.round(realMap.get(x.sfp).days)}d` : ''}</span></div>`).join('')
        : '<div class="meta">nothing notable changed in the last 24h (filtered: durable categories or ≥p75 score; deaths only if watched/≥7d)</div>';
      changedHtml = `<div class="meta" style="margin-bottom:8px">vs ${esc(diff.basis)} UTC · raw churn ${bornAllN} born / ${goneAllN} gone (mostly sub-2-day categories, filtered out)</div>` + changedHtml;
    }
  }

  // --- 4. Exit radar -----------------------------------------------------------------------------
  const radar = [];
  for (const f of favs) {
    const r = realMap.get(f.fingerprint);
    const last2 = f.history.slice(-2);
    const offScan = last2.length === 2 && last2.every((h) => !h.present);
    const flags = [];
    if (r && isTrap(r)) flags.push(['bad', `TVL ${Math.round(r.tvl)}%`]);
    if (r && r.ret != null && r.ret < 0.70) flags.push(['bad', `retention ${r.ret}`]);
    if (offScan) flags.push(['bad', 'off scan 2+ cycles']);
    if (!flags.length && r && r.ret != null && r.ret < 0.85) flags.push(['warn', `retention ${r.ret}`]);
    if (flags.length) radar.push({ f, r, flags });
  }
  const radarHtml = (radar.length
    ? radar.map(({ f, flags }) => `<div class="evt trapd">${esc((f.initialSnapshot || {}).action || f.fingerprint)} — ${flags.map(([k, t]) => `<span class="pill ${k}">${esc(t)}</span>`).join(' ')} <a href="/favorites">→ favorites</a></div>`).join('')
    : `<div class="meta">✓ ${favs.length} favorite${favs.length === 1 ? '' : 's'} healthy · ${wallets.length} wallet${wallets.length === 1 ? '' : 's'} tracked</div>`)
    + (poolTraps.length ? `<details class="fold"><summary>⚠ ${poolTraps.length} trap${poolTraps.length === 1 ? '' : 's'} currently in the live pool (yield held, TVL fled ≤−50%) — excluded from all boards</summary>
      <table style="margin-top:6px"><tr><th>Cat</th><th>Action</th><th>TVL Δ</th><th>Seen</th><th></th></tr>${poolTraps.map((s) => { const r = realOf(s); return `<tr><td><span class="cat">${esc(s.category)}</span></td><td class="act">${esc(s.action)}</td><td class="r" style="color:var(--bad)">${Math.round(r.tvl)}%</td><td class="r dim">${Math.round(r.days)}d</td><td>${focusLink(s._sfp)}</td></tr>`; }).join('')}</table></details>` : '');

  // --- 5. Convex board (retention-gated picks) ---------------------------------------------------
  const board = all.filter((s) => DURABLE_CATS.has(s.category))
    .filter((s) => returnMagnitude(s.expectedReturn) >= 15)
    .filter((s) => {
      // Blue-chip preference (2026-06-11): micro-cap/meme legs never make the board.
      if (s.nonMajorToken || s.riskyLp || s.microPool) return false;
      const r = realOf(s);
      if (isTrap(r)) return false;
      const isNew = !r || r.days < 2;
      const dc = decayInfo(s);
      if (!isNew && dc && dc.flag === 'HIGH' && (dc.pctFell10 || 0) >= 50) return false;
      if (!isNew && r && r.ret != null && r.ret < 0.6) return false;
      return true;
    })
    .map((s) => { const r = realOf(s); const proven = r && r.days >= 2 && r.ret != null; return { s, r, adj: (s.profitScore || 0) * Math.min(1, proven ? r.ret : 1) }; })
    .sort((a, b) => b.adj - a.adj).slice(0, 12);
  const boardHtml = board.length ? `<table><tr><th>#</th><th>Cat</th><th>Play</th><th>Return</th><th>Risk</th><th>TVL</th><th>Evidence</th><th>Adj score</th><th>Open</th><th></th></tr>`
    + board.map(({ s, r, adj }, i) => {
      const riskN = parseInt(s.risk) || 0;
      const isNew = !r || r.days < 2;
      const badges = (isNew ? ' <span class="badge-new">NEW</span>' : '') + (crowded.has(s._sfp) ? ' <span class="badge-crowd" title="held a top-3 slot in >40% of the last 72h of scans — time-at-#1 ≠ durability (the gmtrade lesson)">CROWDED</span>' : '');
      return `<tr><td class="r dim">${i + 1}</td><td><span class="cat">${esc(s.category)}</span></td>
        <td class="act">${esc(s.action)}${badges}${decayTag(s)}</td>
        <td class="r ret">${esc(s.expectedReturn || '')}</td>
        <td class="r"><span class="pill ${riskN <= 3 ? 'ok' : riskN <= 6 ? 'warn' : 'bad'}">${esc(s.risk || '')}</span></td>
        <td class="r">${esc(s.tvl || '')}${r && r.tvl != null ? ` <span class="dim" style="color:${r.tvl < 0 ? 'var(--warn)' : 'var(--ok)'}">${r.tvl > 0 ? '+' : ''}${Math.round(r.tvl)}%</span>` : ''}</td>
        <td class="r dim">${isNew ? '—' : `${Math.round(r.days)}d · ${r.sight}× · ret ${r.ret ?? '—'}`}</td>
        <td class="r dim">${Math.round(adj)}</td>
        <td class="open-cell">${safeLinks(s)}</td>
        <td>${favForm(s._sfp)} ${focusLink(s._sfp)}</td></tr>`;
    }).join('') + `</table>` : '<div class="meta">nothing clears the convex gates this scan (return ≥15%, durable category, not trap/decay-HIGH, retention ≥0.6 or new)</div>';

  // --- 6. Fast lane (ephemeral dislocations: act this session or ignore) -------------------------
  const navData = readJSON(`${RESEARCH_DIR}/nav.json`) || {};
  const fdData = readJSON(`${RESEARCH_DIR}/funding-dispersion.json`) || {};
  const navLines = (Array.isArray(navData.actionable) ? navData.actionable : [])
    .filter((a) => Math.abs(+a.bps || +a.premium_bps || 0) >= 30).slice(0, 4)
    .map((a) => `<div class="ticker">NAV ${esc(a.sym || a.asset || '?')} ${esc(String(a.bps ?? a.premium_bps ?? ''))} bps — ${esc(a.action || a.note || 'NAV dislocation')}</div>`);
  const fdLines = (Array.isArray(fdData.real_edge) ? fdData.real_edge : [])
    .filter((e) => !e.baselineArtifact).slice(0, 4)
    .map((e) => `<div class="ticker">FUNDING ${esc(e.coin)} dispersion ${esc(String(e.dispersionPct))}% — ${esc(e.harvest || '')}</div>`);
  const carryLines = all.filter((s) => s.category === 'CARRY' && returnMagnitude(s.expectedReturn) >= 8)
    .sort((a, b) => returnMagnitude(b.expectedReturn) - returnMagnitude(a.expectedReturn)).slice(0, 4)
    .map((s) => `<div class="ticker">CARRY ${esc(s.action)} <span class="ret">${esc(s.expectedReturn || '')}</span> ${focusLink(s._sfp)}</div>`);
  const fastLines = [...navLines, ...fdLines, ...carryLines].slice(0, 8);

  // --- 7. Safe anchor (collapsed) ----------------------------------------------------------------
  const anchors = poolSurvivors.filter((s) => (parseInt(s.risk) || 0) <= 5)
    .map((s) => { const r = realOf(s); return { s, r, adjRet: returnMagnitude(s.expectedReturn) * (r.ret ?? 1) }; })
    .sort((a, b) => b.adjRet - a.adjRet);
  const anchorBest = anchors.length ? anchors[0].adjRet : 0;
  const anchorHtml = anchors.length ? `<details class="fold"><summary>${anchors.length} proven survivors live (≥7d observed, retention ≥0.85, TVL ≥−10%, risk ≤5) — best ~${anchorBest.toFixed(1)}% retention-adjusted. The boring-money parking list, deliberately not the headline.</summary>
    <table style="margin-top:8px"><tr><th>Play</th><th>Return</th><th>Held</th><th>Retention</th><th>TVL Δ</th><th>Open</th><th></th></tr>
    ${anchors.slice(0, 8).map(({ s, r }) => `<tr><td class="act"><span class="cat">${esc(s.category)}</span> ${esc(s.action)}</td>
      <td class="r ret">${esc(s.expectedReturn || '')}</td><td class="r dim">${Math.round(r.days)}d</td><td class="r">${r.ret}</td>
      <td class="r" style="color:${r.tvl < 0 ? 'var(--warn)' : 'var(--ok)'}">${r.tvl > 0 ? '+' : ''}${Math.round(r.tvl ?? 0)}%</td>
      <td class="open-cell">${safeLinks(s)}</td><td>${favForm(s._sfp)} ${focusLink(s._sfp)}</td></tr>`).join('')}
    </table>${anchors.length > 8 ? `<div class="meta" style="margin-top:6px"><a href="/all">all ${anchors.length} on the full table →</a></div>` : ''}</details>`
    : '<div class="meta">no survivors meet the anchor bar in the live pool right now</div>';

  // --- status strip ------------------------------------------------------------------------------
  const scanOk = d.scanAgeMs >= 0 && d.scanAgeMs < 15 * 60 * 1000;
  let decayAge = null; try { decayAge = Date.now() - statSync(`${RESEARCH_DIR}/decay-model.json`).mtimeMs; } catch { }
  const strip = `<div class="strip">
    <span class="${scanOk ? '' : 'red'}">scan <span class="sv">${ago(d.scanAgeMs)}</span></span>
    <span class="${all.length < 100 ? 'red' : ''}">pool <span class="sv">${all.length}</span></span>
    <span class="${matched < all.length * 0.6 ? 'red' : ''}" title="live pool rows matched to realization history">history <span class="sv">${matched}/${all.length}</span></span>
    <span class="${decayAge == null || decayAge > 30 * 60 * 1000 ? 'red' : ''}">decay <span class="sv">${decayAge == null ? 'MISSING' : ago(decayAge)}</span></span>
    ${stale.length ? `<span class="red" title="data files >30 min old">stale: ${esc(stale.join(', '))}</span>` : '<span class="grn">modules ✓</span>'}
    <a href="#sec-windows"><span class="${freshQual.length ? 'grn' : ''}">windows <span class="sv">${freshQual.length} fresh · ${alphaRows.length} alpha</span></span></a>
    <a href="#sec-changed">Δ24h <span class="sv">+${changedCounts.born} / ±${changedCounts.moved} / −${changedCounts.gone}</span></a>
    <a href="#sec-radar"><span class="${poolTraps.length ? '' : 'grn'}">traps <span class="sv">${poolTraps.length}</span></span></a>
    <a href="#sec-anchor">survivors <span class="sv">${anchors.length}</span></a>
    <span class="nav-spacer"></span>
    <a href="/portfolio">portfolio <span class="sv">${fmtUsd(portTotal)}</span></a>
  </div>`;

  return page('defi-tracker · today', `
  ${headerNav('home', walletStat(wallets, portfolios))}
  ${msg ? `<div class="${msg.kind === 'err' ? 'err' : 'ok-msg'}">${esc(msg.text)}</div>` : ''}
  ${strip}
  ${!scanOk ? '<div class="err">SCAN STALE — everything below reflects old data. Check defi-tracker.timer / journalctl on the box.</div>' : ''}
  <div class="panel" id="sec-windows">
    <h2>⚡ Entry windows — fresh incentives <span class="dim">(day-1 dilution is the edge; youngest first)</span></h2>
    ${freshHtml}
    <h2 style="margin-top:16px">🎯 Alpha plays</h2>
    ${alphaHtmlFull}
  </div>
  <div class="panel" id="sec-changed">
    <h2>Δ Changed in 24h</h2>
    ${changedHtml}
  </div>
  <div class="panel" id="sec-radar">
    <h2>🚪 Exit radar <span class="dim">(silence = health)</span></h2>
    ${radarHtml}
  </div>
  <div class="panel" id="sec-board">
    <h2>📈 Convex board <span class="dim">(return ≥15%, durable categories, traps/decay-HIGH excluded, score × retention)</span></h2>
    ${boardHtml}
  </div>
  ${fastLines.length ? `<div class="panel" id="sec-fast">
    <h2>⏱ Fast lane <span class="dim">(median lifespan &lt;2d — act this session or ignore)</span></h2>
    ${fastLines.join('')}
  </div>` : ''}
  <div class="panel" id="sec-anchor">
    <h2>🛡 Safe anchor</h2>
    ${anchorHtml}
  </div>
  <div class="panel meta">today view · auto-refresh 60s · <a href="/all">full table (${all.length})</a> · <a href="/research">research</a> · rendered ${new Date().toISOString().replace('T', ' ').replace(/\..+/, ' UTC')}</div>
  `);
}

// ---- Full table page (/all) -------------------------------------------------------------------

async function renderMain(d, f, msg) {
  const allStrategies = d.strategies || [];
  const summary = d.report.summary || {};
  const fresh = d.scanAgeMs >= 0 && d.scanAgeMs < 10 * 60 * 1000;

  // Filters
  const entriesWithChain = allStrategies.map((s) => ({ s, chain: s._chain }));
  const cats = [...new Set(allStrategies.map((s) => s.category))].sort();
  const fiats = [...new Set(allStrategies.map((s) => s._fiatPeg).filter(Boolean))].sort();
  const chainsByLc = new Map();
  for (const e of entriesWithChain) {
    if (!e.chain) continue;
    const lc = e.chain.toLowerCase();
    const cur = chainsByLc.get(lc);
    if (!cur || (e.chain !== lc && cur === lc)) chainsByLc.set(lc, e.chain);
  }
  const chains = [...chainsByLc.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const fCat = f.cat || '', fChain = f.chain || '';
  const fMaxRisk = f.maxRisk ? parseInt(f.maxRisk) : 0;
  const fMaxCap = f.maxCap ? parseInt(f.maxCap) : 0;
  const fMinRet = f.minRet ? parseFloat(f.minRet) : 0;
  const fSort = f.sort || 'rank';
  const fView = f.view || '';
  const fStable = f.stable || '';
  const fFiat = f.fiat || '';
  let strategies = entriesWithChain.filter(({ s, chain }) => {
    if (fView === 'top' && !s._topPick) return false;
    if (fView === 'pool' && s._topPick) return false;
    if (fStable === 'yes' && !s._isStable) return false;
    if (fFiat && (s._fiatPeg || '') !== fFiat) return false;
    if (fCat && s.category !== fCat) return false;
    if (fChain && chain.toLowerCase() !== fChain.toLowerCase()) return false;
    if (fMaxRisk && (parseInt(s.risk) || 0) > fMaxRisk) return false;
    if (fMaxCap && (s.minCapitalUsd || 0) > fMaxCap) return false;
    if (fMinRet && returnMagnitude(s.expectedReturn) < fMinRet) return false;
    return true;
  }).map((e) => e.s);
  if (fSort === 'score') strategies.sort((a, b) => (b.profitScore || 0) - (a.profitScore || 0));
  else if (fSort === 'risk') strategies.sort((a, b) => (parseInt(a.risk) || 0) - (parseInt(b.risk) || 0));
  else if (fSort === 'return') strategies.sort((a, b) => returnMagnitude(b.expectedReturn) - returnMagnitude(a.expectedReturn));

  // Wallets: just count + total (the full portfolio panel lives on /portfolio now).
  const wallets = listWallets();
  const portfolios = await Promise.all(wallets.map((w) => fetchPortfolio(w.address).catch((e) => ({ wallet: w.address, totalUsd: 0, chains: [], error: e.message }))));
  // Snapshot favorites against this scan. Idempotent within a single scan timestamp.
  snapshotFavorites(d.strategies, d.report?.timestamp);
  const favFps = favoriteFpSet();
  const summaryCells = Object.entries(summary)
    .map(([k, v]) => `<div class="stat"><div class="snum">${esc(v)}</div><div class="slbl">${esc(k.replace(/^total_/, ''))}</div></div>`)
    .join('');
  const r = d.report;

  return page('defi-tracker · all opportunities', `
  ${headerNav('all', walletStat(wallets, portfolios))}
  <div class="panel top">
    <div>
      <h1>STRATEGIES <span class="dim">${esc(r.version || '')}</span></h1>
      <div class="meta">capital model: $${esc(r.capitalUsd || '?')} · ${allStrategies.length} opportunities ranked · ${favFps.size} favorited</div>
    </div>
    <div style="text-align:right">
      ${pill(fresh ? 'scan fresh' : 'scan STALE', fresh ? 'ok' : 'bad')}
      <div class="meta">last scan ${ago(d.scanAgeMs)} · ${esc((r.timestamp || '').replace('T', ' ').replace(/\..+/, ' UTC'))}</div>
    </div>
  </div>
  ${msg ? `<div class="${msg.kind === 'err' ? 'err' : 'ok-msg'}">${esc(msg.text)}</div>` : ''}
  <div class="panel">
    <h2>Services</h2>
    ${pill('tracker.timer ' + d.svc.trackerTimer, d.svc.trackerTimer === 'active' ? 'ok' : 'bad')}
    ${pill('executor-dryrun ' + d.svc.executorTimer, d.svc.executorTimer === 'active' ? 'ok' : 'bad')}
    ${pill('dev-agent ' + d.svc.devAgentEnabled, d.svc.devAgentEnabled === 'enabled' ? 'ok' : 'dim')}
    <span class="meta"> &nbsp;dev-agent timer intentionally disabled (Claude-compute reduction)</span>
  </div>
  <div class="panel">
    <h2>Opportunity scan — counts by source</h2>
    <div class="grid">${summaryCells}</div>
  </div>
  ${strategiesTable(strategies, allStrategies, wallets.length, { fCat, fChain, fMaxRisk, fMaxCap, fMinRet, fSort, fView, fStable, fFiat }, cats, chains, fiats, favFps, realizationMap())}
  <div class="panel meta">full table · auto-refresh 60s · <a href="/">back to Today</a> · rendered ${new Date().toISOString().replace('T', ' ').replace(/\..+/, ' UTC')}</div>
  `);
}

// ---- Portfolio overview page ----------------------------------------------

async function renderPortfolio(msg) {
  const wallets = listWallets();
  const portfolios = await Promise.all(wallets.map((w) => fetchPortfolio(w.address).catch((e) => ({ wallet: w.address, totalUsd: 0, chains: [], error: e.message }))));
  const allPins = listPins();
  const pinsByWallet = new Map();
  for (const p of allPins) {
    const lc = p.walletAddress.toLowerCase();
    if (!pinsByWallet.has(lc)) pinsByWallet.set(lc, []);
    pinsByWallet.get(lc).push(p);
  }
  const total = portfolios.reduce((s, p) => s + (p?.totalUsd || 0), 0);
  const pinTotals = `<div class="meta" style="margin-bottom:10px">${allPins.length} pinned strategies across ${pinsByWallet.size} wallet${pinsByWallet.size === 1 ? '' : 's'} · ${allPins.filter((p) => p.status === 'active').length} active · ${allPins.filter((p) => p.status === 'planned').length} planned · ${allPins.filter((p) => p.status === 'closed').length} closed</div>`;
  return page('Portfolio', `
    ${headerNav('portfolio')}
    <div class="panel top">
      <div>
        <h1>PORTFOLIO</h1>
        <div class="meta">${wallets.length} wallet${wallets.length === 1 ? '' : 's'} · ${esc(fmtUsd(total))} total</div>
      </div>
    </div>
    ${msg ? `<div class="${msg.kind === 'err' ? 'err' : 'ok-msg'}">${esc(msg.text)}</div>` : ''}
    ${wallets.length ? pinTotals : ''}
    ${portfolioPanel(wallets, portfolios)}
  `);
}

// ---- Favorites page -------------------------------------------------------

async function renderFavorites(d, msg) {
  // Snapshot before render so the page always shows up-to-date data.
  snapshotFavorites(d.strategies, d.report?.timestamp);
  const favorites = listFavorites();
  const byFp = new Map(d.strategies.map((s) => [s._sfp, s]));

  const rows = favorites.map((fav) => {
    const cur = byFp.get(fav.fingerprint);
    const histScores = fav.history.map((h) => h.profitScore);
    const initReturn = fav.initialSnapshot.returnPct;
    const curReturn = cur ? returnPct(cur.expectedReturn) : (fav.history.length ? fav.history[fav.history.length - 1].returnPct : null);
    const delta = (initReturn != null && curReturn != null) ? curReturn - initReturn : null;
    const deltaCls = delta == null ? 'dim' : delta >= 0 ? 'ok' : 'bad';
    const ageDays = Math.max(0, Math.floor((Date.now() - new Date(fav.addedAt).getTime()) / 86400000));
    return `<tr>
      <td><span class="cat">${esc(fav.initialSnapshot.category)}</span></td>
      <td><span class="chain">${esc(fav.initialSnapshot.chain || '—')}</span></td>
      <td class="act" style="max-width:420px">${esc((cur || fav.initialSnapshot).action)}</td>
      <td class="r">
        <div class="meta">initial</div><div>${esc(fav.initialSnapshot.expectedReturn || '—')}</div>
        <div class="meta" style="margin-top:4px">current</div><div class="${cur ? 'ret' : 'dim'}">${esc(cur ? cur.expectedReturn : 'off scan')}</div>
        ${delta != null ? `<div class="meta" style="margin-top:4px">Δ <span class="pill ${deltaCls}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts</span></div>` : ''}
      </td>
      <td class="spark-cell">${sparkline(histScores)}<div class="meta">profit-score over time</div></td>
      <td class="r dim">
        <div>${fav.history.length} snaps</div>
        <div class="meta">${ageDays}d tracked</div>
        <div class="meta">added ${esc(fav.addedAt.slice(0, 10))}</div>
      </td>
      <td>${cur ? pill('in scan', 'ok') : pill('off scan', 'warn')}</td>
      <td class="r open-cell">${renderOpenLinks(cur || { ...fav.initialSnapshot, _chain: fav.initialSnapshot.chain })}</td>
      <td class="r">
        <form method="post" action="/favorites/remove" style="display:inline">
          <input type="hidden" name="fp" value="${esc(fav.fingerprint)}">
          <button class="ptiny">unfav</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return page('Favorites', `
    ${headerNav('favorites')}
    <div class="panel top">
      <div>
        <h1>FAVORITES</h1>
        <div class="meta">${favorites.length} tracked · snapshots taken every scan (5 min) · last scan ${ago(d.scanAgeMs)}</div>
      </div>
    </div>
    ${msg ? `<div class="${msg.kind === 'err' ? 'err' : 'ok-msg'}">${esc(msg.text)}</div>` : ''}
    <div class="panel">
      ${favorites.length === 0
        ? `<div class="meta">No favorites yet. Click ★ next to any strategy on the <a href="/">Strategies</a> page to start tracking it here.</div>`
        : `<table>
            <tr><th>Cat</th><th>Chain</th><th>Action</th><th>Return: initial → current</th><th>Score trajectory</th><th>Tracked</th><th>Status</th><th>Open</th><th></th></tr>
            ${rows}
          </table>
          <div class="meta" style="margin-top:10px">Sparklines show profit-score over time. Up to 1000 snapshots per favorite (~3.5 days at 5-min scan cadence). A "off scan" status means the strategy fell out of the scanner's report — it may have been filtered, removed, or its action wording changed.</div>`}
    </div>
  `);
}

// ---- Wallet detail page ---------------------------------------------------

async function renderWalletDetail(addr, allStrategies, msg) {
  const w = findWallet(addr);
  if (!w) return { code: 404, body: page('Wallet not found', `<div class="panel"><h2>Wallet not found</h2><a href="/" class="btn sec">← back</a></div>`) };
  const pf = await fetchPortfolio(w.address).catch((e) => ({ wallet: w.address, totalUsd: 0, chains: [], error: e.message }));
  const heldSymbols = symbolSet(pf);
  const pins = listPins(w.address);

  // Match held tokens against strategies — naive "wallet has source token" suggestion
  const suggested = allStrategies.filter((s) => {
    const action = String(s.action || '');
    // First token in actions: "Borrow XYZ from..." / "Deposit XYZ ..." / "Move XYZ from..." / "TIGHT RANGE pair: XYZ-USDC..."
    const m = action.match(/(?:^Borrow|^Deposit into [\w.-]+|^Move|RANGE.*?:)\s+([A-Za-z0-9.]+)/);
    const tok = m && m[1] && m[1].toUpperCase();
    return tok && heldSymbols.has(tok);
  }).slice(0, 10);

  const chainsHtml = (pf.chains || []).map((c) => {
    if (c.error) return `<div class="meta">${esc(c.label)}: ${esc(c.error)}</div>`;
    if (!c.balances.length) return '';
    const rows = c.balances.map((b) => `<tr>
      <td><strong>${esc(b.symbol)}</strong></td>
      <td class="r">${esc(fmtAmt(b.amount))}</td>
      <td class="r dim">${b.price ? '@ ' + esc(fmtUsd(b.price)) : ''}</td>
      <td class="r ret">${esc(fmtUsd(b.usd))}</td>
    </tr>`).join('');
    return `<div style="margin-bottom:12px">
      <h3>${esc(c.label)} <span class="dim" style="font-weight:400">· ${esc(fmtUsd(c.totalUsd))}</span></h3>
      <table class="holdings-table">${rows}</table>
    </div>`;
  }).join('');

  const pinsHtml = pins.length ? pins.map((p) => {
    const statusCls = p.status === 'active' ? 'ok' : p.status === 'closed' ? 'dim' : 'warn';
    const nextStatuses = { planned: 'active', active: 'closed', closed: 'planned' };
    return `<div class="pinrow">
      <span class="pstatus">${pill(p.status, statusCls)}</span>
      <strong>${esc(p.snapshot.category)}</strong>
      ${p.snapshot.chain ? '<span class="chain">' + esc(p.snapshot.chain) + '</span>' : ''}
      <span class="dim">— ${esc(p.snapshot.expectedReturn || '')} · risk ${esc(p.snapshot.risk || '?')}</span>
      <div class="dim" style="margin-top:4px">${esc(p.snapshot.action)}</div>
      <div style="margin-top:6px">
        <form method="post" action="/pins/update" style="display:inline">
          <input type="hidden" name="id" value="${esc(p.id)}">
          <input type="hidden" name="status" value="${esc(nextStatuses[p.status])}">
          <button class="ptiny" type="submit">→ ${esc(nextStatuses[p.status])}</button>
        </form>
        <form method="post" action="/pins/remove" style="display:inline">
          <input type="hidden" name="id" value="${esc(p.id)}">
          <button class="ptiny" type="submit">unpin</button>
        </form>
        <span class="open-cell" style="margin-left:8px">${renderOpenLinks(p.snapshot)}</span>
        <span class="meta" style="margin-left:8px">pinned ${esc(p.pinnedAt.slice(0, 10))}</span>
      </div>
    </div>`;
  }).join('') : '<div class="meta">No strategies pinned yet — click 📌 on any strategy row to pin it here.</div>';

  const suggestedHtml = suggested.length ? `
    <h2 style="margin-top:18px">Suggested for this wallet</h2>
    <table>
      <tr><th>#</th><th>Cat</th><th>Chain</th><th>Action</th><th>Return</th><th>Risk</th><th>Open</th><th></th></tr>
      ${suggested.map((s) => {
        const riskN = parseInt(s.risk) || 0;
        const riskCls = riskN <= 3 ? 'ok' : riskN <= 6 ? 'warn' : 'bad';
        return `<tr>
          <td class="r">${esc(s.rank)}</td>
          <td><span class="cat">${esc(s.category)}</span></td>
          <td><span class="chain">${esc(s._chain || '—')}</span></td>
          <td class="act">${esc(s.action)}</td>
          <td class="r ret">${esc(s.expectedReturn || '')}</td>
          <td class="r"><span class="pill ${riskCls}">${esc(s.risk || '')}</span></td>
          <td class="r open-cell">${renderOpenLinks(s)}</td>
          <td class="r"><a href="/pin?fp=${encodeURIComponent(s._fp)}&w=${encodeURIComponent(w.address)}" class="pin-link">📌</a></td>
        </tr>`;
      }).join('')}
    </table>` : '';

  return { code: 200, body: page('Wallet · ' + w.label, `
    ${headerNav('portfolio')}
    <div class="panel top">
      <div>
        <h1>${esc(w.label)} <span class="dim" style="font-weight:400">${esc(w.address)}</span></h1>
        <div class="meta">added ${esc(w.addedAt.slice(0, 10))} · portfolio fetched ${esc((pf.fetchedAt || '').slice(11, 19))} UTC</div>
      </div>
      <div style="text-align:right">
        <div class="wval" style="font-size:22px;font-weight:700;color:var(--acc)">${esc(fmtUsd(pf.totalUsd))}</div>
        <a href="/" class="btn sec" style="margin-top:4px">← all wallets</a>
      </div>
    </div>
    ${msg ? `<div class="${msg.kind === 'err' ? 'err' : 'ok-msg'}">${esc(msg.text)}</div>` : ''}
    <div class="panel">
      <h2>Holdings</h2>
      ${chainsHtml || '<div class="meta">No on-chain balances detected across tracked chains.</div>'}
    </div>
    <div class="panel">
      <h2>Pinned strategies (${pins.length})</h2>
      ${pinsHtml}
      ${suggestedHtml}
    </div>
  `) };
}

// ---- Pin confirmation page -----------------------------------------------

function renderPinConfirm(strategy, wallets, preselected) {
  if (!strategy) {
    return { code: 404, body: page('Strategy not found', `<div class="panel">
      <h2>Strategy not found in current scan</h2>
      <div class="meta">Fingerprints are scan-specific. The action text may have changed since you clicked. <a href="/">Back to dashboard</a>.</div>
    </div>`) };
  }
  if (wallets.length === 0) {
    return { code: 400, body: page('No wallets', `<div class="panel">
      <h2>Add a wallet first</h2><div class="meta">Pinning needs a tracked wallet. <a href="/">Back</a> and add one.</div>
    </div>`) };
  }
  const riskN = parseInt(strategy.risk) || 0;
  const riskCls = riskN <= 3 ? 'ok' : riskN <= 6 ? 'warn' : 'bad';
  const opts = wallets.map((w) => `<option value="${esc(w.address)}"${w.address === preselected ? ' selected' : ''}>${esc(w.label)} (${esc(shortAddr(w.address))})</option>`).join('');
  return { code: 200, body: page('Pin strategy', `
    <div class="panel">
      <h2>Pin strategy to wallet</h2>
      <div style="background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:12px;margin:10px 0">
        <div><span class="cat">${esc(strategy.category)}</span>
          ${strategy._chain ? '<span class="chain">' + esc(strategy._chain) + '</span>' : ''}
          <span class="ret" style="margin-left:8px">${esc(strategy.expectedReturn)}</span>
          <span class="pill ${riskCls}" style="margin-left:8px">risk ${esc(strategy.risk)}</span></div>
        <div style="margin-top:6px">${esc(strategy.action)}</div>
        <div class="meta" style="margin-top:6px">TVL ${esc(strategy.tvl || '?')} · min capital $${esc(strategy.minCapitalUsd || 0)}</div>
      </div>
      <form method="post" action="/pins/add">
        <input type="hidden" name="fp" value="${esc(strategy._fp)}">
        <label style="display:block;margin-bottom:10px">
          <span class="meta">Wallet</span><br>
          <select name="walletAddress" required>${opts}</select>
        </label>
        <label style="display:block;margin-bottom:10px">
          <span class="meta">Notes (optional)</span><br>
          <input type="text" name="notes" maxlength="200" style="width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 6px">
        </label>
        <button class="btn" type="submit">Confirm pin</button>
        <a href="/" class="btn sec" style="margin-left:8px">cancel</a>
      </form>
    </div>
  `) };
}

// ---- Request helpers ------------------------------------------------------

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const ctype = (req.headers['content-type'] || '').split(';')[0].trim();
  if (ctype === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  if (ctype === 'application/json') {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return {};
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function setMsgRedirect(res, target, kind, text) {
  const sep = target.includes('?') ? '&' : '?';
  redirect(res, target + sep + (kind === 'err' ? 'err' : 'ok') + '=' + encodeURIComponent(text));
}

function extractMsg(searchParams) {
  if (searchParams.get('err')) return { kind: 'err', text: searchParams.get('err') };
  if (searchParams.get('ok')) return { kind: 'ok', text: searchParams.get('ok') };
  return null;
}

// ---- Server ---------------------------------------------------------------

// ---- Phase-0 research readout (off-DefiLlama edge measurements) -----------
function ageStr(iso) {
  const t = Date.parse(iso); if (isNaN(t)) return '?';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m}m ago` : `${(m / 60).toFixed(1)}h ago`;
}
function renderResearch() {
  const inc = readJSON(`${RESEARCH_DIR}/incentives.json`);
  const nav = readJSON(`${RESEARCH_DIR}/nav.json`);
  const fd = readJSON(`${RESEARCH_DIR}/funding-dispersion.json`);
  const ph = readJSON(`${RESEARCH_DIR}/pool-history-state.json`);
  const dm = readJSON(`${RESEARCH_DIR}/decay-model.json`);

  const tbl = (rows) => `<table style="width:100%;border-collapse:collapse;margin:6px 0">${rows}</table>`;
  const th = (cols) => `<tr>${cols.map((c) => `<th style="text-align:left;color:var(--dim);font-weight:normal;border-bottom:1px solid var(--line);padding:4px 8px">${c}</th>`).join('')}</tr>`;
  const td = (cols) => `<tr>${cols.map((c) => `<td style="padding:4px 8px;border-bottom:1px solid var(--line)">${c}</td>`).join('')}</tr>`;

  // 1) Incentives (Merkl) — the scanner is blind to these entirely
  let incBody = '<div class="dim">no data</div>';
  if (inc) {
    const rows = (inc.fresh_high_apr || inc.top_live || []).slice(0, 15).map((o) => td([
      `<b>${num(o.apr).toFixed(0)}%</b>`, esc(o.chain), esc(o.protocol || ''),
      esc(String(o.name || '').slice(0, 44)),
      o.aprRatio != null ? `${o.aprRatio < 0.85 ? '<span class="bad">' : ''}${(o.aprRatio * 100).toFixed(0)}%${o.aprRatio < 0.85 ? '</span>' : ''}` : '—',
      o.ageHoursSinceFirstSeen != null ? `${o.ageHoursSinceFirstSeen}h` : '—',
      o.depositUrl ? `<a href="${esc(o.depositUrl)}" target="_blank">open ↗</a>` : '',
    ])).join('');
    incBody = `<div class="meta">${inc.summary?.live || 0} live programs · ${inc.summary?.new_this_scan || 0} new this scan · ${inc.summary?.fresh_high_apr || 0} fresh&lt;72h+&gt;20% · max ${num(inc.summary?.max_apr).toFixed(0)}% · ${ageStr(inc.timestamp)}</div>`
      + tbl(th(['APR', 'chain', 'protocol', 'program', 'vs first', 'age', '']) + rows);
  }

  // 2) NAV oracle — discount distribution (edge lives in the tails over time)
  let navBody = '<div class="dim">no data</div>';
  if (nav) {
    const bpsCell = (v, big) => v == null ? '—' : `${big && Math.abs(v) >= 15 ? '<span class="ret">' : ''}${v > 0 ? '+' : ''}${v}bps${big && Math.abs(v) >= 15 ? '</span>' : ''}`;
    const rows = (nav.assets || []).map((a) => {
      // spot can be a stale phantom; exec (size-aware ParaSwap) is the authoritative confirmation.
      const spot = a.spotDiscountBps ?? a.discountBps;  // tolerate legacy shape
      // A big exec edge on a NON-redeemable token (e.g. osETH) is STRUCTURAL — there is no at-will
      // redemption to capture it. Render it greyed + tagged so it can't be misread as an opportunity.
      // Capture requires BOTH legs real: a DISCOUNT (exec>0) needs redeemable; a PREMIUM (exec<0)
      // needs mintableAtNav (acquire at NAV). Premiums on stake-pool LSTs are NOT capturable — you
      // can't mint at NAV (verified: jitoSOL DEX buy +37.9bps, sell +37.8bps — both above NAV).
      const isPremium = a.execDiscountBps != null && a.execDiscountBps < 0;
      const capturable = a.execDiscountBps != null && !a.illiquid && (Math.abs(a.execDiscountBps) - (a.frictionBps || 0)) >= 15
        && (a.execDiscountBps > 0 ? a.redeemable !== false : a.mintableAtNav === true);
      let execCell;
      if (a.execDiscountBps == null) execCell = a.illiquid ? '<span class="dim">illiquid</span>' : '<span class="dim">—</span>';
      else if (capturable) execCell = bpsCell(a.execDiscountBps, true);
      else if (a.redeemable === false) execCell = `<span class="dim">${a.execDiscountBps}bps</span> <span class="warn">structural · not capturable</span>`;
      else if (isPremium) execCell = `<span class="dim">${a.execDiscountBps}bps premium</span> <span class="warn">not capturable (can't mint at NAV)</span>`;
      else execCell = bpsCell(a.execDiscountBps, true);
      const grey = !capturable && a.execDiscountBps != null && Math.abs(a.execDiscountBps) >= 15;
      return `<tr${grey ? ' style="opacity:.55"' : ''}>` + [
        `<b>${esc(a.sym)}</b>${capturable ? ' <span class="pill ok">CAPTURABLE</span>' : ''}`,
        `<span class="chain">${esc(a.net || 'ethereum')}</span>`,
        a.navRate != null ? a.navRate : '—',
        bpsCell(spot, false),
        execCell,
        a.redeemable === false ? '<span class="warn">no (locked)</span>' : a.redeemable === true ? 'yes' : '?',
        esc(String(a.redemption || '').slice(0, 38)),
      ].map((c) => `<td style="padding:4px 8px;border-bottom:1px solid var(--line)">${c}</td>`).join('') + '</tr>';
    }).join('');
    navBody = `<div class="meta">${nav.assets?.length || 0} assets across ${[...new Set((nav.assets || []).map((a) => a.net || 'ethereum'))].length} chains · <span class="ret">${nav.actionable?.length || 0} actionable</span> (capturable BOTH legs) · ${ageStr(nav.timestamp)}</div>`
      + `<div class="meta" style="color:var(--warn)">⚠ A discount needs a real <b>redemption</b> (buy→redeem); a <b>premium</b> needs <b>mint-at-NAV</b> (mint→sell) — which stake-pool LSTs (jitoSOL, mSOL…) do NOT have (you can't acquire at NAV), so their premium is the market's fair value, NOT an arb. Only <span class="pill ok">CAPTURABLE</span> rows / <b>NAV_ARB</b> are tradeable.</div>`
      + `<div class="meta">spot = DefiLlama ratio (can be a stale phantom); exec = size-aware quote net of slippage (authoritative); illiquid = edge evaporated / pool too thin.</div>`
      + tbl(th(['asset', 'chain', 'NAV', 'spot', 'exec (real)', 'redeemable', 'redemption path']) + rows);
  }

  // 3) Funding dispersion — cross-venue, baseline artifacts filtered
  let fdBody = '<div class="dim">no data</div>';
  if (fd) {
    const rows = (fd.real_edge || []).slice(0, 15).map((c) => td([
      `<b>${esc(c.coin)}</b>`, `${c.dispersionPct}%`, esc(c.harvest),
    ])).join('');
    fdBody = `<div class="meta">${fd.summary?.multi_venue || 0} multi-venue · <span class="ret">${fd.summary?.real_edge || 0} real-edge(&ge;10%)</span> · ${fd.summary?.baseline_filtered || 0} baseline-artifacts dropped · max ${num(fd.summary?.max_dispersion).toFixed(0)}% · ${ageStr(fd.timestamp)}</div>`
      + `<div class="meta" style="color:var(--warn)">⚠ fat dispersions are volatile small-caps — mean-revert fast, one-leg-liquidation risk. Execution needs 1 KYC account per venue.</div>`
      + tbl(th(['coin', 'dispersion', 'delta-neutral harvest']) + rows);
  }

  // 4) Pool-history capture status (decay-model data accumulating)
  const phBody = ph
    ? `<div class="meta">last UUID-keyed snapshot: ${ageStr(ph.lastSnapshotIso)} · universe ${ph.lastUniverseSize || 0} pools (tvl≥$1M, apy≥8%) · accumulating de-censored forward history for the decay model</div>`
    : '<div class="dim">no snapshot yet</div>';

  // 5) Decay model — empirical APY-reversion table + current pools predicted to revert
  let dmBody = '<div class="dim">no model yet (accumulating history)</div>';
  if (dm && dm.ready) {
    const bands = Object.keys(dm.table || {});
    const horizons = dm.horizons_computed || [];
    const trows = bands.map((b) => td([
      `<b>${esc(b)}%</b>`,
      ...horizons.map((h) => {
        const c = dm.table[b][h];
        if (!c) return '—';
        const sev = c.pctFell10 >= 55 ? 'bad' : c.pctFell10 >= 35 ? 'warn' : '';
        return `<span class="${sev}">×${c.medianRatio}</span> <span class="dim">${c.pctFell10}%↓ n${c.n}</span>`;
      }),
    ])).join('');
    const hi = (dm.high_risk || []).slice(0, 12).map((s) => td([
      `<b>${num(s.apy).toFixed(0)}%</b>`, `→${num(s.predictedApy).toFixed(0)}%`,
      `<span class="bad">${s.pctFell10}%↓</span>`, esc(s.chain), esc(s.project), esc(String(s.symbol).slice(0, 18)),
    ])).join('');
    dmBody = `<div class="meta">scored ${dm.summary?.scored || 0} pools · <span class="bad">${dm.summary?.high_risk || 0} HIGH-risk</span> · ${dm.summary?.history_rows || 0} history rows over ${dm.span_hours}h · scoring @ ${dm.scoring_horizon} · ${ageStr(dm.timestamp)}</div>`
      + `<div class="meta">Decay table — median APY ratio (×<1 = reverts) + P(fall&gt;10%) + sample n, by initial-APY band × horizon:</div>`
      + tbl(th(['APY band', ...horizons]) + trows)
      + `<div class="meta" style="margin-top:8px">Current pools predicted to revert (≥55% historically fell &gt;10% @ ${dm.scoring_horizon}) — <b>exit-timing flags</b>:</div>`
      + tbl(th(['APY now', 'predicted', 'P(fall)', 'chain', 'project', 'pool']) + hi);
  }

  const section = (title, sub, body) => `<div class="panel" style="margin:10px 0;padding:10px"><h3 style="margin:0 0 2px">${title}</h3><div class="meta" style="margin-bottom:6px">${sub}</div>${body}</div>`;

  const body = headerNav('research')
    + `<h2>Research — off-DefiLlama edge measurements <span class="meta">(Phase 0 · read-only · captures nothing-but-data)</span></h2>`
    + section('① Incentive programs (Merkl)', 'Invisible to the DefiLlama scanner. "vs first" = APR now ÷ APR when first seen (&lt;100% = diluting as designed). The early window is the Strategy-#1 edge.', incBody)
    + section('② LST / stable NAV vs DEX', 'On-chain redemption value vs DEX price. Blue-chips sit near NAV in calm markets; the edge is the event-driven discount tail — measured over time.', navBody)
    + section('③ Cross-venue funding dispersion', 'Hyperliquid + Binance + Bybit predicted funding. Delta-neutral: short the high-funding venue, long the low.', fdBody)
    + section('④ Pool-history capture (decay model)', 'UUID-keyed hourly snapshot — fixes the survivorship-censoring that makes the existing top-N archive untrainable.', phBody)
    + section('⑤ APY decay model (exit timing)', 'Empirical realized-vs-headline decay from the UUID-keyed history. Higher headline APY reverts faster; use as an exit/entry-caution signal. Confidence grows as 1d/3d/7d horizons populate.', dmBody);
  return page('Research — DeFi-Tracker', body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (TOKEN && url.searchParams.get('k') !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }

    if (req.method === 'GET' && p === '/data.json') {
      const data = collectScan();
      const wallets = listWallets();
      const portfolios = await Promise.all(wallets.map((w) => fetchPortfolio(w.address).catch((e) => ({ wallet: w.address, error: e.message }))));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...data, wallets, portfolios, pins: listPins() }, null, 2));
    }

    if (req.method === 'GET' && p === '/') {
      const d = collectScan();
      const msg = extractMsg(url.searchParams);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await renderToday(d, msg));
    }

    if (req.method === 'GET' && p === '/all') {
      const d = collectScan();
      const msg = extractMsg(url.searchParams);
      const f = Object.fromEntries(url.searchParams);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await renderMain(d, f, msg));
    }

    if (req.method === 'GET' && p === '/portfolio') {
      const msg = extractMsg(url.searchParams);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await renderPortfolio(msg));
    }

    if (req.method === 'GET' && p === '/favorites') {
      const d = collectScan();
      const msg = extractMsg(url.searchParams);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await renderFavorites(d, msg));
    }

    if (req.method === 'GET' && p === '/research') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderResearch());
    }

    if (req.method === 'GET' && p === '/wallet') {
      const d = collectScan();
      const addr = url.searchParams.get('addr') || '';
      const msg = extractMsg(url.searchParams);
      const result = await renderWalletDetail(addr, d.strategies, msg);
      res.writeHead(result.code, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(result.body);
    }

    if (req.method === 'GET' && p === '/pin') {
      const d = collectScan();
      const fp = url.searchParams.get('fp');
      const w = url.searchParams.get('w');
      const strategy = d.strategies.find((s) => s._fp === fp);
      const result = renderPinConfirm(strategy, listWallets(), w);
      res.writeHead(result.code, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(result.body);
    }

    // ---- POST handlers ----
    if (req.method === 'POST') {
      const body = await readBody(req);

      if (p === '/wallets/add') {
        try {
          addWallet({ address: body.address, label: body.label });
          return setMsgRedirect(res, '/', 'ok', 'Wallet added');
        } catch (e) { return setMsgRedirect(res, '/', 'err', e.message); }
      }

      if (p === '/wallets/remove') {
        try {
          removeWallet(body.address);
          return setMsgRedirect(res, '/', 'ok', 'Wallet removed');
        } catch (e) { return setMsgRedirect(res, '/', 'err', e.message); }
      }

      if (p === '/pins/add') {
        try {
          const d = collectScan();
          const strategy = d.strategies.find((s) => s._fp === body.fp);
          if (!strategy) throw new Error('Strategy not found in current scan');
          addPin({ walletAddress: body.walletAddress, strategy, notes: body.notes });
          return setMsgRedirect(res, '/wallet?addr=' + encodeURIComponent(body.walletAddress), 'ok', 'Pinned');
        } catch (e) { return setMsgRedirect(res, '/', 'err', e.message); }
      }

      if (p === '/pins/update') {
        try {
          const pin = listPins().find((x) => x.id === body.id);
          updatePinStatus(body.id, body.status);
          return setMsgRedirect(res, pin ? '/wallet?addr=' + encodeURIComponent(pin.walletAddress) : '/', 'ok', 'Status updated');
        } catch (e) { return setMsgRedirect(res, '/', 'err', e.message); }
      }

      if (p === '/favorites/add') {
        try {
          const d = collectScan();
          const strategy = d.strategies.find((s) => s._sfp === body.fp);
          if (!strategy) throw new Error('Strategy not found in current scan');
          addFavorite(strategy);
          // Initial snapshot now, so the trajectory starts immediately
          snapshotFavorites(d.strategies, d.report?.timestamp);
          return setMsgRedirect(res, req.headers.referer || '/favorites', 'ok', 'Added to favorites');
        } catch (e) { return setMsgRedirect(res, '/', 'err', e.message); }
      }

      if (p === '/favorites/remove') {
        try {
          removeFavorite(body.fp);
          return setMsgRedirect(res, req.headers.referer || '/favorites', 'ok', 'Removed from favorites');
        } catch (e) { return setMsgRedirect(res, '/', 'err', e.message); }
      }

      if (p === '/pins/remove') {
        try {
          const pin = listPins().find((x) => x.id === body.id);
          removePin(body.id);
          return setMsgRedirect(res, pin ? '/wallet?addr=' + encodeURIComponent(pin.walletAddress) : '/', 'ok', 'Unpinned');
        } catch (e) { return setMsgRedirect(res, '/', 'err', e.message); }
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    console.error('dashboard route error:', e && e.stack ? e.stack : e);
    // Guard: if a handler already sent headers (e.g. writeHead(200) then renderX threw), a second
    // writeHead throws ERR_HTTP_HEADERS_SENT and crashes the process — don't.
    if (!res.headersSent) { try { res.writeHead(500, { 'content-type': 'text/plain' }); } catch {} }
    try { res.end('dashboard error: ' + (e && e.message)); } catch {}
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`defi-tracker dashboard on 127.0.0.1:${PORT}`);
  if (!process.env.DRPC_KEY) console.warn('WARNING: DRPC_KEY env var not set — portfolio RPC calls will fail.');
  // Background warmer: every 60s, resolve any (project, chain, symbol) tuples
  // present in the current scan that don't have a cached deposit URL yet.
  // Skips cleanly without DRPC; protocols that need on-chain reads stay
  // unresolved but Aave V3 (no RPC) still works.
  try { startResolverWarmer(() => collectAllOpportunities()); }
  catch (e) { console.error('pool-resolver warmer failed to start:', e.message); }
});

// Background snapshot loop — captures favorites' state every 5 min so trajectories
// build up even when no one is viewing the dashboard. Idempotent within a scan.
setInterval(() => {
  try {
    if (!listFavorites().length) return;
    const d = collectScan();
    snapshotFavorites(d.strategies, d.report?.timestamp);
  } catch (e) {
    console.error('background snapshot error:', e.message);
  }
}, 5 * 60 * 1000);
