#!/usr/bin/env bash
# migrate_task_json.sh — Migrate task.json from v4 (workflow_mode) to v5 (executor_type × session_mode)
# Usage: migrate_task_json.sh <task.json>
# Idempotent: safe to run multiple times on the same file.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: migrate_task_json.sh <task.json>" >&2
  exit 1
fi

TASK_FILE="$1"

if [ ! -f "$TASK_FILE" ]; then
  echo "Error: file not found: ${TASK_FILE}" >&2
  exit 1
fi

python3 - "$TASK_FILE" <<'PYEOF'
import json, sys, os

fpath = sys.argv[1]
with open(fpath, encoding="utf-8") as f:
    d = json.load(f)

changed = False

# Skip if already migrated (has executor_type and no workflow_mode)
if "executor_type" in d and "workflow_mode" not in d:
    print("Already migrated: " + fpath)
    sys.exit(0)

# Map workflow_mode to executor_type + session_mode
wm = d.get("workflow_mode", "")
if wm:
    mapping = {
        "collab":  ("multi_agent", "continuous"),
        "solo":    ("solo_agent",  "continuous"),
        "single":  ("api_call",    "fresh"),
    }
    if wm not in mapping:
        print("Error: unknown workflow_mode '{}' in {}".format(wm, fpath), file=sys.stderr)
        sys.exit(1)
    et, sm = mapping[wm]
    d["executor_type"] = et
    d["session_mode"] = sm
    del d["workflow_mode"]
    changed = True
elif "executor_type" not in d:
    # Legacy v3: execution_mode based — default to solo_agent
    em = d.get("execution_mode", "auto")
    if em == "semi-auto":
        d["executor_type"] = "multi_agent"
        d["session_mode"] = "continuous"
    else:
        d["executor_type"] = "solo_agent"
        d["session_mode"] = "continuous"
    changed = True

# If workflow_mode still present (shouldn't be), remove it
if "workflow_mode" in d:
    del d["workflow_mode"]
    changed = True

# Migrate solo_config -> agent_config (if present)
if "solo_config" in d:
    sc = d.pop("solo_config")
    if "agent_config" not in d:
        d["agent_config"] = {}
    # Merge solo_config fields into agent_config (don't overwrite existing)
    for k, v in sc.items():
        if k not in d["agent_config"]:
            d["agent_config"][k] = v
    changed = True

# Ensure agent_config exists with defaults
if "agent_config" not in d:
    ac = {}
    # Pull max_attempts from top-level if present
    if "max_attempts" in d:
        ac["max_attempts"] = d["max_attempts"]
    d["agent_config"] = ac
    changed = True

# Bump schema_version
if d.get("schema_version") != "v5":
    d["schema_version"] = "v5"
    changed = True

if changed:
    # Atomic write: write to tmp then rename
    tmp = fpath + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, fpath)
    print("Migrated: " + fpath)
else:
    print("No changes needed: " + fpath)
PYEOF
