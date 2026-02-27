#!/usr/bin/env bash
# req_code_gen.sh — derive CCB REQ CODE from session_id.
# Format: RC- + sha256(session_id)[:8].upper()

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <session_id>" >&2
  exit 1
fi

session_id="$1"

hash8=""
if command -v sha256sum >/dev/null 2>&1; then
  hash8="$(printf '%s' "$session_id" | sha256sum | awk '{print $1}' | cut -c1-8 | tr '[:lower:]' '[:upper:]')"
elif command -v shasum >/dev/null 2>&1; then
  hash8="$(printf '%s' "$session_id" | shasum -a 256 | awk '{print $1}' | cut -c1-8 | tr '[:lower:]' '[:upper:]')"
elif command -v openssl >/dev/null 2>&1; then
  hash8="$(printf '%s' "$session_id" | openssl dgst -sha256 | awk '{print $NF}' | cut -c1-8 | tr '[:lower:]' '[:upper:]')"
else
  echo "Error: sha256 tool not found (need sha256sum/shasum/openssl)" >&2
  exit 1
fi

printf 'RC-%s\n' "$hash8"
