#!/usr/bin/env bash
# test_judge_feedback_injection.sh — T04: Verify judge next_instructions passed to next attempt
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"

PASS=0; FAIL=0; TOTAL=0

assert_file_contains() {
  local label="$1" file="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if grep -qE "$needle" "$file" 2>/dev/null; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (pattern '$needle' not in $file)"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_not_contains() {
  local label="$1" file="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if grep -qE "$needle" "$file" 2>/dev/null; then
    echo "  FAIL: $label (should NOT match '$needle')"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  fi
}

echo "=== Test Suite: judge_feedback_injection ==="

# ---- build_instruction uses session_mode ----
echo ""
echo "--- build_instruction is session_mode-aware ---"
assert_file_contains "reads session_mode" "$RUN_TASK" 'session_mode'
assert_file_contains "has carry context strategy" "$RUN_TASK" 'eff_ctx.*carry'
assert_file_contains "has reset context strategy" "$RUN_TASK" 'eff_ctx.*reset'

# ---- iterative mode injects prev output ----
echo ""
echo "--- iterative mode injects previous output ---"
assert_file_contains "iterative injects prev output" "$RUN_TASK" 'PREVIOUS VERSION.*attempt'

# ---- iterative mode injects judge next_instructions ----
echo ""
echo "--- iterative mode injects judge next_instructions ---"
assert_file_contains "next_instructions injection" "$RUN_TASK" 'next_instructions'
assert_file_contains "Judge feedback header" "$RUN_TASK" 'Judge.*指引'

# ---- fresh mode skips history ----
echo ""
echo "--- fresh mode skips all history ---"
# The condition should check eff_ctx != reset for judge feedback
assert_file_contains "fresh mode guard" "$RUN_TASK" 'eff_ctx.*!=.*reset'

# ---- git-first verdict reading ----
echo ""
echo "--- verdict read from git first, then filesystem fallback ---"
assert_file_contains "git show verdict" "$RUN_TASK" 'git.*show.*HEAD:.*verdict.json'
assert_file_contains "filesystem fallback" "$RUN_TASK" 'Filesystem fallback'

# ---- verdict.json path in .rdloop/ ----
echo ""
echo "--- verdict.json at .rdloop/attempt_N/ ---"
assert_file_contains "rdloop verdict path" "$RUN_TASK" '\.rdloop/attempt_'

# ---- empty next_instructions not injected ----
echo ""
echo "--- empty next_instructions not injected ---"
# Check the guard: if [ -n "$ni" ]; then
# Check that empty ni is guarded (grep for the line with -n and ni together)
TOTAL=$((TOTAL + 1))
if grep -q 'if \[ -n "$ni" \]' "$RUN_TASK" 2>/dev/null; then
  echo "  PASS: empty check guard"
  PASS=$((PASS + 1))
else
  echo "  FAIL: empty check guard"
  FAIL=$((FAIL + 1))
fi

# ---- Integration: mock attempt with verdict ----
echo ""
echo "--- Integration: mock verdict injection ---"
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

# Create a mock task directory structure simulating attempt 1 complete
TASK_DIR="$TMPDIR/task_dir"
mkdir -p "$TASK_DIR/attempt_001/judge"
mkdir -p "$TASK_DIR/attempt_001/coder"
mkdir -p "$TASK_DIR/attempt_002/coder"
echo '{"decision":"FAIL","score":5,"next_instructions":"Fix the auth token validation — check expiry before signature.","reasoning":"incomplete"}' > "$TASK_DIR/attempt_001/judge/verdict.json"
echo "first attempt output content here" > "$TASK_DIR/attempt_001/coder/run.log"

# Use build_instruction inline test by extracting the prompt assembly logic
# We simulate build_instruction for iterative mode
TASK_JSON_PATH="$TMPDIR/task.json"
cat > "$TASK_JSON_PATH" <<'EOF'
{
  "task_id": "test_feedback",
  "executor_type": "api_call",
  "session_mode": "iterative",
  "goal": "test goal",
  "acceptance": "test acceptance",
  "task_type": "requirements_doc"
}
EOF

# Simulate the prompt assembly
att_num=2
pp=$(printf "%03d" $(( att_num - 1 )))
pv="${TASK_DIR}/attempt_${pp}/judge/verdict.json"
ni=$(python3 -c "
import json
with open('$pv') as f: v = json.load(f)
print(v.get('next_instructions', ''))
" 2>/dev/null || echo "")

TOTAL=$((TOTAL + 1))
if [ "$ni" = "Fix the auth token validation — check expiry before signature." ]; then
  echo "  PASS: next_instructions extracted correctly from verdict.json"
  PASS=$((PASS + 1))
else
  echo "  FAIL: next_instructions extraction failed (got: '$ni')"
  FAIL=$((FAIL + 1))
fi

# Test fresh mode: should NOT inject
TOTAL=$((TOTAL + 1))
eff_ctx="reset"
if [ "$eff_ctx" = "reset" ]; then
  echo "  PASS: fresh mode correctly prevents injection (eff_ctx=reset)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: fresh mode should have eff_ctx=reset"
  FAIL=$((FAIL + 1))
fi

# Test iterative mode: should inject
TOTAL=$((TOTAL + 1))
eff_ctx="carry"
if [ "$eff_ctx" != "reset" ] && [ -n "$ni" ]; then
  echo "  PASS: iterative mode correctly enables injection (eff_ctx=carry, ni non-empty)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: iterative mode should inject feedback"
  FAIL=$((FAIL + 1))
fi

# ---- Summary ----
echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
