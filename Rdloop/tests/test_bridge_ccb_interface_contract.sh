#!/usr/bin/env bash
# test_bridge_ccb_interface_contract.sh — verify bridge and ccb adapters accept unified interface flags
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="${RDLOOP_ROOT}/coordinator/lib"
BRIDGE_SCRIPT="${LIB}/call_coder_bridge.sh"
CCB_SCRIPT="${LIB}/call_coder_ccb.sh"

PASS=0; FAIL=0; TOTAL=0

assert_ok() {
  local label="$1"
  shift
  TOTAL=$((TOTAL + 1))
  if "$@" 2>/dev/null; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Test Suite: bridge_ccb_interface_contract ==="

# Both scripts must exist
assert_ok "bridge script exists" test -f "$BRIDGE_SCRIPT"
assert_ok "ccb script exists" test -f "$CCB_SCRIPT"

# Both scripts accept --session-id, --task-code, --attempt flags
# (check by grepping the source for flag handling)
assert_ok "bridge accepts --session-id" grep -q '\-\-session-id' "$BRIDGE_SCRIPT"
assert_ok "bridge accepts --task-code" grep -q '\-\-task-code' "$BRIDGE_SCRIPT"
assert_ok "bridge accepts --attempt" grep -q '\-\-attempt' "$BRIDGE_SCRIPT"
assert_ok "bridge accepts --req-code (compat)" grep -q '\-\-req-code' "$BRIDGE_SCRIPT"

assert_ok "ccb accepts --session-id" grep -q '\-\-session-id' "$CCB_SCRIPT"
assert_ok "ccb accepts --req-code" grep -q '\-\-req-code' "$CCB_SCRIPT"

# Both scripts produce the same output structure (rc.txt, run.log)
assert_ok "bridge outputs rc.txt" grep -q 'rc\.txt' "$BRIDGE_SCRIPT"
assert_ok "bridge outputs run.log" grep -q 'run\.log' "$BRIDGE_SCRIPT"
assert_ok "ccb outputs rc.txt" grep -q 'rc\.txt' "$CCB_SCRIPT"
assert_ok "ccb outputs run.log" grep -q 'run\.log' "$CCB_SCRIPT"

# Bridge reads RDLOOP_TASK_CODE from env
assert_ok "bridge reads RDLOOP_TASK_CODE" grep -q 'RDLOOP_TASK_CODE' "$BRIDGE_SCRIPT"
assert_ok "bridge reads RDLOOP_ATTEMPT" grep -q 'RDLOOP_ATTEMPT' "$BRIDGE_SCRIPT"

# claude_bridge/index.js accepts --task-code and --attempt
BRIDGE_INDEX="${RDLOOP_ROOT}/claude_bridge/index.js"
if [ -f "$BRIDGE_INDEX" ]; then
  assert_ok "index.js accepts --task-code" grep -q "task-code" "$BRIDGE_INDEX"
  assert_ok "index.js accepts --attempt" grep -q "'--attempt'" "$BRIDGE_INDEX"
fi

# run_task.sh unified dispatch: no more separate ccb/bridge/else triple branch for coder call
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"

# Check that run_role_action_v51 uses unified role_flags
assert_ok "role action uses unified role_flags" grep -q 'role_flags' "$RUN_TASK"

# Check that coder call uses unified coder_flags
assert_ok "coder call uses unified coder_flags" grep -q 'coder_flags' "$RUN_TASK"

echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
