#!/usr/bin/env bash
# test_branch_naming.sh — Tests for T06 branch naming convention
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
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

# Define the same functions inline (from git_ops.sh) for unit testing
sanitize_slug() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//'
}
task_branch_name() {
  local date_str="$1" slug="$2"
  local safe_slug; safe_slug=$(sanitize_slug "$slug")
  echo "task/${date_str}-${safe_slug}"
}
worker_branch_name() {
  local slug="$1" executor_type="$2" label="$3"
  local safe_slug; safe_slug=$(sanitize_slug "$slug")
  local safe_label; safe_label=$(sanitize_slug "$label")
  case "$executor_type" in
    api_call)     echo "worker/${safe_slug}-content" ;;
    solo_agent)   echo "worker/${safe_slug}-agent" ;;
    multi_agent)  echo "worker/${safe_slug}-${safe_label}" ;;
    *) return 1 ;;
  esac
}

echo "=== Test Suite: branch_naming ==="

# ---- sanitize_slug ----
echo ""
echo "--- sanitize_slug ---"
assert_eq "lowercase" "hello-world" "$(sanitize_slug "Hello World")"
assert_eq "underscores preserved" "auth_service" "$(sanitize_slug "auth_service")"
assert_eq "multiple hyphens" "a-b-c" "$(sanitize_slug "a--b--c")"
assert_eq "leading/trailing" "abc" "$(sanitize_slug "-abc-")"
assert_eq "spaces" "my-task" "$(sanitize_slug "my task")"
assert_eq "mixed" "my-cool-task-v2" "$(sanitize_slug "My Cool Task v2")"

# ---- task_branch_name ----
echo ""
echo "--- task_branch_name ---"
assert_eq "basic" "task/20260226-homepage-copy" "$(task_branch_name "20260226" "homepage-copy")"
assert_eq "with spaces" "task/20260226-auth-service" "$(task_branch_name "20260226" "Auth Service")"

# ---- worker_branch_name for api_call ----
echo ""
echo "--- worker_branch_name: api_call ---"
assert_eq "api_call content" "worker/homepage-copy-content" "$(worker_branch_name "homepage-copy" "api_call" "content")"

# ---- worker_branch_name for solo_agent ----
echo ""
echo "--- worker_branch_name: solo_agent ---"
assert_eq "solo_agent agent" "worker/homepage-copy-agent" "$(worker_branch_name "homepage-copy" "solo_agent" "agent")"

# ---- worker_branch_name for multi_agent ----
echo ""
echo "--- worker_branch_name: multi_agent ---"
assert_eq "multi_agent executor-a" "worker/homepage-copy-executor-a" "$(worker_branch_name "homepage-copy" "multi_agent" "executor-A")"
assert_eq "multi_agent executor-b" "worker/homepage-copy-executor-b" "$(worker_branch_name "homepage-copy" "multi_agent" "executor-B")"
assert_eq "multi_agent reviewer" "worker/homepage-copy-reviewer" "$(worker_branch_name "homepage-copy" "multi_agent" "reviewer")"

# ---- slug sanitize prevents bad chars ----
echo ""
echo "--- slug sanitize edge cases ---"
assert_eq "no spaces in branch" "worker/my-task-content" "$(worker_branch_name "my task" "api_call" "content")"
assert_eq "no special chars" "worker/auth-login-agent" "$(worker_branch_name "auth/login" "solo_agent" "agent")"

# ---- create-branches integration (with temp git repo) ----
echo ""
echo "--- create-branches integration ---"
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

# Create a bare git repo for testing
git -C "$TMPDIR" init --bare repo.git >/dev/null 2>&1
git clone "$TMPDIR/repo.git" "$TMPDIR/repo" >/dev/null 2>&1
cd "$TMPDIR/repo"
echo "init" > README.md
git add README.md && git commit -m "init" >/dev/null 2>&1
git push origin main >/dev/null 2>&1

# Write BranchInitSpec
cat > "$TMPDIR/spec.json" <<EOF
{
  "type": "BranchInitSpec",
  "task_slug": "test-task",
  "date": "20260226",
  "repo_path": "$TMPDIR/repo",
  "base_ref": "main",
  "workers": [
    { "task_id": "T01", "executor_type": "api_call", "label": "content" },
    { "task_id": "T02", "executor_type": "solo_agent", "label": "agent" }
  ]
}
EOF

# Run create-branches
bash "$GIT_OPS" create-branches "$TMPDIR/spec.json" >/dev/null 2>&1

# Check branches were created
TOTAL=$((TOTAL + 1))
if git -C "$TMPDIR/repo" show-ref --verify --quiet "refs/heads/task/20260226-test-task" 2>/dev/null; then
  echo "  PASS: task branch created"
  PASS=$((PASS + 1))
else
  echo "  FAIL: task branch not created"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
if git -C "$TMPDIR/repo" show-ref --verify --quiet "refs/heads/worker/test-task-content" 2>/dev/null; then
  echo "  PASS: api_call worker branch created"
  PASS=$((PASS + 1))
else
  echo "  FAIL: api_call worker branch not created"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
if git -C "$TMPDIR/repo" show-ref --verify --quiet "refs/heads/worker/test-task-agent" 2>/dev/null; then
  echo "  PASS: solo_agent worker branch created"
  PASS=$((PASS + 1))
else
  echo "  FAIL: solo_agent worker branch not created"
  FAIL=$((FAIL + 1))
fi

# ---- Idempotent: run again, should not error ----
TOTAL=$((TOTAL + 1))
if bash "$GIT_OPS" create-branches "$TMPDIR/spec.json" >/dev/null 2>&1; then
  echo "  PASS: create-branches idempotent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: create-branches not idempotent"
  FAIL=$((FAIL + 1))
fi

# ---- Summary ----
echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
