#!/usr/bin/env bash
# test_run_task_routing_v5.sh — Tests for T02: v5 two-parameter routing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"

PASS=0; FAIL=0; TOTAL=0
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

assert_contains() {
  local label="$1" file="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if grep -q "$needle" "$file" 2>/dev/null; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected '$needle' in $file)"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" file="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if grep -q "$needle" "$file" 2>/dev/null; then
    echo "  FAIL: $label (should NOT contain '$needle')"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  fi
}

echo "=== Test Suite: run_task_routing_v5 ==="

# ---- Source file has v5 routing ----
echo ""
echo "--- run_task.sh contains v5 routing ---"
assert_contains "has executor_type routing" "$RUN_TASK" 'executor_type'
assert_contains "has session_mode routing" "$RUN_TASK" 'session_mode'
assert_contains "has context_strategy" "$RUN_TASK" 'context_strategy'
assert_contains "api_call → cliproxy" "$RUN_TASK" 'api_call'
assert_contains "solo_agent → solo" "$RUN_TASK" 'solo_agent'
assert_contains "multi_agent → ccb" "$RUN_TASK" 'multi_agent'
assert_contains "fresh → reset" "$RUN_TASK" 'context_strategy="reset"'
assert_contains "iterative → carry" "$RUN_TASK" 'context_strategy="carry"'
assert_contains "continuous → persist" "$RUN_TASK" 'context_strategy="persist"'

# ---- workflow_mode removed (v5 only) ----
echo ""
echo "--- workflow_mode not in routing ---"
assert_not_contains "no workflow_mode routing" "$RUN_TASK" 'workflow_mode.*case\|case.*workflow_mode'
assert_not_contains "no workflow_mode read" "$RUN_TASK" 'json_read.*workflow_mode'

# ---- Preserved adapters (cursor/codex/mock) ----
echo ""
echo "--- Legacy adapters preserved ---"
assert_contains "cursor adapter" "$RUN_TASK" 'coder_script_suffix="cursor"'
assert_contains "codex adapter" "$RUN_TASK" 'coder_script_suffix="codex"'
assert_contains "mock adapter fallback" "$RUN_TASK" 'coder_type="mock"'

# ---- Routing logic: extract executor_type → coder_type mapping ----
echo ""
echo "--- Routing logic correctness ---"
# api_call → cliproxy
TOTAL=$((TOTAL + 1))
if grep -A2 'api_call)' "$RUN_TASK" | grep -q 'coder_type="cliproxy"'; then
  echo "  PASS: api_call routes to cliproxy"
  PASS=$((PASS + 1))
else
  echo "  FAIL: api_call should route to cliproxy"
  FAIL=$((FAIL + 1))
fi

# solo_agent → solo (bridge) and ccb (visual_ccb)
TOTAL=$((TOTAL + 1))
if grep -A35 'solo_agent)' "$RUN_TASK" | grep -q 'coder_type="solo"' && \
   grep -A35 'solo_agent)' "$RUN_TASK" | grep -q 'coder_type="ccb"'; then
  echo "  PASS: solo_agent routes to solo/ccb by run_surface"
  PASS=$((PASS + 1))
else
  echo "  FAIL: solo_agent should route to solo/ccb by run_surface"
  FAIL=$((FAIL + 1))
fi

# multi_agent → ccb only (bridge routing removed from coordinator→agent path)
TOTAL=$((TOTAL + 1))
if grep -A6 'multi_agent)' "$RUN_TASK" | grep -q 'coder_type="ccb"' && \
   ! grep -A6 'multi_agent)' "$RUN_TASK" | grep -q 'coder_type="bridge"'; then
  echo "  PASS: multi_agent routes to ccb only"
  PASS=$((PASS + 1))
else
  echo "  FAIL: multi_agent should route to ccb only"
  FAIL=$((FAIL + 1))
fi

# ---- session_mode defaults to continuous ----
echo ""
echo "--- session_mode defaults ---"
assert_contains "default continuous" "$RUN_TASK" 'session_mode.*continuous'

# ---- Summary ----
echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
