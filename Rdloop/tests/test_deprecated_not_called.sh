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

# --- v5.2 T4: legacy antigravity/claude api-only adapters ---

echo ""
echo "=== Test Suite: v52_legacy_adapters ==="

# Legacy files must exist and have LEGACY header
for f in call_coder_antigravity.sh call_judge_antigravity.sh call_judge_claude.sh; do
  assert_ok "${f} has LEGACY header" bash -lc 'head -3 "'"${RDLOOP_ROOT}/coordinator/lib/${f}"'" | grep -q "LEGACY"'
done

# v5.1 routing functions must NOT return "antigravity-cli" for gemini provider
assert_ok "coder_type gemini!=antigravity-cli" bash -lc '
  eval "$(sed -n "/^normalize_provider_v51()/,/^}/p" "'"$RUN_TASK"'")"
  eval "$(sed -n "/^resolve_nonvisual_coder_type_v51()/,/^}/p" "'"$RUN_TASK"'")"
  result=$(resolve_nonvisual_coder_type_v51 "gemini")
  [ "$result" = "bridge" ]
'

assert_ok "judge_type gemini!=antigravity-cli" bash -lc '
  eval "$(sed -n "/^normalize_provider_v51()/,/^}/p" "'"$RUN_TASK"'")"
  eval "$(sed -n "/^resolve_nonvisual_judge_type_v51()/,/^}/p" "'"$RUN_TASK"'")"
  result=$(resolve_nonvisual_judge_type_v51 "gemini")
  [ "$result" = "bridge" ]
'

assert_ok "coder_type antigravity!=antigravity-cli" bash -lc '
  eval "$(sed -n "/^normalize_provider_v51()/,/^}/p" "'"$RUN_TASK"'")"
  eval "$(sed -n "/^resolve_nonvisual_coder_type_v51()/,/^}/p" "'"$RUN_TASK"'")"
  result=$(resolve_nonvisual_coder_type_v51 "antigravity")
  [ "$result" = "bridge" ]
'

# Existing mappings still work
assert_ok "coder_type claude=bridge" bash -lc '
  eval "$(sed -n "/^normalize_provider_v51()/,/^}/p" "'"$RUN_TASK"'")"
  eval "$(sed -n "/^resolve_nonvisual_coder_type_v51()/,/^}/p" "'"$RUN_TASK"'")"
  result=$(resolve_nonvisual_coder_type_v51 "claude")
  [ "$result" = "bridge" ]
'

assert_ok "coder_type codex=codex_cli" bash -lc '
  eval "$(sed -n "/^normalize_provider_v51()/,/^}/p" "'"$RUN_TASK"'")"
  eval "$(sed -n "/^resolve_nonvisual_coder_type_v51()/,/^}/p" "'"$RUN_TASK"'")"
  result=$(resolve_nonvisual_coder_type_v51 "codex")
  [ "$result" = "codex_cli" ]
'

echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
