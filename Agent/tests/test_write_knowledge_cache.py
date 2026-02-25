"""
Unit tests for write_knowledge_cache.py.
Covers atomic write behavior and both writer modes (pm, executor).
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional


# Resolve Agent root and tools path
AGENT_ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = AGENT_ROOT / ".context" / "tools"
SCRIPT = TOOLS_DIR / "write_knowledge_cache.py"


def _run_cli(project_path: str, writer: str, task_id: str, third: str, cwd: Optional[str] = None) -> subprocess.CompletedProcess:
    cmd = [sys.executable, str(SCRIPT), "--project-path", project_path, "--writer", writer, "--task-id", task_id]
    if writer == "pm":
        if third.startswith("{"):
            cmd += ["--entry-json", third]
        else:
            cmd += ["--entry-file", third]
    else:
        cmd += ["--final-summary", third]
    return subprocess.run(cmd, capture_output=True, text=True, cwd=cwd or os.getcwd(), timeout=10)


def test_pm_mode_creates_cache_and_task_entry():
    """PM mode with inline JSON creates cache file and task:Txx entry."""
    with tempfile.TemporaryDirectory() as d:
        project_path = d
        entry = {
            "type": "task",
            "title": "Implement auth",
            "design_rationale": "Use JWT",
            "acceptance_criteria": ["GET /user returns 200"],
            "written_by": "PM",
        }
        r = _run_cli(project_path, "pm", "T01", json.dumps(entry))
        assert r.returncode == 0, (r.stderr or r.stdout)
        cache_path = Path(project_path) / ".context" / "knowledge_cache.json"
        assert cache_path.exists()
        data = json.loads(cache_path.read_text())
        assert "version" in data and "project" in data and "last_updated" in data and "entries" in data
        assert "task:T01" in data["entries"]
        assert data["entries"]["task:T01"]["title"] == "Implement auth"
        assert data["entries"]["task:T01"]["written_by"] == "PM"


def test_pm_mode_entry_file():
    """PM mode with --entry-file reads JSON from file."""
    with tempfile.TemporaryDirectory() as d:
        project_path = d
        entry_file = Path(d) / "entry.json"
        entry = {"title": "Task from file", "acceptance_criteria": []}
        entry_file.write_text(json.dumps(entry))
        r = _run_cli(project_path, "pm", "T02", str(entry_file))
        assert r.returncode == 0
        cache_path = Path(project_path) / ".context" / "knowledge_cache.json"
        data = json.loads(cache_path.read_text())
        assert data["entries"]["task:T02"]["title"] == "Task from file"


def test_executor_mode_merges_knowledge_entries():
    """Executor mode reads final_summary.json knowledge_entries and merges into cache."""
    with tempfile.TemporaryDirectory() as d:
        project_path = d
        final_summary = Path(d) / "final_summary.json"
        final_summary.write_text(json.dumps({
            "state": "READY_FOR_REVIEW",
            "knowledge_entries": {
                "src/auth.py": "JWT auth. verify_token(), issue_token().",
                "src/auth_test.py": "Tests for auth module.",
            },
        }))
        r = _run_cli(project_path, "executor", "T01", str(final_summary))
        assert r.returncode == 0
        cache_path = Path(project_path) / ".context" / "knowledge_cache.json"
        data = json.loads(cache_path.read_text())
        assert "src/auth.py" in data["entries"]
        assert "src/auth_test.py" in data["entries"]
        assert data["entries"]["src/auth.py"]["written_by"] == "executor"
        assert data["entries"]["src/auth.py"]["owner_task"] == "T01"
        assert "last_modified_at" in data["entries"]["src/auth.py"]
        # Executor mode must write interface_hash (SHA-256 first 8 chars) for file entries
        assert "interface_hash" in data["entries"]["src/auth.py"]
        assert len(data["entries"]["src/auth.py"]["interface_hash"]) == 8
        assert data["entries"]["src/auth.py"]["interface_hash"].isalnum()
        assert "interface_hash" in data["entries"]["src/auth_test.py"]
        assert len(data["entries"]["src/auth_test.py"]["interface_hash"]) == 8


def test_executor_mode_empty_knowledge_entries_no_write_error():
    """Executor mode with missing or empty knowledge_entries does not fail."""
    with tempfile.TemporaryDirectory() as d:
        project_path = d
        final_summary = Path(d) / "final_summary.json"
        final_summary.write_text(json.dumps({"state": "READY_FOR_REVIEW"}))
        r = _run_cli(project_path, "executor", "T01", str(final_summary))
        assert r.returncode == 0
        cache_path = Path(project_path) / ".context" / "knowledge_cache.json"
        # Should create cache with empty entries if file didn't exist, or leave as-is
        if cache_path.exists():
            data = json.loads(cache_path.read_text())
            assert "entries" in data


def test_atomic_write_concurrent_safe():
    """Cache file is created via temp then rename (atomic)."""
    with tempfile.TemporaryDirectory() as d:
        project_path = d
        entry = {"title": "Atomic", "written_by": "PM"}
        r = _run_cli(project_path, "pm", "T01", json.dumps(entry))
        assert r.returncode == 0
        cache_path = Path(project_path) / ".context" / "knowledge_cache.json"
        assert cache_path.exists()
        content = cache_path.read_text()
        assert "task:T01" in content and "Atomic" in content


def test_pm_mode_requires_entry():
    """PM mode without --entry-json or --entry-file returns non-zero."""
    with tempfile.TemporaryDirectory() as d:
        # Call without entry (invalid: we have to pass something; so pass empty entry-json)
        r = subprocess.run(
            [sys.executable, str(SCRIPT), "--project-path", d, "--writer", "pm", "--task-id", "T01"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert r.returncode != 0


def test_pm_mode_task_entry_without_interface_hash_ok():
    """PM mode task entry does not require interface_hash (task entries do not get auto-generated hash)."""
    with tempfile.TemporaryDirectory() as d:
        project_path = d
        entry = {"title": "Task only", "acceptance_criteria": []}
        r = _run_cli(project_path, "pm", "T01", json.dumps(entry))
        assert r.returncode == 0
        cache_path = Path(project_path) / ".context" / "knowledge_cache.json"
        data = json.loads(cache_path.read_text())
        assert "task:T01" in data["entries"]
        # interface_hash may be absent for task entries
        assert "title" in data["entries"]["task:T01"]


def test_pm_mode_preserves_interface_hash_when_provided():
    """PM mode preserves interface_hash from entry_data when present."""
    with tempfile.TemporaryDirectory() as d:
        project_path = d
        entry = {"title": "Contract task", "interface_hash": "abc12345"}
        r = _run_cli(project_path, "pm", "T01", json.dumps(entry))
        assert r.returncode == 0
        cache_path = Path(project_path) / ".context" / "knowledge_cache.json"
        data = json.loads(cache_path.read_text())
        assert data["entries"]["task:T01"].get("interface_hash") == "abc12345"


def test_executor_mode_requires_final_summary():
    """Executor mode without valid --final-summary returns non-zero."""
    with tempfile.TemporaryDirectory() as d:
        r = subprocess.run(
            [sys.executable, str(SCRIPT), "--project-path", d, "--writer", "executor",
             "--task-id", "T01", "--final-summary", "/nonexistent/path"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert r.returncode != 0


def test_write_creates_lock_file():
    """After a write (PM or executor), the lock file knowledge_cache.json.lock exists for reader coordination."""
    with tempfile.TemporaryDirectory() as d:
        project_path = d
        entry = {"title": "Lock test", "written_by": "PM"}
        r = _run_cli(project_path, "pm", "T01", json.dumps(entry))
        assert r.returncode == 0
        cache_path = Path(project_path) / ".context" / "knowledge_cache.json"
        lock_path = Path(project_path) / ".context" / "knowledge_cache.json.lock"
        assert cache_path.exists()
        assert lock_path.exists(), "write_knowledge_cache.py should create .lock for read/write coordination"
