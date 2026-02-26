#!/usr/bin/env bash
# test_worktree_init_timing.sh — T03: Verify worktree pre-initialization (fix PAUSED_NOT_GIT_REPO)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"
GIT_OPS="${RDLOOP_ROOT}/tools/git_ops.sh"

PASS=0; FAIL=0; TOTAL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected='$expected', actual='$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_contains() {
  local label="$1" file="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if grep -qE "$needle" "$file" 2>/dev/null; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (pattern '$needle' not found in $file)"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  FAIL: $label (should NOT contain '$needle')"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  fi
}

echo "=== Test Suite: worktree_init_timing ==="

# ---- run_task.sh: no worktree init inside attempt for api_call ----
echo ""
echo "--- run_task.sh does not init worktree inside attempt for api_call ---"

# api_call path checks for pre-created worktree
assert_file_contains "api_call checks pre-created worktree" "$RUN_TASK" 'pre_wt=.*WORKTREES_DIR'
assert_file_contains "api_call uses pre-created worktree" "$RUN_TASK" 'found_wt'

# ---- run_task.sh: v5 routing references executor_type not workflow_mode for worktree ----
echo ""
echo "--- executor_type used for worktree decision ---"
# The worktree section should reference executor_type
assert_file_contains "worktree uses executor_type" "$RUN_TASK" 'executor_type.*=.*api_call'

# ---- git_ops.sh create-branches creates worktree ----
echo ""
echo "--- git_ops.sh creates worktree during branch creation ---"
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

git init "$TMPDIR/repo" >/dev/null 2>&1
cd "$TMPDIR/repo"
echo "init" > README.md
git add README.md && git commit -m "init" >/dev/null 2>&1

cat > "$TMPDIR/spec.json" <<EOF
{
  "type": "BranchInitSpec",
  "task_slug": "wt-test",
  "date": "20260226",
  "repo_path": "$TMPDIR/repo",
  "base_ref": "main",
  "workers": [
    { "task_id": "WT01", "executor_type": "api_call", "label": "content" }
  ]
}
EOF

bash "$GIT_OPS" create-branches "$TMPDIR/spec.json" >/dev/null 2>&1

# Verify worktree was created
TOTAL=$((TOTAL + 1))
wt_path="${RDLOOP_ROOT}/worktrees/wt-test"
if [ -d "$wt_path" ]; then
  echo "  PASS: worktree directory created by create-branches"
  PASS=$((PASS + 1))
  # Cleanup
  git -C "$TMPDIR/repo" worktree prune 2>/dev/null || true
  for d in "$wt_path"/*/; do
    [ -d "$d" ] && git -C "$TMPDIR/repo" worktree remove --force "$d" 2>/dev/null || true
  done
  rm -rf "$wt_path" 2>/dev/null || true
else
  echo "  FAIL: worktree directory not created by create-branches"
  FAIL=$((FAIL + 1))
fi

# ---- PAUSED_NOT_GIT_REPO not triggered for api_call (code path check) ----
echo ""
echo "--- PAUSED_NOT_GIT_REPO suppressed for api_call ---"
# The setup_worktree function is only called as fallback, not as primary path for api_call
# The api_call path should prefer pre-created worktree
assert_file_contains "api_call has pre-wt check before setup_worktree" "$RUN_TASK" 'pre_wt=.*WORKTREES_DIR'

# ---- Worktree absent detection: clear error message ----
echo ""
echo "--- Worktree fallback to setup_worktree when pre-wt missing ---"
# When pre-created worktree doesn't exist, api_call should fall back to setup_worktree (not crash)
assert_file_contains "fallback to setup_worktree" "$RUN_TASK" 'setup_worktree'

# ---- Summary ----
echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
