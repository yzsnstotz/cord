#!/usr/bin/env bash
# ccb-agent-status - Check CCB coding agent (askd) and backend run state
#
# Usage:
#   ./ccb-agent-status.sh           # human-readable summary
#   ./ccb-agent-status.sh --json     # JSON output
#   ./ccb-agent-status.sh --ping     # also TCP ping askd (slower)
#
# Checks:
#   - Unified askd: process, state file (~/.cache/ccb/askd.json), optional TCP ping
#   - Legacy per-provider daemons: caskd, gaskd, oaskd, laskd, daskd (if present)
#   - Tmux: whether inside tmux, CCB-related sessions/panes
#   - Project session files in .ccb/ (if CWD has .ccb)

set -euo pipefail

PROVIDERS="codex:caskd gemini:gaskd opencode:oaskd claude:laskd droid:daskd"
RUN_DIR="${CCB_RUN_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ccb}"
FORMAT="text"
DO_PING=false
CWD="$(pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) FORMAT="json"; shift ;;
    --ping) DO_PING=true; shift ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      CWD="$1"
      shift
      ;;
  esac
done
CWD="$(cd "$CWD" 2>/dev/null && pwd)" || CWD="$(pwd)"

# ---------- Helpers ----------
_is_pid_alive() {
  local pid="$1"
  [[ -z "$pid" || "$pid" -le 0 ]] && return 1
  kill -0 "$pid" 2>/dev/null
}

# Check if a process matching the given pattern is running (one line per match).
_pgrep_pattern() {
  local pattern="$1"
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "$pattern" 2>/dev/null || true
  else
    ps -eo pid= -o args= 2>/dev/null | grep -E "$pattern" | awk '{print $1}' || true
  fi
}

# Unified askd: state file and optional ping.
_askd_state_path() {
  echo "${RUN_DIR}/askd.json"
}

_read_json_key() {
  local file="$1" key="$2"
  if [[ -f "$file" ]]; then
    python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    print(d.get(sys.argv[2], '') or '')
except Exception:
    print('')
" "$file" "$key" 2>/dev/null || echo ""
  fi
}

_tcp_ping_askd() {
  local host port token
  local state="$RUN_DIR/askd.json"
  [[ ! -f "$state" ]] && return 1
  host="$(_read_json_key "$state" "connect_host")"
  [[ -z "$host" ]] && host="$(_read_json_key "$state" "host")"
  port="$(_read_json_key "$state" "port")"
  token="$(_read_json_key "$state" "token")"
  [[ -z "$host" || -z "$port" ]] && return 1
  # Send ask.ping and expect ask.pong (Python one-liner for portability).
  python3 -c "
import json, socket, sys
try:
    s = socket.create_connection(('$host', $port), timeout=1.0)
    req = {'type':'ask.ping','v':1,'id':'ping','token':'$token'}
    s.sendall((json.dumps(req) + chr(10)).encode('utf-8'))
    buf = s.recv(1024).decode('utf-8', errors='replace')
    s.close()
    line = buf.split(chr(10))[0]
    r = json.loads(line)
    sys.exit(0 if r.get('type') in ('ask.pong','ask.response') and int(r.get('exit_code') or 1) == 0 else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

# ---------- Gather ----------
# 1) Unified askd
ASKd_STATE="$(_askd_state_path)"
ASKd_PID=""
ASKd_RUNNING=false
ASKd_PING_OK=false
if [[ -f "$ASKd_STATE" ]]; then
  ASKd_PID="$(_read_json_key "$ASKd_STATE" "pid")"
  if _is_pid_alive "$ASKd_PID"; then
    ASKd_RUNNING=true
    if [[ "$DO_PING" == true ]]; then
      _tcp_ping_askd && ASKd_PING_OK=true || true
    fi
  fi
fi
# Also consider "askd" process by name (in case state file is stale)
if [[ "$ASKd_RUNNING" != true ]]; then
  if [[ -n "$(_pgrep_pattern '[p]ython.*askd')" ]] || [[ -n "$(_pgrep_pattern '[b]in/askd')" ]]; then
    ASKd_RUNNING=true
  fi
fi

# 2) Legacy daemons (caskd, gaskd, oaskd, laskd, daskd) - helpers (Bash 3 compatible)
_legacy_daemon_for() {
  case "$1" in
    codex)   echo "caskd" ;;
    gemini)  echo "gaskd" ;;
    opencode) echo "oaskd" ;;
    claude)  echo "laskd" ;;
    droid)   echo "daskd" ;;
    *)       echo "" ;;
  esac
}
_legacy_state_file() {
  local daemon="$(_legacy_daemon_for "$1")"
  [[ -z "$daemon" ]] && return
  echo "${RUN_DIR}/${daemon}.json"
}
_legacy_pid() {
  local prov="$1"
  local state="$(_legacy_state_file "$prov")"
  local daemon="$(_legacy_daemon_for "$prov")"
  [[ -z "$state" || ! -f "$state" ]] && return
  local pid found
  pid="$(_read_json_key "$state" "pid")"
  if _is_pid_alive "$pid"; then
    echo "$pid"
    return
  fi
  found="$(_pgrep_pattern "[b]in/${daemon}\$")"
  [[ -n "$found" ]] && echo "${found%%$'\n'*}"
}
_legacy_running() {
  local pid="$(_legacy_pid "$1")"
  [[ -n "$pid" ]] && _is_pid_alive "$pid"
}

# 3) Tmux
TMUX_INSIDE=false
TMUX_SESSIONS=()
TMUX_CCB_SESSIONS=()
if [[ -n "${TMUX:-}" ]] || [[ -n "${TMUX_PANE:-}" ]]; then
  TMUX_INSIDE=true
fi
if command -v tmux >/dev/null 2>&1; then
  while IFS= read -r line; do
    TMUX_SESSIONS+=("$line")
  done < <(tmux list-sessions -F "#{session_name}" 2>/dev/null || true)
  for s in "${TMUX_SESSIONS[@]}"; do
    [[ "$s" == ccb_* ]] && TMUX_CCB_SESSIONS+=("$s") || true
  done
fi

# 4) Project session files (.ccb/.provider-session)
SESSION_DIR="$CWD/.ccb"
SESSION_LEGACY="$CWD/.ccb_config"
HAS_SESSION=()
for pair in $PROVIDERS; do
  prov="${pair%%:*}"
  case "$prov" in
    claude)  f=".claude-session" ;;
    codex)   f=".codex-session" ;;
    gemini)  f=".gemini-session" ;;
    opencode) f=".opencode-session" ;;
    droid)   f=".droid-session" ;;
    *)       f="" ;;
  esac
  if [[ -n "$f" ]]; then
    if [[ -f "$SESSION_DIR/$f" ]] || [[ -f "$SESSION_LEGACY/$f" ]] || [[ -f "$CWD/$f" ]]; then
      HAS_SESSION+=("$prov")
    fi
  fi
done

# ---------- Output ----------
if [[ "$FORMAT" == "json" ]]; then
  echo "{"
  echo "  \"cwd\": \"$CWD\","
  echo "  \"run_dir\": \"$RUN_DIR\","
  echo "  \"askd\": {"
  echo "    \"state_file\": \"$ASKd_STATE\","
  echo "    \"state_exists\": $([[ -f "$ASKd_STATE" ]] && echo true || echo false),"
  echo "    \"pid\": \"$ASKd_PID\","
  echo "    \"running\": $([[ "$ASKd_RUNNING" == true ]] && echo true || echo false),"
  echo "    \"ping_ok\": $([[ "$ASKd_PING_OK" == true ]] && echo true || echo false)"
  echo "  },"
  echo "  \"legacy_daemons\": {"
  first=true
  for pair in $PROVIDERS; do
    prov="${pair%%:*}"
    pid="$(_legacy_pid "$prov")"
    state="$(_legacy_state_file "$prov")"
    running="false"
    _legacy_running "$prov" && running="true"
    [[ "$first" == true ]] && first=false || echo ","
    echo -n "    \"$prov\": { \"pid\": \"$pid\", \"state_file\": \"$state\", \"running\": $running }"
  done
  echo ""
  echo "  },"
  echo "  \"tmux\": {"
  echo "    \"inside\": $([[ "$TMUX_INSIDE" == true ]] && echo true || echo false),"
  echo "    \"ccb_sessions\": [$(printf '"%s",' "${TMUX_CCB_SESSIONS[@]}" 2>/dev/null | sed 's/,$//')]"
  echo "  },"
  if [[ ${#HAS_SESSION[@]} -gt 0 ]]; then
    echo "  \"project_has_session\": [$(printf '"%s",' "${HAS_SESSION[@]}" | sed 's/,$//')]"
  else
    echo "  \"project_has_session\": []"
  fi
  echo "}"
  exit 0
fi

# Text output
echo "=============================================="
echo "CCB Coding Agent Status"
echo "=============================================="
echo "Run dir:    $RUN_DIR"
echo "CWD:        $CWD"
echo ""
echo "--- Unified askd (serves all providers) ---"
if [[ -f "$ASKd_STATE" ]]; then
  echo "State file: $ASKd_STATE (exists)"
  echo "PID:        ${ASKd_PID:-<none>}"
  if [[ "$ASKd_RUNNING" == true ]]; then
    echo "Process:    running"
    if [[ "$DO_PING" == true ]]; then
      echo "TCP ping:   $([[ "$ASKd_PING_OK" == true ]] && echo "OK" || echo "failed")"
    fi
  else
    echo "Process:    not running (stale state file?)"
  fi
else
  echo "State file: $ASKd_STATE (missing)"
  echo "Process:    not running"
fi
echo ""
echo "--- Legacy per-provider daemons ---"
for pair in $PROVIDERS; do
  prov="${pair%%:*}"
  daemon="$(_legacy_daemon_for "$prov")"
  pid="$(_legacy_pid "$prov")"
  state="$(_legacy_state_file "$prov")"
  if [[ -n "$state" ]]; then
    running="no"
    _legacy_running "$prov" && running="yes"
    echo "  $prov ($daemon): state=$state pid=${pid:-<none>} running=$running"
  else
    echo "  $prov ($daemon): no state file"
  fi
done
echo ""
echo "--- Tmux ---"
echo "Inside tmux: $TMUX_INSIDE"
if [[ ${#TMUX_CCB_SESSIONS[@]} -gt 0 ]]; then
  echo "CCB sessions: ${TMUX_CCB_SESSIONS[*]}"
else
  echo "CCB sessions: (none)"
fi
echo ""
echo "--- Project session files (.ccb) ---"
if [[ ${#HAS_SESSION[@]} -gt 0 ]]; then
  echo "  Found for: ${HAS_SESSION[*]}"
else
  echo "  (none in $CWD)"
fi
echo "=============================================="

# One-line summary
if [[ "$ASKd_RUNNING" == true ]]; then
  echo "Summary: askd is running (unified backend). Backends (codex/gemini/opencode/claude/droid) are available via this daemon."
else
  legacy_any=false
  for pair in $PROVIDERS; do
    prov="${pair%%:*}"
    _legacy_running "$prov" && legacy_any=true && break
  done
  if [[ "$legacy_any" == true ]]; then
    echo "Summary: Unified askd not running; some legacy daemons are running."
  else
    echo "Summary: No askd or legacy daemons running. Start CCB with: ccb [providers...] (e.g. ccb codex claude)."
  fi
fi
