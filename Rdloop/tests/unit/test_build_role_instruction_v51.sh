#!/usr/bin/env bash
# test_build_role_instruction_v51.sh — verify role-specific context slicing in knowledge_agent_query
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"

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

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected to find '${needle}')"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  FAIL: $label (unexpectedly found '${needle}')"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  fi
}

# Setup mock environment
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

TASK_DIR="${TMPDIR}/out/test_task"
mkdir -p "${TASK_DIR}"
TASK_JSON="${TASK_DIR}/task.json"
OUT_DIR="${TMPDIR}/out"
PROMPTS_DIR="${RDLOOP_ROOT}/prompts"

cat > "$TASK_JSON" <<'JSON'
{
  "task_type": "solo",
  "goal": "Implement feature X",
  "acceptance": ["Test passes", "No regressions"],
  "repo_path": "",
  "max_attempts": 1,
  "agent_config": {
    "provider": "claude",
    "max_attempts": 1,
    "knowledge_shards": ["shard_1: background info", "shard_2: domain context"]
  },
  "collab_roles": {"pm":"claude","designer":"claude","executor":"claude","reviewer":"claude"},
  "allowed_paths": ["src/", "tests/"]
}
JSON

# Extract needed functions from run_task.sh using python for reliable extraction
extract_func() {
  local file="$1" fname="$2"
  python3 -c "
import re, sys
code = open(sys.argv[1], encoding='utf-8').read()
# Match function from 'fname() {' to closing '}' at same indent level
pattern = r'(?m)(^[ ]*' + re.escape(sys.argv[2]) + r'\(\)\s*\{.*?)(?=\n[ ]*\w+\(\)\s*\{|\n##|\Z)'
m = re.search(pattern, code, re.DOTALL)
if m:
    print(m.group(1).rstrip())
" "$file" "$fname"
}

eval "$(extract_func "$RUN_TASK" "json_read")"
eval "$(extract_func "$RUN_TASK" "knowledge_agent_query")"

# Stub write_event_ext to no-op
write_event_ext() { :; }

echo "=== Test Suite: knowledge_agent_query context slicing ==="

# --- PM context ---
pm_ctx=$(knowledge_agent_query "pm" "" "" "" "")
assert_contains "pm gets KNOWLEDGE SHARDS" "$pm_ctx" "KNOWLEDGE SHARDS"
assert_contains "pm gets shard content" "$pm_ctx" "shard_1"
assert_not_contains "pm has no GIT STATUS" "$pm_ctx" "GIT STATUS"
assert_not_contains "pm has no DESIGNER OUTPUT" "$pm_ctx" "DESIGNER OUTPUT"
assert_not_contains "pm has no EVIDENCE BUNDLE" "$pm_ctx" "EVIDENCE BUNDLE"

# --- Designer context ---
# Create mock PM output
mkdir -p "${TASK_DIR}/roles/pm-00/coder"
echo "PM decomposition: step 1, step 2, step 3" > "${TASK_DIR}/roles/pm-00/coder/stdout.log"

designer_ctx=$(knowledge_agent_query "designer" "pm" "sid-pm" "" "")
assert_contains "designer gets PM OUTPUT" "$designer_ctx" "PM OUTPUT"
assert_contains "designer gets PM content" "$designer_ctx" "PM decomposition"
assert_not_contains "designer has no GIT STATUS" "$designer_ctx" "GIT STATUS"
assert_not_contains "designer has no EVIDENCE BUNDLE" "$designer_ctx" "EVIDENCE BUNDLE"

# --- Executor context ---
# Create mock designer output
mkdir -p "${TASK_DIR}/roles/designer-01/coder"
echo "Design contract: modify src/auth.py, add tests/test_auth.py" > "${TASK_DIR}/roles/designer-01/coder/stdout.log"

executor_ctx=$(knowledge_agent_query "executor" "designer" "sid-designer" "" "")
assert_contains "executor gets DESIGNER OUTPUT" "$executor_ctx" "DESIGNER OUTPUT"
assert_contains "executor gets designer content" "$executor_ctx" "Design contract"
assert_contains "executor gets ALLOWED PATHS" "$executor_ctx" "ALLOWED PATHS"
assert_contains "executor gets allowed path values" "$executor_ctx" "src/"
assert_not_contains "executor has no PM OUTPUT" "$executor_ctx" "PM OUTPUT"
assert_not_contains "executor has no EVIDENCE BUNDLE" "$executor_ctx" "EVIDENCE BUNDLE"

# --- Reviewer context ---
# Create mock attempt dir with evidence
mkdir -p "${TASK_DIR}/attempt_001/coder"
echo "Coder output: implemented auth module" > "${TASK_DIR}/attempt_001/coder/stdout.log"
mkdir -p "${TASK_DIR}/attempt_001/test"
echo "0" > "${TASK_DIR}/attempt_001/test/rc.txt"
echo "All tests passed" > "${TASK_DIR}/attempt_001/test/stdout.log"
echo "diff content here" > "${TASK_DIR}/attempt_001/diff.patch"

reviewer_ctx=$(knowledge_agent_query "reviewer" "" "" "" "")
assert_contains "reviewer gets EVIDENCE BUNDLE" "$reviewer_ctx" "EVIDENCE BUNDLE"
assert_contains "reviewer gets coder output" "$reviewer_ctx" "implemented auth module"
assert_contains "reviewer gets test result" "$reviewer_ctx" "Test result: rc=0"
assert_contains "reviewer gets test log" "$reviewer_ctx" "All tests passed"
assert_contains "reviewer gets diff patch" "$reviewer_ctx" "diff content here"
assert_not_contains "reviewer has no PM OUTPUT" "$reviewer_ctx" "PM OUTPUT"
assert_not_contains "reviewer has no DESIGNER OUTPUT" "$reviewer_ctx" "DESIGNER OUTPUT"

# --- PM with no shards ---
cat > "$TASK_JSON" <<'JSON'
{
  "task_type": "solo",
  "goal": "Simple task",
  "acceptance": [],
  "repo_path": "",
  "max_attempts": 1,
  "agent_config": {"provider": "claude", "max_attempts": 1, "knowledge_shards": []},
  "collab_roles": {"pm":"claude","designer":"claude","executor":"claude","reviewer":"claude"}
}
JSON

pm_empty_ctx=$(knowledge_agent_query "pm" "" "" "" "")
TOTAL=$((TOTAL + 1))
if [ -z "$pm_empty_ctx" ]; then
  echo "  PASS: pm with no shards returns empty context"
  PASS=$((PASS + 1))
else
  echo "  FAIL: pm with no shards should return empty context"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
