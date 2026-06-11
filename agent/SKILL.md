---
name: defi-receipts
description: Operate the defi-receipts engine — a self-grading DeFi opportunity scanner with a Postgres realization layer (every opportunity tracked to its outcome), a dashboard, and a gated Telegram alerter. Use when asked to run scans, query opportunities or their track record, inspect/extend ranking, operate the dashboard or alerter, or work on the dev-agent loop.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# defi-receipts — operating skill

A DeFi opportunity engine whose distinguishing feature is that **it grades itself**: every
opportunity gets a stable identity and is tracked across scans into a Postgres "realization"
layer recording whether its yield held and whether liquidity stayed. Ranking reads those
outcomes back in. Your job when this skill is active is to run, query, or extend that engine
without breaking the identity spine it depends on.

## Orient first

```bash
node scanner/src/index.js scan          # run one scan -> scanner/data/*.json
cat scanner/data/latest_report.json     # the ranked output (top_strategies[])
psql -d defi -c '\d opportunity_realization'   # the receipts schema (if DB is set up)
```

Read `docs/ARCHITECTURE.md` for the pipeline and `docs/DATA-DICTIONARY.md` for every field.

## The one rule that matters: stable identity

An opportunity is tracked by `stable_fp = md5(category | stable_stem(action))[:12]`, where the
stem strips volatile numbers from the action text. It is implemented **three times** and they
MUST stay byte-identical:

- `realization/realization.sql` — `stable_stem()` / `stable_fp()` (SQL)
- `scanner/src/index.js` — `stableStemJs()` / `stableFpJs()` (JS)
- `dashboard/server.mjs` — same (JS)

If you change how the stem works in one, change all three in the same commit, or you silently
orphan the entire outcome history (old opportunities reappear as "new"). When in doubt, verify
parity: compute `stableFpJs` over live rows and compare to the SQL `stable_fp` — they must match
100%.

## Common tasks

**Run a scan and read it**

```bash
node scanner/src/index.js scan
node -e "const r=require('./scanner/data/latest_report.json'); for(const s of (r.top_strategies||[]).slice(0,10)) console.log(s.category, s.expectedReturn, '|', s.action.slice(0,60), s.tvlFlight?('[TRAP '+s.tvlFlight+'%]'):'')"
```

**Query the receipts** (requires the realization layer set up — see `docs/DEPLOY.md`)

```bash
# Proven survivors: still live, 7d+ observed, APY held, liquidity stable
psql -d defi -tA -F' | ' -c "SELECT category, round(current_apy,1), round(apy_retention,2), days_obs FROM opportunity_realization WHERE still_live AND days_obs>=7 AND apy_retention>=0.85 AND (tvl_change_pct IS NULL OR tvl_change_pct>=-10) ORDER BY apy_retention*current_apy DESC LIMIT 12"

# Active traps in the current pool: yield held, liquidity fled
psql -d defi -tA -F' | ' -c "SELECT category, round(tvl_change_pct), days_obs, left(sample_action,50) FROM opportunity_realization WHERE tvl_change_pct<=-50 AND still_live ORDER BY tvl_change_pct LIMIT 20"

# Per-category survival (which categories last long enough to act on)
psql -d defi -tA -F' | ' -c "SELECT category, count(*), round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_obs)::numeric,1) AS median_days FROM opportunity_realization GROUP BY category ORDER BY median_days DESC"
```

**Run / restart the dashboard**

```bash
node dashboard/server.mjs &                      # http://localhost:8847
curl -s localhost:8847/health
curl -s localhost:8847/data.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.strategies.length,'strategies')})"
```

**Extend the ranking — the evidence-first rule.** Any change to how opportunities are scored or
filtered MUST be justified by a query against `opportunity_realization` showing the historical
outcome it improves. "This looks risky" is not a reason; "of N identities matching this pattern,
M had retention <0.6 within 7d" is. This is the bar the dev-agent loop holds itself to
(`agent/MANDATE.md`); apply it to yourself. Propose, validate against history, then commit.

## Hard rules

1. **Postgres is SELECT-only** unless you are deliberately migrating schema. Never
   DELETE/TRUNCATE `realization_baselines` (it's the unpruned anchor for entry baselines) or
   `strategies`.
2. **Don't put numbers in the stem.** The whole identity system breaks if the stem stops
   stripping a volatile value, or starts stripping a stable one (e.g. a token version like
   `aave-v3`). Test parity after any stem edit.
3. **Telegram is precious.** The alerter targets 0–4 msgs/day via gates + 7-day dedup. Don't add
   new send paths; extend `alerting/defi-tg-alerts.mjs`. Marks persist only on confirmed
   delivery. Respect the blue-chip gate (non-major pairs never alert).
4. **Secrets via env only** (`TELEGRAM_BOT_TOKEN`, `DRPC_KEY_FILE`, `RECEIPTS_PSQL`, …). Never
   hardcode a token, key, chat id, or wallet path. Never print key material; redact `dkey=`.
5. **Capital execution is out of scope** for this repo. The engine scans, grades, and reports.
   Do not add signing/trading without an explicit, separate decision.
6. **Commit what you change** with a clear message; these are live git repos.

## Configuration (env)

| Var | Purpose | Default |
|---|---|---|
| `RECEIPTS_PSQL` | psql command the JS shells out to | `psql -d defi -U defi` |
| `RECEIPTS_DATA_DIR` | scanner output dir | `scanner/data` |
| `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER` | ingest connection | localhost/5432/defi/defi |
| `TELEGRAM_BOT_TOKEN` (or `_FILE`) | alerter bot | — (alerter no-ops without it) |
| `TELEGRAM_CHAT_ID` | alert destination | — (required to send) |
| `DRPC_KEY_FILE` | paid RPC key for portfolio/NAV | `./secrets/drpc.env` (optional) |
| `DASHBOARD_PORT` | dashboard bind port | 8847 |

See `.env.example`. Public RPC + DefiLlama work with no keys for read-only scanning.
