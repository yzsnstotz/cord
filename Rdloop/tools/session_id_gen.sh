#!/usr/bin/env bash
# session_id_gen.sh — generate deterministic session_id for v5.1.
# Format: {task_id}-{role}-{NN}-{attempt_token}
# Example: T01-executor-01-A01

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <task_id> <role> <attempt_or_index>" >&2
  exit 1
fi

task_id="$1"
role="$2"
attempt_or_index="$3"

if ! [[ "$attempt_or_index" =~ ^[0-9]+$ ]]; then
  echo "Error: attempt_or_index must be a non-negative integer" >&2
  exit 1
fi

printf '%s-%s-%02d-A%02d\n' "$task_id" "$role" "$attempt_or_index" "$attempt_or_index"
