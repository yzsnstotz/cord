# Live GUI Real-Provider Test (localhost:17333)

| spec_id | task_id | state | pause_reason | ccb_call | bridge_call | coder_ccb | coder_bridge | judge_ccb | judge_bridge |
|---|---|---|---|---:|---:|---|---|---|---|
| v51live_20260228_053833_copywriting_bridge | v51live_20260228_053833_copywriting_bridge_20260228_053833 | PAUSED | PAUSED_CODER_TIMEOUT | 1 | 0 | Y | N | N | N |
| v51live_20260228_053833_copywriting_ccb | v51live_20260228_053833_copywriting_ccb_20260228_053833 | PAUSED | PAUSED_CODER_TIMEOUT | 1 | 0 | Y | N | N | N |
| v51live_20260228_053833_multi_agent_bridge | v51live_20260228_053833_multi_agent_bridge_20260228_053834 | PAUSED | PAUSED_CODER_TIMEOUT | 1 | 0 | Y | N | N | N |
| v51live_20260228_053833_multi_agent_ccb | v51live_20260228_053833_multi_agent_ccb_20260228_053834 | PAUSED | PAUSED_CODER_TIMEOUT | 1 | 0 | Y | N | N | N |
| v51live_20260228_053833_solo_bridge | v51live_20260228_053833_solo_bridge_20260228_053834 | PAUSED | PAUSED_CODER_FAILED | 0 | 0 | N | Y | N | N |
| v51live_20260228_053833_solo_ccb | v51live_20260228_053833_solo_ccb_20260228_053834 | PAUSED | PAUSED_CODER_TIMEOUT | 1 | 0 | Y | N | N | N |

Notes:
- All runs were triggered via GUI API at localhost:17333 (`/api/task_specs/:taskId/run`).
- CCB session bootstrap returned unavailable status for both codex and gemini in this environment, causing timeout/failure pauses.
- In current coordinator routing, `copywriting` and `multi_agent` legacy runs still call CCB adapters even when `run_surface=bridge`.
