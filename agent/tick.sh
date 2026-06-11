#!/usr/bin/env bash
set -u

AGENT_DIR="${RECEIPTS_AGENT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
WORKSPACE="$AGENT_DIR/workspace"
STATE="$AGENT_DIR/state"
TS=$(date -u +%Y%m%d-%H%M%S)
LOG="$AGENT_DIR/logs/tick-$TS.log"

mkdir -p "$WORKSPACE" "$STATE" "$AGENT_DIR/logs"

if [ ! -d "$WORKSPACE/.git" ]; then
    cd "$WORKSPACE" && git init -q
    git config user.email "defi-dev-agent@vps3.local"
    git config user.name "defi-dev-agent"
    [ ! -f README.md ] && echo "# DeFi-Tracker Dev Agent — Workspace" > README.md
    git add -A && git commit -q -m "initial workspace" --allow-empty
fi

PROGRESS=$(tail -200 "$STATE/PROGRESS.md" 2>/dev/null || echo "(empty)")
TODO=$(tail -150 "$STATE/TODO.md" 2>/dev/null || echo "(empty)")
LEARNINGS=$(tail -100 "$STATE/LEARNINGS.md" 2>/dev/null || echo "(empty)")
BLOCKERS=$(tail -60 "$STATE/BLOCKERS.md" 2>/dev/null || echo "(empty)")
GITLOG=$(cd "$WORKSPACE" && git log --oneline -n 12 2>&1)

PROMPT_FILE=$(mktemp)
{
printf '=== defi-tracker-dev-agent tick %s ===\n' "$TS"
printf '=== MANDATE ===\n'
cat "$AGENT_DIR/MANDATE.md"
printf '\n=== STATE: TODO.md ===\n%s\n' "$TODO"
printf '\n=== STATE: PROGRESS.md (tail 200) ===\n%s\n' "$PROGRESS"
printf '\n=== STATE: LEARNINGS.md (tail 100) ===\n%s\n' "$LEARNINGS"
printf '\n=== STATE: BLOCKERS.md (tail 60) ===\n%s\n' "$BLOCKERS"
printf '\n=== recent commits ===\n%s\n' "$GITLOG"
printf '\n=== INSTRUCTION ===\n'
printf "Execute ONE focused tick per the mandate. Sandbox: the agent/ directory ONLY.\n"
printf "COMMIT EARLY: git commit code edits BEFORE long validation runs - a timeout must never strand verified work. If uncommitted changes exist from a prior tick, verify and commit those FIRST before starting anything new.\n"
printf 'Before returning:\n'
printf '  1) Update state files in agent/state/ with dated entries.\n'
printf '  2) cd "$AGENT_DIR/workspace" && git add -A && git commit -m "tick summary" --allow-empty\n'
printf '  3) Print "TICK DONE: brief summary" as your final output line.\n'
} > "$PROMPT_FILE"

cd "$WORKSPACE"
timeout 720 claude -p "$(cat $PROMPT_FILE)" > "$LOG" 2>&1
RC=$?
rm -f "$PROMPT_FILE"

echo "--- tick $TS exit=$RC ---" >> "$AGENT_DIR/logs/summary.log"
tail -3 "$LOG" >> "$AGENT_DIR/logs/summary.log" 2>/dev/null
exit 0
