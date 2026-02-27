#!/usr/bin/env bash
# test_run_task_routing_v51.sh — v5.1 task_type + launch_mode routing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"

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

run_case() {
  local task_type="$1" launch_mode="$2"
  local task_id="${task_type}_${launch_mode}"
  local spec="${TMPDIR}/${task_id}.json"
  local roles_json='{"pm":"claude","designer":"claude","executor":"claude","reviewer":"claude"}'
  if [ "$task_type" = "copywriting" ]; then
    roles_json='{"executor":"claude","reviewer":"claude"}'
  fi

  cat > "$spec" <<JSON
{
  "schema_version": "v51",
  "task_id": "${task_id}",
  "task_type": "${task_type}",
  "launch_mode": "${launch_mode}",
  "launch_mode_locked": true,
  "collab_roles": ${roles_json},
  "agent_config": {"provider":"claude"},
  "goal": "test",
  "acceptance": "ok",
  "test_cmd": "true",
  "max_attempts": 1
}
JSON

  set +e
  RDLOOP_OUT_DIR="${TMPDIR}/out" RDLOOP_WORKTREES_DIR="${TMPDIR}/wt" bash "$RUN_TASK" "$spec" >"${TMPDIR}/${task_id}.log" 2>&1
  local rc=$?
  set -e
  assert_ok "${task_id} run rc=0" bash -lc '[ "'$rc'" = "0" ]'

  local tdir="${TMPDIR}/out/${task_id}"
  local events="${tdir}/events.jsonl"
  local status="${tdir}/status.json"
  local task_state="${tdir}/task_state.json"

  assert_ok "${task_id} events exists" test -f "$events"
  assert_ok "${task_id} status READY_FOR_REVIEW" bash -lc 'grep -q "READY_FOR_REVIEW" "'$status'"'
  assert_ok "${task_id} task_state sessions exists" bash -lc 'python3 - <<PY
import json
with open("'$task_state'", encoding="utf-8") as f:
  d=json.load(f)
assert isinstance(d.get("sessions"), dict) and len(d.get("sessions"))>0
PY'

  local expected_roles="3"
  [ "$task_type" = "copywriting" ] || expected_roles="4"

  assert_ok "${task_id} launch_mode_selected event has fields" bash -lc 'python3 - <<PY
import json
ok=False
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="launch_mode_selected":
    ok=(e.get("launch_mode")=="'$launch_mode'" and e.get("locked") is True)
assert ok
PY'

  assert_ok "${task_id} role_start count" bash -lc 'python3 - <<PY
import json
n=0
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="role_start":
    assert e.get("session_id")
    n+=1
assert n=='$expected_roles'
PY'

  assert_ok "${task_id} role_transition includes from/to/session_id" bash -lc 'python3 - <<PY
import json
n=0
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="role_transition":
    assert e.get("from")
    assert e.get("to")
    assert e.get("session_id")
    n+=1
assert n=='$((expected_roles-1))'
PY'

  if [ "$launch_mode" = "ccb" ]; then
    assert_ok "${task_id} uses ccb_call" bash -lc 'python3 - <<PY
import json
n=0
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="ccb_call":
    assert e.get("session_id") and e.get("req_code")
    n+=1
assert n=='$expected_roles'
PY'
  else
    assert_ok "${task_id} uses bridge_call" bash -lc 'python3 - <<PY
import json
n=0
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="bridge_call":
    assert e.get("session_id")
    n+=1
assert n=='$expected_roles'
PY'
  fi

  if [ "$task_type" = "copywriting" ]; then
    assert_ok "${task_id} skips designer" bash -lc 'python3 - <<PY
import json
roles=[]
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="role_start":
    roles.append(e.get("role"))
assert roles==["pm","executor","reviewer"]
PY'
  fi
}

echo "=== Test Suite: run_task_routing_v51 ==="
for tt in copywriting solo multi_agent; do
  for lm in ccb bridge; do
    run_case "$tt" "$lm"
  done
done

# missing task_type should fail in v51 signature
bad="${TMPDIR}/missing_task_type.json"
cat > "$bad" <<'JSON'
{
  "schema_version": "v51",
  "task_id": "missing_task_type",
  "launch_mode": "ccb",
  "launch_mode_locked": true,
  "goal": "x",
  "acceptance": "x",
  "test_cmd": "true"
}
JSON
set +e
RDLOOP_OUT_DIR="${TMPDIR}/out" RDLOOP_WORKTREES_DIR="${TMPDIR}/wt" bash "$RUN_TASK" "$bad" >"${TMPDIR}/missing.log" 2>&1
bad_rc=$?
set -e
assert_ok "missing task_type returns non-zero" bash -lc '[ "'$bad_rc'" -ne 0 ]'
assert_ok "missing task_type message clear" bash -lc 'grep -q "task_type is required" "'$TMPDIR'/missing.log"'

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
