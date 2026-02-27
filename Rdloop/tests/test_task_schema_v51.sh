#!/usr/bin/env bash
# test_task_schema_v51.sh — tests for v5.1 task schema + migration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMA="${RDLOOP_ROOT}/docs/schema/task_schema_v51.json"
MIGRATE="${RDLOOP_ROOT}/tools/migrate_task_json_v51.sh"
EXAMPLES_DIR="${RDLOOP_ROOT}/tests/fixtures/mock_project_v51/migration_examples"

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
    echo "  FAIL: $label (missing '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

json_read() {
  python3 -c '
import json,sys
with open(sys.argv[1], encoding="utf-8") as f:
    d=json.load(f)
v=d
for k in sys.argv[2].split("."):
    v=v[k]
if isinstance(v,bool): print("true" if v else "false")
elif v is None: print("")
else: print(v)
' "$1" "$2" 2>/dev/null || echo ""
}

validate_v51() {
  local file="$1"
  python3 - "$SCHEMA" "$file" <<'PY'
import json, sys

schema_path, doc_path = sys.argv[1], sys.argv[2]
with open(schema_path, encoding='utf-8') as f:
    schema = json.load(f)
with open(doc_path, encoding='utf-8') as f:
    doc = json.load(f)

errors = []
required = schema.get('required', [])
for field in required:
    if field not in doc:
        errors.append(f"missing required: {field}")

task_type = doc.get('task_type')
if task_type not in ['copywriting', 'solo', 'multi_agent']:
    errors.append('invalid task_type')

launch_mode = doc.get('launch_mode')
if launch_mode not in ['ccb', 'bridge']:
    errors.append('invalid launch_mode')

if 'launch_mode_locked' in doc and not isinstance(doc['launch_mode_locked'], bool):
    errors.append('launch_mode_locked must be boolean')

roles = doc.get('collab_roles') or {}
if task_type == 'copywriting':
    if not isinstance(roles, dict):
        errors.append('copywriting collab_roles must be object')
    else:
        allowed = {'executor', 'reviewer'}
        unknown = sorted([k for k in roles.keys() if k not in allowed])
        if unknown:
            errors.append('copywriting collab_roles only allow executor/reviewer')
        for k in ['executor', 'reviewer']:
            if k not in roles:
                errors.append(f'copywriting missing collab_roles.{k}')

if task_type == 'solo' and isinstance(roles, dict) and roles:
    vals = {str(v).strip().lower() for v in roles.values() if str(v).strip()}
    if len(vals) > 1:
        errors.append('solo requires same provider for all collab_roles')

if errors:
    print('\n'.join(errors))
    sys.exit(1)
print('ok')
PY
}

echo "=== Test Suite: task_schema_v51 ==="

TOTAL=$((TOTAL + 1))
if [ -f "$SCHEMA" ]; then
  echo "  PASS: schema file exists"
  PASS=$((PASS + 1))
else
  echo "  FAIL: schema missing: $SCHEMA"
  FAIL=$((FAIL + 1))
fi

schema_content="$(cat "$SCHEMA")"
assert_contains "schema has task_type" "$schema_content" '"task_type"'
assert_contains "schema has launch_mode" "$schema_content" '"launch_mode"'
assert_contains "schema has launch_mode_locked" "$schema_content" '"launch_mode_locked"'
assert_contains "task_type enum includes copywriting" "$schema_content" '"copywriting"'
assert_contains "task_type enum includes solo" "$schema_content" '"solo"'
assert_contains "task_type enum includes multi_agent" "$schema_content" '"multi_agent"'
assert_contains "launch_mode enum includes ccb" "$schema_content" '"ccb"'
assert_contains "launch_mode enum includes bridge" "$schema_content" '"bridge"'
TOTAL=$((TOTAL + 1))
if echo "$schema_content" | grep -q '"executor_type"'; then
  echo "  FAIL: schema should not contain executor_type"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: schema removed executor_type"
  PASS=$((PASS + 1))
fi
TOTAL=$((TOTAL + 1))
if echo "$schema_content" | grep -q '"session_mode"'; then
  echo "  FAIL: schema should not contain session_mode"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: schema removed session_mode"
  PASS=$((PASS + 1))
fi

# Migration mapping tests (3 examples)
cp "$EXAMPLES_DIR/before_copywriting.json" "$TMPDIR/copy.json"
cp "$EXAMPLES_DIR/before_solo.json" "$TMPDIR/solo.json"
cp "$EXAMPLES_DIR/before_multi_agent.json" "$TMPDIR/multi.json"

# Default mode writes migrated copy and keeps source unchanged.
cp "$EXAMPLES_DIR/before_copywriting.json" "$TMPDIR/default_mode.json"
cp "$TMPDIR/default_mode.json" "$TMPDIR/default_mode.snapshot.json"
bash "$MIGRATE" "$TMPDIR/default_mode.json" >/dev/null
assert_eq "default mode keeps source file untouched" "$(cat "$TMPDIR/default_mode.snapshot.json")" "$(cat "$TMPDIR/default_mode.json")"
TOTAL=$((TOTAL + 1))
if [ -f "$TMPDIR/default_mode.v51.json" ]; then
  echo "  PASS: default mode writes .v51.json output"
  PASS=$((PASS + 1))
else
  echo "  FAIL: default mode should write .v51.json output"
  FAIL=$((FAIL + 1))
fi

bash "$MIGRATE" --in-place --drop-legacy "$TMPDIR/copy.json" "$TMPDIR/solo.json" "$TMPDIR/multi.json" >/dev/null

assert_eq "api_call -> copywriting" "copywriting" "$(json_read "$TMPDIR/copy.json" "task_type")"
assert_eq "solo_agent -> solo" "solo" "$(json_read "$TMPDIR/solo.json" "task_type")"
assert_eq "multi_agent -> multi_agent" "multi_agent" "$(json_read "$TMPDIR/multi.json" "task_type")"
assert_eq "default launch_mode ccb" "ccb" "$(json_read "$TMPDIR/copy.json" "launch_mode")"
assert_eq "run_surface bridge -> launch_mode bridge" "bridge" "$(json_read "$TMPDIR/solo.json" "launch_mode")"
assert_eq "launch_mode_locked default false" "false" "$(json_read "$TMPDIR/copy.json" "launch_mode_locked")"

TOTAL=$((TOTAL + 1))
copy_after="$(cat "$TMPDIR/copy.json")"
if echo "$copy_after" | grep -q '"executor_type"\|"session_mode"'; then
  echo "  FAIL: migration should remove executor_type/session_mode"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: migration removes executor_type/session_mode"
  PASS=$((PASS + 1))
fi

# Idempotent
cp "$TMPDIR/copy.json" "$TMPDIR/copy.snapshot.json"
bash "$MIGRATE" --in-place --drop-legacy "$TMPDIR/copy.json" >/dev/null
TOTAL=$((TOTAL + 1))
if diff -q "$TMPDIR/copy.snapshot.json" "$TMPDIR/copy.json" >/dev/null 2>&1; then
  echo "  PASS: migration idempotent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: migration not idempotent"
  FAIL=$((FAIL + 1))
fi

# Validator cases
cat > "$TMPDIR/valid.json" <<'J'
{
  "task_id": "valid_1",
  "task_type": "copywriting",
  "launch_mode": "ccb",
  "launch_mode_locked": false,
  "collab_roles": { "executor": "claude", "reviewer": "claude" }
}
J
TOTAL=$((TOTAL + 1))
if validate_v51 "$TMPDIR/valid.json" >/dev/null 2>&1; then
  echo "  PASS: validator accepts valid v5.1"
  PASS=$((PASS + 1))
else
  echo "  FAIL: validator rejected valid v5.1"
  FAIL=$((FAIL + 1))
fi

cat > "$TMPDIR/bad_task_type.json" <<'J'
{"task_type":"unknown","launch_mode":"ccb","launch_mode_locked":false}
J
TOTAL=$((TOTAL + 1))
if out=$(validate_v51 "$TMPDIR/bad_task_type.json" 2>&1); then
  echo "  FAIL: invalid task_type should fail"
  FAIL=$((FAIL + 1))
else
  if echo "$out" | grep -q 'invalid task_type'; then
    echo "  PASS: invalid task_type returns clear error"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: invalid task_type error message unclear"
    FAIL=$((FAIL + 1))
  fi
fi

cat > "$TMPDIR/missing_launch.json" <<'J'
{"task_type":"solo","launch_mode_locked":false,"collab_roles":{"pm":"claude","designer":"claude","executor":"claude","reviewer":"claude"}}
J
TOTAL=$((TOTAL + 1))
if out=$(validate_v51 "$TMPDIR/missing_launch.json" 2>&1); then
  echo "  FAIL: missing launch_mode should fail"
  FAIL=$((FAIL + 1))
else
  if echo "$out" | grep -q 'missing required: launch_mode'; then
    echo "  PASS: missing launch_mode returns clear error"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: missing launch_mode error message unclear"
    FAIL=$((FAIL + 1))
  fi
fi

cat > "$TMPDIR/bad_solo_roles.json" <<'J'
{"task_type":"solo","launch_mode":"bridge","launch_mode_locked":false,"collab_roles":{"pm":"claude","designer":"codex","executor":"claude","reviewer":"claude"}}
J
TOTAL=$((TOTAL + 1))
if out=$(validate_v51 "$TMPDIR/bad_solo_roles.json" 2>&1); then
  echo "  FAIL: solo provider mismatch should fail"
  FAIL=$((FAIL + 1))
else
  if echo "$out" | grep -q 'solo requires same provider'; then
    echo "  PASS: solo provider mismatch rejected"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: solo provider mismatch message unclear"
    FAIL=$((FAIL + 1))
  fi
fi

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
