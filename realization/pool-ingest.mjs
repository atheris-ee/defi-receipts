#!/usr/bin/env node
// Ingest the FULL dashboard opportunity pool (not just curated top_strategies) into Postgres,
// so opportunity_realization (and the dashboard badges) cover every row.
//   node pool-ingest.mjs <dir>  — one archive dir (live, from archive-scan.sh)
//   node pool-ingest.mjs        — backfill every archived scan dir
// Idempotent: ON CONFLICT (scan_ts,fingerprint) DO NOTHING (also dedups vs curated rows).
// Matview refresh is gated to ~every 30 min (aggregates change slowly; 13s+ refresh is too heavy per-5-min).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { collectAllOpportunities, setDataDir } from '../dashboard/opportunities.mjs';

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || new URL('../archive', import.meta.url).pathname;
const PG_CONFIG = { host: process.env.PGHOST || '/run/postgresql', port: parseInt(process.env.PGPORT || '5432'), database: process.env.PGDATABASE || 'defi', user: process.env.PGUSER || 'defi' };
const KNOWN_CHAINS = new Set(['ethereum','polygon','arbitrum','base','optimism','avalanche','bsc','binance','solana','sui','aptos','bitcoin','litecoin','tron','ton','near','cosmos','osmosis','injective','starknet','stellar','sei','hyperliquid l1','hyperliquid','hyperevm','fantom','sonic','gnosis','cronos','kava','celo','harmony','moonbeam','moonriver','aurora','fuse','boba','velas','telos','mantle','linea','scroll','plasma','op mainnet','arbitrum nova','manta','blast','mode','metis','zksync era','polygon zkevm','berachain','monad','hemi','katana','plume','tac','unichain','flare','rootstock','world chain','ink','soneium']);
function chainOf(action){ const a=String(action||''); for(const m of a.matchAll(/[\(\[]([A-Za-z][A-Za-z0-9 .-]{0,29})[\)\]]/g)){ const c=m[1].trim(); if(KNOWN_CHAINS.has(c.toLowerCase())) return c; } return null; }
function fingerprintOf(s){ const norm=(s.category||'')+'|'+String(s.action||'').toLowerCase().replace(/\s+/g,' ').replace(/[^a-z0-9 →>\-+().%$]/g,'').trim(); return createHash('sha1').update(norm).digest('hex').slice(0,10); }
function returnPct(er){ const m=String(er||'').match(/-?\d+(?:\.\d+)?/); const v=m?parseFloat(m[0]):null; return Number.isFinite(v)?v:null; }
const UPDATE_SFP = 'UPDATE strategies SET stable_fp = stable_fp(category, action) WHERE stable_fp IS NULL';
// Persist first-sighting baselines per stable_fp into a table the 30-day prune never touches, so
// opportunity_realization keeps true entry_apy/tvl_entry/first_seen after rows age out of strategies.
const BASELINE_UPSERT = (where) => `INSERT INTO realization_baselines (sfp, category, first_seen, entry_apy, tvl_entry, sample_action)
  SELECT stable_fp, min(category), min(scan_ts),
    round((array_agg(return_pct ORDER BY scan_ts) FILTER (WHERE return_pct IS NOT NULL))[1]::numeric,1),
    (array_agg(tvl_to_num(tvl) ORDER BY scan_ts) FILTER (WHERE tvl_to_num(tvl) IS NOT NULL))[1],
    min(left(action,72))
  FROM strategies WHERE ${where} stable_fp IS NOT NULL AND action NOT ILIKE 'EARLY LAUNCH:%'
  GROUP BY stable_fp ON CONFLICT (sfp) DO NOTHING`;

async function ingestPoolDir(client, dir){
  let r; try { r=JSON.parse(readFileSync(join(dir,'latest_report.json'),'utf8')); } catch { return {skipped:'noreport'}; }
  if(!r.timestamp) return {skipped:'nots'};
  const ts=r.timestamp;
  await client.query(`INSERT INTO scans (scan_ts,version,capital_usd,summary,raw) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (scan_ts) DO NOTHING`,
    [ts, r.version||null, r.capitalUsd||null, JSON.stringify(r.summary||{}), JSON.stringify(r)]);
  setDataDir(dir);
  let pool; try { pool=collectAllOpportunities(); } catch(e){ return {ts, error:'pool:'+e.message}; }
  let inserted=0;
  for(const o of pool){
    try {
      const res=await client.query(
        `INSERT INTO strategies (scan_ts,rank,category,action,expected_return,return_pct,risk,tvl,min_capital_usd,profit_score,chain,fingerprint,raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (scan_ts,fingerprint) DO NOTHING`,
        [ts, o.rank||null, o.category||null, o.action||null, o.expectedReturn||null, returnPct(o.expectedReturn), parseInt(o.risk)||null, o.tvl||null, o.minCapitalUsd||null, o.profitScore||null, chainOf(o.action), fingerprintOf(o), JSON.stringify(o)]);
      inserted += res.rowCount;
    } catch(e){ /* skip bad row */ }
  }
  return {ts, inserted, pool:pool.length};
}
function findDirs(root){ const out=[]; if(!existsSync(root)) return out; for(const date of readdirSync(root)){ if(date.startsWith('.')) continue; const dp=join(root,date); if(!statSync(dp).isDirectory()) continue; for(const hm of readdirSync(dp)){ const hp=join(dp,hm); if(!statSync(hp).isDirectory()) continue; if(existsSync(join(hp,'latest_report.json'))) out.push(hp); } } return out.sort(); }
async function refresh(client){
  try { await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY opportunity_realization'); return true; }
  catch(e){ console.error('REFRESH CONCURRENTLY failed:', e.message);
    try { await client.query('REFRESH MATERIALIZED VIEW opportunity_realization'); return true; }
    catch(e2){ console.error('REFRESH failed:', e2.message); return false; } } }

async function main(){
  const client=new pg.Client(PG_CONFIG); await client.connect();
  try {
    const arg=process.argv[2];
    if(arg){
      const res=await ingestPoolDir(client, arg);
      await client.query(UPDATE_SFP);
      if(res.ts) await client.query(BASELINE_UPSERT('scan_ts = $1 AND'), [res.ts]);
      const mins=new Date(res.ts||0).getUTCMinutes();           // refresh ~twice/hr, not every 5-min scan
      let refreshed=false;
      if(Number.isFinite(mins) && mins%30<5){ refreshed = await refresh(client); }
      const pr=await client.query(`DELETE FROM scans WHERE scan_ts < now() - interval '30 days'`);
      console.log(`pool-ingest ${arg}: ${JSON.stringify(res)} refreshed=${refreshed} pruned=${pr.rowCount}`);
    } else {
      const dirs=findDirs(ARCHIVE_DIR); let tot=0, done=0;
      for(const d of dirs){ try { const res=await ingestPoolDir(client,d); tot+=res.inserted||0; } catch(e){ console.error('FAIL',d,e.message); } if(++done%500===0) console.log(`  ${done}/${dirs.length} dirs, ${tot} rows`); }
      await client.query(UPDATE_SFP);
      await client.query(BASELINE_UPSERT(''));
      await refresh(client);
      console.log(`backfill done: ${dirs.length} dirs, ${tot} pool rows inserted`);
    }
  } finally { await client.end(); }
}
main().catch(e=>{ console.error(e); process.exit(1); });
