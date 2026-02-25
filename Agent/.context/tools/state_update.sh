#!/usr/bin/env bash
# state_update.sh — Update a single task's status (and optional fields) in session_state.json
# Usage: bash tools/state_update.sh <project_path> <task_id> <new_status> [json_patch]
# Output: confirmation line (stdout) or error (stderr)
# Valid statuses: pending, in_progress, review, done, blocked, skipped
# Only PM role may call this script.
set -euo pipefail

VALID_STATUSES="pending in_progress review done blocked skipped"

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "Usage: bash tools/state_update.sh <project_path> <task_id> <new_status> [json_patch]" >&2
  exit 1
fi

PROJECT_PATH="$1"
TASK_ID="$2"
NEW_STATUS="$3"
JSON_PATCH="${4:-{}}"

STATE_FILE="$PROJECT_PATH/.context/session_state.json"

# Validate status
if [[ ! " $VALID_STATUSES " =~ " $NEW_STATUS " ]]; then
  echo "Error: invalid status '$NEW_STATUS'. Valid: $VALID_STATUSES" >&2
  exit 1
fi

if [[ ! -f "$STATE_FILE" ]]; then
  echo "Error: session_state.json not found at $STATE_FILE" >&2
  exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOCKFILE="$STATE_FILE.lock"

# Update via Python fcntl (cross-platform: macOS + Linux, no flock binary needed)
python3 - "$STATE_FILE" "$TASK_ID" "$NEW_STATUS" "$JSON_PATCH" "$TIMESTAMP" "$LOCKFILE" <<'PYEOF'
import sys, json, fcntl

state_file  = sys.argv[1]
task_id     = sys.argv[2]
new_status  = sys.argv[3]
json_patch  = sys.argv[4]
timestamp   = sys.argv[5]
lockfile    = sys.argv[6]

with open(lockfile, "w") as lf:
    fcntl.flock(lf, fcntl.LOCK_EX)

    with open(state_file, 'r') as f:
        state = json.load(f)

    patch = json.loads(json_patch)
    task  = next((t for t in state.get('tasks', []) if t['task_id'] == task_id), None)
    if task is None:
        print(f"Error: task_id '{task_id}' not found in session_state.json", file=sys.stderr)
        sys.exit(1)

    old_status = task.get('status')
    task['status'] = new_status
    task.update(patch)
    state['last_updated'] = timestamp

    with open(state_file, 'w') as f:
        json.dump(state, f, indent=2)

    fcntl.flock(lf, fcntl.LOCK_UN)

print(f"state_update: OK [{task_id}] {old_status} → {new_status} @ {timestamp}")
PYEOF
