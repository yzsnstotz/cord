#!/usr/bin/env python3
"""
migrate_knowledge_cache.py — One-time migration from single knowledge_cache.json
to module-based shard files under .context/knowledge/.
Groups entries by file path prefix heuristic. Entries that can't be grouped
go into a 'default' shard.
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone


def infer_shard(key: str) -> str:
    """Infer shard name from entry key. task:* entries use 'tasks' shard."""
    if key.startswith("task:"):
        return "tasks"
    parts = key.replace("\\", "/").split("/")
    if len(parts) >= 2:
        return parts[0].lower().replace(".", "_").replace("-", "_")
    return "default"


def migrate(project_path: str, dry_run: bool = False) -> dict:
    base = os.path.abspath(project_path)
    cache_path = os.path.join(base, ".context", "knowledge_cache.json")
    knowledge_dir = os.path.join(base, ".context", "knowledge")

    if not os.path.isfile(cache_path):
        print(f"No knowledge_cache.json found at {cache_path}", file=sys.stderr)
        return {"migrated": 0}

    if os.path.isdir(knowledge_dir) and os.listdir(knowledge_dir):
        print(f"Knowledge dir already exists and is non-empty: {knowledge_dir}", file=sys.stderr)
        return {"migrated": 0, "skipped": True}

    with open(cache_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    entries = data.get("entries", {})
    project_name = data.get("project", os.path.basename(base))

    # Group entries by inferred shard
    shards = defaultdict(dict)
    for key, entry in entries.items():
        shard_name = infer_shard(key)
        shards[shard_name][key] = entry

    if dry_run:
        print("Dry run — would create shards:")
        for name, ents in sorted(shards.items()):
            print(f"  {name}.json: {len(ents)} entries")
        return {"migrated": len(entries), "shards": list(shards.keys()), "dry_run": True}

    os.makedirs(knowledge_dir, exist_ok=True)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    meta = {"version": "1.0", "project": project_name, "shards": {}}

    for shard_name, ents in shards.items():
        shard_data = {
            "version": "1.0",
            "shard": shard_name,
            "description": f"Auto-migrated from knowledge_cache.json ({len(ents)} entries)",
            "last_updated": now,
            "entries": ents,
        }
        shard_path = os.path.join(knowledge_dir, shard_name + ".json")
        with open(shard_path, "w", encoding="utf-8") as f:
            json.dump(shard_data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        meta["shards"][shard_name] = {
            "description": shard_data["description"],
            "entry_count": len(ents),
            "last_updated": now,
        }

    meta_path = os.path.join(knowledge_dir, "_meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # Rename original
    bak_path = cache_path + ".bak"
    os.rename(cache_path, bak_path)
    print(f"Migrated {len(entries)} entries into {len(shards)} shards.")
    print(f"Original backed up to {bak_path}")

    return {"migrated": len(entries), "shards": list(shards.keys())}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("project_path", help="Project root path")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done without writing")
    args = parser.parse_args()
    result = migrate(args.project_path, args.dry_run)
    print(json.dumps(result, indent=2))
