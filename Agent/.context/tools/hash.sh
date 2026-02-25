#!/usr/bin/env bash
# hash.sh — Compute sha256 hash of a file
# Usage: bash tools/hash.sh <filepath>
# Output: sha256 hex string (stdout)
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: bash tools/hash.sh <filepath>" >&2
  exit 1
fi

FILE="$1"

if [[ ! -f "$FILE" ]]; then
  echo "Error: file not found: $FILE" >&2
  exit 1
fi

if command -v sha256sum &>/dev/null; then
  sha256sum "$FILE" | awk '{print $1}'
elif command -v shasum &>/dev/null; then
  shasum -a 256 "$FILE" | awk '{print $1}'
else
  echo "Error: no sha256 tool found (sha256sum or shasum)" >&2
  exit 1
fi
