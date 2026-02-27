#!/usr/bin/env bash
# call_judge_bridge.sh — auto mode judge adapter
# Coordinator spawns; judge reads evidence and outputs JudgeVerdict v2; fully automatic.
# Interface: $1=task_json_path $2=evidence_json_path $3=attempt_dir $4=judge_prompt_path
# Outputs: attempt_dir/judge/verdict.json, attempt_dir/judge/rc.txt, attempt_dir/judge/run.log

set -uo pipefail

session_id=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id) session_id="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

if [ -z "${session_id:-}" ]; then
  echo "Usage: call_judge_bridge.sh --session-id <id> <task_json> <evidence_json> <attempt_dir> <judge_prompt>" >&2
  exit 2
fi

task_json_path="${1:-}"
evidence_json_path="${2:-}"
attempt_dir="${3:-}"
judge_prompt_path="${4:-}"
[ -n "$task_json_path" ] || { echo "missing task_json_path" >&2; exit 2; }
[ -n "$evidence_json_path" ] || { echo "missing evidence_json_path" >&2; exit 2; }
[ -n "$attempt_dir" ] || { echo "missing attempt_dir" >&2; exit 2; }
[ -n "$judge_prompt_path" ] || { echo "missing judge_prompt_path" >&2; exit 2; }

mkdir -p "${attempt_dir}/judge"

RDLOOP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRIDGE_INDEX="${RDLOOP_ROOT}/claude_bridge/index.js"
BRIDGE_DIR="${attempt_dir}/bridge_ipc_judge"

run_log="${attempt_dir}/judge/run.log"

judge_timeout=$(python3 -c "
import json
try: print(json.load(open('$task_json_path')).get('judge_timeout_seconds', 300))
except: print(300)
" 2>/dev/null || echo "300")

project_path=$(python3 -c "
import json
try: print(json.load(open('$task_json_path')).get('repo_path',''))
except: print('')
" 2>/dev/null || echo "")
worktree_dir="$project_path"
if [ -f "$evidence_json_path" ]; then
  wt=$(python3 -c "
import json,sys
try:
    with open('$evidence_json_path') as f:
        d = json.load(f)
    print(d.get('worktree_path',''))
except: print('')
" 2>/dev/null || echo "")
  [ -n "$wt" ] && [ -d "$wt" ] && worktree_dir="$wt"
fi

# Build stdin from coordinator-owned request core when available.
judge_request_path="${JUDGE_REQUEST_PATH:-}"
if [ -n "$judge_request_path" ] && [ -f "$judge_request_path" ]; then
  full_instruction="$(cat "$judge_request_path")"
else
  full_instruction=""
  if [ -f "$judge_prompt_path" ]; then
    full_instruction=$(cat "$judge_prompt_path")
  fi
  full_instruction="${full_instruction}
---
"
  [ -f "$evidence_json_path" ] && full_instruction="${full_instruction}$(cat "$evidence_json_path")"
fi

tout=""
command -v timeout >/dev/null 2>&1 && tout="timeout"
[ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"

{
  echo "[JUDGE][auto/bridge] $(date -u +%Y-%m-%dT%H:%M:%SZ) coordinator-spawned"
  echo "[JUDGE][auto/bridge] session_id: ${session_id}"
  echo "[JUDGE][auto/bridge] timeout: ${judge_timeout}s"

  if [ -n "$tout" ]; then
    raw_out="${attempt_dir}/judge/raw_out.txt"
    $tout "$judge_timeout" \
      node "$BRIDGE_INDEX" \
        --bridge-dir "$BRIDGE_DIR" \
        --session-id "${session_id}" \
        -- -p "$full_instruction" \
           --cwd "$worktree_dir" \
           --dangerously-skip-permissions 2>"${attempt_dir}/judge/bridge_stderr.txt" | tee "$raw_out"
    rc=$?
    [ "$rc" = "124" ] && echo "TIMEOUT" >> "$run_log"
  else
    raw_out="${attempt_dir}/judge/raw_out.txt"
    node "$BRIDGE_INDEX" \
      --bridge-dir "$BRIDGE_DIR" \
      --session-id "${session_id}" \
      -- -p "$full_instruction" \
         --cwd "$worktree_dir" \
         --dangerously-skip-permissions 2>"${attempt_dir}/judge/bridge_stderr.txt" | tee "$raw_out"
    rc=$?
  fi

  # Extract verdict JSON (JudgeVerdict v1 or v2) into verdict.json
  if [ -f "$raw_out" ]; then
    python3 -c "
import json,sys,re
raw=open('$raw_out', encoding='utf-8').read()
d=None
try:
    d=json.loads(raw)
except: pass
if d is None:
    m=re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', raw, re.DOTALL)
    if m:
        try: d=json.loads(m.group())
        except: pass
if d and 'decision' in d and 'reasons' in d:
    with open('${attempt_dir}/judge/verdict.json','w',encoding='utf-8') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    sys.exit(0)
# fallback
with open('${attempt_dir}/judge/verdict.json','w',encoding='utf-8') as f:
    json.dump({'schema_version':'v1','decision':'NEED_USER_INPUT','reasons':['Could not extract verdict'],'next_instructions':'','questions_for_user':['Judge output invalid']}, f, indent=2)
sys.exit(0)
" 2>/dev/null || true
  fi

  echo "[JUDGE][auto/bridge] $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
  echo "$rc" > "${attempt_dir}/judge/rc.txt"
  exit "$rc"
} >> "$run_log" 2>&1

rc=$?
[ ! -f "${attempt_dir}/judge/rc.txt" ] && echo "$rc" > "${attempt_dir}/judge/rc.txt"
exit "$(cat "${attempt_dir}/judge/rc.txt" 2>/dev/null || echo "$rc")"
