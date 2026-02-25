#!/usr/bin/env bash
# validate_schema.sh — T03: static validation for rules/init.md shared_contracts schema
# Usage: bash tests/validate_schema.sh <file>  (e.g. .context/rules/init.md)
# Run from Agent root. Fail-fast: first missing keyword exits 1.

set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Usage: $0 <path_to_init.md>" >&2
  echo "Example: bash tests/validate_schema.sh .context/rules/init.md" >&2
  exit 1
fi

content="$(cat "$FILE")"

check() {
  local keyword="$1"
  if ! echo "$content" | grep -q "$keyword"; then
    echo "validate_schema: missing required keyword: $keyword" >&2
    exit 1
  fi
}

check "shared_contracts"
check "owner_task"
check "interface_hash"
check "dependents"

# At least two file example JSON: src/auth.py and api/schema.json
if ! echo "$content" | grep -q "src/auth.py"; then
  echo "validate_schema: missing file example 'src/auth.py'" >&2
  exit 1
fi
if ! echo "$content" | grep -q "api/schema.json"; then
  echo "validate_schema: missing file example 'api/schema.json'" >&2
  exit 1
fi

echo "validate_schema: OK ($FILE)"
exit 0
