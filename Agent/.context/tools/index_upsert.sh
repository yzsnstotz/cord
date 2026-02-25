#!/usr/bin/env bash
# index_upsert.sh — Upsert one file entry in index.json (insert or update by path)
# Usage: bash tools/index_upsert.sh <project_path> <entry_json>
# Output: confirmation line (stdout) or error (stderr)
# entry_json fields: path, type, summary, exports, dependencies, hash, last_modified, last_modified_by
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: bash tools/index_upsert.sh <project_path> '<entry_json>'" >&2
  exit 1
fi

PROJECT_PATH="$1"
ENTRY_JSON="$2"
INDEX_FILE="$PROJECT_PATH/.context/index.json"

# Validate entry_json is valid JSON
if ! echo "$ENTRY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'path' in d, 'missing path field'" 2>/dev/null; then
  echo "Error: entry_json is not valid JSON or missing required 'path' field" >&2
  exit 1
fi

# Ensure index.json exists with base structure
if [[ ! -f "$INDEX_FILE" ]]; then
  mkdir -p "$(dirname "$INDEX_FILE")"
  echo '{"files":[],"last_updated":""}' > "$INDEX_FILE"
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
ENTRY_PATH=$(echo "$ENTRY_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['path'])")

# Upsert via Python fcntl (cross-platform: macOS + Linux, no flock binary needed)
LOCKFILE="$INDEX_FILE.lock"
python3 - "$INDEX_FILE" "$ENTRY_JSON" "$TIMESTAMP" "$LOCKFILE" <<'PYEOF'
import sys, json, fcntl

index_file = sys.argv[1]
entry_json = sys.argv[2]
timestamp  = sys.argv[3]
lockfile   = sys.argv[4]

with open(lockfile, "w") as lf:
    fcntl.flock(lf, fcntl.LOCK_EX)

    with open(index_file, 'r') as f:
        index = json.load(f)

    new_entry  = json.loads(entry_json)
    entry_path = new_entry['path']

    index['files'] = [f for f in index.get('files', []) if f.get('path') != entry_path]
    index['files'].append(new_entry)
    index['last_updated'] = timestamp

    with open(index_file, 'w') as f:
        json.dump(index, f, indent=2)

    fcntl.flock(lf, fcntl.LOCK_UN)

print(f"index_upsert: OK [{entry_path}] @ {timestamp}")
PYEOF
