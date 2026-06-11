#!/usr/bin/env bash
# Copies the defi-tracker's scan output into a dated archive each fire so
# Hermes (or anyone) can SQL/grep across history rather than just the latest scan.
set -u
SRC="${RECEIPTS_DATA_DIR:-$(dirname "$0")/../scanner/data}"
ARCHIVE="${ARCHIVE_DIR:-$(dirname "$0")/../archive}"
[ -d "$SRC" ] || exit 0

# Read the scan's own timestamp (UTC) from latest_report.json so all files
# in this archive dir share the scan's real time, not the timer's fire time.
TS=$(node -e 'try{const r=require("'"$SRC"'/latest_report.json"); process.stdout.write(r.timestamp || new Date().toISOString())}catch{process.stdout.write(new Date().toISOString())}' 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
DATE=${TS%%T*}
HM=$(echo "$TS" | sed -E 's/.*T([0-9]+):([0-9]+):.*/\1\2/')
DEST="$ARCHIVE/$DATE/$HM"

# Idempotent: skip if this exact scan timestamp is already archived.
if [ -d "$DEST" ]; then
  exit 0
fi

mkdir -p "$DEST"
cp "$SRC"/*.json "$DEST/" 2>/dev/null
echo "$TS" > "$DEST/.scan_ts"

# Rotate: keep last 30 days. Only date-named dirs are eligible — an unconstrained find would
# eventually rm -rf .logs/ (and anything else living at the top level) once it aged past 30 days.
find "$ARCHIVE" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' -mtime +30 -exec rm -rf {} \; 2>/dev/null

# Brief log entry to ops log
mkdir -p "$ARCHIVE/.logs"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) archived scan ts=$TS to $DEST" >> "$ARCHIVE/.logs/archive.log"

# Ingest into Postgres (idempotent; skips if scan_ts already loaded).
# Ingest failures FAIL the unit so they're visible in journalctl/systemd — an earlier `|| true`
# here swallowed every error, which is exactly how the matview refresh stayed broken for days.
FAILED=""
INGEST_DIR="$(dirname "$0")/../realization"
if [ -f "$INGEST_DIR/ingest.mjs" ]; then
  cd "$INGEST_DIR" && \
    node ingest.mjs "$DEST" >> "$ARCHIVE/.logs/archive.log" 2>&1 || FAILED="$FAILED ingest.mjs"
fi

# Ingest the full opportunity pool too, so EVERY dashboard row (not just curated picks) gets
# realization history. Idempotent; refreshes the opportunity_realization matview.
if [ -f "$INGEST_DIR/pool-ingest.mjs" ]; then
  cd "$INGEST_DIR" && \
    node pool-ingest.mjs "$DEST" >> "$ARCHIVE/.logs/archive.log" 2>&1 || FAILED="$FAILED pool-ingest.mjs"
fi

if [ -n "$FAILED" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) INGEST FAILED:$FAILED (scan $TS) — see archive.log" >&2
  exit 1
fi
