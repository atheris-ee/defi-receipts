# Vision: a fund built on receipts

## The problem with DeFi yield

DeFi has no shortage of yield. It has a shortage of *honesty about yield*. Every dashboard,
aggregator, and Telegram alpha group competes to show you the biggest number. None of them owe
you an accounting of what happened after you clicked.

The structural result is that yield-chasing systematically underperforms simple holding, because
the high numbers are disproportionately:

- **Traps** — yield held up while liquidity quietly exited, leaving late entrants as exit
  liquidity.
- **Spikes** — a transient rate that reverts within days, long before a human notices.
- **Ephemeral** — opportunities that exist for hours (most arbitrage, carry, short-farm), not
  the days a person needs to act.

The edge isn't finding a secret pool. **The edge is survivorship discipline** — refusing the
traps, sizing the spikes for their reversion, and ignoring what won't outlive your attention
span. That discipline is hard for humans (the big number is seductive) and easy for a machine
that has *measured the outcomes*.

## What this engine actually proves

`defi-receipts` gives every opportunity a stable identity and grades it against what happened.
After 22 days of operation on its reference deployment, the realization layer holds outcome
records for 1,500+ distinct opportunities. From that data, three things are demonstrated:

1. **Traps are detectable and persistent.** Of opportunities flagged as TVL-flight traps
   (liquidity fled ≥50% while yield held), ~96% stayed trapped over the following day — the flag
   is not noise, and it almost never discards a recoverable play.
2. **Survivorship is category-structural.** Median lifespans cluster hard by category
   (LIQUIDATION ~21d, ARB ~18d, FUNDING ~15d, CLM ~9d vs CARRY ~1.3d, NAV-arb ~0.5d,
   short-farm ~0.3d). A system can mechanically route attention to the durable categories.
3. **Decay is bandable.** The probability that an APY falls >10% within 72 hours rises
   monotonically with the headline rate (~12% for sub-15% pools, ~53% for >80% pools). High
   numbers can be shown with their expected reversion instead of at face value.

## What it does *not* yet prove

Honesty is the whole point, so: **22 days validates the method, not the edge.** We have shown the
plumbing works and the trap detection is real. We have *not* yet shown — with statistical
confidence — that retention-gated ranking produces better *realized returns* than naive
APY-ranking over a full market cycle. Opportunity median lifespan is ~6.6 days and retention is
measured over 7+ day windows, so a meaningful return comparison needs months, not weeks, and
ideally a bear leg. The repository ships the measurement apparatus to *settle that question in
public*, not a claim that it's settled.

## The fund thesis

If a system can keep auditable receipts on every yield decision, it can support a category of
fund that DeFi mostly lacks: **a transparent, reproducible-from-public-data yield strategy.**

- **Every allocation decision is logged** with a stable identity, a timestamp, and the exact
  ranking logic (which is open source, in this repo). An auditor — or an investor — can replay
  the decision from public DefiLlama/on-chain data and the commit history.
- **The track record is the product.** Not a backtest (which is curve-fitted by definition), but
  a forward, timestamped, public log of "here is what the engine recommended, here is what
  happened." That log either earns trust or it doesn't, in the open.
- **Capital execution stays separate.** This open-source repo is the *research and grading*
  engine. A fund built on it would add an execution layer (deliberately not published here) and
  custody — but the *decisions* would remain reproducible from the open engine.

### How others could participate

The repository is structured so the engine is **forkable and consumable**, several ways:

- **Run your own.** Clone, point it at your Postgres, accumulate your own receipts. Your fund,
  your discipline, your audit trail.
- **Consume the signal.** The [MCP server](../integrations/mcp/) and `/data.json` HTTP endpoint
  let another system — including an autonomous capital-allocating agent — pull graded
  opportunities and their receipts programmatically.
- **Contribute discipline.** The dev-agent loop's standard applies to all contributors: a
  ranking change ships only with a query proving the historical outcome it improves. The engine
  gets smarter in public, evidence by evidence.

A future direction (not built, explicitly speculative) is an on-chain vault whose rebalance
logic *is* the open ranking engine — depositors could verify that their capital is allocated by
exactly the audited, public logic, with the receipts on a public dashboard. That is the
direction "a fund where users could clone the system" points; this repo is its foundation.

## Legal

This repository is **software and research**. It is **not**:

- financial, investment, legal, or tax advice;
- an offer, solicitation, or recommendation to buy, sell, or hold any asset or security;
- an offer of, or solicitation for, any fund, pooled investment vehicle, or managed account;
- a guarantee of any return, or a representation that past measured outcomes predict future ones.

DeFi protocols carry severe and total-loss risks (smart-contract exploits, oracle failures,
depegs, rug pulls, regulatory action). "Blue chip" reduces but does not remove these risks.
Running this software, and any capital decision informed by it, is entirely at your own risk and
responsibility. Any actual fund, vault, or pooled vehicle would be a separate undertaking
subject to the securities and financial-services laws of the relevant jurisdictions, with its
own disclosures and counsel; nothing in this repository constitutes any part of such an offer.
