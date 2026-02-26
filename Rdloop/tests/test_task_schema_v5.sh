#!/usr/bin/env bash
# test_task_schema_v5.sh — Tests for v5 task.json schema and migration
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATE="${RDLOOP_ROOT}/tools/migrate_task_json.sh"
SCHEMA="${RDLOOP_ROOT}/docs/schema/task_schema_v5.json"

PASS=0; FAIL=0; TOTAL=0
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected='$expected', actual='$actual')"
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
    echo "  FAIL: $label (expected to contain '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  FAIL: $label (should NOT contain '$needle')"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  fi
}

json_read() {
  python3 -c "
import json,sys
with open(sys.argv[1]) as f: d=json.load(f)
keys=sys.argv[2].split('.')
v=d
for k in keys: v=v[k]
if isinstance(v,bool): print('true' if v else 'false')
elif v is None: print('')
else: print(v)
" "$1" "$2" 2>/dev/null || echo ""
}

echo "=== Test Suite: task_schema_v5 ==="

# ---- Schema file exists ----
echo ""
echo "--- Schema file ---"
TOTAL=$((TOTAL + 1))
if [ -f "$SCHEMA" ]; then
  echo "  PASS: schema file exists"
  PASS=$((PASS + 1))
else
  echo "  FAIL: schema file not found at $SCHEMA"
  FAIL=$((FAIL + 1))
fi

# ---- Schema has required v5 fields ----
echo ""
echo "--- Schema fields ---"
schema_content=$(cat "$SCHEMA")
assert_contains "schema has executor_type" "$schema_content" '"executor_type"'
assert_contains "schema has session_mode" "$schema_content" '"session_mode"'
assert_contains "schema has agent_config" "$schema_content" '"agent_config"'
assert_contains "schema has collab_roles" "$schema_content" '"collab_roles"'
assert_contains "executor_type enum: api_call" "$schema_content" '"api_call"'
assert_contains "executor_type enum: solo_agent" "$schema_content" '"solo_agent"'
assert_contains "executor_type enum: multi_agent" "$schema_content" '"multi_agent"'
assert_contains "session_mode enum: fresh" "$schema_content" '"fresh"'
assert_contains "session_mode enum: iterative" "$schema_content" '"iterative"'
assert_contains "session_mode enum: continuous" "$schema_content" '"continuous"'
assert_contains "agent_config has max_attempts" "$schema_content" '"max_attempts"'
assert_contains "agent_config has auto_pass_threshold" "$schema_content" '"auto_pass_threshold"'
assert_contains "agent_config has knowledge_shards" "$schema_content" '"knowledge_shards"'
assert_contains "agent_config has provider" "$schema_content" '"provider"'

# ---- Migration: collab → multi_agent/continuous ----
echo ""
echo "--- Migration: collab → multi_agent/continuous ---"
cat > "$TMPDIR/collab.json" <<'EOF'
{
  "task_id": "test_collab",
  "workflow_mode": "collab",
  "goal": "test",
  "acceptance": "test",
  "collab_roles": { "executor": "claude", "reviewer": "codex" },
  "max_attempts": 3
}
EOF
bash "$MIGRATE" "$TMPDIR/collab.json"
assert_eq "executor_type=multi_agent" "multi_agent" "$(json_read "$TMPDIR/collab.json" "executor_type")"
assert_eq "session_mode=continuous" "continuous" "$(json_read "$TMPDIR/collab.json" "session_mode")"
assert_eq "schema_version=v5" "v5" "$(json_read "$TMPDIR/collab.json" "schema_version")"
collab_content=$(cat "$TMPDIR/collab.json")
assert_not_contains "workflow_mode removed" "$collab_content" '"workflow_mode"'

# ---- Migration: solo → solo_agent/continuous ----
echo ""
echo "--- Migration: solo → solo_agent/continuous ---"
cat > "$TMPDIR/solo.json" <<'EOF'
{
  "task_id": "test_solo",
  "workflow_mode": "solo",
  "goal": "test",
  "acceptance": "test",
  "max_attempts": 5
}
EOF
bash "$MIGRATE" "$TMPDIR/solo.json"
assert_eq "executor_type=solo_agent" "solo_agent" "$(json_read "$TMPDIR/solo.json" "executor_type")"
assert_eq "session_mode=continuous" "continuous" "$(json_read "$TMPDIR/solo.json" "session_mode")"
solo_content=$(cat "$TMPDIR/solo.json")
assert_not_contains "workflow_mode removed" "$solo_content" '"workflow_mode"'

# ---- Migration: single → api_call/fresh ----
echo ""
echo "--- Migration: single → api_call/fresh ---"
cat > "$TMPDIR/single.json" <<'EOF'
{
  "task_id": "test_single",
  "workflow_mode": "single",
  "goal": "test",
  "acceptance": "test",
  "max_attempts": 3
}
EOF
bash "$MIGRATE" "$TMPDIR/single.json"
assert_eq "executor_type=api_call" "api_call" "$(json_read "$TMPDIR/single.json" "executor_type")"
assert_eq "session_mode=fresh" "fresh" "$(json_read "$TMPDIR/single.json" "session_mode")"
single_content=$(cat "$TMPDIR/single.json")
assert_not_contains "workflow_mode removed" "$single_content" '"workflow_mode"'

# ---- Migration idempotent ----
echo ""
echo "--- Migration idempotent ---"
cp "$TMPDIR/single.json" "$TMPDIR/single_copy.json"
bash "$MIGRATE" "$TMPDIR/single.json"
TOTAL=$((TOTAL + 1))
if diff -q "$TMPDIR/single.json" "$TMPDIR/single_copy.json" >/dev/null 2>&1; then
  echo "  PASS: idempotent (no change on re-run)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: idempotent (file changed on re-run)"
  FAIL=$((FAIL + 1))
fi

# ---- Migration: solo_config → agent_config ----
echo ""
echo "--- Migration: solo_config → agent_config ---"
cat > "$TMPDIR/with_solo_config.json" <<'EOF'
{
  "task_id": "test_sc",
  "workflow_mode": "solo",
  "goal": "test",
  "acceptance": "test",
  "solo_config": {
    "max_attempts": 5,
    "auto_pass_threshold": 0.9,
    "knowledge_shards": ["auth"],
    "provider": "claude"
  }
}
EOF
bash "$MIGRATE" "$TMPDIR/with_solo_config.json"
assert_eq "agent_config.max_attempts" "5" "$(json_read "$TMPDIR/with_solo_config.json" "agent_config.max_attempts")"
assert_eq "agent_config.provider" "claude" "$(json_read "$TMPDIR/with_solo_config.json" "agent_config.provider")"
sc_content=$(cat "$TMPDIR/with_solo_config.json")
assert_not_contains "solo_config removed" "$sc_content" '"solo_config"'

# ---- Schema validation: missing executor_type → error ----
echo ""
echo "--- Schema validation: missing required fields ---"
cat > "$TMPDIR/no_executor.json" <<'EOF'
{
  "task_id": "test_no_et",
  "goal": "test",
  "acceptance": "test"
}
EOF
# Validate using python jsonschema if available, otherwise basic check
TOTAL=$((TOTAL + 1))
if python3 -c "
import json
with open('$SCHEMA') as f: schema = json.load(f)
with open('$TMPDIR/no_executor.json') as f: doc = json.load(f)
# Check required fields
required = schema.get('required', [])
missing = [r for r in required if r not in doc]
if missing:
    print('MISSING: ' + ','.join(missing))
    exit(1)
exit(0)
" 2>/dev/null; then
  echo "  FAIL: should reject missing executor_type"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: rejects missing executor_type"
  PASS=$((PASS + 1))
fi

# ---- Schema validation: invalid executor_type enum ----
echo ""
echo "--- Schema validation: invalid enum ---"
TOTAL=$((TOTAL + 1))
if python3 -c "
import json
with open('$SCHEMA') as f: schema = json.load(f)
et_enum = schema['properties']['executor_type']['enum']
if 'invalid_type' in et_enum:
    exit(0)
else:
    exit(1)
" 2>/dev/null; then
  echo "  FAIL: should not allow invalid_type in enum"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: invalid enum value not in schema"
  PASS=$((PASS + 1))
fi

# ---- Summary ----
echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
