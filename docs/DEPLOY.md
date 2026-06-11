# Deploying defi-receipts

The engine is file/SQL-driven and has almost no moving parts. A production install is: schedule
the scanner, schedule the archive+ingest, and (optionally) run the dashboard, alerter, and
dev-agent as long-running/timed services. The reference deployment runs on NixOS with systemd;
templates below are generic systemd.

## 0. Prerequisites

- Node.js 22+
- PostgreSQL 14+
- `cd realization && npm install pg` (the only third-party dependency in the system)

## 1. Database

```bash
createdb defi
psql -d defi -f realization/realization.sql      # functions, baselines table, matview
```

Grant the role your `RECEIPTS_PSQL` uses SELECT on the matview, and INSERT/UPDATE on `strategies`
+ `realization_baselines` for the ingest role.

## 2. Scheduled scan + archive

Scan every 5 minutes; archive+ingest one minute later. With systemd:

`/etc/systemd/system/receipts-scan.service`
```ini
[Service]
Type=oneshot
WorkingDirectory=/opt/defi-receipts
EnvironmentFile=/opt/defi-receipts/.env
ExecStart=/usr/bin/node scanner/src/index.js scan
# Optional: fire the instant Telegram lane right after each scan (no '-' = let failures show;
# the alerter is written to always exit 0 in instant mode so it can't fail the scan):
ExecStartPost=-/usr/bin/node alerting/defi-tg-alerts.mjs instant
```

`/etc/systemd/system/receipts-scan.timer`
```ini
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
```

`receipts-archive.service` / `.timer` — same shape, `ExecStart=/usr/bin/bash ops/archive-scan.sh`,
`OnCalendar=*:1/5` (one minute after each scan). See `ops/systemd/` for ready-to-edit copies.

## 3. Dashboard

`/etc/systemd/system/receipts-dashboard.service`
```ini
[Service]
WorkingDirectory=/opt/defi-receipts
EnvironmentFile=/opt/defi-receipts/.env
ExecStart=/usr/bin/node dashboard/server.mjs
Restart=always
[Install]
WantedBy=multi-user.target
```

Binds `127.0.0.1:${DASHBOARD_PORT:-8847}`. Reach it over an SSH tunnel
(`ssh -L 8847:localhost:8847 host`) or put it behind your own auth proxy — there is no built-in
auth beyond the optional `DASHBOARD_TOKEN`.

## 4. Telegram alerter (optional)

Set `TELEGRAM_BOT_TOKEN` (or `_FILE`) and `TELEGRAM_CHAT_ID` in `.env`. The `instant` lane runs
as the scan's `ExecStartPost` (above). For the daily digest, add a timer:

`receipts-digest.service`: `ExecStart=/usr/bin/node alerting/defi-tg-alerts.mjs digest`
`receipts-digest.timer`: `OnCalendar=07:00`

Dedup state lives in `state/telegram/state.json`. The alerter targets 0–4 messages/day.

## 5. Dev-agent loop (optional, advanced)

The self-improving loop in `agent/` requires the `claude` CLI (or adapt `agent/tick.sh` to your
agent runner). It edits an isolated `agent/workspace/` copy and writes patch proposals to
`agent/workspace/proposals/` — **a human reviews and applies**; it does not touch live `scanner/`.
Schedule `agent/tick.sh` every 15 minutes if you want continuous, evidence-backed ranking
improvements. Read `agent/MANDATE.md` first. This is genuinely optional; the engine is complete
without it.

## 6. Backups

`opportunity_realization` is derived, but `strategies` + `realization_baselines` are your
irreplaceable history. `pg_dump defi | gzip` on a timer, shipped off-box, is enough. The
reference deployment dumps nightly and pulls the dump to a separate machine.

## Operational notes

- **First receipts take days.** The realization layer needs multiple days of scans before
  `apy_retention` / `days_obs` are meaningful. Until then the engine ranks fine, just ungated.
- **`realization_baselines` is never pruned** by design — it anchors entry baselines past the
  30-day `strategies` prune. Don't add a prune to it.
- **Watch one full cycle after any change:** `journalctl -u receipts-scan -f` — a scan should
  exit 0 and (once the DB has history) log a `[REALIZE]` line.
- **Health:** `curl localhost:8847/health`; the dashboard's top status strip turns red on stale
  scans, a stale module, or a Postgres outage.
