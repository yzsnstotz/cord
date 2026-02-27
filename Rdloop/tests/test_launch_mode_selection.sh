#!/usr/bin/env bash
# test_launch_mode_selection.sh — launch_mode_locked true/false behavior
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

echo "=== Test Suite: launch_mode_selection ==="

# locked=true uses task launch_mode directly
spec_locked="${TMPDIR}/locked_true.json"
cat > "$spec_locked" <<'JSON'
{
  "schema_version": "v51",
  "task_id": "locked_true",
  "task_type": "solo",
  "launch_mode": "bridge",
  "launch_mode_locked": true,
  "collab_roles": {"pm":"claude","designer":"claude","executor":"claude","reviewer":"claude"},
  "agent_config": {"provider":"claude"},
  "goal": "x",
  "acceptance": "x",
  "test_cmd": "true"
}
JSON
RDLOOP_OUT_DIR="${TMPDIR}/out" RDLOOP_WORKTREES_DIR="${TMPDIR}/wt" bash "$RUN_TASK" "$spec_locked" >"${TMPDIR}/locked_true.log" 2>&1
assert_ok "locked=true no wait path picks bridge" bash -lc 'python3 - <<PY
import json
ok=False
for line in open("'$TMPDIR'/out/locked_true/events.jsonl", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="launch_mode_selected":
    ok=(e.get("launch_mode")=="bridge" and e.get("locked") is True)
assert ok
PY'

# locked=false waits for GUI write
spec_wait="${TMPDIR}/locked_false_wait.json"
cat > "$spec_wait" <<'JSON'
{
  "schema_version": "v51",
  "task_id": "locked_false_wait",
  "task_type": "solo",
  "launch_mode_locked": false,
  "collab_roles": {"pm":"claude","designer":"claude","executor":"claude","reviewer":"claude"},
  "agent_config": {"provider":"claude"},
  "goal": "x",
  "acceptance": "x",
  "test_cmd": "true"
}
JSON
set +e
RDLOOP_OUT_DIR="${TMPDIR}/out" RDLOOP_WORKTREES_DIR="${TMPDIR}/wt" RDLOOP_LAUNCH_MODE_WAIT_SECONDS=8 bash "$RUN_TASK" "$spec_wait" >"${TMPDIR}/locked_false_wait.log" 2>&1 &
pid=$!
set -e
sleep 2
python3 - <<PY
import json, os, time
path = os.path.join("$TMPDIR", "out", "locked_false_wait", "task.json")
for _ in range(20):
    if os.path.exists(path):
        break
    time.sleep(0.2)
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        d=json.load(f)
    d["launch_mode"] = "bridge"
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
PY
wait "$pid"
assert_ok "locked=false waits and picks GUI-written bridge" bash -lc 'python3 - <<PY
import json
ok=False
for line in open("'$TMPDIR'/out/locked_false_wait/events.jsonl", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="launch_mode_selected":
    ok=(e.get("launch_mode")=="bridge" and e.get("locked") is False)
assert ok
PY'

# locked=false timeout defaults ccb
spec_timeout="${TMPDIR}/locked_false_timeout.json"
cat > "$spec_timeout" <<'JSON'
{
  "schema_version": "v51",
  "task_id": "locked_false_timeout",
  "task_type": "copywriting",
  "launch_mode_locked": false,
  "collab_roles": {"executor":"claude","reviewer":"claude"},
  "agent_config": {"provider":"claude"},
  "goal": "x",
  "acceptance": "x",
  "test_cmd": "true"
}
JSON
RDLOOP_OUT_DIR="${TMPDIR}/out" RDLOOP_WORKTREES_DIR="${TMPDIR}/wt" RDLOOP_LAUNCH_MODE_WAIT_SECONDS=1 bash "$RUN_TASK" "$spec_timeout" >"${TMPDIR}/locked_false_timeout.log" 2>&1
assert_ok "locked=false timeout defaults ccb" bash -lc 'python3 - <<PY
import json
ok=False
for line in open("'$TMPDIR'/out/locked_false_timeout/events.jsonl", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="launch_mode_selected":
    ok=(e.get("launch_mode")=="ccb" and e.get("locked") is False)
assert ok
PY'

assert_ok "timeout path writes launch_mode to task.json" bash -lc 'python3 - <<PY
import json
with open("'$TMPDIR'/out/locked_false_timeout/task.json", encoding="utf-8") as f:
  d=json.load(f)
assert d.get("launch_mode")=="ccb"
PY'

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
