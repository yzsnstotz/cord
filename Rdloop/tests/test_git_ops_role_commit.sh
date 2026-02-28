#!/usr/bin/env bash
# test_git_ops_role_commit.sh — tests git_ops.sh role-commit subcommand
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_OPS="${RDLOOP_ROOT}/tools/git_ops.sh"

PASS=0; FAIL=0; TOTAL=0
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

assert_true() {
  local label="$1"
  shift
  TOTAL=$((TOTAL + 1))
  if "$@"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Test Suite: git_ops_role_commit ==="

git init "$TMPDIR/repo" >/dev/null 2>&1
cd "$TMPDIR/repo"
git config user.name "rdloop-test"
git config user.email "rdloop-test@example.com"
echo "init" > README.md
git add README.md
git commit -m "init" >/dev/null 2>&1

# dirty worktree commit
mkdir -p src
echo "v1" > src/file.txt
dirty_log="${TMPDIR}/role_commit.log"
set +e
bash "$GIT_OPS" role-commit --task T01 --role designer --session-id T01-designer-01-A01 --attempt-id 1 --message "phase complete" --repo "$TMPDIR/repo" >"$dirty_log" 2>&1
dirty_rc=$?
set -e
assert_true "role-commit exits 0 on dirty worktree" bash -lc '[ "'$dirty_rc'" = "0" ]'

# ensure commit message format and file is readable from git show HEAD:file
last_msg="$(git log -1 --pretty=%s)"
TOTAL=$((TOTAL + 1))
if [[ "$last_msg" == "role/designer task=T01 session=T01-designer-01-A01 attempt=1: phase complete" ]]; then
  echo "  PASS: commit message includes role/task/session/attempt"
  PASS=$((PASS + 1))
else
  echo "  FAIL: commit message includes role/task/session/attempt (actual='$last_msg')"
  FAIL=$((FAIL + 1))
fi

head_file="$(git show HEAD:src/file.txt 2>/dev/null || true)"
assert_true "role-commit output readable via git show" bash -lc '[ "'$head_file'" = "v1" ]'

# no-op path
before_sha="$(git rev-parse HEAD)"
noop_log="${TMPDIR}/role_commit_noop.log"
bash "$GIT_OPS" role-commit --task T01 --role designer --session-id T01-designer-01-A01 --attempt-id 1 --message "phase complete" --repo "$TMPDIR/repo" >"$noop_log" 2>&1
after_sha="$(git rev-parse HEAD)"
assert_true "no-op returns rc=0 and no new commit" bash -lc '[ "'$before_sha'" = "'$after_sha'" ]'
assert_true "no-op logs message" bash -lc 'grep -q "no-op" "'$noop_log'"'

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
