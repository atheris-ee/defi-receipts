# defi-receipts

**A DeFi opportunity engine that grades itself on what actually happened — not what it promised.**

> [!NOTE]
> **Status (July 2026):** this repo is a sanitized snapshot of the production engine as of
> June 2026 and is not auto-synced. The live system has evolved since (adversarial pick
> verification, decay priors, verdict-gated ranking). A refreshed release will follow once
> the current measurement cycle completes.

Most yield dashboards show you a 197% APY and move on. They never tell you that the pool's
liquidity fled the next day, that the "headline" rate reverted within 72 hours, or that the
same opportunity has died and resurrected six times this month. `defi-receipts` is built around
the opposite premise: **every opportunity it has ever surfaced is tracked to its outcome**, and
those outcomes feed back into the ranking. The result is a system whose recommendations come
with a verifiable track record attached.

> Yields are a promise. Receipts are what you actually got. This engine keeps the receipts.

---

## What it does

A scanner sweeps DeFi yield, arbitrage, funding, carry, liquidation and concentrated-LP
opportunities across 8+ chains every 5 minutes (data from DefiLlama, DEX aggregators, perp
venues). Each opportunity is given a **stable identity** that survives its numbers changing, so
the system can follow the *same* opportunity across thousands of scans and record what happened
to it: did the APY hold, or decay? Did liquidity grow, or flee? How many days did it survive?

That outcome history — the **realization layer** — is then fed back into ranking. An opportunity
whose liquidity has fled 50%+ while its yield "held" (the classic exit-liquidity trap) is
automatically demoted, flagged, and excluded from alerts, no matter how attractive its headline
number. Opportunities that have *proven* durability over 7+ days surface as the "safe anchor."

On top of the engine:

- A **dashboard** that leads with a daily decision view (entry windows, what changed in 24h,
  exit signals on your watchlist, a retention-gated board) instead of a 200-row table.
- A **Telegram alerter** tuned for signal, not noise (0–4 messages/day, not 124).
- A self-improving **dev-agent loop** that proposes ranking-accuracy patches backed by queries
  against the outcome database — every proposal must cite the historical evidence, and a human
  reviews before anything ships.
- First-class **AI-agent operability**: an [agent skill](agent/SKILL.md), an
  [`AGENTS.md`](AGENTS.md), an [`llms.txt`](llms.txt), and a minimal [MCP server](integrations/mcp/)
  so another agent can query the engine's opportunities and receipts directly.

## Why this is different

| Typical yield tool | defi-receipts |
|---|---|
| Ranks by headline APY | Ranks by headline APY **× measured retention**, trap-penalized |
| Each scan is stateless | Every opportunity tracked to outcome across 22+ days |
| "197% APY!" | "197% headline → fell to 61% of entry over 11d, liquidity −72%, this is a trap" |
| Survivorship-blind | Knows that CARRY plays die in ~1.3 days and LIQUIDATION lasts ~21 |
| Alerts on everything | Alerts only on what cleared a gate and isn't a known trap |
| You trust the number | You audit the receipt |

This is **research and signal infrastructure**, not an auto-trader. It tells you what's worth
your attention and shows its work. Capital execution is deliberately out of scope (see
[Scope & safety](#scope--safety)).

## The thesis: a fund built on receipts

The "alpha" in DeFi yield isn't a secret pool — it's *survivorship discipline*. The reason most
yield-chasing underperforms is that it enters durable-looking traps and holds through decay.
A system that has measured the outcome of 1,500+ opportunities over weeks can make that
discipline mechanical:

- **Provable track record.** Because every recommendation is logged with a stable identity and
  graded against what happened, the engine's historical calls are *auditable*, not anecdotal.
  This is the foundation a transparent, on-chain-auditable yield strategy could be built on —
  a fund whose every position decision is reproducible from public data and timestamped logic.
- **Forkable.** The whole engine is here. Clone it, point it at your own database, run your own
  receipts. The [MCP server](integrations/mcp/) and [HTTP API](#http-api) let other systems —
  including AI agents allocating capital — consume the engine's graded opportunities
  programmatically.
- **Honest about its stage.** See [docs/VISION.md](docs/VISION.md) for the full framing,
  including what is proven (the realization plumbing, the trap detection) and what needs more
  time (whether retention-gating *improves realized returns* — a 22-day dataset validates the
  method, not yet the edge).

**This repository is software and research, not financial advice or a solicitation to invest.**
Nothing here is an offer of securities. See [docs/VISION.md](docs/VISION.md#legal) and
[Scope & safety](#scope--safety).

## Quickstart

Requirements: Node.js 22+, PostgreSQL 14+ (no other dependencies — the scanner and dashboard
use zero npm packages; only the Postgres ingest uses `pg`).

```bash
git clone https://github.com/atheris-ee/defi-receipts.git
cd defi-receipts
cp .env.example .env            # edit: at minimum nothing is required to scan read-only

# 1. Run one scan (writes scanner/data/*.json — no database needed for this)
node scanner/src/index.js scan

# 2. See the ranked report
node -e "const r=require('./scanner/data/latest_report.json'); console.table((r.top_strategies||[]).slice(0,10).map(s=>({cat:s.category,action:s.action.slice(0,48),ret:s.expectedReturn,risk:s.risk})))"

# 3. (optional) Stand up the realization layer for receipts
createdb defi
psql -d defi -f realization/realization.sql
bash ops/archive-scan.sh                      # archive this scan + ingest into Postgres
#   ...let the scanner + archive run on a schedule for a few days to accumulate history

# 4. (optional) Run the dashboard
node dashboard/server.mjs                      # http://localhost:8847
```

For a production install (systemd timers, scheduled scans, the alerter, the dev-agent loop) see
[docs/DEPLOY.md](docs/DEPLOY.md). For the full data-flow and concepts see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository layout

```
scanner/        The opportunity engine — yields, arb, carry, funding, CLM, liquidation, flash-arb,
  src/          alpha hunters. Zero npm deps. `node src/index.js scan` writes data/*.json.
  config/       settings.json — thresholds, chains, API endpoints.
realization/    The receipts. realization.sql defines the stable-identity matview; ingest.mjs +
                pool-ingest.mjs load each archived scan into Postgres and refresh outcomes.
dashboard/      Server-rendered web UI (zero deps). / = daily decision view, /all = full table.
alerting/       defi-tg-alerts.mjs — unified Telegram lane (instant + daily digest), gated + deduped.
agent/          The self-improving dev-agent loop: MANDATE.md, tick.sh, and SKILL.md for *operating*
                the engine from another AI agent.
ops/            archive-scan.sh, heartbeat example, systemd unit templates.
integrations/   MCP server + HTTP API notes for programmatic / agent access.
docs/           ARCHITECTURE, VISION (the fund framing), DEPLOY, DATA-DICTIONARY.
AGENTS.md       Top-level operating guide for AI coding agents.
llms.txt        Machine-readable index for LLM discovery.
```

## Core concepts (the 60-second version)

- **Stable fingerprint (`stable_fp`)** — `md5(category | normalized_action).slice(0,12)`. The
  action text embeds live numbers ("...@ 197.0%"); the fingerprint strips them so the *same*
  opportunity keeps one identity across scans even as its APY moves. This identity is the spine
  of the whole system and is computed identically in three places (scanner JS, dashboard JS, and
  SQL) — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#stable-identity).
- **Realization (`opportunity_realization`)** — a Postgres materialized view keyed by `stable_fp`
  holding `apy_retention`, `tvl_change_pct`, `days_obs`, `sightings`, `still_live` for every
  identity ever seen. This is the receipt.
- **TVL-flight trap** — yield held while liquidity fled ≥50%. Auto-demoted, flagged, never
  alerted. The single most valuable signal the realization layer produces.
- **Survivorship gates** — categories have measured median lifespans (LIQUIDATION ~21d, FUNDING
  ~15d, CLM ~9d … CARRY ~1.3d, SHORT_FARM ~0.3d). Sub-2-day categories never headline; they're
  noise for a human who checks once a day.
- **Decay model** — empirical P(APY falls >10% in 72h) by APY band (~12% for <15% pools, ~53%
  for >80% pools). High-APY headline numbers are shown with their predicted reversion.

## HTTP API

The dashboard exposes machine-readable endpoints (bind it where you like; it's localhost by
default):

- `GET /data.json` — the full current scan: ranked strategies with realization fields, wallets,
  portfolios.
- `GET /health` — liveness.

For richer programmatic access (query opportunities by category/chain, pull a specific
identity's receipt, subscribe an agent), use the [MCP server](integrations/mcp/).

## Scope & safety

- **Read-only by design.** The published engine scans, ranks, and reports. The capital-execution
  module is intentionally **not** included in this repository.
- **No secrets in this repo.** All credentials (RPC keys, Telegram tokens, any wallet files) are
  loaded from environment variables or local `secrets/` files that are git-ignored. See
  [.env.example](.env.example).
- **Bring your own keys.** Public RPCs and DefiLlama work out of the box for read-only scanning;
  a paid RPC (e.g. DRPC) and a Telegram bot are optional and configured via env.
- **This is research tooling.** DeFi is risky; smart contracts get exploited; "blue chip" is not
  "safe." Nothing here is financial advice. You are responsible for your own capital.

## License

[MIT](LICENSE). Use it, fork it, build a fund on it — keep your receipts.

## Contributing

Issues and PRs welcome. If you're an AI agent, start with [AGENTS.md](AGENTS.md). If you're
extending the ranking, the bar is the same one the dev-agent loop holds itself to: **every
ranking change must be backed by a query against the realization data showing the historical
outcome it improves.** Opinions are cheap; receipts aren't.
