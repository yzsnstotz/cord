#!/usr/bin/env bash
# test_req_boundary_extraction.sh — RDLOOP_REQ START/END parser contract.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTRACT="${RDLOOP_ROOT}/tools/extract_req_segment.sh"

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

echo "=== Test Suite: req_boundary_extraction ==="

sample="${TMPDIR}/sample.txt"
cat > "$sample" <<'TXT'
noise-before
[RDLOOP_REQ:RC-ABCD1234:START]
line-1
line-2
[RDLOOP_REQ:RC-ABCD1234:END]
noise-after
TXT

payload="$("$EXTRACT" "RC-ABCD1234" "$sample")"
printf 'line-1\nline-2' > "${TMPDIR}/expected_payload.txt"
printf '%s' "$payload" > "${TMPDIR}/actual_payload.txt"
assert_ok "extracts payload between markers" diff -u "${TMPDIR}/expected_payload.txt" "${TMPDIR}/actual_payload.txt"

missing_start="${TMPDIR}/missing_start.txt"
cat > "$missing_start" <<'TXT'
[RDLOOP_REQ:RC-ABCD1234:END]
TXT

set +e
"$EXTRACT" "RC-ABCD1234" "$missing_start" >"${TMPDIR}/out1.txt" 2>"${TMPDIR}/err1.txt"
rc1=$?
set -e
assert_ok "missing START returns non-zero" bash -lc '[ "'$rc1'" -ne 0 ]'
assert_ok "missing START message clear" bash -lc 'grep -q "missing START marker" "'$TMPDIR'/err1.txt"'

missing_end="${TMPDIR}/missing_end.txt"
cat > "$missing_end" <<'TXT'
[RDLOOP_REQ:RC-ABCD1234:START]
payload
TXT

set +e
"$EXTRACT" "RC-ABCD1234" "$missing_end" >"${TMPDIR}/out2.txt" 2>"${TMPDIR}/err2.txt"
rc2=$?
set -e
assert_ok "missing END returns non-zero" bash -lc '[ "'$rc2'" -ne 0 ]'
assert_ok "missing END message clear" bash -lc 'grep -q "missing END marker" "'$TMPDIR'/err2.txt"'

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
