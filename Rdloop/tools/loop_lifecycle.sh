#!/usr/bin/env bash
# loop_lifecycle.sh — Loop completion automation (no LLM)
# Triggered by coordinator after all worker PRs are merged.
#
# Usage:
#   loop_lifecycle.sh on-loop-complete <task_slug> [repo_path] [task_json]
#
# Execution order:
#   1. Regression gate (test_cmd, fails → REGRESSION_FAILED, blocks)
#   2. Knowledge write (PR description → module shard + debt shard)
#   3. Loop stats (loop_stats.jsonl)
#   4. Session state derivation (session_state.json from git)
#   5. Events (loop_complete event)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${RDLOOP_OUT_DIR:-${RDLOOP_ROOT}/out}"

log_info() { echo "[LOOP_LIFECYCLE][INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
log_error() { echo "[LOOP_LIFECYCLE][ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }

json_read() {
  local file="$1" field="$2" default="${3:-}"
  python3 -c "
import json,sys
try:
  with open(sys.argv[1]) as f: d=json.load(f)
  keys=sys.argv[2].split('.')
  v=d
  for k in keys: v=v[k]
  if isinstance(v,list): print(json.dumps(v))
  elif isinstance(v,bool): print('true' if v else 'false')
  elif v is None: print(sys.argv[3] if len(sys.argv)>3 else '')
  else: print(v)
except: print(sys.argv[3] if len(sys.argv)>3 else '')
" "$file" "$field" "$default" 2>/dev/null
}

ATOMIC_WRITE="${RDLOOP_ROOT}/coordinator/lib/atomic_write.py"

##############################################################################
# on-loop-complete
##############################################################################
cmd_on_loop_complete() {
  local task_slug="$1"
  local repo_path="${2:-}"
  local task_json="${3:-}"
  local loop_id="task/${task_slug}"
  local loop_start; loop_start=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  [ -z "$task_slug" ] && { log_error "task_slug required"; exit 1; }

  # Locate task directory in out/
  local task_dir=""
  for d in "${OUT_DIR}"/*; do
    [ -d "$d" ] && [ -f "$d/task.json" ] && {
      local tid; tid=$(json_read "$d/task.json" "task_id" "")
      if echo "$tid" | grep -q "$task_slug"; then
        task_dir="$d"
        [ -z "$task_json" ] && task_json="$d/task.json"
        break
      fi
    }
  done

  # If repo_path not provided, try from task.json
  if [ -z "$repo_path" ] && [ -n "$task_json" ] && [ -f "$task_json" ]; then
    repo_path=$(json_read "$task_json" "repo_path" "")
  fi

  # ---- Step 1: Regression gate ----
  log_info "Step 1: Regression gate"
  if [ -n "$task_json" ] && [ -f "$task_json" ]; then
    local test_cmd; test_cmd=$(json_read "$task_json" "test_cmd" "true")
    if [ "$test_cmd" != "true" ] && [ -n "$test_cmd" ]; then
      local test_dir="${repo_path:-.}"
      local test_rc=0
      set +e
      bash -lc "cd '${test_dir}' && ${test_cmd}" >/dev/null 2>&1
      test_rc=$?
      set -e
      if [ "$test_rc" != "0" ]; then
        log_error "REGRESSION_FAILED: test_cmd '${test_cmd}' returned rc=${test_rc}"
        # Write REGRESSION_FAILED event
        if [ -n "$task_dir" ]; then
          python3 -c '
import json,sys
e={"ts":sys.argv[1],"type":"REGRESSION_FAILED","loop_id":sys.argv[2],"test_cmd":sys.argv[3],"test_rc":int(sys.argv[4])}
print(json.dumps(e))
' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$loop_id" "$test_cmd" "$test_rc" \
            | python3 "$ATOMIC_WRITE" --append "${task_dir}/events.jsonl" - 2>/dev/null || true
        fi
        exit 1
      fi
      log_info "Regression gate passed (rc=0)"
    else
      log_info "No test_cmd or test_cmd=true, skipping regression gate"
    fi
  fi

  # ---- Step 2: Knowledge write ----
  log_info "Step 2: Knowledge write"
  if [ -n "$task_dir" ]; then
    # Extract from final_summary.json or PR descriptions
    python3 - "$task_dir" "$loop_id" "$ATOMIC_WRITE" <<'PYEOF'
import json, sys, os, re, glob

task_dir = sys.argv[1]
loop_id = sys.argv[2]
atomic_write = sys.argv[3]

# Find knowledge_cache path (project .context/)
repo_path = ""
task_json_path = os.path.join(task_dir, "task.json")
if os.path.isfile(task_json_path):
    with open(task_json_path) as f:
        t = json.load(f)
    repo_path = t.get("repo_path", "")

# Read debt entries from final_summary or attempt artifacts
debt_entries = {}
module_entries = {}

# Scan attempt directories
for att_dir in sorted(glob.glob(os.path.join(task_dir, "attempt_*"))):
    # Read knowledge_entries from coder
    ke_path = os.path.join(att_dir, "coder", "knowledge_entries.json")
    if os.path.isfile(ke_path):
        try:
            with open(ke_path) as f:
                ke = json.load(f)
            for path_key, summary in ke.items():
                module_entries[path_key] = {
                    "type": "file",
                    "path": path_key,
                    "summary": summary,
                    "loop_id": loop_id,
                    "written_by": "coordinator"
                }
        except Exception:
            pass

# Write module shard entries
if module_entries and repo_path:
    kc_dir = os.path.join(repo_path, ".context", "knowledge")
    os.makedirs(kc_dir, exist_ok=True)
    shard_path = os.path.join(kc_dir, "module_" + loop_id.replace("/", "_") + ".json")
    # Idempotent: don't overwrite existing
    if not os.path.isfile(shard_path):
        with open(shard_path, "w") as f:
            json.dump({"entries": module_entries}, f, indent=2, ensure_ascii=False)
        print("Wrote module shard: " + shard_path)

# Write debt shard entries
if repo_path:
    kc_dir = os.path.join(repo_path, ".context", "knowledge")
    os.makedirs(kc_dir, exist_ok=True)
    debt_path = os.path.join(kc_dir, "debt.json")
    existing_debt = {"entries": {}}
    if os.path.isfile(debt_path):
        try:
            with open(debt_path) as f:
                existing_debt = json.load(f)
        except Exception:
            pass
    # We'll extract debt from final_summary if available
    fs_path = os.path.join(task_dir, "final_summary.json")
    if os.path.isfile(fs_path):
        try:
            with open(fs_path) as f:
                fs = json.load(f)
            task_id = fs.get("task_id", "unknown")
            date_part = loop_id.split("/")[-1][:8] if "/" in loop_id else "00000000"
            debt_key = "debt:" + task_id + "-" + date_part
            if debt_key not in existing_debt.get("entries", {}):
                # Placeholder for PR description extraction
                pass
        except Exception:
            pass
    if existing_debt["entries"]:
        with open(debt_path, "w") as f:
            json.dump(existing_debt, f, indent=2, ensure_ascii=False)
PYEOF
  fi

  # ---- Step 3: Loop stats ----
  log_info "Step 3: Loop stats"
  if [ -n "$task_dir" ]; then
    python3 - "$task_dir" "$loop_id" "$loop_start" "$ATOMIC_WRITE" <<'PYEOF'
import json, sys, os, glob, time

task_dir = sys.argv[1]
loop_id = sys.argv[2]
loop_start = sys.argv[3]
atomic_write = sys.argv[4]

# Count attempts per task
task_attempts = []
task_json_path = os.path.join(task_dir, "task.json")
task_id = "unknown"
max_attempts = 3
if os.path.isfile(task_json_path):
    with open(task_json_path) as f:
        t = json.load(f)
    task_id = t.get("task_id", "unknown")
    max_attempts = t.get("max_attempts", t.get("agent_config", {}).get("max_attempts", 3))

actual_attempts = len(glob.glob(os.path.join(task_dir, "attempt_*")))
task_attempts.append({
    "task_id": task_id,
    "actual_attempts": actual_attempts,
    "max_attempts": max_attempts
})

# Loop stats line
stats = {
    "loop_id": loop_id,
    "task_attempts": task_attempts,
    "total_duration_seconds": 0,
    "completed_at": sys.argv[3]
}

stats_path = os.path.join(os.path.dirname(task_dir), "loop_stats.jsonl")
# Idempotent: check if this loop_id already recorded
already_recorded = False
if os.path.isfile(stats_path):
    with open(stats_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get("loop_id") == loop_id:
                    already_recorded = True
                    break
            except Exception:
                pass

if not already_recorded:
    import subprocess
    subprocess.run(
        ["python3", atomic_write, "--append", stats_path, "-"],
        input=json.dumps(stats) + "\n",
        text=True
    )
    print("Wrote loop_stats entry for " + loop_id)
else:
    print("Loop stats already recorded for " + loop_id)
PYEOF
  fi

  # ---- Step 4: Session state derivation ----
  log_info "Step 4: Session state derivation"
  if [ -n "$repo_path" ] && [ -d "$repo_path/.context" ]; then
    python3 - "$repo_path" "$loop_id" "$task_slug" <<'PYEOF'
import json, sys, os, subprocess

repo_path = sys.argv[1]
loop_id = sys.argv[2]
task_slug = sys.argv[3]

ss_path = os.path.join(repo_path, ".context", "session_state.json")
ss = {}
if os.path.isfile(ss_path):
    try:
        with open(ss_path) as f:
            ss = json.load(f)
    except Exception:
        pass

# Derive task state from git branches
try:
    result = subprocess.run(
        ["git", "-C", repo_path, "branch", "--list", "task/*", "worker/*"],
        capture_output=True, text=True, timeout=5
    )
    branches = [b.strip().lstrip("* ") for b in result.stdout.strip().split("\n") if b.strip()]
except Exception:
    branches = []

# Update session state
if "tasks" not in ss:
    ss["tasks"] = {}
ss["last_loop_id"] = loop_id
ss["last_updated"] = subprocess.run(
    ["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"],
    capture_output=True, text=True
).stdout.strip()

# Mark loop complete
if "completed_loops" not in ss:
    ss["completed_loops"] = []
if loop_id not in ss["completed_loops"]:
    ss["completed_loops"].append(loop_id)

with open(ss_path, "w") as f:
    json.dump(ss, f, indent=2, ensure_ascii=False)
print("Updated session_state.json")
PYEOF
  fi

  # ---- Step 5: Events ----
  log_info "Step 5: loop_complete event"
  if [ -n "$task_dir" ]; then
    python3 -c '
import json,sys
e={"ts":sys.argv[1],"type":"loop_complete","loop_id":sys.argv[2]}
print(json.dumps(e))
' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$loop_id" \
      | python3 "$ATOMIC_WRITE" --append "${task_dir}/events.jsonl" - 2>/dev/null || true
    log_info "loop_complete event written"
  fi

  log_info "on-loop-complete finished for ${task_slug}"
}

##############################################################################
# Entry point
##############################################################################
case "${1:-}" in
  on-loop-complete)
    [ $# -lt 2 ] && { log_error "Usage: loop_lifecycle.sh on-loop-complete <task_slug> [repo_path] [task_json]"; exit 1; }
    cmd_on_loop_complete "${2:-}" "${3:-}" "${4:-}"
    ;;
  *)
    echo "Usage: loop_lifecycle.sh on-loop-complete <task_slug> [repo_path] [task_json]"
    exit 1
    ;;
esac
