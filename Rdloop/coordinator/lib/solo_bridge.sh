#!/usr/bin/env bash
# solo_bridge.sh — Provider-agnostic bridge for solo agent mode
# Runs in visible tmux pane. Coordinator communicates via JSON files.
#
# Usage: solo_bridge.sh <provider> <session_dir> <attempt_dir> [--fresh-per-step]
#
# Protocol:
#   Coordinator writes: <session_dir>/request.json (with newer mtime than response)
#   Bridge detects new request, sends to agent, writes <session_dir>/response.json
#   Coordinator writes: <session_dir>/control.json {"action":"exit"} to terminate

set -euo pipefail

PROVIDER="$1"
SESSION_DIR="$2"
ATTEMPT_DIR="$3"
FRESH_PER_STEP=false
[ "${4:-}" = "--fresh-per-step" ] && FRESH_PER_STEP=true

SESSION_FILE="${SESSION_DIR}/agent.session"
LAST_REQUEST_MTIME=0

echo "[BRIDGE] Started. provider=${PROVIDER} session_dir=${SESSION_DIR} fresh=${FRESH_PER_STEP}"

dispatch_to_agent() {
  local request_file="$1"
  local response_file="$2"
  local step_log="$3"

  local instruction
  instruction=$(python3 -c "import json; print(json.load(open('${request_file}')).get('instruction',''))" 2>/dev/null || echo "")

  local instruction_file="${SESSION_DIR}/_current_instruction.md"
  echo "$instruction" > "$instruction_file"

  local session_flag=""
  if [ "$FRESH_PER_STEP" = "false" ] && [ -f "$SESSION_FILE" ]; then
    session_flag="--session-file ${SESSION_FILE}"
  fi

  local rc=0
  case "$PROVIDER" in
    claude)
      # Claude CLI: -p for prompt, --cwd for working directory
      local cwd
      cwd=$(python3 -c "import json; print(json.load(open('${SESSION_DIR}/../../../task.json')).get('repo_path','.'))" 2>/dev/null || echo ".")
      set +e
      claude -p "$(cat "$instruction_file")" \
        --cwd "$cwd" \
        --dangerously-skip-permissions \
        --output-format text \
        2>&1 | tee "$step_log" > "${SESSION_DIR}/_raw_output.txt"
      rc=${PIPESTATUS[0]}
      set -e
      ;;
    codex)
      set +e
      codex --prompt "$(cat "$instruction_file")" \
        --auto-edit \
        2>&1 | tee "$step_log" > "${SESSION_DIR}/_raw_output.txt"
      rc=${PIPESTATUS[0]}
      set -e
      ;;
    *)
      echo "[BRIDGE] Unknown provider: ${PROVIDER}" >&2
      echo '{"self_eval":"dead_loop","summary":"Unknown provider: '"${PROVIDER}"'"}' > "$response_file"
      return 1
      ;;
  esac

  # Extract structured JSON from agent output (last JSON block)
  python3 -c "
import json, re, sys

raw = open('${SESSION_DIR}/_raw_output.txt').read()

# Find last JSON block in output
matches = list(re.finditer(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', raw, re.DOTALL))
parsed = None
for m in reversed(matches):
    try:
        candidate = json.loads(m.group())
        if 'self_eval' in candidate or 'step_completed' in candidate:
            parsed = candidate
            break
    except: continue

if parsed is None:
    # Agent didn't produce structured output — wrap raw output
    parsed = {
        'step_completed': 'unknown',
        'self_eval': 'partial' if ${rc} == 0 else 'dead_loop',
        'confidence': 0.5,
        'summary': raw[-500:] if len(raw) > 500 else raw,
        'files_modified': [],
        'issues': [],
        'next_action': 'fix_and_retry',
        'knowledge_entries': {}
    }

json.dump(parsed, open('${response_file}', 'w'), indent=2)
" 2>/dev/null || echo '{"self_eval":"dead_loop","summary":"Failed to parse agent output"}' > "$response_file"
}

# Main loop: watch for new requests
while true; do
  # Check for exit signal
  if [ -f "${SESSION_DIR}/control.json" ]; then
    action=$(python3 -c "import json; print(json.load(open('${SESSION_DIR}/control.json')).get('action',''))" 2>/dev/null || echo "")
    if [ "$action" = "exit" ]; then
      echo "[BRIDGE] Received exit signal."
      break
    fi
  fi

  # Check for new request (request.json newer than response.json)
  if [ -f "${SESSION_DIR}/request.json" ]; then
    req_mtime=$(stat -f%m "${SESSION_DIR}/request.json" 2>/dev/null || stat -c%Y "${SESSION_DIR}/request.json" 2>/dev/null || echo 0)
    resp_mtime=0
    [ -f "${SESSION_DIR}/response.json" ] && resp_mtime=$(stat -f%m "${SESSION_DIR}/response.json" 2>/dev/null || stat -c%Y "${SESSION_DIR}/response.json" 2>/dev/null || echo 0)

    if [ "$req_mtime" -gt "$resp_mtime" ] && [ "$req_mtime" -ne "$LAST_REQUEST_MTIME" ]; then
      LAST_REQUEST_MTIME="$req_mtime"
      iteration=$(python3 -c "import json; print(json.load(open('${SESSION_DIR}/request.json')).get('iteration',0))" 2>/dev/null || echo "0")
      step_dir="${SESSION_DIR}/step_$(printf '%03d' "$iteration")"
      mkdir -p "$step_dir"

      echo "[BRIDGE] Processing request iteration=${iteration}"
      dispatch_to_agent "${SESSION_DIR}/request.json" "${SESSION_DIR}/response.json" "${step_dir}/agent.log"
      echo "[BRIDGE] Response written for iteration=${iteration}"
    fi
  fi

  sleep 2
done

echo "[BRIDGE] Exiting."
