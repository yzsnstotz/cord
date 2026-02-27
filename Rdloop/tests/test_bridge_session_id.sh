#!/usr/bin/env bash
# test_bridge_session_id.sh — Bridge adapters require external session_id
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CODER="${RDLOOP_ROOT}/coordinator/lib/call_coder_bridge.sh"
JUDGE="${RDLOOP_ROOT}/coordinator/lib/call_judge_bridge.sh"
SOLO_LINK="${RDLOOP_ROOT}/coordinator/lib/solo_bridge.sh"
BRIDGE="${RDLOOP_ROOT}/coordinator/lib/bridge.sh"

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

echo "=== Test Suite: bridge_session_id ==="

assert_ok "coder accepts --session-id" grep -q -- "--session-id" "$CODER"
assert_ok "judge accepts --session-id" grep -q -- "--session-id" "$JUDGE"
assert_ok "solo_bridge.sh is symlink" test -L "$SOLO_LINK"
assert_ok "solo_bridge.sh points to bridge.sh" bash -lc '[ "$(readlink "'$SOLO_LINK'")" = "bridge.sh" ]'
assert_ok "bridge.sh exists" test -f "$BRIDGE"

cat > "$TMPDIR/task.json" <<'JSON'
{"task_id":"t","repo_path":".","coder_timeout_seconds":1,"judge_timeout_seconds":1}
JSON
echo "instruction" > "$TMPDIR/instruction.txt"
mkdir -p "$TMPDIR/attempt/coder" "$TMPDIR/attempt/judge"
cat > "$TMPDIR/evidence.json" <<'JSON'
{"worktree_path":"."}
JSON

set +e
bash "$CODER" "$TMPDIR/task.json" "$TMPDIR/attempt" "$TMPDIR" "$TMPDIR/instruction.txt" >/dev/null 2>&1
coder_rc=$?
bash "$JUDGE" "$TMPDIR/task.json" "$TMPDIR/evidence.json" "$TMPDIR/attempt" "$TMPDIR/instruction.txt" >/dev/null 2>&1
judge_rc=$?
set -e

assert_ok "coder missing session_id rejected" bash -lc '[ "'$coder_rc'" -ne 0 ]'
assert_ok "judge missing session_id rejected" bash -lc '[ "'$judge_rc'" -ne 0 ]'

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
