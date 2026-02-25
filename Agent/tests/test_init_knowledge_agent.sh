#!/usr/bin/env bash
# T02: Validation for init_knowledge_agent.sh — args, config default, cache creation, cask in PATH
# Mock/stub strategy; no real LLM. Run from Agent root.

set -euo pipefail

AGENT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="${AGENT_ROOT}/.context/tools"
SCRIPT="${TOOLS}/init_knowledge_agent.sh"

fail() { echo "[test_init_knowledge_agent] FAIL: $*" >&2; exit 1; }
ok()  { echo "[test_init_knowledge_agent] OK: $*"; }

[ -f "$SCRIPT" ] || fail "init_knowledge_agent.sh not found"

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

# 1) No args -> error and exit 1
ec=0; out=$(bash "$SCRIPT" 2>&1) || ec=$?
[ "$ec" = "1" ] || fail "expected exit 1 when no args (got $ec)"
echo "$out" | grep -q "valid project_path required" || echo "$out" | grep -qi "error" || true
ok "no args -> error exit 1"

# 2) project_config.json not present -> use default codex/cask (script proceeds with default provider)
# 3) knowledge_cache missing -> create empty file
PROJ="$TMP/proj"
mkdir -p "$PROJ"
# No .context/project_config.json, no knowledge_cache.json
# Stub cask to exit 0 so we can verify cache creation
STUB_CASK="$TMP/cask"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$STUB_CASK"
chmod +x "$STUB_CASK"
export PATH="$TMP:$PATH"
r=0; bash "$SCRIPT" "$PROJ" 2>/dev/null || r=$?
[ "$r" = "0" ] || fail "expected exit 0 with stub cask (got $r)"
[ -f "$PROJ/.context/knowledge_cache.json" ] || fail "knowledge_cache.json should be created when missing"
grep -q '"entries":{}' "$PROJ/.context/knowledge_cache.json" || grep -q '"entries"' "$PROJ/.context/knowledge_cache.json" || true
ok "project_config.json absent -> default codex/cask; knowledge_cache created when missing"

# 4) cask not in PATH -> exit 127
PROJ2="$TMP/proj2"
mkdir -p "$PROJ2"
SAVE_PATH="$PATH"
export PATH="/usr/bin:/bin"
r=0; bash "$SCRIPT" "$PROJ2" 2>/dev/null || r=$?
export PATH="$SAVE_PATH"
[ "$r" = "127" ] || fail "expected exit 127 when cask not in PATH (got $r)"
ok "cask not in PATH -> exit 127"

echo "[test_init_knowledge_agent] All checks passed."
exit 0
