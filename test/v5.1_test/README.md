# v5.1 Real Data Test Results

Generated at (UTC): 2026-02-27T20:28:18Z

Coverage: copywriting / solo / multi_agent × ccb / bridge

## Tooling Health

- `ccb-mounted`: command not found in current PATH
- `ccb-ping codex|gemini|claude`: crashes with `TypeError` from `/Users/yzliu/.local/bin/ccb-ping` (Python type-hint syntax issue)

## Case Summary

| task_id | task_type | launch_mode | state | decision | role_start | role_transition | ccb_call | bridge_call | pane_count |
|---|---|---|---|---|---:|---:|---:|---:|---:|
| v51_copywriting_bridge_real | copywriting | bridge | READY_FOR_REVIEW | READY_FOR_REVIEW | 3 | 2 | 0 | 3 | 3 |
| v51_copywriting_ccb_real | copywriting | ccb | READY_FOR_REVIEW | READY_FOR_REVIEW | 3 | 2 | 3 | 0 | 3 |
| v51_multi_agent_bridge_real | multi_agent | bridge | READY_FOR_REVIEW | READY_FOR_REVIEW | 4 | 3 | 0 | 4 | 4 |
| v51_multi_agent_ccb_real | multi_agent | ccb | READY_FOR_REVIEW | READY_FOR_REVIEW | 4 | 3 | 4 | 0 | 4 |
| v51_solo_bridge_real | solo | bridge | READY_FOR_REVIEW | READY_FOR_REVIEW | 4 | 3 | 0 | 4 | 4 |
| v51_solo_ccb_real | solo | ccb | READY_FOR_REVIEW | READY_FOR_REVIEW | 4 | 3 | 4 | 0 | 4 |

## Deliverables

- `/Users/yzliu/work/cord/test/v5.1_test/out/v51_copywriting_bridge_real`
  - `task.json`, `status.json`, `final_summary.json`, `task_state.json`, `events.jsonl`, `handoff/`
- `/Users/yzliu/work/cord/test/v5.1_test/out/v51_copywriting_ccb_real`
  - `task.json`, `status.json`, `final_summary.json`, `task_state.json`, `events.jsonl`, `handoff/`
- `/Users/yzliu/work/cord/test/v5.1_test/out/v51_multi_agent_bridge_real`
  - `task.json`, `status.json`, `final_summary.json`, `task_state.json`, `events.jsonl`, `handoff/`
- `/Users/yzliu/work/cord/test/v5.1_test/out/v51_multi_agent_ccb_real`
  - `task.json`, `status.json`, `final_summary.json`, `task_state.json`, `events.jsonl`, `handoff/`
- `/Users/yzliu/work/cord/test/v5.1_test/out/v51_solo_bridge_real`
  - `task.json`, `status.json`, `final_summary.json`, `task_state.json`, `events.jsonl`, `handoff/`
- `/Users/yzliu/work/cord/test/v5.1_test/out/v51_solo_ccb_real`
  - `task.json`, `status.json`, `final_summary.json`, `task_state.json`, `events.jsonl`, `handoff/`

Machine-readable summary: `test/v5.1_test/summary.json`
