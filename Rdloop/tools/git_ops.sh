#!/usr/bin/env bash
# git_ops.sh — Coordinator git operations layer
# LLM does not execute git directly; coordinator calls this script.
#
# Usage:
#   git_ops.sh create-branches <branch_init_spec.json>
#   git_ops.sh merge-pr         <merge_decision.json>
#   git_ops.sh review-prep      <task_slug> <contract_path>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

##############################################################################
# Utility
##############################################################################
json_read() {
  local file="$1" field="$2" default="${3:-}"
  python3 -c "
import json,sys
try:
  with open(sys.argv[1]) as f: d=json.load(f)
  keys=sys.argv[2].split('.')
  v=d
  for k in keys:
    if isinstance(v, list): v=v[int(k)]
    else: v=v[k]
  if isinstance(v,list): print(json.dumps(v))
  elif isinstance(v,bool): print('true' if v else 'false')
  elif v is None: print(sys.argv[3] if len(sys.argv)>3 else '')
  else: print(v)
except: print(sys.argv[3] if len(sys.argv)>3 else '')
" "$file" "$field" "$default" 2>/dev/null
}

json_array_len() {
  local file="$1" field="$2"
  python3 -c "
import json,sys
with open(sys.argv[1]) as f: d=json.load(f)
keys=sys.argv[2].split('.')
v=d
for k in keys: v=v[k]
print(len(v) if isinstance(v,list) else 0)
" "$file" "$field" 2>/dev/null || echo "0"
}

log_info() { echo "[GIT_OPS][INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
log_error() { echo "[GIT_OPS][ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }

##############################################################################
# Branch naming functions
##############################################################################

# Sanitize slug: lowercase, replace spaces/specials with hyphens, collapse
sanitize_slug() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//'
}

# Generate task branch name: task/<YYYYMMDD>-<slug>
task_branch_name() {
  local date_str="$1" slug="$2"
  local safe_slug; safe_slug=$(sanitize_slug "$slug")
  echo "task/${date_str}-${safe_slug}"
}

# Generate worker branch name based on executor_type
# worker_branch_name <slug> <executor_type> <label>
worker_branch_name() {
  local slug="$1" executor_type="$2" label="$3"
  local safe_slug; safe_slug=$(sanitize_slug "$slug")
  local safe_label; safe_label=$(sanitize_slug "$label")
  case "$executor_type" in
    api_call)     echo "worker/${safe_slug}-content" ;;
    solo_agent)   echo "worker/${safe_slug}-agent" ;;
    multi_agent)  echo "worker/${safe_slug}-${safe_label}" ;;
    *)
      log_error "Unknown executor_type: ${executor_type}"
      return 1
      ;;
  esac
}

##############################################################################
# create-branches: parse BranchInitSpec, create task + worker branches + worktrees
##############################################################################
cmd_create_branches() {
  local spec_file="$1"
  [ ! -f "$spec_file" ] && { log_error "BranchInitSpec not found: ${spec_file}"; exit 1; }

  local spec_type; spec_type=$(json_read "$spec_file" "type" "")
  [ "$spec_type" != "BranchInitSpec" ] && { log_error "Invalid spec type: ${spec_type} (expected BranchInitSpec)"; exit 1; }

  local task_slug; task_slug=$(json_read "$spec_file" "task_slug" "")
  local date_str; date_str=$(json_read "$spec_file" "date" "")
  local repo_path; repo_path=$(json_read "$spec_file" "repo_path" "")

  [ -z "$task_slug" ] && { log_error "task_slug missing in BranchInitSpec"; exit 1; }
  [ -z "$date_str" ] && { log_error "date missing in BranchInitSpec"; exit 1; }
  [ -z "$repo_path" ] && { log_error "repo_path missing in BranchInitSpec"; exit 1; }

  # Validate repo is a git repo
  if ! git -C "$repo_path" rev-parse --git-dir >/dev/null 2>&1; then
    log_error "repo_path is not a git repository: ${repo_path}"
    exit 1
  fi

  # Create task branch (idempotent)
  local task_br; task_br=$(task_branch_name "$date_str" "$task_slug")
  if git -C "$repo_path" show-ref --verify --quiet "refs/heads/${task_br}" 2>/dev/null; then
    log_info "Task branch already exists: ${task_br}"
  else
    local base_ref; base_ref=$(json_read "$spec_file" "base_ref" "main")
    git -C "$repo_path" branch "$task_br" "$base_ref" 2>/dev/null || {
      log_error "Failed to create task branch: ${task_br}"
      exit 1
    }
    log_info "Created task branch: ${task_br}"
  fi

  # Create worker branches from workers array
  local num_workers; num_workers=$(json_array_len "$spec_file" "workers")
  local i=0
  while [ "$i" -lt "$num_workers" ]; do
    local w_task_id; w_task_id=$(json_read "$spec_file" "workers.${i}.task_id" "")
    local w_executor_type; w_executor_type=$(json_read "$spec_file" "workers.${i}.executor_type" "")
    local w_label; w_label=$(json_read "$spec_file" "workers.${i}.label" "")
    [ -z "$w_label" ] && w_label="$w_task_id"

    local worker_br; worker_br=$(worker_branch_name "$task_slug" "$w_executor_type" "$w_label")
    if git -C "$repo_path" show-ref --verify --quiet "refs/heads/${worker_br}" 2>/dev/null; then
      log_info "Worker branch already exists: ${worker_br}"
    else
      git -C "$repo_path" branch "$worker_br" "$task_br" 2>/dev/null || {
        log_error "Failed to create worker branch: ${worker_br}"
        exit 1
      }
      log_info "Created worker branch: ${worker_br}"
    fi

    # Create worktree for this worker branch
    local wt_dir="${RDLOOP_ROOT}/worktrees/${task_slug}/${worker_br##*/}"
    if [ -d "$wt_dir" ]; then
      log_info "Worktree already exists: ${wt_dir}"
    else
      mkdir -p "$(dirname "$wt_dir")"
      git -C "$repo_path" worktree add "$wt_dir" "$worker_br" 2>/dev/null || {
        # Fallback: create dir and checkout
        mkdir -p "$wt_dir"
        git -C "$repo_path" archive "$worker_br" | tar -x -C "$wt_dir" 2>/dev/null || true
        log_info "Worktree created via archive fallback: ${wt_dir}"
      }
      log_info "Created worktree: ${wt_dir} → ${worker_br}"
    fi

    i=$((i + 1))
  done

  log_info "create-branches complete for task: ${task_slug}"
}

##############################################################################
# merge-pr: parse MergeDecision, execute merge or set changes_requested
##############################################################################
cmd_merge_pr() {
  local decision_file="$1"
  [ ! -f "$decision_file" ] && { log_error "MergeDecision not found: ${decision_file}"; exit 1; }

  local spec_type; spec_type=$(json_read "$decision_file" "type" "")
  [ "$spec_type" != "MergeDecision" ] && { log_error "Invalid type: ${spec_type} (expected MergeDecision)"; exit 1; }

  local task_id; task_id=$(json_read "$decision_file" "task_id" "")
  local verdict; verdict=$(json_read "$decision_file" "verdict" "")
  local repo_path; repo_path=$(json_read "$decision_file" "repo_path" "")
  local worker_branch; worker_branch=$(json_read "$decision_file" "worker_branch" "")
  local task_branch; task_branch=$(json_read "$decision_file" "task_branch" "")

  [ -z "$task_id" ] && { log_error "task_id missing in MergeDecision"; exit 1; }
  [ -z "$verdict" ] && { log_error "verdict missing in MergeDecision"; exit 1; }
  [ -z "$repo_path" ] && { log_error "repo_path missing in MergeDecision"; exit 1; }

  # Check merge_after dependencies
  local merge_after; merge_after=$(json_read "$decision_file" "merge_after" "[]")
  if [ "$merge_after" != "[]" ]; then
    python3 - "$decision_file" "$repo_path" <<'PYEOF'
import json, sys, subprocess
with open(sys.argv[1]) as f:
    d = json.load(f)
repo = sys.argv[2]
merge_after = d.get("merge_after", [])
for dep_branch in merge_after:
    # Check if dep branch has been merged into task branch
    result = subprocess.run(
        ["git", "-C", repo, "branch", "--merged", d.get("task_branch", "main")],
        capture_output=True, text=True
    )
    merged_branches = [b.strip().lstrip("* ") for b in result.stdout.strip().split("\n")]
    if dep_branch not in merged_branches:
        print("BLOCKED: dependency branch not yet merged: " + dep_branch, file=sys.stderr)
        sys.exit(1)
PYEOF
    local dep_rc=$?
    if [ "$dep_rc" != "0" ]; then
      log_error "merge_after dependency not satisfied"
      exit 1
    fi
  fi

  case "$verdict" in
    approve)
      [ -z "$worker_branch" ] && { log_error "worker_branch missing for approve"; exit 1; }
      [ -z "$task_branch" ] && { log_error "task_branch missing for approve"; exit 1; }
      git -C "$repo_path" checkout "$task_branch" 2>/dev/null
      git -C "$repo_path" merge --no-ff "$worker_branch" -m "Merge ${worker_branch} into ${task_branch} (task: ${task_id})" 2>/dev/null || {
        log_error "Merge failed for ${worker_branch} → ${task_branch}"
        exit 1
      }
      log_info "Merged: ${worker_branch} → ${task_branch}"
      ;;
    request_changes)
      local blocking; blocking=$(json_read "$decision_file" "blocking_issues" "[]")
      log_info "Changes requested for ${task_id}: ${blocking}"
      # Write status marker
      echo "{\"status\":\"changes_requested\",\"task_id\":\"${task_id}\",\"issues\":${blocking}}" > "${repo_path}/.rdloop_review_status_${task_id}.json" 2>/dev/null || true
      ;;
    *)
      log_error "Unknown verdict: ${verdict}"
      exit 1
      ;;
  esac
}

##############################################################################
# review-prep: generate structured review report
##############################################################################
cmd_review_prep() {
  local task_slug="$1"
  local contract_path="${2:-}"
  local repo_path="${3:-}"
  local task_branch="${4:-}"
  local worker_branches="${5:-}" # comma-separated

  [ -z "$repo_path" ] && { log_error "repo_path required for review-prep"; exit 1; }

  python3 - "$task_slug" "$contract_path" "$repo_path" "$task_branch" "$worker_branches" <<'PYEOF'
import json, sys, subprocess, os, re

task_slug = sys.argv[1]
contract_path = sys.argv[2] if len(sys.argv) > 2 else ""
repo_path = sys.argv[3] if len(sys.argv) > 3 else ""
task_branch = sys.argv[4] if len(sys.argv) > 4 else ""
worker_branches_str = sys.argv[5] if len(sys.argv) > 5 else ""

worker_branches = [b.strip() for b in worker_branches_str.split(",") if b.strip()]

report = {
    "task_id": task_slug,
    "executor_type": None,
    "contract_check": None,
    "diff_summary": "",
    "judge_scores": None,
    "pr_description": ""
}

# Determine executor_type from worker branch naming
if len(worker_branches) > 1:
    report["executor_type"] = "multi_agent"
elif worker_branches:
    br = worker_branches[0]
    if br.endswith("-content"):
        report["executor_type"] = "api_call"
    elif br.endswith("-agent"):
        report["executor_type"] = "solo_agent"
    else:
        report["executor_type"] = "multi_agent"

# Diff summary for each worker branch
diff_parts = []
for wb in worker_branches:
    try:
        result = subprocess.run(
            ["git", "-C", repo_path, "diff", "--stat", task_branch + "..." + wb],
            capture_output=True, text=True, timeout=10
        )
        if result.stdout.strip():
            diff_parts.append(wb + ": " + result.stdout.strip().split("\n")[-1].strip())
    except Exception:
        diff_parts.append(wb + ": (diff unavailable)")
report["diff_summary"] = "; ".join(diff_parts)

# Contract check (multi_agent only)
if report["executor_type"] == "multi_agent" and contract_path and os.path.isfile(contract_path):
    contract_check = {
        "required_exports": [],
        "found_exports": [],
        "missing": [],
        "path_matches": True,
        "cross_contamination": False
    }

    # Parse contract for required exports
    with open(contract_path, encoding="utf-8") as f:
        contract_text = f.read()
    # Simple extraction: look for function signatures like funcName(
    exports = re.findall(r'(?:export\s+(?:function|const|class)\s+|function\s+)(\w+)', contract_text)
    if not exports:
        exports = re.findall(r'`(\w+)\(`', contract_text)
    contract_check["required_exports"] = exports

    # Check each worker branch for the exports
    found = set()
    worker_files = {}
    for wb in worker_branches:
        try:
            result = subprocess.run(
                ["git", "-C", repo_path, "diff", "--name-only", task_branch + "..." + wb],
                capture_output=True, text=True, timeout=10
            )
            files = [f.strip() for f in result.stdout.strip().split("\n") if f.strip()]
            worker_files[wb] = files
        except Exception:
            worker_files[wb] = []

        # Search for exports in diff content
        try:
            result = subprocess.run(
                ["git", "-C", repo_path, "diff", task_branch + "..." + wb],
                capture_output=True, text=True, timeout=10
            )
            for exp in exports:
                if exp in result.stdout:
                    found.add(exp)
        except Exception:
            pass

    contract_check["found_exports"] = sorted(found)
    contract_check["missing"] = sorted(set(exports) - found)

    # Cross contamination: check if worker branches modify overlapping files
    all_file_sets = list(worker_files.values())
    if len(all_file_sets) > 1:
        for i in range(len(all_file_sets)):
            for j in range(i + 1, len(all_file_sets)):
                overlap = set(all_file_sets[i]) & set(all_file_sets[j])
                if overlap:
                    contract_check["cross_contamination"] = True
                    break

    report["contract_check"] = contract_check

# Read judge scores from .rdloop/ if available
for wb in worker_branches:
    try:
        result = subprocess.run(
            ["git", "-C", repo_path, "show", wb + ":.rdloop/latest_verdict.json"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout.strip():
            verdict = json.loads(result.stdout)
            report["judge_scores"] = {
                "final_score": verdict.get("final_score_0_100", verdict.get("score")),
                "decision": verdict.get("decision", verdict.get("verdict"))
            }
    except Exception:
        pass

print(json.dumps(report, indent=2, ensure_ascii=False))
PYEOF
}

##############################################################################
# Entry point
##############################################################################
case "${1:-}" in
  create-branches)
    [ $# -lt 2 ] && { log_error "Usage: git_ops.sh create-branches <branch_init_spec.json>"; exit 1; }
    cmd_create_branches "$2"
    ;;
  merge-pr)
    [ $# -lt 2 ] && { log_error "Usage: git_ops.sh merge-pr <merge_decision.json>"; exit 1; }
    cmd_merge_pr "$2"
    ;;
  review-prep)
    [ $# -lt 2 ] && { log_error "Usage: git_ops.sh review-prep <task_slug> [contract_path] [repo_path] [task_branch] [worker_branches]"; exit 1; }
    cmd_review_prep "${2:-}" "${3:-}" "${4:-}" "${5:-}" "${6:-}"
    ;;
  *)
    echo "Usage: git_ops.sh <create-branches|merge-pr|review-prep> [args...]"
    exit 1
    ;;
esac
