#!/usr/bin/env bash
# test_session_id.sh — tests for session_id_gen.sh + req_code_gen.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SID_GEN="${RDLOOP_ROOT}/tools/session_id_gen.sh"
REQ_GEN="${RDLOOP_ROOT}/tools/req_code_gen.sh"

PASS=0; FAIL=0; TOTAL=0

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

echo "=== Test Suite: session_id ==="

sid1="$(bash "$SID_GEN" T01 executor 1)"
assert_true "session_id format" bash -lc '[[ "'$sid1'" = "T01-executor-01-A01" ]]'

sid2="$(bash "$SID_GEN" T01 executor 1)"
assert_true "session_id deterministic for same input" bash -lc '[ "'$sid1'" = "'$sid2'" ]'

sid0="$(bash "$SID_GEN" T99 pm 0)"
assert_true "index and attempt token padded 00" bash -lc '[[ "'$sid0'" = "T99-pm-00-A00" ]]'

# fixed example for deterministic req code check
fixed_sid="T01-executor-01-A01"
req_code="$(bash "$REQ_GEN" "$fixed_sid")"
assert_true "req_code format" bash -lc '[[ "'$req_code'" =~ ^RC-[A-F0-9]{8}$ ]]'

expected="$(python3 - <<'PY'
import hashlib
sid='T01-executor-01-A01'
print('RC-' + hashlib.sha256(sid.encode()).hexdigest()[:8].upper())
PY
)"
assert_true "req_code deterministic hash" bash -lc '[ "'$req_code'" = "'$expected'" ]'

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
