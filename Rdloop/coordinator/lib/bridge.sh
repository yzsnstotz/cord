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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORD_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BRIDGELOG_DIR="${BRIDGELOG_DIR:-${CORD_ROOT}/bridgelog}"
BRIDGELOG_FILE="${BRIDGELOG_DIR}/claude_bridge_comm.log"
mkdir -p "$BRIDGELOG_DIR" 2>/dev/null || true

bridge_log_json() {
  local event="$1"
  local provider="${2:-}"
  local payload="${3:-{}}"
  python3 - "$BRIDGELOG_FILE" "$event" "$provider" "$payload" <<'PY' 2>/dev/null || true
import json, sys, datetime
log_file, event, provider, payload_raw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    payload = json.loads(payload_raw)
except Exception:
    payload = {"payload_raw": payload_raw}
entry = {
    "ts": datetime.datetime.utcnow().isoformat(timespec="milliseconds") + "Z",
    "event": event,
    "source": "solo_bridge",
    "provider": provider or None,
    **payload
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
PY
}

echo "[BRIDGE] Started. provider=${PROVIDER} session_dir=${SESSION_DIR} fresh=${FRESH_PER_STEP}"
bridge_log_json "solo_bridge_started" "${PROVIDER}" "session_dir=${SESSION_DIR} attempt_dir=${ATTEMPT_DIR} fresh_per_step=${FRESH_PER_STEP}"

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
  local cwd
  cwd=$(python3 -c "import json; print(json.load(open('${SESSION_DIR}/../../task.json')).get('repo_path','.'))" 2>/dev/null || echo ".")
  [ -z "$cwd" ] && cwd="."
  [ -d "$cwd" ] || cwd="."
  local instruction_preview
  instruction_preview=$(printf "%s" "$instruction" | head -c 4000 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"\"")
  bridge_log_json "solo_bridge_request_dispatch" "${PROVIDER}" "request_file=${request_file} response_file=${response_file} cwd=${cwd} instruction_preview=${instruction_preview}"

  local rc=0
  case "$PROVIDER" in
    claude)
      # Claude CLI: -p for prompt, --cwd for working directory
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
      codex exec --ephemeral --full-auto -C "$cwd" - < "$instruction_file" \
        2>&1 | tee "$step_log" > "${SESSION_DIR}/_raw_output.txt"
      rc=${PIPESTATUS[0]}
      set -e
      ;;
    cursor)
      local task_json model
      task_json="${SESSION_DIR}/../../task.json"
      model=$(python3 -c "
import json
try:
  m=str(json.load(open('${task_json}')).get('coder_model','')).strip()
  print(m)
except:
  print('')
" 2>/dev/null || echo "")
      set +e
      if [ -n "$model" ]; then
        cursor-agent --print --output-format text --force --trust --workspace "$cwd" --model "$model" "$(cat "$instruction_file")" \
          2>&1 | tee "$step_log" > "${SESSION_DIR}/_raw_output.txt"
      else
        cursor-agent --print --output-format text --force --trust --workspace "$cwd" "$(cat "$instruction_file")" \
          2>&1 | tee "$step_log" > "${SESSION_DIR}/_raw_output.txt"
      fi
      rc=${PIPESTATUS[0]}
      set -e
      ;;
    antigravity|gemini)
      local task_json ccb_root ccb_session_file ccb_run_dir
      task_json="${SESSION_DIR}/../../task.json"
      ccb_root=$(python3 -c "
import json, os
task='${task_json}'
repo='.'
try:
  with open(task) as f:
    repo=str(json.load(f).get('repo_path') or '.')
except Exception:
  pass
repo=os.path.abspath(repo)
p=repo
while True:
  if os.path.isdir(os.path.join(p,'.ccb')):
    print(p); break
  pp=os.path.dirname(p)
  if pp==p:
    print(repo); break
  p=pp
" 2>/dev/null || echo "$cwd")
      ccb_session_file="${ccb_root}/.ccb/.gemini-session"
      ccb_run_dir="${ccb_root}/.ccb/run"
      mkdir -p "$ccb_run_dir" 2>/dev/null || true
      if ! command -v gask >/dev/null 2>&1; then
        rc=127
        cat > "${SESSION_DIR}/_raw_output.txt" <<EOF
[BRIDGE][gemini] gask command not found in PATH.
EOF
      else
        set +e
        CCB_GASKD_AUTOSTART=1 CCB_RUN_DIR="$ccb_run_dir" CCB_SESSION_FILE="$ccb_session_file" \
          gask --output "${SESSION_DIR}/_raw_output.txt" --timeout 600 "$(cat "$instruction_file")" > "$step_log" 2>&1
        rc=$?
        set -e
        if [ "$rc" -ne 0 ]; then
          cat > "${SESSION_DIR}/_raw_output.txt" <<EOF
[BRIDGE][gemini] gask execution failed (rc=${rc}).
The Gemini executor in solo bridge requires CCB daemon/session readiness.
Check: ccb gemini / ccb-ping gemini / session file ${ccb_session_file}
EOF
        fi
      fi
      cat "${SESSION_DIR}/_raw_output.txt" | tee -a "$step_log" > /dev/null
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
  local response_preview
  response_preview=$(cat "${response_file}" 2>/dev/null | head -c 4000 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"\"")
  bridge_log_json "solo_bridge_response_written" "${PROVIDER}" "response_file=${response_file} rc=${rc} response_preview=${response_preview}"
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
      bridge_log_json "solo_bridge_request_detected" "${PROVIDER}" "iteration=${iteration} request_mtime=${req_mtime}"
      dispatch_to_agent "${SESSION_DIR}/request.json" "${SESSION_DIR}/response.json" "${step_dir}/agent.log"
      echo "[BRIDGE] Response written for iteration=${iteration}"
    fi
  fi

  sleep 2
done

echo "[BRIDGE] Exiting."
bridge_log_json "solo_bridge_exiting" "${PROVIDER}" "session_dir=${SESSION_DIR}"
