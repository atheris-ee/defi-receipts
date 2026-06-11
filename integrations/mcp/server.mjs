#!/usr/bin/env node
// defi-receipts MCP server — exposes the engine's graded opportunities and their receipts to any
// MCP-capable agent (Claude, etc.) over stdio. Zero dependencies: speaks MCP's JSON-RPC 2.0
// framing directly. Read-only: it reads the latest scan report and queries the realization
// Postgres view via psql; it never writes, trades, or moves funds.
//
// Tools:
//   list_opportunities   — current ranked opportunities, filterable by category/chain/risk
//   get_receipt          — the outcome history (retention, TVL change, days observed) for a play
//   list_traps           — opportunities the engine has flagged as exit-liquidity traps
//   list_survivors       — proven-durable opportunities (the "safe anchor" set)
//   category_survival    — measured median lifespan / retention per category
//
// Configure via the same env as the rest of the repo (RECEIPTS_DATA_DIR, RECEIPTS_PSQL).
// Register with an MCP client, e.g. Claude Code:
//   claude mcp add defi-receipts -- node /path/to/defi-receipts/integrations/mcp/server.mjs

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO = new URL('../../', import.meta.url).pathname;
const DATA_DIR = process.env.RECEIPTS_DATA_DIR || `${REPO}scanner/data`;
const PSQL = process.env.RECEIPTS_PSQL || 'psql -d defi -U defi';

const stem = (a) => String(a || '')
  .replace(/\s+[—–-]\s+current\s[\s\S]*$/, '').replace(/\s+@\s+[\s\S]*$/, '')
  .replace(/\$?\d[\d.,]*\s*[KkMmBb]?%?/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const sfp = (cat, action) => createHash('md5').update(String(cat || '') + '|' + stem(action)).digest('hex').slice(0, 12);
const readReport = () => { try { return JSON.parse(readFileSync(`${DATA_DIR}/latest_report.json`, 'utf8')); } catch { return null; } };
function psql(sql) {
  try { return execSync(`${PSQL} -tA -F'\t' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 10000 }).trim().split('\n').filter(Boolean); }
  catch (e) { return { error: String(e.message || e).split('\n')[0] }; }
}

const TOOLS = {
  list_opportunities: {
    description: 'Current ranked DeFi opportunities from the latest scan, with realization flags (tvlFlight = trap). Filter by category, chain, max risk, or minimum return.',
    inputSchema: { type: 'object', properties: {
      category: { type: 'string', description: 'e.g. YIELD, CLM, FUNDING, ALPHA, LIQUIDATION' },
      chain: { type: 'string' }, maxRisk: { type: 'number' }, minReturnPct: { type: 'number' }, limit: { type: 'number', default: 20 },
    } },
    run(a) {
      const r = readReport();
      if (!r) return { error: 'no scan report found — run `node scanner/src/index.js scan` first' };
      let rows = (r.top_strategies || []);
      if (a.category) rows = rows.filter((s) => s.category === a.category);
      if (a.chain) rows = rows.filter((s) => (s._chain || '').toLowerCase() === String(a.chain).toLowerCase() || (s.action || '').toLowerCase().includes(String(a.chain).toLowerCase()));
      if (a.maxRisk) rows = rows.filter((s) => (parseInt(s.risk) || 0) <= a.maxRisk);
      if (a.minReturnPct) rows = rows.filter((s) => { const m = String(s.expectedReturn || '').match(/-?[\d.]+/); return m && Math.abs(parseFloat(m[0])) >= a.minReturnPct; });
      return { scan: r.timestamp, count: rows.length, opportunities: rows.slice(0, a.limit || 20).map((s) => ({
        rank: s.rank, category: s.category, action: s.action, expectedReturn: s.expectedReturn, risk: s.risk,
        profitScore: s.profitScore, tvl: s.tvl, trap: s.tvlFlight != null ? `TVL ${s.tvlFlight}% — exit-liquidity risk` : undefined,
        nonMajor: s.nonMajorToken || undefined, stable_fp: sfp(s.category, s.action),
      })) };
    },
  },
  get_receipt: {
    description: 'The outcome history ("receipt") for an opportunity: APY retention, TVL change since first sighting, days observed, whether it is still live. Pass either a stable_fp or a category+action.',
    inputSchema: { type: 'object', properties: { stable_fp: { type: 'string' }, category: { type: 'string' }, action: { type: 'string' } } },
    run(a) {
      const id = a.stable_fp || (a.category && a.action ? sfp(a.category, a.action) : null);
      if (!id) return { error: 'pass stable_fp, or category + action' };
      const out = psql(`SELECT category, round(entry_apy,1), round(current_apy,1), round(apy_retention,2), round(tvl_change_pct), days_obs, sightings, still_live, left(sample_action,80) FROM opportunity_realization WHERE sfp='${id.replace(/'/g, "")}'`);
      if (out.error) return out;
      if (!out.length) return { stable_fp: id, found: false, note: 'no history yet — opportunity not seen long enough, or DB not set up' };
      const [c, ea, ca, ret, tvl, days, sight, live, sample] = out[0].split('\t');
      return { stable_fp: id, found: true, category: c, entry_apy: +ea, current_apy: +ca, apy_retention: +ret,
        tvl_change_pct: tvl === '' ? null : +tvl, days_observed: +days, sightings: +sight, still_live: live === 't',
        verdict: (+tvl <= -50 ? 'TRAP (liquidity fled while yield held)' : (live === 't' && +days >= 7 && +ret >= 0.85 && +tvl >= -10) ? 'SURVIVOR (proven durable)' : 'tracking'), sample_action: sample };
    },
  },
  list_traps: {
    description: 'Opportunities the engine has flagged as exit-liquidity traps: yield held while TVL fled ≥50%. Currently live in the pool.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 25 } } },
    run(a) {
      const out = psql(`SELECT category, round(tvl_change_pct), round(apy_retention,2), days_obs, left(sample_action,70) FROM opportunity_realization WHERE tvl_change_pct<=-50 AND still_live ORDER BY tvl_change_pct LIMIT ${a.limit || 25}`);
      if (out.error) return out;
      return { traps: out.map((l) => { const [c, tvl, ret, d, s] = l.split('\t'); return { category: c, tvl_change_pct: +tvl, apy_retention: +ret, days_observed: +d, action: s }; }) };
    },
  },
  list_survivors: {
    description: 'Proven-durable opportunities (the "safe anchor"): still live, 7+ days observed, APY retention ≥0.85, TVL stable. Ranked by retention-adjusted return.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 15 } } },
    run(a) {
      const out = psql(`SELECT category, round(current_apy,1), round(apy_retention,2), days_obs, round(tvl_change_pct), left(sample_action,70) FROM opportunity_realization WHERE still_live AND days_obs>=7 AND apy_retention>=0.85 AND (tvl_change_pct IS NULL OR tvl_change_pct>=-10) AND avg_risk<=5 ORDER BY apy_retention*current_apy DESC NULLS LAST LIMIT ${a.limit || 15}`);
      if (out.error) return out;
      return { survivors: out.map((l) => { const [c, apy, ret, d, tvl, s] = l.split('\t'); return { category: c, current_apy: +apy, apy_retention: +ret, days_observed: +d, tvl_change_pct: tvl === '' ? null : +tvl, action: s }; }) };
    },
  },
  category_survival: {
    description: 'Measured survival statistics per category: how many identities tracked, % that lasted 7+ days, median lifespan in days, average APY retention. The survivorship map.',
    inputSchema: { type: 'object', properties: {} },
    run() {
      const out = psql(`SELECT category, count(*), round(avg(CASE WHEN days_obs>=7 THEN 1 ELSE 0 END)*100), round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_obs)::numeric,1), round(avg(apy_retention),2) FROM opportunity_realization GROUP BY category HAVING count(*)>=10 ORDER BY 4 DESC`);
      if (out.error) return out;
      return { categories: out.map((l) => { const [c, n, p7, med, ret] = l.split('\t'); return { category: c, identities: +n, pct_lasting_7d: +p7, median_lifespan_days: +med, avg_apy_retention: +ret }; }) };
    },
  },
};

// --- MCP stdio JSON-RPC loop --------------------------------------------------------------------
const SERVER_INFO = { name: 'defi-receipts', version: '1.0.0' };
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    handle(req);
  }
});

function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
  if (method === 'tools/call') {
    const t = TOOLS[params?.name];
    if (!t) return fail(id, -32601, `unknown tool: ${params?.name}`);
    let result; try { result = t.run(params.arguments || {}); } catch (e) { result = { error: String(e.message || e) }; }
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  }
  if (id !== undefined) fail(id, -32601, `unknown method: ${method}`);
}

process.stderr.write(`defi-receipts MCP server ready (data: ${DATA_DIR})\n`);
