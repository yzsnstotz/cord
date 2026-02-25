#!/usr/bin/env bash
# validate_markdown.sh — T04: static validation for skills/autoflow-run/SKILL.md (v1.9.0)
# Usage: bash tests/validate_markdown.sh <file>
# Run from Agent root. Fail-fast: first missing keyword exits 1.

set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Usage: $0 <path_to_SKILL.md>" >&2
  echo "Example: bash tests/validate_markdown.sh .context/skills/autoflow-run/SKILL.md" >&2
  exit 1
fi

content="$(cat "$FILE")"

check() {
  local keyword="$1"
  if ! echo "$content" | grep -q "$keyword"; then
    echo "validate_markdown: missing required keyword: $keyword" >&2
    exit 1
  fi
}

check "v1.9.0"
check "Step4c"
check "execution_mode"
check "run_rdloop_task.sh"

# At least 3 knowledge agent query examples (section has 4; require 3 distinct patterns)
count=0
echo "$content" | grep -q "What are the public" && count=$((count+1))
echo "$content" | grep -q "Which tasks modified" && count=$((count+1))
echo "$content" | grep -q "Summarize what" && count=$((count+1))
echo "$content" | grep -q "Which tests cover" && count=$((count+1))
if [ "$count" -lt 3 ]; then
  echo "validate_markdown: SKILL.md must contain at least 3 knowledge agent query examples (found $count)" >&2
  exit 1
fi

echo "validate_markdown: OK ($FILE)"
exit 0
