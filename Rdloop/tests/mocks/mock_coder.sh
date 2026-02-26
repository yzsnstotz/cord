#!/usr/bin/env bash
set -euo pipefail

rc=0
output_file=""
content=""

while [ $# -gt 0 ]; do
  case "$1" in
    --rc)
      rc="${2:-0}"; shift 2 ;;
    --output-file)
      output_file="${2:-}"; shift 2 ;;
    --content)
      content="${2:-}"; shift 2 ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2 ;;
  esac
done

if [ -n "$output_file" ]; then
  mkdir -p "$(dirname "$output_file")"
  printf '%s\n' "$content" > "$output_file"
fi

exit "$rc"
