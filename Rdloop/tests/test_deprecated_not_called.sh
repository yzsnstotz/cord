#!/usr/bin/env bash
# test_deprecated_not_called.sh — ensure deprecated cliproxy path is archived and not routed
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"

PASS=0; FAIL=0; TOTAL=0

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

echo "=== Test Suite: deprecated_not_called ==="

assert_ok "deprecated coder script exists" test -f "${RDLOOP_ROOT}/coordinator/lib/deprecated/call_coder_cliproxy.sh"
assert_ok "deprecated judge script exists" test -f "${RDLOOP_ROOT}/coordinator/lib/deprecated/call_judge_cliproxy.sh"
assert_ok "active coder cliproxy removed" bash -lc '[ ! -f "'"${RDLOOP_ROOT}"'"/coordinator/lib/call_coder_cliproxy.sh ]'
assert_ok "active judge cliproxy removed" bash -lc '[ ! -f "'"${RDLOOP_ROOT}"'"/coordinator/lib/call_judge_cliproxy.sh ]'
assert_ok "run_task does not reference deprecated dir" bash -lc '! rg -q "deprecated/" "'$RUN_TASK'"'
assert_ok "run_task api_call route not cliproxy" bash -lc 'python3 - <<PY
import re
s=open("'$RUN_TASK'", encoding="utf-8").read()
m=re.search(r"api_call\)\\n(?P<body>.*?)\\n\s*;;", s, re.S)
assert m and "cliproxy" not in m.group("body")
PY'

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
