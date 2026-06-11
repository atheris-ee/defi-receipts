# Data dictionary

## `scanner/data/latest_report.json`

The ranked output of one scan.

| Field | Type | Meaning |
|---|---|---|
| `timestamp` | ISO string | scan time (UTC); the scan's true identity for archive/ingest |
| `version` | string | engine version |
| `capitalUsd` | number\|null | capital model used for sizing (null = unlimited) |
| `summary` | object | per-category counts (`total_yield`, `total_arb`, …) |
| `top_strategies[]` | array | the ranked opportunities (below) |

### `top_strategies[]` entry

| Field | Type | Meaning |
|---|---|---|
| `rank` | number | 1-based rank after dedup + realization penalty |
| `category` | string | YIELD, ARB, CARRY, FREE_CARRY, SPREAD, CLM, RECURSIVE, FREE_LOOP, FUNDING, LIQUIDATION, FLASH_ARB, DEPEG_ARB, ALPHA, FARMABLE_7D |
| `action` | string | human-readable instruction; **embeds live numbers** (don't key on it — see `stable_fp`) |
| `expectedReturn` | string | headline return, e.g. `"197.0% APY headline"` or `"$6.13 per trade"` |
| `risk` | string | `"N/10"` |
| `profitScore` | number | normalized, risk-adjusted score used for ranking (~0–600 scale) |
| `tvl` | string | formatted TVL of the destination pool |
| `minCapitalUsd` | number | minimum economical capital |
| `tvlFlight` | number? | present **only** if the realization layer flagged this as a trap; the % TVL change since first sighting (negative). Risk is floored and score cut when set. |
| `bagTrap` / `lowTvl` / `microPool` / `volatileLp` / `riskyLp` | bool? | structural risk flags from the hunters |
| `nonMajorToken` | bool? | a leg is not a major/stable/forex-commodity asset — demoted, excluded from alerts (blue-chip preference) |
| `cedefi` / `rwaCredit` | bool? | counterparty/credit nature flags |
| `sameChain` / `hardBridge` / `nonEvmBridge` | bool? | execution-complexity flags |
| `alphaType` | string? | for ALPHA: FRESH_INCENTIVE, RESURRECTED_EXTREME, PENDLE_BASIS, SYNTHETIC_SHORT, COMPOSABLE_STACK |
| `alphaReason` | string? | for ALPHA: the thesis + suggested exit trigger |

## `opportunity_realization` (Postgres matview) — the receipts

One row per `stable_fp`. This is the outcome record the whole system is built around.

| Column | Type | Meaning |
|---|---|---|
| `sfp` | text | stable fingerprint = `md5(category \| stable_stem(action))[:12]` — the identity |
| `category` | text | category at first sighting |
| `chain` | text | normalized chain (often null; ~half of rows) |
| `sightings` | int | how many scans this identity has appeared in |
| `first_seen` / `last_seen` | timestamptz | from `realization_baselines` (first) and current data (last) |
| `days_obs` | numeric | observation span in days (last − first) |
| `entry_apy` | numeric | APY at **first sighting** (from the never-pruned baselines table) |
| `current_apy` / `avg_apy` / `peak_apy` | numeric | latest / mean / max APY observed |
| `tvl_entry` / `tvl_now` | numeric | TVL at first sighting / latest |
| `apy_retention` | numeric | `avg_apy / entry_apy` — 1.0 = held, <1 = decayed, >1 = grew. The durability metric. |
| `tvl_change_pct` | numeric | `(tvl_now − tvl_entry) / tvl_entry × 100`. **≤ −50 while yield holds = trap.** |
| `still_live` | bool | seen in the most recent ~15 min of scans |
| `avg_risk` / `avg_score` | numeric | mean risk / profit-score across sightings |
| `sample_action` | text | a representative action string (for display) |

### Derived classifications (used across the system, same thresholds everywhere)

- **Trap:** `tvl_change_pct ≤ −50`. Auto-demoted in ranking, flagged on the dashboard, never
  alerted.
- **Survivor ("safe anchor"):** `still_live AND days_obs ≥ 7 AND apy_retention ≥ 0.85 AND
  tvl_change_pct ≥ −10`.
- **Proven (for board promotion):** `days_obs ≥ 2 AND apy_retention` known — newer entries are
  shown but marked `NEW`.

## `strategies` (Postgres table)

Every opportunity from every scan, append-only (30-day prune on `scans`). Columns mirror a
`top_strategies` entry plus `scan_ts`, `stable_fp`, `fingerprint` (volatile per-scan id),
`return_pct`, and the raw JSON. This is the source the matview aggregates and the 24h diff reads.

## `realization_baselines` (Postgres table)

One row per `stable_fp` capturing **first-sighting** `entry_apy`, `tvl_entry`, `first_seen`.
Upserted `ON CONFLICT (sfp) DO NOTHING` and **never pruned**, so entry baselines survive after raw
`strategies` rows age out. Deleting from this table corrupts every retention/TVL-change number.
