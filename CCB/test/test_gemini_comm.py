from __future__ import annotations

import json
from pathlib import Path

from ccb_protocol import is_done_text
from gemini_comm import GeminiLogReader


def _write_session(path: Path, *, messages: list[dict], session_id: str = "sid-1") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"sessionId": session_id, "messages": messages}
    path.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def test_capture_state_finds_slugified_suffix_project_hash(tmp_path: Path) -> None:
    work_dir = tmp_path / "claude_code_bridge"
    work_dir.mkdir()
    root = tmp_path / "gemini-root"
    session_path = root / "claude-code-bridge-1" / "chats" / "session-a.json"
    _write_session(
        session_path,
        messages=[
            {"type": "user", "content": "hello"},
            {"type": "gemini", "id": "g1", "content": "world"},
        ],
    )

    reader = GeminiLogReader(root=root, work_dir=work_dir)
    state = reader.capture_state()

    assert state.get("session_path") == session_path
    assert int(state.get("msg_count") or 0) == 2


def test_wait_for_message_reads_reply_from_slugified_suffix_project_hash(tmp_path: Path) -> None:
    req_id = "20260222-161452-539-76463-1"
    work_dir = tmp_path / "claude_code_bridge"
    work_dir.mkdir()
    root = tmp_path / "gemini-root"
    session_path = root / "claude-code-bridge-1" / "chats" / "session-b.json"

    messages = [{"type": "user", "content": f"CCB_REQ_ID: {req_id}\nquestion"}]
    _write_session(session_path, messages=messages)

    reader = GeminiLogReader(root=root, work_dir=work_dir)
    state = reader.capture_state()

    messages.append({"type": "gemini", "id": "g2", "content": f"ok\nCCB_DONE: {req_id}"})
    _write_session(session_path, messages=messages)

    reply, new_state = reader.wait_for_message(state, timeout=0.5)

    assert reply is not None
    assert is_done_text(reply, req_id)
    assert new_state.get("session_path") == session_path
