#!/usr/bin/env node
// Ingest archived scans into Postgres. Idempotent on scan_ts.
// Run mode A: `node ingest.mjs` — scans /var/lib/defi-tracker-archive recursively, loads anything new.
// Run mode B: `node ingest.mjs <path/to/dir>` — loads a single archive dir.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || new URL('../archive', import.meta.url).pathname;
const PG_CONFIG = {
  host: process.env.PGHOST || '/run/postgresql',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'defi',
  user: process.env.PGUSER || 'defi',
};

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

function chainOf(action) {
  const a = String(action || '');
  for (const m of a.matchAll(/[\(\[]([A-Za-z][A-Za-z0-9 .-]{0,29})[\)\]]/g)) {
    const c = m[1].trim();
    if (KNOWN_CHAINS.has(c.toLowerCase())) return c;
  }
  return null;
}

function fingerprintOf(s) {
  const norm = (s.category || '') + '|' + String(s.action || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 →>\-+().%$]/g, '')
    .trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 10);
}

function returnPct(expectedReturn) {
  const m = String(expectedReturn || '').match(/-?\d+(?:\.\d+)?/);
  const v = m ? parseFloat(m[0]) : null;
  return Number.isFinite(v) ? v : null;
}

async function ingestReport(client, reportPath) {
  let r;
  try { r = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return { skipped: 'unparseable' }; }
  if (!r.timestamp) return { skipped: 'no timestamp' };

  // Skip if scan_ts already loaded
  const existing = await client.query('SELECT 1 FROM scans WHERE scan_ts = $1', [r.timestamp]);
  if (existing.rowCount) return { skipped: 'already loaded', scan_ts: r.timestamp };

  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO scans (scan_ts, version, capital_usd, summary, raw)
       VALUES ($1, $2, $3, $4, $5)`,
      [r.timestamp, r.version || null, r.capitalUsd || null, JSON.stringify(r.summary || {}), JSON.stringify(r)]
    );
    const strategies = r.top_strategies || [];
    for (const s of strategies) {
      const fp = fingerprintOf(s);
      const chain = chainOf(s.action);
      const risk = parseInt(s.risk) || null;
      const rp = returnPct(s.expectedReturn);
      await client.query(
        `INSERT INTO strategies (scan_ts, rank, category, action, expected_return, return_pct, risk, tvl, min_capital_usd, profit_score, chain, fingerprint, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (scan_ts, fingerprint) DO NOTHING`,
        [r.timestamp, s.rank || null, s.category || null, s.action || null, s.expectedReturn || null, rp, risk,
         s.tvl || null, s.minCapitalUsd || null, s.profitScore || null, chain, fp, JSON.stringify(s)]
      );
    }
    await client.query('COMMIT');
    return { loaded: r.timestamp, strategies: strategies.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function findReports(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const date of readdirSync(root)) {
    if (date.startsWith('.')) continue;
    const dpath = join(root, date);
    if (!statSync(dpath).isDirectory()) continue;
    for (const hm of readdirSync(dpath)) {
      const hmpath = join(dpath, hm);
      if (!statSync(hmpath).isDirectory()) continue;
      const report = join(hmpath, 'latest_report.json');
      if (existsSync(report)) out.push(report);
    }
  }
  return out;
}

async function main() {
  const client = new pg.Client(PG_CONFIG);
  await client.connect();
  try {
    const arg = process.argv[2];
    const reports = arg ? [join(arg, 'latest_report.json')] : await findReports(ARCHIVE_DIR);
    let loaded = 0, skipped = 0;
    for (const r of reports) {
      try {
        const res = await ingestReport(client, r);
        if (res.loaded) loaded++; else skipped++;
      } catch (e) {
        console.error('FAIL', r, e.message);
      }
    }
    console.log(`ingest: ${loaded} loaded, ${skipped} skipped (${reports.length} total found)`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
