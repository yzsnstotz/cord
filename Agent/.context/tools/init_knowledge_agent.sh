#!/usr/bin/env bash
# init_knowledge_agent.sh — Initialize knowledge-agent session for a project.
# Loads knowledge_cache.json into CCB persistent session (default codex/cask).
# Idempotent: safe to re-run after session interrupt; cache is external file.
# Usage: init_knowledge_agent.sh <project_path>

set -euo pipefail

project_path="${1:-}"
if [ -z "$project_path" ] || [ ! -d "$project_path" ]; then
  echo "[init_ka] ERROR: valid project_path required" >&2
  exit 1
fi

project_path="$(cd "$project_path" && pwd)"
context_dir="${project_path}/.context"
config_file="${context_dir}/project_config.json"

# Defaults (architecture 3.4)
provider="codex"
session_file="${context_dir}/knowledge_agent/.ka-session"
cache_file="${context_dir}/knowledge_cache.json"

if [ -f "$config_file" ]; then
  ka_provider=$(python3 -c "
import json
try:
    with open('$config_file') as f:
        d = json.load(f)
    ka = d.get('knowledge_agent') or {}
    print(ka.get('provider', 'codex'))
except Exception:
    print('codex')
" 2>/dev/null || echo "codex")
  [ -n "$ka_provider" ] && provider="$ka_provider"

  ka_session=$(python3 -c "
import json
try:
    with open('$config_file') as f:
        d = json.load(f)
    ka = d.get('knowledge_agent') or {}
    print(ka.get('session_file', ''))
except Exception:
    print('')
" 2>/dev/null || echo "")
  if [ -n "$ka_session" ]; then
    case "$ka_session" in
      /*) session_file="$ka_session" ;;
      *)  session_file="${project_path}/${ka_session}" ;;
    esac
  fi

  ka_cache=$(python3 -c "
import json
try:
    with open('$config_file') as f:
        d = json.load(f)
    ka = d.get('knowledge_agent') or {}
    print(ka.get('cache_file', ''))
except Exception:
    print('')
" 2>/dev/null || echo "")
  if [ -n "$ka_cache" ]; then
    case "$ka_cache" in
      /*) cache_file="$ka_cache" ;;
      *)  cache_file="${project_path}/${ka_cache}" ;;
    esac
  fi
fi

# Resolve cask/gask from provider
ccb_bin="cask"
[ "$provider" = "gask" ] && ccb_bin="gask"
if ! command -v "$ccb_bin" >/dev/null 2>&1; then
  echo "[init_ka] ERROR: $ccb_bin not found (provider=$provider)" >&2
  exit 127
fi

# Ensure cache exists (empty if missing)
if [ ! -f "$cache_file" ]; then
  mkdir -p "$(dirname "$cache_file")"
  echo '{"version":"1.0","project":"","last_updated":"","entries":{}}' > "$cache_file"
  echo "[init_ka] Created empty cache: $cache_file"
fi

# Session dir for persistent session file
mkdir -p "$(dirname "$session_file")"

# Load cache content into session (system prompt)
cache_content=""
[ -f "$cache_file" ] && cache_content=$(cat "$cache_file" 2>/dev/null || true)

system_prompt="You are the project knowledge retrieval assistant. Load and index the following project knowledge base. Do not read any raw project files; answer only from this index.

Knowledge base (JSON):
${cache_content}

After loading, respond only from this index when queried."

if "$ccb_bin" --session-file "$session_file" "$system_prompt" >/dev/null 2>&1; then
  echo "[init_ka] OK: knowledge agent initialized (session=$session_file)"
  exit 0
else
  echo "[init_ka] FAIL: $ccb_bin init failed" >&2
  exit 1
fi
