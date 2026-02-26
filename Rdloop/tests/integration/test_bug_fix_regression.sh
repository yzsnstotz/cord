#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
bash "$ROOT/test_worktree_init_timing.sh"
bash "$ROOT/test_judge_feedback_injection.sh"
