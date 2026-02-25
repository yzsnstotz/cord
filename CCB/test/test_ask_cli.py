from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _run_ask(args: list[str], *, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    exe = sys.executable
    script_path = _repo_root() / "bin" / "ask"
    return subprocess.run(
        [exe, str(script_path), *args],
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def test_async_mode_fails_fast_when_unified_daemon_unavailable(tmp_path: Path) -> None:
    env = dict(os.environ)
    env["CCB_CALLER"] = "claude"
    env["CCB_UNIFIED_ASKD"] = "1"
    env["CCB_ASKD_AUTOSTART"] = "0"
    env["CCB_RUN_DIR"] = str(tmp_path / "run")

    proc = _run_ask(["gemini", "hello"], cwd=tmp_path, env=env)

    assert proc.returncode == 1
    assert "Unified askd daemon not running" in proc.stderr
    assert "[CCB_ASYNC_SUBMITTED" not in proc.stdout
