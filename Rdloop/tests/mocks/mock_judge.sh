#!/usr/bin/env bash
set -euo pipefail

score="0"
next_instructions=""
rc=0
output_file="verdict.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --score)
      score="${2:-0}"; shift 2 ;;
    --next-instructions)
      next_instructions="${2:-}"; shift 2 ;;
    --rc)
      rc="${2:-0}"; shift 2 ;;
    --output-file)
      output_file="${2:-verdict.json}"; shift 2 ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2 ;;
  esac
done

mkdir -p "$(dirname "$output_file")"
cat > "$output_file" <<JSON
{
  "decision": "$( [ "$rc" -eq 0 ] && echo PASS || echo FAIL )",
  "score": $score,
  "next_instructions": $(printf '%s' "$next_instructions" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
}
JSON

exit "$rc"
