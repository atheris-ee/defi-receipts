-- Realization layer for defi-tracker (additive). Updated 2026-06-10: realization_baselines table
-- persists first-sighting entry values OUTSIDE the 30-day prune, and opportunity_realization
-- COALESCEs them so entry_apy/tvl_entry/first_seen/apy_retention/tvl_change_pct stay anchored to
-- the TRUE first sighting after strategies rows age out (first prune fires ~2026-06-19).
-- Run as role defi (psql -U defi -p 5433 -d defi) so the matview owner can REFRESH it (06-08 lesson).
CREATE OR REPLACE FUNCTION stable_stem(act text) RETURNS text AS $$
  SELECT nullif(trim(lower(regexp_replace(regexp_replace(regexp_replace(
    regexp_replace(coalesce(act,''), '\s+[—–-]\s+current\s.*$', ''), '\s+@\s+.*$', ''),
    '\$?\d[\d.,]*\s*[KkMmBb]?%?', '', 'g'), '\s+', ' ', 'g'))), '');
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION stable_fp(cat text, act text) RETURNS text AS $$
  SELECT substr(md5(coalesce(cat,'')||'|'||coalesce(stable_stem(act),'')),1,12);
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION tvl_to_num(t text) RETURNS numeric AS $$
  SELECT CASE WHEN nullif(regexp_replace(coalesce(t,''),'[^0-9.]','','g'),'') IS NULL THEN NULL
    ELSE (regexp_replace(t,'[^0-9.]','','g'))::numeric
      * CASE upper(coalesce(substring(t from '[KkMmBb]'),'')) WHEN 'K' THEN 1e3 WHEN 'M' THEN 1e6 WHEN 'B' THEN 1e9 ELSE 1 END END;
$$ LANGUAGE sql IMMUTABLE;
-- ALTER TABLE strategies ADD COLUMN stable_fp text;  (populated via: UPDATE strategies SET stable_fp = stable_fp(category,action) WHERE stable_fp IS NULL;)
-- CREATE INDEX idx_strategies_sfp_ts ON strategies (stable_fp, scan_ts);

-- First-sighting baselines, upserted by pool-ingest.mjs every run (ON CONFLICT DO NOTHING).
-- NEVER pruned. Seed from full history before the first prune:
--   INSERT INTO realization_baselines (...) SELECT ... FROM strategies GROUP BY stable_fp ON CONFLICT (sfp) DO NOTHING;
CREATE TABLE IF NOT EXISTS realization_baselines (
  sfp text PRIMARY KEY,
  category text,
  first_seen timestamptz NOT NULL,
  entry_apy numeric,
  tvl_entry numeric,
  sample_action text
);
GRANT SELECT ON realization_baselines TO hermes;

DROP MATERIALIZED VIEW IF EXISTS opportunity_realization;
CREATE MATERIALIZED VIEW opportunity_realization AS
SELECT q.sfp, q.category, q.chain, q.sightings,
  coalesce(b.first_seen, q.first_seen_w) AS first_seen,
  q.last_seen,
  round(extract(epoch FROM (q.last_seen - coalesce(b.first_seen, q.first_seen_w)))/86400.0,1) AS days_obs,
  coalesce(b.entry_apy, q.entry_apy_w) AS entry_apy,
  q.current_apy, q.avg_apy, q.peak_apy, q.avg_risk, q.avg_score,
  coalesce(b.tvl_entry, q.tvl_entry_w) AS tvl_entry,
  q.tvl_now, q.still_live, q.sample_action,
  CASE WHEN coalesce(b.entry_apy, q.entry_apy_w) > 0
    THEN round((q.avg_apy/coalesce(b.entry_apy, q.entry_apy_w))::numeric,2) END AS apy_retention,
  CASE WHEN coalesce(b.tvl_entry, q.tvl_entry_w) > 0
    THEN round(((q.tvl_now - coalesce(b.tvl_entry, q.tvl_entry_w))/coalesce(b.tvl_entry, q.tvl_entry_w)*100)::numeric) END AS tvl_change_pct
FROM (
  SELECT stable_fp AS sfp, min(category) AS category, min(lower(chain)) AS chain,
    count(*) AS sightings, min(scan_ts) AS first_seen_w, max(scan_ts) AS last_seen,
    round((array_agg(return_pct ORDER BY scan_ts) FILTER (WHERE return_pct IS NOT NULL))[1]::numeric,1) AS entry_apy_w,
    round((array_agg(return_pct ORDER BY scan_ts DESC) FILTER (WHERE return_pct IS NOT NULL))[1]::numeric,1) AS current_apy,
    round(avg(return_pct)::numeric,1) AS avg_apy, round(max(return_pct)::numeric,1) AS peak_apy,
    round(avg(risk)::numeric,1) AS avg_risk, round(avg(profit_score)::numeric,0) AS avg_score,
    (array_agg(tvl_to_num(tvl) ORDER BY scan_ts) FILTER (WHERE tvl_to_num(tvl) IS NOT NULL))[1] AS tvl_entry_w,
    (array_agg(tvl_to_num(tvl) ORDER BY scan_ts DESC) FILTER (WHERE tvl_to_num(tvl) IS NOT NULL))[1] AS tvl_now,
    bool_or(scan_ts >= (SELECT max(scan_ts) FROM strategies) - interval '15 min') AS still_live,
    min(left(action,72)) AS sample_action
  FROM strategies WHERE stable_fp IS NOT NULL AND action NOT ILIKE 'EARLY LAUNCH:%'
  GROUP BY stable_fp
) q
LEFT JOIN realization_baselines b ON b.sfp = q.sfp;
CREATE UNIQUE INDEX idx_oppreal_sfp ON opportunity_realization (sfp);
GRANT SELECT ON opportunity_realization TO hermes;
