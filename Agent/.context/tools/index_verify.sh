#!/usr/bin/env bash
# index_verify.sh — Verify actual file hashes against index.json records
# Usage: bash tools/index_verify.sh <project_path> [--files file1 file2 ...]
# Output: JSON array of mismatches: [{"path","expected_hash","actual_hash"}]
#         Empty array [] = all verified
# On mismatch: caller must STOP and report to user — do not proceed with stale index data.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: bash tools/index_verify.sh <project_path> [--files file1 file2 ...]" >&2
  exit 1
fi

PROJECT_PATH="$1"
shift

# Parse optional --files list
FILTER_FILES=()
if [[ $# -gt 0 && "$1" == "--files" ]]; then
  shift
  while [[ $# -gt 0 ]]; do
    FILTER_FILES+=("$1")
    shift
  done
fi

INDEX_FILE="$PROJECT_PATH/.context/index.json"

if [[ ! -f "$INDEX_FILE" ]]; then
  echo "Error: index.json not found at $INDEX_FILE" >&2
  exit 1
fi

# Compute hash helper (same logic as hash.sh)
compute_hash() {
  local file="$1"
  if command -v sha256sum &>/dev/null; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum &>/dev/null; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "Error: no sha256 tool found" >&2
    exit 1
  fi
}

# Run verification via Python
python3 - "$PROJECT_PATH" "$INDEX_FILE" "${FILTER_FILES[@]+"${FILTER_FILES[@]}"}" <<'PYEOF'
import sys, json, subprocess, os

project_path = sys.argv[1]
index_file = sys.argv[2]
filter_files = sys.argv[3:] if len(sys.argv) > 3 else []

with open(index_file, 'r') as f:
    index = json.load(f)

mismatches = []

for entry in index.get('files', []):
    path = entry.get('path', '')
    expected_hash = entry.get('hash', '')

    # Apply filter if specified
    if filter_files and path not in filter_files:
        continue

    if not expected_hash:
        continue  # no hash recorded, skip

    # Resolve full path (relative to project root parent or absolute)
    full_path = path if os.path.isabs(path) else os.path.join(project_path, '..', path)
    full_path = os.path.normpath(full_path)

    if not os.path.isfile(full_path):
        mismatches.append({"path": path, "expected_hash": expected_hash, "actual_hash": "FILE_NOT_FOUND"})
        continue

    result = subprocess.run(
        ['bash', os.path.join(os.path.dirname(index_file), '..', 'tools', 'hash.sh'), full_path],
        capture_output=True, text=True
    )
    actual_hash = result.stdout.strip()

    if actual_hash != expected_hash:
        mismatches.append({"path": path, "expected_hash": expected_hash, "actual_hash": actual_hash})

print(json.dumps(mismatches, indent=2))
PYEOF
