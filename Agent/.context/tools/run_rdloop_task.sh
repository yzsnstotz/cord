#!/usr/bin/env bash
# run_rdloop_task.sh — PM ↔ rdloop coordinator glue.
# Accepts TaskSpec JSON path, starts rdloop, polls status; on READY_FOR_REVIEW
# calls write_knowledge_cache.py (executor writer). On FAILED/PAUSED reports accordingly.
# Usage: run_rdloop_task.sh <task_spec.json> [rdloop_root]
#   rdloop_root optional; else uses RDLOOP_ROOT env or sibling Rdloop under Cord.

set -euo pipefail

task_spec_path="${1:-}"
rdloop_root="${2:-${RDLOOP_ROOT:-}}"

if [ -z "$task_spec_path" ] || [ ! -f "$task_spec_path" ]; then
  echo "[run_rdloop_task] ERROR: TaskSpec JSON path required" >&2
  exit 1
fi

# Resolve rdloop root: arg > env > sibling of Agent
if [ -z "$rdloop_root" ]; then
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  # Assume Agent/.context/tools -> Agent = script_dir/../.., Cord = Agent/..
  agent_root="$(cd "${script_dir}/../.." && pwd)"
  cord_root="$(cd "${agent_root}/.." && pwd)"
  if [ -d "${cord_root}/Rdloop" ]; then
    rdloop_root="${cord_root}/Rdloop"
  else
    echo "[run_rdloop_task] ERROR: RDLOOP_ROOT not set and Rdloop not found at ${cord_root}/Rdloop" >&2
    exit 1
  fi
fi
rdloop_root="$(cd "$rdloop_root" && pwd)"
run_task_sh="${rdloop_root}/coordinator/run_task.sh"
out_dir="${RDLOOP_OUT_DIR:-${rdloop_root}/out}"

if [ ! -f "$run_task_sh" ]; then
  echo "[run_rdloop_task] ERROR: run_task.sh not found at $run_task_sh" >&2
  exit 1
fi

task_id=$(python3 -c "
import json,sys
try:
    with open('$task_spec_path') as f:
        d = json.load(f)
    print(d.get('task_id',''))
except Exception:
    print('')
" 2>/dev/null || echo "")
if [ -z "$task_id" ]; then
  echo "[run_rdloop_task] ERROR: task_id not found in $task_spec_path" >&2
  exit 1
fi

project_path=$(python3 -c "
import json,sys
try:
    with open('$task_spec_path') as f:
        d = json.load(f)
    print(d.get('repo_path',''))
except Exception:
    print('')
" 2>/dev/null || echo "")

poll_interval="${RDLOOP_POLL_INTERVAL:-10}"
timeout_secs="${RDLOOP_TASK_TIMEOUT:-3600}"

# Start rdloop in background (or run in foreground and poll after)
RDLOOP_OUT_DIR="$out_dir" bash "$run_task_sh" "$task_spec_path" &
run_pid=$!
start_ts=$(date +%s)
status_json="${out_dir}/${task_id}/status.json"
final_summary_json="${out_dir}/${task_id}/final_summary.json"

while true; do
  sleep "$poll_interval"
  now=$(date +%s)
  if [ $(( now - start_ts )) -ge "$timeout_secs" ]; then
    echo "[run_rdloop_task] TIMEOUT after ${timeout_secs}s" >&2
    [ -f "$status_json" ] && cat "$status_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print('Current state:', d.get('state',''))" 2>/dev/null || true
    kill "$run_pid" 2>/dev/null || true
    exit 124
  fi
  if ! kill -0 "$run_pid" 2>/dev/null; then
    wait "$run_pid" 2>/dev/null || true
    break
  fi
  if [ -f "$status_json" ]; then
    state=$(python3 -c "
import json,sys
try:
    with open('$status_json') as f:
        d = json.load(f)
    print(d.get('state',''))
except Exception:
    print('')
" 2>/dev/null || echo "")
    case "$state" in
      READY_FOR_REVIEW)
        wait "$run_pid" 2>/dev/null || true
        if [ -n "$project_path" ] && [ -f "$final_summary_json" ]; then
          tools_dir="$(cd "$(dirname "$0")" && pwd)"
          python3 "${tools_dir}/write_knowledge_cache.py" \
            --project-path "$project_path" \
            --task-id "$task_id" \
            --final-summary "$final_summary_json" \
            --writer executor
        fi
        echo "[run_rdloop_task] READY_FOR_REVIEW; executor summary written to knowledge_cache"
        exit 0
        ;;
      FAILED)
        wait "$run_pid" 2>/dev/null || true
        if [ -f "$final_summary_json" ]; then
          python3 -c "
import json,sys
try:
    with open('$final_summary_json') as f:
        d = json.load(f)
    issues = d.get('verdict_summary') or d.get('top_issues') or d.get('questions_for_user') or []
    if isinstance(issues, list):
        for i in issues: print(i)
    else:
        print(issues)
except Exception: pass
" 2>/dev/null || true
        fi
        echo "[run_rdloop_task] FAILED" >&2
        exit 1
        ;;
      PAUSED*)
        if [ -f "$status_json" ]; then
          python3 -c "
import json,sys
try:
    with open('$status_json') as f:
        d = json.load(f)
    q = d.get('questions_for_user') or []
    for x in q: print(x)
except Exception: pass
" 2>/dev/null || true
        fi
        echo "[run_rdloop_task] PAUSED — waiting for user intervention" >&2
        wait "$run_pid" 2>/dev/null || true
        exit 2
        ;;
    esac
  fi
done

# Exited without READY_FOR_REVIEW
if [ -f "$status_json" ]; then
  state=$(python3 -c "
import json,sys
try:
    with open('$status_json') as f:
        d = json.load(f)
    print(d.get('state',''))
except Exception:
    print('')
" 2>/dev/null || echo "")
  case "$state" in
    READY_FOR_REVIEW)
      if [ -n "$project_path" ] && [ -f "$final_summary_json" ]; then
        tools_dir="$(cd "$(dirname "$0")" && pwd)"
        python3 "${tools_dir}/write_knowledge_cache.py" \
          --project-path "$project_path" \
          --task-id "$task_id" \
          --final-summary "$final_summary_json" \
          --writer executor
      fi
      exit 0
      ;;
    FAILED) exit 1 ;;
    PAUSED*) exit 2 ;;
  esac
fi
exit 1
