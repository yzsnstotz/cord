#!/usr/bin/env bash
# test_git_ops.sh — Tests for T07: git_ops.sh create-branches/merge-pr/review-prep
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_OPS="${RDLOOP_ROOT}/tools/git_ops.sh"

PASS=0; FAIL=0; TOTAL=0
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

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

assert_rc() {
  local label="$1" expected_rc="$2"
  shift 2
  TOTAL=$((TOTAL + 1))
  set +e; "$@" >/dev/null 2>&1; local actual_rc=$?; set -e
  if [ "$expected_rc" = "$actual_rc" ]; then
    echo "  PASS: $label (rc=$actual_rc)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected rc=$expected_rc, actual rc=$actual_rc)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Test Suite: git_ops ==="

# ---- Setup: create test git repo ----
git init "$TMPDIR/repo" >/dev/null 2>&1
cd "$TMPDIR/repo"
echo "init" > README.md
git add README.md && git commit -m "init" >/dev/null 2>&1

# ---- create-branches: api_call ----
echo ""
echo "--- create-branches: api_call ---"
cat > "$TMPDIR/spec_api.json" <<EOF
{
  "type": "BranchInitSpec",
  "task_slug": "homepage-copy",
  "date": "20260226",
  "repo_path": "$TMPDIR/repo",
  "base_ref": "main",
  "workers": [
    { "task_id": "T01", "executor_type": "api_call", "label": "content" }
  ]
}
EOF

assert_rc "create-branches api_call succeeds" 0 bash "$GIT_OPS" create-branches "$TMPDIR/spec_api.json"

TOTAL=$((TOTAL + 1))
if git -C "$TMPDIR/repo" show-ref --verify --quiet "refs/heads/task/20260226-homepage-copy"; then
  echo "  PASS: task branch created"
  PASS=$((PASS + 1))
else
  echo "  FAIL: task branch not created"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
if git -C "$TMPDIR/repo" show-ref --verify --quiet "refs/heads/worker/homepage-copy-content"; then
  echo "  PASS: worker/homepage-copy-content branch created"
  PASS=$((PASS + 1))
else
  echo "  FAIL: worker/homepage-copy-content branch not created"
  FAIL=$((FAIL + 1))
fi

# ---- create-branches: idempotent ----
echo ""
echo "--- create-branches: idempotent ---"
assert_rc "idempotent run" 0 bash "$GIT_OPS" create-branches "$TMPDIR/spec_api.json"

# ---- create-branches: multi_agent ----
echo ""
echo "--- create-branches: multi_agent ---"
cat > "$TMPDIR/spec_multi.json" <<EOF
{
  "type": "BranchInitSpec",
  "task_slug": "auth-service",
  "date": "20260226",
  "repo_path": "$TMPDIR/repo",
  "base_ref": "main",
  "workers": [
    { "task_id": "T10", "executor_type": "multi_agent", "label": "executor-a" },
    { "task_id": "T11", "executor_type": "multi_agent", "label": "executor-b" },
    { "task_id": "T12", "executor_type": "multi_agent", "label": "reviewer" }
  ]
}
EOF

assert_rc "create-branches multi_agent succeeds" 0 bash "$GIT_OPS" create-branches "$TMPDIR/spec_multi.json"

for br in "worker/auth-service-executor-a" "worker/auth-service-executor-b" "worker/auth-service-reviewer"; do
  TOTAL=$((TOTAL + 1))
  if git -C "$TMPDIR/repo" show-ref --verify --quiet "refs/heads/${br}"; then
    echo "  PASS: branch ${br} created"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: branch ${br} not created"
    FAIL=$((FAIL + 1))
  fi
done

# ---- create-branches: invalid spec type ----
echo ""
echo "--- create-branches: invalid spec ---"
echo '{"type":"NotBranchInitSpec"}' > "$TMPDIR/bad_spec.json"
assert_rc "invalid spec type rejected" 1 bash "$GIT_OPS" create-branches "$TMPDIR/bad_spec.json"

# ---- merge-pr: approve ----
echo ""
echo "--- merge-pr: approve ---"
# Clean up any worktrees so we can checkout the branch in the main repo
git -C "$TMPDIR/repo" worktree prune 2>/dev/null || true
for wt in "${RDLOOP_ROOT}/worktrees/homepage-copy"/*; do
  [ -d "$wt" ] && git -C "$TMPDIR/repo" worktree remove --force "$wt" 2>/dev/null || true
done
# Make a commit on worker branch
git -C "$TMPDIR/repo" checkout "worker/homepage-copy-content" >/dev/null 2>&1
echo "content v1" > "$TMPDIR/repo/content.md"
git -C "$TMPDIR/repo" add content.md && git -C "$TMPDIR/repo" commit -m "add content" >/dev/null 2>&1
git -C "$TMPDIR/repo" checkout main >/dev/null 2>&1

cat > "$TMPDIR/merge_approve.json" <<EOF
{
  "type": "MergeDecision",
  "task_id": "T01",
  "verdict": "approve",
  "repo_path": "$TMPDIR/repo",
  "worker_branch": "worker/homepage-copy-content",
  "task_branch": "task/20260226-homepage-copy",
  "blocking_issues": [],
  "merge_after": []
}
EOF

assert_rc "merge approve succeeds" 0 bash "$GIT_OPS" merge-pr "$TMPDIR/merge_approve.json"

# Check content.md is now in task branch
TOTAL=$((TOTAL + 1))
git -C "$TMPDIR/repo" checkout "task/20260226-homepage-copy" >/dev/null 2>&1
if [ -f "$TMPDIR/repo/content.md" ]; then
  echo "  PASS: content.md merged into task branch"
  PASS=$((PASS + 1))
else
  echo "  FAIL: content.md not in task branch after merge"
  FAIL=$((FAIL + 1))
fi
git -C "$TMPDIR/repo" checkout main >/dev/null 2>&1

# ---- merge-pr: request_changes ----
echo ""
echo "--- merge-pr: request_changes ---"
cat > "$TMPDIR/merge_rc.json" <<EOF
{
  "type": "MergeDecision",
  "task_id": "T02",
  "verdict": "request_changes",
  "repo_path": "$TMPDIR/repo",
  "blocking_issues": ["missing tests"],
  "merge_after": []
}
EOF
assert_rc "request_changes succeeds" 0 bash "$GIT_OPS" merge-pr "$TMPDIR/merge_rc.json"

# ---- merge-pr: invalid verdict ----
echo ""
echo "--- merge-pr: invalid verdict ---"
cat > "$TMPDIR/merge_bad.json" <<EOF
{
  "type": "MergeDecision",
  "task_id": "T03",
  "verdict": "something_else",
  "repo_path": "$TMPDIR/repo"
}
EOF
assert_rc "invalid verdict rejected" 1 bash "$GIT_OPS" merge-pr "$TMPDIR/merge_bad.json"

# ---- review-prep: basic ----
echo ""
echo "--- review-prep: basic ---"
TOTAL=$((TOTAL + 1))
output=$(bash "$GIT_OPS" review-prep "homepage-copy" "" "$TMPDIR/repo" "task/20260226-homepage-copy" "worker/homepage-copy-content" 2>/dev/null)
if echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'task_id' in d" 2>/dev/null; then
  echo "  PASS: review-prep outputs valid JSON with task_id"
  PASS=$((PASS + 1))
else
  echo "  FAIL: review-prep output invalid"
  FAIL=$((FAIL + 1))
fi

# ---- review-prep: api_call has null contract_check ----
TOTAL=$((TOTAL + 1))
cc=$(echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('contract_check'))" 2>/dev/null)
if [ "$cc" = "None" ]; then
  echo "  PASS: api_call contract_check is null"
  PASS=$((PASS + 1))
else
  echo "  FAIL: api_call contract_check should be null (got: $cc)"
  FAIL=$((FAIL + 1))
fi

# ---- Summary ----
echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
