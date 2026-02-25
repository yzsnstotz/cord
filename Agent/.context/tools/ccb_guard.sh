#!/usr/bin/env bash
# ccb_guard.sh — Remove CCB-injected blocks from CLAUDE.md / AGENTS.md / .clinerules
# Run once after CCB install, or on demand if CCB re-injects.
# Usage: bash $TOOLS_ROOT/ccb_guard.sh [--check]
#   --check : report only, do not modify files
#
# CCB injects these marker blocks which this script removes:
#   <!-- CCB_CONFIG_START --> ... <!-- CCB_CONFIG_END -->     (CLAUDE.md)
#   <!-- CCB_ROLES_START --> ... <!-- CCB_ROLES_END -->       (AGENTS.md, .clinerules)
#   <!-- REVIEW_RUBRICS_START --> ... <!-- REVIEW_RUBRICS_END --> (AGENTS.md)
#
# These blocks are redundant: agent body manages role/rubric content via
# collab_context.md and embeds it in every /ask task package directly.

set -euo pipefail

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
fi

CLAUDE_MD="$HOME/.claude/CLAUDE.md"
AGENTS_MD="$HOME/.local/share/codex-dual/AGENTS.md"
CLINERULES="$HOME/.local/share/codex-dual/.clinerules"

found_any=false

strip_block() {
  local file="$1"
  local start_marker="$2"
  local end_marker="$3"
  local label="$4"

  if [[ ! -f "$file" ]]; then
    return
  fi

  if grep -q "$start_marker" "$file" 2>/dev/null; then
    found_any=true
    echo "FOUND: CCB $label block in $file"
    if ! $CHECK_ONLY; then
      python3 - "$file" "$start_marker" "$end_marker" << 'PYEOF'
import re, sys
path, start, end = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
pattern = re.escape(start) + r'.*?' + re.escape(end)
cleaned = re.sub(pattern, '', content, flags=re.DOTALL)
cleaned = re.sub(r'\n{3,}', '\n\n', cleaned).strip() + '\n'
with open(path, 'w', encoding='utf-8') as f:
    f.write(cleaned)
PYEOF
      echo "REMOVED: CCB $label block from $file"
    fi
  fi
}

# CLAUDE.md — full CCB config block
strip_block "$CLAUDE_MD"    "<!-- CCB_CONFIG_START -->"    "<!-- CCB_CONFIG_END -->"      "config"

# CLAUDE.md — roles block (if injected separately)
strip_block "$CLAUDE_MD"    "<!-- CCB_ROLES_START -->"     "<!-- CCB_ROLES_END -->"       "roles"

# AGENTS.md — roles block
strip_block "$AGENTS_MD"    "<!-- CCB_ROLES_START -->"     "<!-- CCB_ROLES_END -->"       "roles"

# AGENTS.md — rubrics block
strip_block "$AGENTS_MD"    "<!-- REVIEW_RUBRICS_START -->" "<!-- REVIEW_RUBRICS_END -->" "rubrics"

# .clinerules — roles block
strip_block "$CLINERULES"   "<!-- CCB_ROLES_START -->"     "<!-- CCB_ROLES_END -->"       "roles"

if ! $found_any; then
  echo "OK: No CCB injection blocks found."
else
  if $CHECK_ONLY; then
    echo ""
    echo "Run without --check to remove the above blocks."
    exit 1
  else
    echo ""
    echo "Done. Agent body (collab_context.md) is now the sole source of role/rubric content."
  fi
fi
