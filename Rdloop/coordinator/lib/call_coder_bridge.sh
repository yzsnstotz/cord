#!/usr/bin/env bash
# call_coder_bridge.sh — auto mode coder adapter
# Coordinator spawns subprocess; claude_bridge IPC; fully automatic, no human in the loop.
# Interface: $1=task_json $2=attempt_dir $3=worktree_dir $4=instruction_path
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/rc.txt

set -uo pipefail

session_id=""
bridge_dir_override=""
task_code="${RDLOOP_TASK_CODE:-}"
attempt_num="${RDLOOP_ATTEMPT:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id) session_id="${2:-}"; shift 2 ;;
    --bridge-dir) bridge_dir_override="${2:-}"; shift 2 ;;
    --task-code) task_code="${2:-}"; shift 2 ;;
    --attempt) attempt_num="${2:-}"; shift 2 ;;
    --req-code) shift 2 ;;  # accepted for interface compatibility, ignored by bridge
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

if [ -z "${session_id:-}" ]; then
  echo "Usage: call_coder_bridge.sh --session-id <id> <task_json> <attempt_dir> <worktree_dir> <instruction_path>" >&2
  exit 2
fi

task_json="${1:-}"
attempt_dir="${2:-}"
worktree_dir="${3:-}"
instruction_path="${4:-}"
[ -n "$task_json" ] || { echo "missing task_json" >&2; exit 2; }
[ -n "$attempt_dir" ] || { echo "missing attempt_dir" >&2; exit 2; }
[ -n "$worktree_dir" ] || { echo "missing worktree_dir" >&2; exit 2; }
[ -n "$instruction_path" ] || { echo "missing instruction_path" >&2; exit 2; }

mkdir -p "${attempt_dir}/coder"

RDLOOP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRIDGE_INDEX="${RDLOOP_ROOT}/claude_bridge/index.js"
if [ -n "$bridge_dir_override" ] && [ -d "$bridge_dir_override" ]; then
  BRIDGE_DIR="$bridge_dir_override"
else
  BRIDGE_DIR="${attempt_dir}/bridge_ipc"
fi

run_log="${attempt_dir}/coder/run.log"
instruction=$(cat "$instruction_path" 2>/dev/null || echo "")

timeout_s=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('coder_timeout_seconds',600))
except: print(600)
" 2>/dev/null || echo "600")

full_instruction="${instruction}"

tout=""
command -v timeout >/dev/null 2>&1 && tout="timeout"
[ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"

{
  local log_prefix="[CODER][auto/bridge]"
  [ -n "$task_code" ] && log_prefix="[${task_code}:${attempt_num:-?}] ${log_prefix}"
  echo "${log_prefix} $(date -u +%Y-%m-%dT%H:%M:%SZ) coordinator-spawned session"
  echo "${log_prefix} session_id: ${session_id}"
  echo "${log_prefix} worktree: ${worktree_dir}"
  echo "${log_prefix} timeout: ${timeout_s}s"
  [ -n "$task_code" ] && echo "${log_prefix} task_code: ${task_code}, attempt: ${attempt_num:-?}"

  # Build bridge args with optional task-code/attempt
  local bridge_extra_args=""
  [ -n "$task_code" ] && bridge_extra_args="${bridge_extra_args} --task-code '${task_code}'"
  [ -n "$attempt_num" ] && bridge_extra_args="${bridge_extra_args} --attempt '${attempt_num}'"

  if [ -n "$tout" ]; then
    $tout "$timeout_s" bash -lc "cd '$worktree_dir' && node '$BRIDGE_INDEX' --bridge-dir '$BRIDGE_DIR' --session-id '$session_id' ${bridge_extra_args} -- -p \"\$1\" --dangerously-skip-permissions" _ "$full_instruction" 2>&1
    rc=$?
    [ "$rc" = "124" ] && echo "TIMEOUT" >> "$run_log"
  else
    bash -lc "cd '$worktree_dir' && node '$BRIDGE_INDEX' --bridge-dir '$BRIDGE_DIR' --session-id '$session_id' ${bridge_extra_args} -- -p \"\$1\" --dangerously-skip-permissions" _ "$full_instruction" 2>&1
    rc=$?
  fi

  echo "${log_prefix} $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
  echo "$rc" > "${attempt_dir}/coder/rc.txt"
  exit "$rc"
} > "$run_log" 2>&1

rc=$?
[ ! -f "${attempt_dir}/coder/rc.txt" ] && echo "$rc" > "${attempt_dir}/coder/rc.txt"
exit "$(cat "${attempt_dir}/coder/rc.txt" 2>/dev/null || echo "$rc")"
