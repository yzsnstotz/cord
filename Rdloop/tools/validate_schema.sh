#!/usr/bin/env bash
# validate_schema.sh — validate task specs against v5.1 required fields/rules.
# Usage:
#   bash tools/validate_schema.sh <task.json> [<task.json> ...]
#   bash tools/validate_schema.sh --schema <schema.json> <task.json> [<task.json> ...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMA="${RDLOOP_ROOT}/docs/schema/task_schema_v51.json"

if [ "${1:-}" = "--schema" ]; then
  [ "$#" -lt 3 ] && { echo "Usage: $0 --schema <schema.json> <task.json> [<task.json> ...]" >&2; exit 1; }
  SCHEMA="$2"
  shift 2
fi

[ "$#" -lt 1 ] && { echo "Usage: $0 <task.json> [<task.json> ...]" >&2; exit 1; }
[ -f "$SCHEMA" ] || { echo "schema not found: $SCHEMA" >&2; exit 1; }

python3 - "$SCHEMA" "$@" <<'PY'
import json
import sys

schema_path = sys.argv[1]
files = sys.argv[2:]

with open(schema_path, encoding="utf-8") as f:
    schema = json.load(f)

required = schema.get("required", [])
allowed_task_types = {"copywriting", "solo", "multi_agent"}
allowed_launch_modes = {"ccb", "bridge"}
failures = []

def add_failure(path, msg):
    failures.append(f"{path}: {msg}")

for path in files:
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except Exception as e:
        add_failure(path, f"invalid json: {e}")
        continue

    for field in required:
        if field not in doc:
            add_failure(path, f"missing required: {field}")

    task_type = doc.get("task_type")
    if task_type not in allowed_task_types:
        add_failure(path, "task_type must be copywriting|solo|multi_agent")

    launch_mode = doc.get("launch_mode")
    if launch_mode not in allowed_launch_modes:
        add_failure(path, "launch_mode must be ccb|bridge")

    if "launch_mode_locked" in doc and not isinstance(doc.get("launch_mode_locked"), bool):
        add_failure(path, "launch_mode_locked must be boolean")

    roles = doc.get("collab_roles") or {}
    if task_type == "copywriting":
        if not isinstance(roles, dict):
            add_failure(path, "copywriting collab_roles must be object")
        else:
            allowed = {"executor", "reviewer"}
            for need in ("executor", "reviewer"):
                if need not in roles:
                    add_failure(path, f"copywriting missing collab_roles.{need}")
            extra = sorted([k for k in roles.keys() if k not in allowed])
            if extra:
                add_failure(path, f"copywriting only allows executor/reviewer (found: {','.join(extra)})")

    if task_type == "solo" and isinstance(roles, dict) and roles:
        vals = {str(v).strip().lower() for v in roles.values() if str(v).strip()}
        if len(vals) > 1:
            add_failure(path, "solo requires identical provider in collab_roles")

if failures:
    for line in failures:
        print(line)
    sys.exit(1)

for path in files:
    print(f"OK: {path}")
PY
