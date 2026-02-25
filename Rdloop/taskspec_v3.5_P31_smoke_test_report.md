# P31 Task Chain Smoke Test Report (taskspec v3.5)

## Purpose

Validate the full PM → rdloop coordinator → executor → judge → status loop:

1. PM (configured provider) sends a task package via /ask (Worker Context embedded).
2. Rdloop coordinator receives the task, picks executor provider, invokes `call_coder_*`.
3. Executor runs via CCB (cask/gask/etc.) in semi-auto mode; writes `output_file` and `final_summary`.
4. Judge scores the attempt; verdict = pass.
5. Coordinator writes `out/<task_id>/status.json` with `status: DONE`, `verdict: pass`.
6. PM can read result via /pend or by reading `status.json` / `final_summary.json`.

## Taskspec v3.5 context

- **P25:** CCB state detection fixed (lock scan + WezTerm mode).
- **P27:** Provider status accurate (opencode ping = oask; per-provider ping in native session).
- **P30:** PM role is configurable (Settings → Roles); collab_context.md updated.
- **P31:** This smoke test confirms the chain end-to-end.

## Prerequisites (from taskspec notes)

- (a) CCB session running (at least codex with valid session in `repo_path/.ccb/.codex-session`).
- (b) `rdloop.config.json`: `ccb_work_dir`, `ccb_path`, `default_execution_mode: semi-auto`, `default_coder: codex-cli` (or ccb).
- (c) GUI server running: `node gui/server.js` from Rdloop root.
- (d) P25/P27 deployed so CCB state is detected correctly.

## Minimal smoke task spec

Use a minimal task to avoid implementation noise:

```json
{
  "task_id": "chain-smoke-1",
  "task_type": "script",
  "execution_mode": "semi-auto",
  "goal": "Write the text CHAIN_OK to a file named chain_smoke_out.txt in the repo root",
  "repo_path": "/Users/yzliu/work/projects/cord_test",
  "acceptance_criteria": [
    "chain_smoke_out.txt exists",
    "content is CHAIN_OK"
  ]
}
```

(Adjust `repo_path` to your test project.)

## Test steps

1. **Create task**  
   Create the above spec under `Rdloop/tasks/chain-smoke-1.json` (or submit via GUI).

2. **PM sends task (simulated or real)**  
   - **Option A (manual):** In GUI, open the task and click Run; coordinator will pick executor from config and run `call_coder_ccb.sh` (semi-auto).  
   - **Option B (full PM path):** From OpenClaw/Telegram, PM sends /ask with [WORKER CONTEXT] block and task goal; the injected payload reaches rdloop (e.g. via queue or API); coordinator is triggered with the same task JSON.

3. **Coordinator execution**  
   - Coordinator creates `out/chain-smoke-1/attempt_001/`, runs coder (e.g. `call_coder_ccb.sh` with provider codex).  
   - Coder attaches to CCB session, executes instruction, writes `chain_smoke_out.txt` and coder output.  
   - Coordinator runs judge; judge reads output and criteria, returns verdict (pass if file exists and content is CHAIN_OK).

4. **Verify outputs**  
   - `out/chain-smoke-1/status.json`: `state: "DONE"`, `last_decision` indicates completion, no `pause_reason_code` for failure.  
   - `out/chain-smoke-1/final_summary.json`: `verdict_summary` or equivalent shows pass; paths include coder output.  
   - Repo root: `chain_smoke_out.txt` exists with content `CHAIN_OK`.

5. **PM reads result**  
   - Via /pend in the same session, or by reading `out/chain-smoke-1/status.json` and `final_summary.json`.

## Expected outcomes

| Check | Expected |
|-------|----------|
| Coordinator log | task_created → coder_started → coder_completed → judge_started → judge_passed → DONE |
| `out/chain-smoke-1/status.json` | `status: "DONE"`, `verdict: "pass"` (or equivalent) |
| `final_summary.json` | Contains executor summary and judge verdict |
| PM /pend or status read | Can obtain `final_summary` and confirm task done |

## Failure points to document

If any step fails, record in **Result** below:

- **PM → coordinator:** /ask payload format, API endpoint, or queue not delivering task JSON.
- **Coordinator → executor:** Wrong coder script, missing env, or CCB session/daemon not ready.
- **Executor output:** Coder adapter not writing `output_file` or `final_summary` in expected shape.
- **Judge:** Verdict format mismatch or coordinator not parsing it.
- **Status write:** `status.json` / `final_summary.json` not updated or not readable by PM.

## Result

**Date run:** _Not run (implementation complete; run when CCB + GUI + test repo are ready)_

**Outcome:** _Pending_

**Notes:**  
- All P25–P30 code changes are in place.  
- To run: ensure CCB is up (`ccb codex` in test repo), start GUI, create `chain-smoke-1.json`, run task from GUI or trigger via PM path; then inspect `out/chain-smoke-1/` and repo root.
