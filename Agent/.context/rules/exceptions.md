# exceptions.md v1.4.9
# Trigger: blocked / uncertain / side-effect / 2 consecutive failures
# DISCARD after escalation resolved

## Stop immediately if

```
- instruction contradicts requirement_ref
- file to modify not in index.json
- index_verify.sh reports hash mismatch on file needed for current task
- side effect on other tasks found mid-execution
- 2 consecutive failures on same action
- action scope unclear
- STEP 0 env mismatch
- tool script exits non-zero
```

## Level 1 — Worker → PM

Solo: PM=self, resolve internally or re-escalate to user.
Collab: send to PM provider.

```json
{
  "level": "worker_to_pm",
  "task_id": "T01",
  "actor": "<role|model-id>",
  "description": "<what failed>",
  "attempted": "<what was tried>",
  "need_from_pm": "<decision or resource needed>"
}
```

## Level 2 — PM → User

```json
{
  "level": "pm_to_user",
  "task_id": "T01",
  "summary": "<what could not be resolved>",
  "attempted_resolutions": [""],
  "need_from_user": "<specific decision or input>",
  "suggested_options": ["A", "B"]
}
```

suggested_options is mandatory — never escalate with an open question.

## Mode behavior

```
solo:    block → escalate directly to user (no degradation path); retry limit = 2
collab:  block → PM attempts degradation (cli_collab.md) → escalate to user only if all fail
```
