# AGENTS.md

Operating guide for AI coding agents working in this repository. (Human contributors: this is a
fine orientation too; see `README.md` for the narrative version.)

## What this is

`defi-receipts` is a self-grading DeFi opportunity engine. A zero-dependency scanner finds yield/
arb/funding/carry/liquidation/CLM opportunities across 8+ chains every 5 minutes; a Postgres
"realization" layer tracks every opportunity to its outcome (did the APY hold? did liquidity
flee?); and the scanner reads those outcomes back into its ranking. Plus a dashboard, a gated
Telegram alerter, and a self-improving dev-agent loop.

Read `docs/ARCHITECTURE.md` before making changes. Read `agent/SKILL.md` for operating commands.

## Setup & run

- **Runtime:** Node.js 22+. The scanner and dashboard have **zero npm dependencies**. Only the
  Postgres ingest (`realization/*.mjs`) needs `pg` (`cd realization && npm i pg`).
- **One scan, no DB:** `node scanner/src/index.js scan` → writes `scanner/data/*.json`.
- **Receipts:** `createdb defi && psql -d defi -f realization/realization.sql`, then
  `bash ops/archive-scan.sh` after each scan to ingest.
- **Dashboard:** `node dashboard/server.mjs` → http://localhost:8847
- **Config:** environment variables (see `.env.example`); no config is required for read-only
  scanning.

## Validation (run before you commit)

```bash
# Syntax-check every JS file (no test runner; this is the smoke test)
for f in scanner/src/*.js dashboard/*.mjs realization/*.mjs alerting/*.mjs; do node --check "$f" || echo "FAIL $f"; done

# A full scan must exit 0 and produce a report
node scanner/src/index.js scan && node -e "require('./scanner/data/latest_report.json').top_strategies.length||process.exit(1)"
```

If you touched anything identity-related, verify `stable_fp` parity between the JS and SQL
implementations (see below) — this is the single most important invariant.

## The invariant you must not break: stable identity

Opportunities are tracked by `stable_fp = md5(category | stable_stem(action))[:12]`. The stem
strips volatile numbers so an opportunity keeps one identity as its APY moves. It is implemented
**three times** — `realization/realization.sql`, `scanner/src/index.js`, `dashboard/server.mjs` —
and they **must stay byte-identical**. Change one → change all three in the same commit, or you
detach the entire outcome history. After any stem change, confirm the JS and SQL produce
identical fingerprints on real rows.

## House rules

- **Evidence-first ranking.** Any change to scoring/filtering must cite a query against
  `opportunity_realization` showing the historical outcome it improves. This is non-negotiable
  and is how the whole engine stays honest. See `agent/MANDATE.md`.
- **Postgres is SELECT-only** in normal work. Never DELETE/TRUNCATE `realization_baselines` or
  `strategies`.
- **No new dependencies** in the scanner or dashboard. The zero-dep property is a security
  feature, not an accident.
- **Secrets via env/local files only.** Never hardcode tokens, keys, chat ids, or wallet paths.
  Anything under `secrets/` is git-ignored. Never print key material.
- **Capital execution is intentionally not in this repo.** Don't add signing/trading.
- **Degrade, don't crash.** Every external dependency (Postgres, an API, Telegram) must degrade
  to less data with a log line, never a thrown scan.
- **Commit style:** small, message says *what changed and the evidence*. Match the terse,
  technical voice of existing comments.

## Where things live

| Path | What |
|---|---|
| `scanner/src/index.js` | scan orchestration, realization feedback, report assembly |
| `scanner/src/*.js` | per-category hunters (yields, arb, carry, aggro, alpha, …) |
| `realization/realization.sql` | stable-identity functions + the receipts matview |
| `realization/*.mjs` | ingest archived scans into Postgres |
| `dashboard/server.mjs` | the web UI (`/` decision view, `/all` table, `/data.json`) |
| `alerting/defi-tg-alerts.mjs` | Telegram instant + digest lanes |
| `agent/` | the dev-agent loop (MANDATE, tick) and the operating SKILL.md |
| `integrations/mcp/` | MCP server for programmatic/agent access |
| `docs/` | ARCHITECTURE, VISION, DEPLOY, DATA-DICTIONARY |

## If you're allocating capital from this engine

This repo grades opportunities; it does not execute. If you consume `/data.json` or the MCP
server to make capital decisions, honor the receipts: an entry flagged `tvlFlight` or excluded
from the convex board is excluded for a measured reason. And read `docs/VISION.md#legal` — this
is research tooling, not advice, and nothing here guarantees any outcome.
