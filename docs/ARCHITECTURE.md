# Architecture

`defi-receipts` is a pipeline: **scan → archive → ingest → grade → rank → surface.** Each stage
is independent and file/SQL-driven, so you can run just the scanner, or the scanner plus
receipts, or the whole thing.

```
                    ┌─────────────┐
   DefiLlama,       │  scanner/   │  every 5 min
   DEX aggregators, │  src/*.js   │──────────────►  scanner/data/*.json
   perp venues,     │ (zero deps) │                 (latest_report.json + per-category)
   on-chain RPC ───►└─────────────┘                        │
                                                            │  ops/archive-scan.sh
                                                            ▼
                                                  archive/YYYY-MM-DD/HHMM/
                                                            │  realization/*.mjs (pg)
                                                            ▼
                    ┌──────────────────────────────────────────────┐
                    │  PostgreSQL                                    │
                    │   strategies         (every scan, every row)  │
                    │   realization_baselines (first-sighting, never pruned)
                    │   opportunity_realization (matview = THE RECEIPTS)
                    └──────────────────────────────────────────────┘
                          │                    │                  │
              reads at scan time         dashboard/          alerting/
              (realization feedback)     server.mjs          defi-tg-alerts.mjs
                          │              http://:8847         Telegram (instant + digest)
                          ▼
                   scanner ranking
                   (trap-penalized)
```

## Stages

### 1. Scan (`scanner/src/index.js scan`)

`runFullScan()` calls a set of independent hunters, each writing its own `data/<category>.json`:

| Module | Category | What it finds |
|---|---|---|
| `yields.js` | YIELD / FARMABLE_7D | DefiLlama pools above APY/TVL floors, with sustainability + decay adjustment |
| `arb.js` | ARB | cross-DEX price discrepancies (chain-aware) |
| `carry.js` | CARRY / FREE_CARRY / SPREAD | borrow-cost-vs-yield carry trades, lending-rate spreads |
| `aggro.js` | CLM / RECURSIVE / FUNDING | concentrated-LP, recursive leverage loops, perp funding (Hyperliquid) |
| `liquidator.js` | LIQUIDATION | positions near liquidation thresholds |
| `flasharb.js` | FLASH_ARB | atomic cross-DEX arbs (EVM + Solana via Jupiter) |
| `alpha.js` | ALPHA | asymmetric/convex plays: resurrected spikes, pendle basis, synthetic shorts, fresh Merkl incentive windows |
| `research-*.js` | (feeds scoring) | incentives registry, NAV premia, funding dispersion, pool-history decay model |

`index.js` then merges everything into `top_strategies`, applies cross-category dedup, the
**realization feedback penalty** (below), and writes `latest_report.json`. Each module is wrapped
so a single module failure degrades to "category omitted" rather than killing the scan.

### 2. Archive + ingest (`ops/archive-scan.sh` → `realization/*.mjs`)

One minute after each scan, `archive-scan.sh` snapshots `data/*.json` into a dated directory
(idempotent on the scan timestamp), then runs `ingest.mjs` (the curated report) and
`pool-ingest.mjs` (the full opportunity pool) to load rows into Postgres. Ingest failures fail
the unit loudly — an earlier silent `|| true` once hid a broken matview for days.

### 3. Grade (`realization/realization.sql`)

The heart of the system. Defines:

- **`stable_fp(category, action)`** and **`stable_stem(action)`** SQL functions — the canonical
  identity (see below).
- **`realization_baselines`** — one row per `stable_fp` capturing its *first-ever* entry APY and
  TVL, upserted `ON CONFLICT DO NOTHING` and **never pruned**, so baselines survive the 30-day
  row prune.
- **`opportunity_realization`** — a materialized view, one row per identity, that COALESCEs the
  baseline against current observations to compute the receipt:
  `apy_retention` (avg APY ÷ entry APY), `tvl_change_pct`, `days_obs`, `sightings`, `still_live`,
  `peak_apy`, `current_apy`.

Refreshed on a gate (~every 30 minutes; the full refresh is too heavy for every 5-minute scan).

### 4. Rank with feedback (`scanner/src/index.js` `loadRealizationMap()`)

Before sorting `top_strategies`, the scanner reads `opportunity_realization` back out of Postgres
and penalizes traps: any identity with `tvl_change_pct ≤ −50`, `days_obs ≥ 1`, `sightings ≥ 12`
gets a `tvlFlight` flag, a risk floor (7, or 9 if ≤ −80), and a profit-score multiplier
(×0.25, or ×0.1 if severe). This is the loop that makes the system learn from its own history.
If Postgres is unreachable, ranking proceeds ungated (logged, never crashes).

### 5. Surface (`dashboard/`, `alerting/`)

- **Dashboard** (`server.mjs`, zero deps) — `/` is a daily decision view: a trust strip
  (scan age, history-match ratio, stale-module detector), entry windows, a 24h diff (computed
  from Postgres by `stable_fp`), an exit radar over your favorites, a retention-gated convex
  board, and a collapsed "safe anchor" of proven survivors. `/all` is the full sortable table.
- **Alerter** (`defi-tg-alerts.mjs`) — two lanes: `instant` (runs as the scanner's post-hook,
  batched, gated, deduped 7 days, blue-chip-filtered) and `digest` (daily, the Today page as one
  message). Designed for 0–4 messages/day.

## Stable identity

This is the one concept to understand. An opportunity's *action text* changes every scan
("BTC-USDC on gmtrade @ **120.3%**" → "@ **118.7%**"), so you can't track it by string. The
**stable stem** strips all volatile numbers and suffixes; the **stable fingerprint** is the first
12 hex of `md5(category | stem)`.

It is implemented **three times and must stay byte-identical**:

1. `realization/realization.sql` — `stable_stem()` / `stable_fp()` (SQL)
2. `scanner/src/index.js` — `stableStemJs()` / `stableFpJs()` (JS, for the feedback read)
3. `dashboard/server.mjs` — same (JS, for the 24h diff and favorites)

A repo test (`node integrations/check-fp-parity.mjs`, if present, or the dev-agent's parity
check) verifies the JS and SQL produce identical fingerprints on live rows. If you change the
stem in one place, change it in all three or you silently detach history.

## Why zero dependencies

The scanner and dashboard use only Node's standard library (`node:http`, `node:crypto`,
`fetch`). This is deliberate: a yield engine that pulls in 300 npm packages has a 300-package
supply-chain attack surface pointed at code that reads financial data. The only third-party
dependency in the whole system is `pg` (Postgres client), used solely by the ingest scripts.

## Failure philosophy

Every external dependency degrades to "less data," never "crash":

- Postgres down → ranking proceeds ungated, dashboard renders without receipts, both log it.
- A scanner module throws → that category is omitted, the scan still completes and exits 0.
- Telegram unreachable → alerts retry next scan (marks persist only on confirmed delivery).
- A data file goes stale → the dashboard's status strip turns it red within one check-in.

The one thing the system refuses to do is **show stale data as fresh**. That failure mode (a
frozen model still reporting `ready: true`) is what the realization layer, the staleness gates,
and the module-freshness strip all exist to prevent.
