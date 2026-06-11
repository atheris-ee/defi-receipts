# defi-receipts MCP server

A zero-dependency [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
the engine's graded opportunities and their receipts to any MCP-capable agent over stdio. It is
**read-only** — it reads the latest scan report and queries the realization Postgres view; it
never writes, trades, or moves funds.

## Tools

| Tool | Returns |
|---|---|
| `list_opportunities` | current ranked opportunities (filter by category/chain/maxRisk/minReturnPct); each carries its `stable_fp` and a trap flag if applicable |
| `get_receipt` | the outcome history for one opportunity — APY retention, TVL change since first sighting, days observed, still-live, and a verdict (TRAP / SURVIVOR / tracking) |
| `list_traps` | opportunities flagged as exit-liquidity traps (yield held, TVL fled ≥50%) |
| `list_survivors` | proven-durable opportunities (the "safe anchor" set) |
| `category_survival` | measured median lifespan and retention per category — the survivorship map |

`list_opportunities` works from just a scan report (no database). The receipt/trap/survivor/
survival tools need the realization layer set up (see `docs/DEPLOY.md`); without it they return a
clear "DB not set up" note rather than failing.

## Register it

**Claude Code:**
```bash
claude mcp add defi-receipts -- node /absolute/path/to/defi-receipts/integrations/mcp/server.mjs
```

**Generic MCP client** — run `node integrations/mcp/server.mjs` and speak JSON-RPC 2.0 over
stdio (newline-framed). It implements `initialize`, `tools/list`, `tools/call`.

Configure via the same env as the rest of the repo: `RECEIPTS_DATA_DIR` (where the scanner writes)
and `RECEIPTS_PSQL` (how to reach Postgres).

## Why this exists

The point of `defi-receipts` is that its recommendations come with an auditable track record. The
MCP server makes that track record *consumable by other agents*: an allocator agent can ask "what
are the current durable opportunities, and what is each one's measured retention?" and get graded,
receipt-backed answers — not just headline APYs. It's the programmatic front door to the fund
thesis in `docs/VISION.md`.
