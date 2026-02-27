#!/usr/bin/env bash
# extract_req_segment.sh — extract payload between RDLOOP_REQ START/END markers.
#
# Usage:
#   extract_req_segment.sh <req_code> <input_file>
#   extract_req_segment.sh <req_code> -   # read from stdin

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <req_code> <input_file|- >" >&2
  exit 1
fi

req_code="$1"
input="$2"

python3 - "$req_code" "$input" <<'PY'
import io
import os
import re
import sys

req_code, input_path = sys.argv[1:3]
start = f"[RDLOOP_REQ:{req_code}:START]"
end = f"[RDLOOP_REQ:{req_code}:END]"

if input_path == "-":
    text = sys.stdin.read()
else:
    if not os.path.isfile(input_path):
        print(f"Error: input file not found: {input_path}", file=sys.stderr)
        raise SystemExit(1)
    with open(input_path, encoding="utf-8") as f:
        text = f.read()

start_idx = text.find(start)
if start_idx < 0:
    print(f"Error: missing START marker for req_code={req_code}", file=sys.stderr)
    raise SystemExit(2)

payload_start = start_idx + len(start)
end_idx = text.find(end, payload_start)
if end_idx < 0:
    print(f"Error: missing END marker for req_code={req_code}", file=sys.stderr)
    raise SystemExit(3)

payload = text[payload_start:end_idx]
if payload.startswith("\r\n"):
    payload = payload[2:]
elif payload.startswith("\n"):
    payload = payload[1:]
print(payload, end="")
PY
