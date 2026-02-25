#!/usr/bin/env python3
"""
write_knowledge_cache.py — Atomic writer for knowledge_cache.json.
Used by PM (planning) and executor (completion) to write task/file summaries.
Supports two writer modes: PM writes task entries (task:T{id}), executor merges
knowledge_entries from final_summary.json into cache.
Uses temp→fsync→rename for concurrent-safe atomic writes.
Uses a file lock (knowledge_cache.json.lock) with fcntl LOCK_EX so that readers
(e.g. GET /api/knowledge) holding LOCK_SH do not read while a write is in progress.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone

try:
    import fcntl
except ImportError:
    fcntl = None  # Windows: no fcntl; lock is no-op

CACHE_VERSION = "1.0"


def _cache_path(project_path: str) -> str:
    """Resolve knowledge_cache.json path under project .context."""
    base = os.path.abspath(project_path)
    return os.path.join(base, ".context", "knowledge_cache.json")


def _lock_path(cache_path: str) -> str:
    """Path of the lock file used for read/write coordination."""
    return cache_path + ".lock"


@contextmanager
def _write_lock(cache_path: str):
    """
    Hold an exclusive (write) lock on the knowledge cache for the duration of the block.
    Creates the lock file if missing. Caller must ensure .context dir exists (e.g. via _atomic_write).
    """
    lock_path = _lock_path(cache_path)
    dirname = os.path.dirname(cache_path)
    os.makedirs(dirname, exist_ok=True)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        if fcntl is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
        os.close(fd)


def _load_cache(cache_path: str) -> dict:
    """Load existing cache or return empty structure."""
    if not os.path.isfile(cache_path):
        return {
            "version": CACHE_VERSION,
            "project": os.path.basename(os.path.dirname(os.path.dirname(cache_path))),
            "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "entries": {},
        }
    with open(cache_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if "entries" not in data:
        data["entries"] = {}
    return data


def _atomic_write(cache_path: str, data: dict) -> None:
    """Write JSON atomically: temp → flush → fsync → rename."""
    dirname = os.path.dirname(cache_path)
    os.makedirs(dirname, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dirname, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, cache_path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def writer_pm(
    project_path: str,
    task_id: str,
    entry_data: dict,
) -> None:
    """
    PM mode: write or overwrite a single task entry (key = task:T{id}).
    entry_data must be a dict (e.g. from inline JSON or file); will be stored
    with type "task" and written_by "PM" if not set.
    """
    cache_path = _cache_path(project_path)
    with _write_lock(cache_path):
        data = _load_cache(cache_path)
        key = f"task:{task_id}"
        entry = dict(entry_data)
        # PM mode: keep entry_data as-is; if interface_hash present retain it (task entries do not require it)
        if "type" not in entry:
            entry["type"] = "task"
        if "written_by" not in entry:
            entry["written_by"] = "PM"
        data["entries"][key] = entry
        data["last_updated"] = _now_iso()
        if "project" not in data or not data["project"]:
            data["project"] = os.path.basename(os.path.abspath(project_path).rstrip(os.sep))
        data["version"] = data.get("version", CACHE_VERSION)
        _atomic_write(cache_path, data)


def writer_executor(
    project_path: str,
    task_id: str,
    final_summary_path: str,
) -> None:
    """
    Executor mode: read knowledge_entries from final_summary.json and merge
    into cache. Each key in knowledge_entries becomes an entry with type "file",
    owner_task, summary, written_by "executor", last_modified_at/_by.
    """
    with open(final_summary_path, "r", encoding="utf-8") as f:
        summary = json.load(f)
    knowledge_entries = summary.get("knowledge_entries") or {}
    if not knowledge_entries:
        return

    cache_path = _cache_path(project_path)
    with _write_lock(cache_path):
        data = _load_cache(cache_path)
        now = _now_iso()
        for filepath, summary_text in knowledge_entries.items():
            if not isinstance(summary_text, str):
                summary_text = json.dumps(summary_text) if summary_text is not None else ""
            interface_hash = hashlib.sha256(summary_text.encode()).hexdigest()[:8]
            data["entries"][filepath] = {
                "type": "file",
                "owner_task": task_id,
                "summary": summary_text,
                "interface_hash": interface_hash,
                "last_modified_by": task_id,
                "last_modified_at": now,
                "written_by": "executor",
            }
        data["last_updated"] = now
        if "project" not in data or not data["project"]:
            data["project"] = os.path.basename(os.path.abspath(project_path).rstrip(os.sep))
        data["version"] = data.get("version", CACHE_VERSION)
        _atomic_write(cache_path, data)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Atomic write to knowledge_cache.json (PM or executor mode)."
    )
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--writer",
        required=True,
        choices=["pm", "executor"],
        help="Writer mode: pm (task entry) or executor (from final_summary)",
    )
    parser.add_argument(
        "--task-id",
        required=True,
        help="Task id (e.g. T01); used as task:T{id} key in PM mode",
    )
    # PM mode: either --entry-json '{"title":"..."}' or --entry-file path
    parser.add_argument("--entry-json", default="", help="Inline JSON object for task entry (PM mode)")
    parser.add_argument("--entry-file", default="", help="Path to JSON file for task entry (PM mode)")
    # Executor mode
    parser.add_argument(
        "--final-summary",
        default="",
        help="Path to final_summary.json containing knowledge_entries (executor mode)",
    )
    args = parser.parse_args()

    if args.writer == "pm":
        if args.entry_file:
            with open(args.entry_file, "r", encoding="utf-8") as f:
                entry_data = json.load(f)
        elif args.entry_json:
            entry_data = json.loads(args.entry_json)
        else:
            print("PM mode requires --entry-json or --entry-file", file=sys.stderr)
            return 1
        writer_pm(args.project_path, args.task_id, entry_data)
        return 0

    if args.writer == "executor":
        if not args.final_summary or not os.path.isfile(args.final_summary):
            print("Executor mode requires --final-summary pointing to existing file", file=sys.stderr)
            return 1
        writer_executor(args.project_path, args.task_id, args.final_summary)
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
