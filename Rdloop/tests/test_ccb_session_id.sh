#!/usr/bin/env bash
# test_ccb_session_id.sh — CCB adapters require session_id + req_code and use req markers
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CODER="${RDLOOP_ROOT}/coordinator/lib/call_coder_ccb.sh"
JUDGE="${RDLOOP_ROOT}/coordinator/lib/call_judge_ccb.sh"

PASS=0; FAIL=0; TOTAL=0
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

assert_ok() {
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

echo "=== Test Suite: ccb_session_id ==="

# static checks for required markers and options
assert_ok "coder accepts --session-id" grep -q -- "--session-id" "$CODER"
assert_ok "coder accepts --req-code" grep -q -- "--req-code" "$CODER"
assert_ok "coder has RDLOOP_REQ START marker" grep -q "RDLOOP_REQ:.*:START" "$CODER"
assert_ok "coder has RDLOOP_REQ END marker" grep -q "RDLOOP_REQ:.*:END" "$CODER"
assert_ok "judge accepts --session-id" grep -q -- "--session-id" "$JUDGE"
assert_ok "judge accepts --req-code" grep -q -- "--req-code" "$JUDGE"
assert_ok "judge has RDLOOP_REQ START marker" grep -q "RDLOOP_REQ:.*:START" "$JUDGE"
assert_ok "judge has RDLOOP_REQ END marker" grep -q "RDLOOP_REQ:.*:END" "$JUDGE"

# behavioral checks: missing required args must fail before adapter execution
cat > "$TMPDIR/task.json" <<'JSON'
{"task_id":"t","repo_path":".","coder_timeout_seconds":1,"judge_timeout_seconds":1}
JSON
echo "instruction" > "$TMPDIR/instruction.txt"
mkdir -p "$TMPDIR/attempt/coder" "$TMPDIR/attempt/judge"
cat > "$TMPDIR/evidence.json" <<'JSON'
{"worktree_path":"."}
JSON

a=0
set +e
bash "$CODER" "$TMPDIR/task.json" "$TMPDIR/attempt" "$TMPDIR" "$TMPDIR/instruction.txt" >/dev/null 2>&1
coder_rc=$?
bash "$JUDGE" "$TMPDIR/task.json" "$TMPDIR/evidence.json" "$TMPDIR/attempt" "$TMPDIR/instruction.txt" >/dev/null 2>&1
judge_rc=$?
set -e

assert_ok "coder missing session args rejected" bash -lc '[ "'$coder_rc'" -ne 0 ]'
assert_ok "judge missing session args rejected" bash -lc '[ "'$judge_rc'" -ne 0 ]'

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
