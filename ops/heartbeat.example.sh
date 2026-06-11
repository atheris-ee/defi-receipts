#!/usr/bin/env bash
# Heartbeat example — adapt service/timer names to your install.
# Alerts go straight to Telegram via curl, with per-condition dedup.
# Dedup: each condition alerts at most once per 6h (state in /var/lib/claude-heartbeat).
set -u
export PATH=/run/current-system/sw/bin:$PATH

STATE_DIR="${HEARTBEAT_STATE_DIR:-$(dirname "$0")/../state/heartbeat}"
LOG="$STATE_DIR/heartbeat.log"
mkdir -p "$STATE_DIR"

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(cat "${TELEGRAM_BOT_TOKEN_FILE:-./secrets/telegram-bot-token}" 2>/dev/null)}"
CHAT_ID="${TELEGRAM_CHAT_ID:?set TELEGRAM_CHAT_ID}"
REALERT_SECS=$((6 * 3600))
NOW=$(date +%s)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

send_tg() {
    local text="$1"
    [[ -z "$BOT_TOKEN" ]] && return 1
    curl -s --max-time 15 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=$CHAT_ID" \
        --data-urlencode "text=$text" >/dev/null 2>&1
}

# --- collect conditions -------------------------------------------------------------------------
declare -a CONDS=()

load=$(awk '{print $1}' /proc/loadavg)
mem=$(free | awk '/Mem:/{printf "%.0f", $3/$2*100}')
disk=$(df / | awk 'NR==2{print $5}' | tr -d %)
(( mem > 85 ))  && CONDS+=("mem:${mem}%")
(( disk > 90 )) && CONDS+=("disk:${disk}%")
awk -v l="$load" 'BEGIN{exit !(l > 8)}' && CONDS+=("load:${load}")

for svc in ${HEARTBEAT_SERVICES:-sshd postgresql receipts-dashboard}; do
    systemctl is-active "$svc" >/dev/null 2>&1 || CONDS+=("svc-down:$svc")
done
for tmr in ${HEARTBEAT_TIMERS:-receipts-scan.timer receipts-archive.timer receipts-digest.timer}; do
    systemctl is-active "$tmr" >/dev/null 2>&1 || CONDS+=("timer-down:$tmr")
done

# Data freshness: the scanner writes latest_report.json every 5 min; >30 min stale means the
# pipeline is broken even if every unit reports active.
REPORT="${RECEIPTS_DATA_DIR:-$(dirname "$0")/../scanner/data}/latest_report.json"
if [[ -f "$REPORT" ]]; then
    age=$(( NOW - $(stat -c %Y "$REPORT") ))
    (( age > 1800 )) && CONDS+=("report-stale:$((age/60))min")
else
    CONDS+=("report-missing")
fi

${RECEIPTS_PSQL:-psql -d defi -U defi} -tAc 'SELECT 1' >/dev/null 2>&1 || CONDS+=("postgres-query-failed")
curl -s --max-time 10 -o /dev/null http://127.0.0.1:${DASHBOARD_PORT:-8847}/ || CONDS+=("dashboard-http-failed")

# --- log + dedup + alert ------------------------------------------------------------------------
cond_str="${CONDS[*]:-}"
echo "$TS load=$load mem=${mem}% disk=${disk}%${cond_str:+ ALERT:[$cond_str]}" >> "$LOG"
# Trim the log when it grows past ~1MB (288 lines/day steady state).
if (( $(stat -c %s "$LOG") > 1048576 )); then
    tail -n 5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

ALERT_LINES=()
for c in "${CONDS[@]:-}"; do
    [[ -z "$c" ]] && continue
    key=$(echo "$c" | tr -c 'A-Za-z0-9' '_')
    stamp_file="$STATE_DIR/alerted-$key"
    last=0
    [[ -f "$stamp_file" ]] && last=$(cat "$stamp_file" 2>/dev/null || echo 0)
    if (( NOW - last > REALERT_SECS )); then
        ALERT_LINES+=("$c")
        echo "$NOW" > "$stamp_file"
    fi
done

if (( ${#ALERT_LINES[@]} > 0 )); then
    send_tg "🚨 VPS3 heartbeat ($TS)
$(printf '%s\n' "${ALERT_LINES[@]}")
load=$load mem=${mem}% disk=${disk}%"
fi

# Recovery notice: conditions just went from some to none.
if [[ -z "$cond_str" && -f "$STATE_DIR/was-failing" ]]; then
    rm -f "$STATE_DIR/was-failing" "$STATE_DIR"/alerted-*
    send_tg "✅ VPS3 heartbeat: all checks green again ($TS)"
elif [[ -n "$cond_str" ]]; then
    touch "$STATE_DIR/was-failing"
fi
