"""
Bridge communication logger: writes CCB send/reply and bridge FIFO traffic to ./bridgelog/ccb_comm.log.

Log dir is taken from env BRIDGELOG_DIR (default: cwd/bridgelog). Directory is created if missing.
Each line is JSON: ts_iso, from, to, event (send|reply|fifo_in|fifo_out), marker?, content?, reply?, etc.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

_BRIDGELOG_DIR: Optional[Path] = None
_CCB_LOG_PATH: Optional[Path] = None


def _get_bridgelog_dir() -> Path:
    global _BRIDGELOG_DIR
    if _BRIDGELOG_DIR is not None:
        return _BRIDGELOG_DIR
    raw = os.environ.get("BRIDGELOG_DIR", "").strip()
    if raw:
        _BRIDGELOG_DIR = Path(raw).expanduser().resolve()
    else:
        _BRIDGELOG_DIR = Path(os.getcwd()).resolve() / "bridgelog"
    return _BRIDGELOG_DIR


def _get_ccb_log_path() -> Path:
    global _CCB_LOG_PATH
    if _CCB_LOG_PATH is not None:
        return _CCB_LOG_PATH
    d = _get_bridgelog_dir()
    d.mkdir(parents=True, exist_ok=True)
    _CCB_LOG_PATH = d / "ccb_comm.log"
    return _CCB_LOG_PATH


def _write_ccb_entry(entry: Dict[str, Any]) -> None:
    try:
        path = _get_ccb_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        with path.open("a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
    except Exception:
        pass


def ccb_log_send(
    *,
    from_role: str,
    to_role: str,
    marker: Optional[str] = None,
    content: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Log a send event (caller -> codex, or fifo -> bridge, or bridge -> pane)."""
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "send",
        "from": from_role,
        "to": to_role,
        "marker": marker,
        "content": content,
    }
    if extra:
        entry.update(extra)
    _write_ccb_entry(entry)


def ccb_log_reply(
    *,
    from_role: str,
    to_role: str,
    marker: Optional[str] = None,
    reply: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Log a reply event (codex -> caller), optionally correlated by marker."""
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "reply",
        "from": from_role,
        "to": to_role,
        "marker": marker,
        "reply": reply,
    }
    if extra:
        entry.update(extra)
    _write_ccb_entry(entry)


def ccb_log_fifo_in(
    *,
    marker: Optional[str] = None,
    content: Optional[str] = None,
    payload_preview: Optional[str] = None,
) -> None:
    """Log bridge reading one request from FIFO."""
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "fifo_in",
        "from": "fifo",
        "to": "bridge",
        "marker": marker,
        "content": content,
        "payload_preview": payload_preview,
    }
    _write_ccb_entry(entry)


def ccb_log_fifo_out(
    *,
    marker: Optional[str] = None,
    content: Optional[str] = None,
) -> None:
    """Log bridge sending content to Codex pane."""
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "fifo_out",
        "from": "bridge",
        "to": "codex_pane",
        "marker": marker,
        "content": content,
    }
    _write_ccb_entry(entry)
