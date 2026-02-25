# P23 Semi-Auto Smoke Test Report (taskspec v3.4)

## Taskspec v3.4 execution summary (2026-02-25)

All tasks from `./taskspec/taskspec_v3.4.json` were executed with target paths:

- **Agent 体系:** `./Agent` (no code changes in this spec; Agent context used per AGENTS.md)
- **Rdloop:** `./Rdloop` — P20, P21 (gui/server.js, gui/public/app.js), P22 (coordinator/lib/call_coder_ccb.sh)
- **CCB:** `./CCB` — reference only (lock path, session naming); no code changes in this spec

**P20:** open-terminal detects existing instance via `~/.ccb/run/ccb-{cwd_hash}.lock` + PID alive; attach to tmux session (findCcbSessionNameByPid enhanced to resolve session by pane PID when session name ≠ lock PID). session/start spawn env strips TMUX, TMUX_PANE, WEZTERM_PANE.

**P21:** GET /api/ccb/session-status returns `ccb_instance: { running, pid?, session_name?, work_dir? }`. GUI shows CCB process row, Attach, Restart, and "清理废弃会话" (POST /api/ccb/session/cleanup).

**P22:** call_coder_ccb.sh has 3 ping retries, diagnostic log on failure (provider, session_file, session_file_exists, cask_cmd). CCB_SESSION_FILE from repo_path/.ccb/.codex-session. bash -n passes.

**P23:** Structural test_cmd passed. Scenarios 1–5 and verification steps documented below; Scenario 4 re-verified with exit 127 and run.log diagnostic when no CCB session.

---

## Prerequisites

- CCB session running in target dir (e.g. `ccb codex` in cord_test), or GUI "在终端中运行 Codex" started once.
- GUI server: `node gui/server.js` (from Rdloop root).
- rdloop.config.json: `ccb_work_dir`, `ccb_path`, `default_execution_mode: "semi-auto"` as needed.

## Scenario 1: CCB not running — GUI "在终端中运行 Codex" succeeds

**Steps:** Ensure no active CCB instance (no lock for ccb_work_dir). Click "在终端中运行 Codex" in CCB panel.

**Expected:** Terminal.app opens, `python3 ccb codex` runs, no "Another ccb instance is already running (pid X)" or exit code 2.

**Verification:** After P20, open-terminal returns `action: 'started'` and new terminal runs ccb.

---

## Scenario 2: CCB already running — repeat "在终端中运行 Codex" → attach, no error

**Steps:** With an active CCB instance (lock file present, PID alive), click "在终端中运行 Codex" again.

**Expected:** No new ccb process; Terminal opens and attaches to existing tmux session. No "Another instance" error.

**Verification:** open-terminal returns `action: 'attached'`, `pid`, `session_name`. GUI may show "已附加到已有 CCB 会话".

---

## Scenario 3: GUI submits semi-auto task

**Steps:** Create/submit a task with `execution_mode: 'semi-auto'`, e.g. task_type engineering_impl, simple instruction.

**Expected:** Task JSON includes `execution_mode: 'semi-auto'`. Coordinator uses coder_type=ccb and invokes call_coder_ccb.sh.

---

## Scenario 4: Coordinator calls call_coder_ccb.sh; run.log shows attached

**Steps:** Run a semi-auto task so that coordinator runs call_coder_ccb.sh (e.g. from GUI run task or manually run_task.sh with semi-auto).

**Expected:** In `attempt_dir/coder/run.log`: line containing "attached to human tmux session". No "CCB daemon unavailable" when CCB session is running.

**Evidence (no daemon — diagnostic):** Run without active CCB session:

```bash
mkdir -p /tmp/p23_attempt/coder
echo '{"repo_path":"/Users/yzliu/work/projects/cord_test","coder_timeout_seconds":60}' > /tmp/p23_task.json
echo "echo hello" > /tmp/p23_inst.txt
bash coordinator/lib/call_coder_ccb.sh /tmp/p23_task.json /tmp/p23_attempt /Users/yzliu/work/projects/cord_test /tmp/p23_inst.txt codex
# exit code: 127
```

**run.log output (2026-02-25):**

```
[CODER][semi-auto/ccb] 2026-02-25T04:01:45Z attached to human tmux session
[CODER][semi-auto/ccb] provider=cask timeout=60s project_path=/Users/yzliu/work/projects/cord_test
[CODER][semi-auto/ccb] ping attempt 1/3 failed, retrying in 1s...
[CODER][semi-auto/ccb] ping attempt 2/3 failed, retrying in 1s...
[CODER][semi-auto/ccb] CCB daemon unavailable after 3 ping(s)
[CODER][semi-auto/ccb] diagnostic: provider=cask session_file=/Users/yzliu/work/projects/cord_test/.ccb/.codex-session session_file_exists=yes cask_cmd=/Users/yzliu/.local/bin/cask
```

Ping retry (3 attempts) and diagnostic (session_file, session_file_exists, cask_cmd) confirmed.

---

## Scenario 5: Cask sends prompt to Codex; task completes DONE/PASS

**Steps:** With active CCB session (ccb codex in cord_test), run a semi-auto task with a trivial instruction (e.g. "echo DONE").

**Expected:** run.log shows attached and no "CCB daemon unavailable". cask sends prompt; Codex responds; stdout.log non-empty; task state becomes DONE or PASS.

**Verification:** Check attempt_dir/coder/stdout.log and task state in GUI/API.

---

## File checks (P23 test_cmd)

- coordinator/run_task.sh — present
- gui/server.js — present
- gui/public/app.js — present

All verified.
