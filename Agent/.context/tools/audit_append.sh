#!/usr/bin/env bash
# audit_append.sh v1.5.0 — Append one structured record to audit.jsonl atomically
# Usage: bash tools/audit_append.sh <project_path> <action> <actor> <target> <task_id> <note>
# Output: confirmation line (stdout) or error (stderr)
set -euo pipefail

VALID_SOLO_ACTIONS="file_created file_modified file_deleted task_started task_completed task_blocked task_degraded session_started session_compressed project_initialized"
VALID_COLLAB_ACTIONS="judge_passed judge_failed"
VALID_SKILL_ACTIONS="skill_added skill_rejected skill_mining_started skill_candidate_found llm_call hub_trace"

if [[ $# -ne 6 ]]; then
  echo "Usage: bash tools/audit_append.sh <project_path> <action> <actor> <target> <task_id> <note>" >&2
  exit 1
fi

PROJECT_PATH="$1"
ACTION="$2"
ACTOR="$3"
TARGET="$4"
TASK_ID="$5"
NOTE="$6"

AUDIT_FILE="$PROJECT_PATH/.context/audit.jsonl"

# Validate action
ALL_VALID="$VALID_SOLO_ACTIONS $VALID_COLLAB_ACTIONS $VALID_SKILL_ACTIONS"
if [[ ! " $ALL_VALID " =~ " $ACTION " ]]; then
  echo "Error: invalid action '$ACTION'. Valid: $ALL_VALID" >&2
  exit 1
fi

# Ensure directory exists
mkdir -p "$(dirname "$AUDIT_FILE")"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build JSON record
RECORD=$(printf '{"timestamp":"%s","action":"%s","actor":"%s","target":"%s","task_id":"%s","note":"%s"}' \
  "$TIMESTAMP" "$ACTION" "$ACTOR" "$TARGET" "$TASK_ID" "$NOTE")

# Atomic append via Python fcntl (cross-platform: macOS + Linux, no flock binary needed)
python3 - "$AUDIT_FILE" "$RECORD" <<'PYEOF'
import sys, fcntl

audit_file = sys.argv[1]
record = sys.argv[2]

lockfile = audit_file + ".lock"
with open(lockfile, "w") as lf:
    fcntl.flock(lf, fcntl.LOCK_EX)
    with open(audit_file, "a") as f:
        f.write(record + "\n")
    fcntl.flock(lf, fcntl.LOCK_UN)
PYEOF

echo "audit_append: OK [$ACTION] $TARGET @ $TIMESTAMP"
