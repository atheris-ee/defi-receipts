#!/usr/bin/env node
// defi-tg-alerts.mjs — the unified DeFi Telegram lane, rebuilt 2026-06-11 around the engine.
// Replaces three ad-hoc alerters: alpha-alert.sh (ExecStartPost), defi-executor-dryrun (15-min
// timer, the 124-alerts/day spam source), and defi-tracker-dev-report (dormant dev agent).
//
//   instant : per-scan via defi-tracker ExecStartPost — rare, time-critical events ONLY,
//             batched into one message per scan. Expected volume ~0-4 messages/day.
//   digest  : daily 07:00 UTC — the dashboard Today page in message form, one message.
//
// Tiers mirror the dashboard: fresh incentive windows → alpha plays → exit radar → convex NEW.
// Identity = stable_fp (md5(category|stem), byte-identical to scanner/dashboard/Postgres).
// Dedup state with per-namespace TTLs at /var/lib/defi-telegram/state.json; seen-marks persist
// ONLY on confirmed Telegram delivery (a lost send retries next scan, not after the TTL).
// HTML parse mode — Markdown broke on underscores/brackets embedded in action strings.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import https from 'node:https';
// NOTE: no static import of opportunities.mjs and no top-level token read — module-init code runs
// BEFORE the exit-0 guard exists, and this script is an ExecStartPost of the scanner: an init
// throw (missing token file, syntax error in the actively-edited dashboard module) must degrade
// to "no alerts this scan", never to a failed defi-tracker.service. Both are loaded lazily.

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const DATA = process.env.RECEIPTS_DATA_DIR || `${REPO_ROOT}scanner/data`;
const FAVORITES = process.env.RECEIPTS_FAVORITES || `${REPO_ROOT}state/favorites.json`;
const STATE_DIR = process.env.RECEIPTS_TG_STATE_DIR || `${REPO_ROOT}state/telegram`;
const STATE = `${STATE_DIR}/state.json`;
let _token;
function token() {
  if (_token === undefined) {
    if (process.env.TELEGRAM_BOT_TOKEN) { _token = process.env.TELEGRAM_BOT_TOKEN.trim(); return _token; }
    try { _token = readFileSync(process.env.TELEGRAM_BOT_TOKEN_FILE || `${REPO_ROOT}secrets/telegram-bot-token`, 'utf8').trim(); }
    catch { _token = null; }
  }
  return _token;
}
const CHAT = process.env.TELEGRAM_CHAT_ID || ''; // required — your own chat/channel id
const TTL_DAYS = { window: 7, alpha: 7, exit: 7, convex: 7, digest: 3 };
const PSQL = process.env.RECEIPTS_PSQL || 'psql -d defi -U defi';
const DURABLE_CATS = new Set(['ALPHA', 'CLM', 'ARB', 'LIQUIDATION', 'YIELD', 'RECURSIVE', 'FREE_LOOP', 'DEPEG_ARB']);

const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (s) => { const m = String(s || '').match(/-?[\d.]+/); return m ? Math.abs(parseFloat(m[0])) : 0; };

function stem(a) {
  let s = String(a || '');
  s = s.replace(/\s+[—–-]\s+current\s[\s\S]*$/, '');
  s = s.replace(/\s+@\s+[\s\S]*$/, '');
  s = s.replace(/\$?\d[\d.,]*\s*[KkMmBb]?%?/g, '');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}
const sfpOf = (cat, action) => createHash('md5').update(String(cat || '') + '|' + stem(action)).digest('hex').slice(0, 12);

function realMap() {
  const m = new Map();
  try {
    const out = execSync(`${PSQL} -c "SELECT sfp,apy_retention,tvl_change_pct,still_live,days_obs,sightings FROM opportunity_realization"`, { encoding: 'utf8', timeout: 8000 });
    for (const line of out.split('\n')) {
      const [sfp, ret, tvl, live, days, sight] = line.split('|');
      if (sfp) m.set(sfp, { ret: ret === '' ? null : parseFloat(ret), tvl: tvl === '' ? null : parseFloat(tvl), live: live === 't', days: parseFloat(days) || 0, sight: parseInt(sight) || 0 });
    }
  } catch { }
  return m;
}
const isTrap = (r) => !!(r && r.tvl != null && r.tvl <= -50);
const isSurvivor = (r) => !!(r && r.live && r.days >= 7 && r.ret != null && r.ret >= 0.85 && (r.tvl == null || r.tvl >= -10));

function loadState() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const s = readJSON(STATE) || {};
  const now = Date.now();
  for (const [k, t] of Object.entries(s)) {
    const ns = k.split(':')[0];
    if (now - t > (TTL_DAYS[ns] || 7) * 86400000) delete s[k];
  }
  return s;
}
// Commit marks via read-modify-write on FRESH state: the instant lane and the 07:00 digest can
// overlap, and a stale in-memory copy written back would clobber the other lane's marks.
function commitMarks(keys) {
  const s = loadState();
  for (const k of keys) s[k] = Date.now();
  writeFileSync(STATE, JSON.stringify(s));
}

function tg(html) {
  return new Promise((res) => {
    if (!token() || !CHAT) { console.error('tg: TELEGRAM_BOT_TOKEN(_FILE) and TELEGRAM_CHAT_ID must be set'); return res(false); }
    const body = new URLSearchParams({ chat_id: CHAT, text: html, parse_mode: 'HTML', disable_web_page_preview: 'true' }).toString();
    const req = https.request({
      host: 'api.telegram.org', path: `/bot${token()}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => { r.on('data', () => { }); r.on('end', () => res(r.statusCode === 200)); });
    // A hung Telegram socket must never stall the scanner unit (oneshot, infinite start timeout).
    req.setTimeout(15000, () => { req.destroy(); res(false); });
    req.on('error', () => res(false));
    req.write(body); req.end();
  });
}

// Fit whole blocks under Telegram's limit — slicing a composed message can cut mid-HTML-tag,
// which 400s forever (identical retry each scan) or silently loses the truncated signals.
// Blocks that don't fit are left unmarked, so they retry as their own message next scan.
function fitBlocks(header, blocks, marks, budget = 3800) {
  let msg = header, used = [];
  for (let i = 0; i < blocks.length; i++) {
    const add = '\n\n' + blocks[i];
    if (msg.length + add.length > budget) break;
    msg += add; used.push(marks[i]);
  }
  return { msg, used, dropped: blocks.length - used.length };
}

const freshFloors = (c) => (+c.apr || 0) >= 20 && (+c.dailyRewards || 0) >= 50 && (+c.tvl || 0) >= 10000 && (+c.ageHoursSinceFirstSeen || 0) <= 72;

let _collect;
async function poolWithSfp() {
  try {
    _collect ??= (await import(new URL('../dashboard/opportunities.mjs', import.meta.url))).collectAllOpportunities;
    return _collect().map((o) => ({ ...o, _sfp: sfpOf(o.category, o.action) }));
  } catch (e) { console.error('pool unavailable: ' + String(e.message || e).slice(0, 120)); return []; }
}

// ---- instant lane -------------------------------------------------------------------------------
async function instant() {
  const state = loadState();
  const rm = realMap();
  const blocks = [];
  const marks = [];

  // 1. Fresh incentive windows (day-1 dilution is the edge — this is the most time-critical tier)
  const inc = readJSON(`${DATA}/incentives.json`) || {};
  for (const c of (inc.fresh_high_apr || []).filter(freshFloors)) {
    const key = `window:${c.id}`;
    if (state[key]) continue;
    blocks.push(`⚡ <b>Fresh window</b> — ${esc(c.name)} [${esc(c.protocol)}/${esc(c.chain)}]\n${(+c.apr).toFixed(1)}% APR · $${Math.round(+c.dailyRewards)}/day · TVL $${Math.round(+c.tvl).toLocaleString()} · ${Math.round(+c.ageHoursSinceFirstSeen)}h/72h window${c.depositUrl ? `\n→ ${esc(c.depositUrl)}` : ''}`);
    marks.push(key);
  }

  // 2. New alpha plays (score ≥ 30, trap-gated except resurrection plays — that IS their thesis)
  const alpha = readJSON(`${DATA}/alpha.json`) || {};
  for (const a of (alpha.all_alpha || [])) {
    // Threshold raised 30→40 (2026-06-11 review): score-31 composable plays are marginal noise.
    if ((a.profitScore || 0) < 40 || a.alphaType === 'EARLY_LAUNCH') continue;
    // FRESH_INCENTIVE is alerted by the window tier above from the same source data — alerting
    // it here too sent the same play twice 5 minutes apart (cross-namespace dedup gap).
    if (a.alphaType === 'FRESH_INCENTIVE') continue;
    // Blue-chip preference (2026-06-11): micro-cap/meme pairs (WETH-ASTEROID class) never alert.
    if (a.nonMajorToken) continue;
    const sfp = sfpOf(a.category, a.action);
    const r = rm.get(sfp);
    if (isTrap(r) && a.alphaType !== 'RESURRECTED_EXTREME') continue;
    const key = `alpha:${sfp}`;
    if (state[key]) continue;
    const evidence = r ? ` · seen ${Math.round(r.days)}d, ret ${r.ret ?? '—'}` : '';
    blocks.push(`🎯 <b>New alpha</b> — ${esc(a.alphaType)}\n${esc(a.action)}\n${esc(a.expectedReturn || '')} · risk ${esc(a.risk || '?')}${evidence}${isTrap(r) ? ` · ⚠ prior TVL flight ${Math.round(r.tvl)}%` : ''}\n<i>${esc(a.alphaReason || '')}</i>`);
    marks.push(key);
  }

  // 3. Exit radar on favorites (the alert that actually protects capital)
  const favs = readJSON(FAVORITES) || [];
  for (const f of favs) {
    const r = rm.get(f.fingerprint);
    const last2 = (f.history || []).slice(-2);
    const offScan = last2.length === 2 && last2.every((h) => !h.present);
    const conds = [];
    if (isTrap(r)) conds.push(['trap', `TVL ${Math.round(r.tvl)}% since entry`]);
    if (r && r.ret != null && r.ret < 0.70) conds.push(['retention', `retention ${r.ret}`]);
    if (offScan) conds.push(['offscan', 'dropped from scan 2+ cycles']);
    for (const [cond, txt] of conds) {
      const key = `exit:${f.fingerprint}:${cond}`;
      if (state[key]) continue;
      blocks.push(`🚪 <b>Exit signal</b> — ${esc((f.initialSnapshot || {}).action || f.fingerprint)}\n${esc(txt)} — review the position`);
      marks.push(key);
    }
  }

  // 4. Convex NEW entrants — high bar (score ≥ 100, risk ≤ 6) so this stays rare
  const pool = await poolWithSfp();
  for (const s of pool) {
    if (s.nonMajorToken || s.riskyLp || s.microPool) continue; // blue-chip preference
    if (!DURABLE_CATS.has(s.category) || pct(s.expectedReturn) < 15) continue;
    if ((s.profitScore || 0) < 100 || (parseInt(s.risk) || 0) > 6) continue;
    const r = rm.get(s._sfp);
    if (r && r.days >= 2) continue;        // not new
    if (isTrap(r)) continue;
    const key = `convex:${s._sfp}`;
    if (state[key]) continue;
    blocks.push(`📈 <b>New convex entrant</b> — ${esc(s.category)}\n${esc(s.action)}\n${esc(s.expectedReturn || '')} · risk ${esc(s.risk || '?')} · score ${Math.round(s.profitScore || 0)} · <i>no retention history yet</i>`);
    marks.push(key);
  }

  if (!blocks.length) { console.log('instant: no new signals'); return; }
  const { msg, used, dropped } = fitBlocks(`<b>DeFi engine</b> — ${blocks.length} signal${blocks.length === 1 ? '' : 's'}${blocks.length > 1 ? '' : ''}`, blocks, marks);
  if (await tg(msg + (dropped ? `\n\n<i>+${dropped} more next scan</i>` : ''))) {
    commitMarks(used);
    console.log(`instant: sent ${used.length} signals${dropped ? `, ${dropped} deferred (length)` : ''}`);
  } else {
    console.error('instant: telegram send FAILED — nothing marked seen, retry next scan');
  }
}

// ---- digest lane --------------------------------------------------------------------------------
async function digest() {
  const state = loadState();
  const day = new Date().toISOString().slice(0, 10);
  const key = `digest:${day}`;
  if (state[key]) { console.log('digest: already sent today'); return; }

  const rm = realMap();
  const pool = await poolWithSfp();
  const matched = pool.filter((s) => rm.has(s._sfp)).length;
  const report = readJSON(`${DATA}/latest_report.json`) || {};
  const scanAgeMin = report.timestamp ? Math.round((Date.now() - new Date(report.timestamp).getTime()) / 60000) : -1;

  // 24h diff (same source of truth as the dashboard: Postgres by stable_fp)
  let diffLine = 'Δ24h: unavailable';
  let bornTop = [];
  try {
    const q = `SELECT side, stable_fp, category, score, ret, action FROM ( SELECT 'now' AS side, stable_fp, min(category) AS category, max(profit_score) AS score, max(return_pct) AS ret, min(action) AS action FROM strategies WHERE scan_ts = (SELECT max(scan_ts) FROM strategies) AND stable_fp IS NOT NULL GROUP BY stable_fp UNION ALL SELECT 'past', stable_fp, min(category), max(profit_score), max(return_pct), min(action) FROM strategies WHERE scan_ts = (SELECT max(scan_ts) FROM strategies WHERE scan_ts <= now() - interval '24 hours') AND stable_fp IS NOT NULL GROUP BY stable_fp ) u`;
    const out = execSync(`${PSQL} -c "${q}"`, { encoding: 'utf8', timeout: 10000 });
    const nowM = new Map(), pastM = new Map();
    for (const line of out.split('\n')) {
      if (!line) continue;
      const parts = line.split('|');
      if (parts.length < 6) continue;
      const row = { sfp: parts[1], category: parts[2], score: parseFloat(parts[3]) || 0, action: parts.slice(5).join('|') };
      (parts[0] === 'now' ? nowM : pastM).set(row.sfp, row);
    }
    const born = [...nowM.values()].filter((x) => !pastM.has(x.sfp) && DURABLE_CATS.has(x.category)).sort((a, b) => b.score - a.score);
    const gone = [...pastM.keys()].filter((k) => !nowM.has(k) && (rm.get(k) || {}).days >= 7).length;
    diffLine = `Δ24h: +${born.length} durable born · −${gone} established gone`;
    bornTop = born.slice(0, 3);
  } catch { }

  // Convex top 5 (trap- and retention-gated, score × retention — same as the dashboard board)
  const board = pool.filter((s) => DURABLE_CATS.has(s.category) && pct(s.expectedReturn) >= 15)
    .filter((s) => !s.nonMajorToken && !s.riskyLp && !s.microPool) // blue-chip preference
    .filter((s) => { const r = rm.get(s._sfp); return !isTrap(r) && (!r || r.days < 2 || r.ret == null || r.ret >= 0.6); })
    .map((s) => { const r = rm.get(s._sfp); return { s, r, adj: (s.profitScore || 0) * Math.min(1, (r && r.days >= 2 && r.ret != null) ? r.ret : 1) }; })
    .sort((a, b) => b.adj - a.adj).slice(0, 5);

  // Exit radar + anchor + traps
  const favs = readJSON(FAVORITES) || [];
  const exits = favs.filter((f) => { const r = rm.get(f.fingerprint); const l2 = (f.history || []).slice(-2); return isTrap(r) || (r && r.ret != null && r.ret < 0.70) || (l2.length === 2 && l2.every((h) => !h.present)); });
  const anchors = pool.filter((s) => isSurvivor(rm.get(s._sfp)) && (parseInt(s.risk) || 0) <= 5);
  const traps = pool.filter((s) => isTrap(rm.get(s._sfp))).length;
  const inc = readJSON(`${DATA}/incentives.json`) || {};
  const freshN = (inc.fresh_high_apr || []).filter(freshFloors).length;
  const alphaN = ((readJSON(`${DATA}/alpha.json`) || {}).all_alpha || []).length;

  const health = scanAgeMin >= 0 && scanAgeMin < 15 && matched >= pool.length * 0.6
    ? `engine ✓ scan ${scanAgeMin}m · pool ${pool.length} · history ${matched}/${pool.length}`
    : `⚠ ENGINE: scan ${scanAgeMin}m old · pool ${pool.length} · history ${matched}/${pool.length} — check the box`;

  const lines = [
    `☀️ <b>DeFi daily</b> — ${day}`,
    health,
    '',
    `⚡ Windows: ${freshN} fresh Merkl · ${alphaN} alpha live`,
    diffLine,
    ...bornTop.map((x) => `  + ${esc(x.category)} ${esc(x.action.slice(0, 70))} (score ${Math.round(x.score)})`),
    '',
    board.length ? `📈 <b>Convex top ${board.length}</b> (retention-gated):` : '📈 Convex board: nothing clears the gates',
    ...board.map(({ s, r, adj }, i) => `${i + 1}. ${esc(s.category)} ${esc(s.action.slice(0, 70))} — ${esc(s.expectedReturn || '')} r${parseInt(s.risk) || '?'} [${r && r.days >= 2 ? `${Math.round(r.days)}d · ret ${r.ret ?? '—'}` : 'NEW'}] adj ${Math.round(adj)}`),
    '',
    exits.length ? `🚪 <b>Exits: ${exits.length} need review</b> — ${exits.map((f) => esc(((f.initialSnapshot || {}).action || '').slice(0, 40))).join('; ')}` : '🚪 Exits: none',
    `🛡 Anchor: ${anchors.length} survivors live${anchors.length ? ` · best ${esc(anchors.map((s) => pct(s.expectedReturn)).sort((a, b) => b - a)[0].toFixed(1))}%` : ''}`,
    `🩸 Traps in pool: ${traps} (excluded from all picks)`,
  ];

  // Digest is structurally bounded (~top-5 + 3 born + fixed lines) but fit defensively by whole
  // lines — never slice into a tag.
  let msg = '';
  for (const l of lines) { if (msg.length + l.length + 1 > 3800) break; msg += (msg ? '\n' : '') + l; }
  if (await tg(msg)) {
    commitMarks([key]);
    console.log('digest: sent');
  } else {
    console.error('digest: telegram send FAILED — will retry on next timer fire');
  }
}

const mode = process.argv[2];
const run = mode === 'digest' ? digest : mode === 'instant' ? instant : null;
if (!run) { console.error('usage: defi-tg-alerts.mjs instant|digest'); process.exit(2); }
// instant runs as ExecStartPost of the scanner — it must NEVER fail the scan unit.
run().then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(mode === 'instant' ? 0 : 1); });
