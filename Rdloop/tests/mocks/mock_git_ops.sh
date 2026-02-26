#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-}"
shift || true

log() { echo "[mock_git_ops] $*" >&2; }

case "$cmd" in
  create-branches)
    repo="${1:-}"
    task_branch="${2:-task/mock-task}"
    worker_branch="${3:-worker/mock-task-content}"
    [ -z "$repo" ] && { echo "repo required" >&2; exit 2; }
    git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { echo "invalid repo" >&2; exit 1; }
    if ! git -C "$repo" show-ref --verify --quiet "refs/heads/$task_branch"; then
      git -C "$repo" branch "$task_branch" >/dev/null 2>&1 || true
    fi
    if ! git -C "$repo" show-ref --verify --quiet "refs/heads/$worker_branch"; then
      git -C "$repo" branch "$worker_branch" "$task_branch" >/dev/null 2>&1 || true
    fi
    log "created $task_branch and $worker_branch"
    ;;
  merge-pr)
    repo="${1:-}"
    worker_branch="${2:-}"
    task_branch="${3:-}"
    [ -z "$repo" ] || [ -z "$worker_branch" ] || [ -z "$task_branch" ] && { echo "usage: merge-pr <repo> <worker_branch> <task_branch>" >&2; exit 2; }
    git -C "$repo" checkout "$task_branch" >/dev/null 2>&1
    git -C "$repo" merge --no-ff "$worker_branch" -m "mock merge $worker_branch" >/dev/null 2>&1 || true
    log "merged $worker_branch -> $task_branch"
    ;;
  review-prep)
    task_id="${1:-mock-task}"
    cat <<JSON
{"task_id":"$task_id","contract_check":null,"cross_contamination":false,"judge_scores":{"overall":100}}
JSON
    ;;
  *)
    echo "usage: $0 <create-branches|merge-pr|review-prep> ..." >&2
    exit 2
    ;;
esac
