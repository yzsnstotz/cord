---
name: autoflow-run
description: Execute one step of the current task plan in collab mode. PM reads task from session_state.json, queries knowledge agent or reads .ccb/state.json, designs, writes knowledge_cache (v1.9.0), delegates execution via run_rdloop_task.sh or executor /ask, reviews, then updates each layer at its own granularity.
trigger: step execution / /tr command / autoflow continue / run next step
lifecycle: DISCARD
mode: cli_collab
version: v1.9.0
---

# AutoFlow Run (v1.9.0)

PM stays in design/review mode. Executor (CCB-connected) or rdloop coordinator performs file I/O.
**MUST NOT load in solo mode.**

## State ownership (read this first)

```
session_state.json     -- task granularity -- PM reads/writes via state_update.sh
.ccb/state.json        -- step granularity -- executor reads/writes (or rdloop)
knowledge_cache.json   -- knowledge base   -- PM/executor write via write_knowledge_cache.py
```

These are separate concerns. PM never writes .ccb/state.json.
Executor never writes session_state.json.
No double-write. No sync needed.

## Worker Context Rule

Every /ask uses <<WORKER_CTX:role>> shorthand meaning:
"paste full [WORKER CONTEXT] base block from collab_context.md, set role = <role>"

For reviewer calls, also append <<RUBRIC_B>> (Rubric B JSON from collab_context.md).
Do NOT append rubrics to executor or inspiration tasks.

---

## Pre-condition

PM checks session_state.json directly (bash, not /ask -- this is task-level, PM's domain):

```bash
cat $project_path/.context/session_state.json
```

- No task with status in_progress -> tell user "No task in progress. Assign a task first." Stop.
- Task in_progress exists -> extract task_id, title, acceptance_criteria. Proceed.

---

## Step 1: Load Current Step (CCB or knowledge agent)

**Option A — Query knowledge agent (v1.9.0 preferred):**

Query the project knowledge agent for current step and context (no FileOpsREQ). Example:

```
/ask <executor> "
<<WORKER_CTX:executor>>

[TASK]
Query the knowledge agent (cask/gask session loaded with knowledge_cache.json) with:

\"What is the current step and step index for this project? Which files are in scope for the current task?\"

Return the answer as JSON: { current_step, step_index, step_context, files_in_scope }.
[END TASK]
"
```

**Option B — FileOpsREQ (legacy):** PM delegates step-level state read to executor:

```
/ask <executor> "
<<WORKER_CTX:executor>>

[TASK]
Execute FileOpsREQ: read current step state from .ccb/state.json

{
  'proto': 'autoflow.fileops.v1',
  'id': 'PREFLIGHT',
  'purpose': 'read_state',
  'ops': [{ 'op': 'autoflow_state_preflight', 'path': '.ccb/state.json', 'maxAttempts': 2 }]
}

Return FileOpsRES JSON only. Include: current step title, status, attempts, stepIndex, stepContext.
[END TASK]
"
```

Interpret response:
- No plan (no .ccb/state.json or no current step) -> tell user "No CCB plan found. Run /tp first." Stop.
- current.type == 'none' -> all steps done. Go to Step 9 (Final Review).
- attempts exceeded -> mark task blocked in session_state.json, escalate (exceptions.md). Stop.
- ok -> extract stepContext + current step info. Proceed to Step 2.

---

## Step 2: Resolve Roles

Roles are in collab_context.md (already in PM context). Default: executor=codex, reviewer=codex.

If .autoflow/roles.json may exist, ask executor to check:

```
/ask <executor> "
<<WORKER_CTX:executor>>

[TASK]
Read .autoflow/roles.json if it exists. Return JSON or null.
[END TASK]
"
```

If found and enabled:true and schemaVersion:1 -> override role assignments accordingly.

---

## Step 3: Dual Independent Step Design

### 3a. PM designs locally (no /ask)

Input: step title + task acceptance_criteria + stepContext from Step 1.

```json
{
  "approach": "",
  "doneConditions": ["max 3"],
  "risks": [],
  "needsSplit": false,
  "splitReason": null,
  "proposedSubsteps": null
}
```

### 3b. Executor designs independently

```
/ask <executor> "
<<WORKER_CTX:executor>>

[TASK]
Independent step design.
Step: [title from stepContext]
Task objective: [task title + acceptance_criteria]
Relevant context: [stepContext.keyFiles, stepContext.background if provided]
Return JSON only: { approach, doneConditions, risks, needsSplit, splitReason, proposedSubsteps }
[END TASK]
"
```

### 3c. PM merges (PM has final authority)

- Union doneConditions (deduplicate, max 3)
- Union risks
- Approach conflict: PM decides
- needsSplit: if either true, PM evaluates and decides

---

## Step 4: Split Check

needsSplit == false -> Step 5.

needsSplit == true:
- Validate proposedSubsteps: 3-7 items, atomic, ordered, no overlap
- If invalid: PM redesigns

```
/ask <executor> "
<<WORKER_CTX:executor>>

[TASK]
Execute FileOpsREQ: insert substeps into .ccb/state.json

{
  'proto': 'autoflow.fileops.v1',
  'id': 'SPLIT',
  'purpose': 'split_step',
  'ops': [{
    'op': 'autoflow_state_split',
    'stepIndex': [current_step_index from preflight],
    'substeps': [proposedSubsteps]
  }]
}

Return FileOpsRES JSON only.
[END TASK]
"
```

After confirmed: tell user "Step split into [N] substeps. Use /tr to continue." Stop this turn.

---

## Step 4c (v1.9.0): PM writes task summary to knowledge_cache

After generating TaskSpec (or after dual design merge), PM writes the task design summary so the knowledge agent can answer future queries. Use the atomic writer:

```bash
bash $TOOLS_ROOT/write_knowledge_cache.py \
  --project-path "$project_path" \
  --task-id "<task_id>" \
  --writer pm \
  --entry-json '{"type":"task","title":"<title>","design_rationale":"<merged rationale>","acceptance_criteria":<array>,"written_by":"PM"}'
```

Or from file: `--entry-file /path/to/task_entry.json`. This step is idempotent; re-running overwrites the task:Txx entry.

---

## execution_mode (v1.9.0)

| When to use **auto** | When to use **semi-auto** |
|----------------------|---------------------------|
| Clear task, clear acceptance, test env | Risky or first-time changes, production |
| No human in the loop | Human may observe and intervene in tmux |
| Coordinator spawns bridge (claude_bridge) | CCB (cask/gask) attached to human session |

Set in TaskSpec: `"execution_mode": "auto"` or `"semi-auto"` (default: auto).

---

## Knowledge agent query examples (v1.9.0)

1. **File interface:**  
   "What are the public interfaces of src/auth.py?"  
   → Use answer to decide dependencies and touch scope.

2. **Dependency / history:**  
   "Which tasks modified src/auth.py and what is the current interface_hash?"  
   → Use to check shared_contracts and conflict risk.

3. **Task history:**  
   "Summarize what T01 to T05 each changed (files and main decisions)."  
   → Use for context before designing the next task.

4. **Test coverage:**  
   "Which tests cover the auth module?"  
   → Use to scope test_cmd or done conditions.

Query via executor (or PM if PM has access to the same knowledge-agent session): send the question to the session that was initialized with `init_knowledge_agent.sh`; response is from knowledge_cache only, no raw file read.

---

## Step 5: Build Execution Package

PM composes for executor (or for rdloop as TaskSpec JSON in v1.9.0 path):

```json
{
  "task_id": "[task_id]-step-[stepIndex]",
  "step_title": "[current step title]",
  "approach": "[merged approach]",
  "doneConditions": ["..."],
  "files_in_scope": ["from stepContext.keyFiles + approach"],
  "files_forbidden": ["any file not in scope"],
  "acceptance_criteria": "[from merged doneConditions]",
  "report_format": "changedFiles + diffSummary + doneConditions_met + commands + notes"
}
```

For **rdloop path (v1.9.0)**: also set `execution_mode` (auto | semi-auto), `repo_path`, `goal`, `acceptance`, `test_cmd`, `coder_timeout_seconds`, etc., and save as TaskSpec JSON.

---

## Step 5–9 (v1.9.0 rdloop path): Call run_rdloop_task.sh

Instead of Step 6–8 below, PM can delegate execution to rdloop coordinator:

1. Save TaskSpec to a JSON file (e.g. under project or tasks/).
2. Call: `bash $TOOLS_ROOT/run_rdloop_task.sh <task_spec.json>`
3. The script starts rdloop (run_task.sh), polls `out/<task_id>/status.json` (default every 10s), and:
   - **READY_FOR_REVIEW**: calls `write_knowledge_cache.py --writer executor` with final_summary.json, then exits 0.
   - **FAILED**: outputs top_issues, exit non-zero.
   - **PAUSED**: outputs questions_for_user, exit 2 (user intervenes then retry).
4. After READY_FOR_REVIEW, PM updates shared_contracts (interface_hash from knowledge_cache) and runs state_update.sh task done. No separate Step 7/8 executor review in this path; rdloop judge and test_cmd cover verification.

---

## Step 6: Execute (executor path)

```
/ask <executor> "
<<WORKER_CTX:executor>>

[TASK]
[execution_package JSON from Step 5]

Constraints:
- Modify only files_in_scope
- Do NOT touch files_forbidden
Return JSON only:
{
  'status': 'ok|ask|fail',
  'changedFiles': [],
  'diffSummary': '',
  'doneConditionsMet': [],
  'commands': ['cmd -> exit N'],
  'notes': ''
}
[END TASK]
"
```

Handle:
- ok   -> Step 7 (Review)
- ask  -> surface questions to user, re-run after answer
- fail -> if attempts < 2: retry Step 5. Else: mark task blocked in session_state.json, escalate.

---

## Step 7: Code Review

```
/ask <reviewer> "
<<WORKER_CTX:reviewer>>
<<RUBRIC_B>>

[TASK]
[CODE REVIEW REQUEST]
Step: [step_title]
Done Conditions: [doneConditions]
Changed Files: [changedFiles]
Diff Summary: [diffSummary]
Notes: [notes]

Score using Rubric B above. Return JSON in Rubric B format.
Pass: overall >= 7.0 AND no dimension <= 3

--- CHANGES START ---
[diffSummary + changedFiles list]
--- CHANGES END ---
[END TASK]
"
```

PM decision:
- PASS -> Step 8 (Finalize)
- FIX (attempt < 2) -> apply fixes, back to Step 5
- FAIL (attempt >= 2) -> mark task blocked in session_state.json, escalate (exceptions.md)

---

## Step 8: Finalize Step

Two independent writes -- each layer updates its own file:

### 8a. CCB step state -> executor finalizes .ccb/state.json

```
/ask <executor> "
<<WORKER_CTX:executor>>

[TASK]
Execute FileOpsREQ: mark current step done and advance state

{
  'proto': 'autoflow.fileops.v1',
  'id': 'FINALIZE',
  'purpose': 'finalize_step',
  'ops': [
    {
      'op': 'autoflow_state_finalize',
      'verification': '[one-line summary of how step was verified]',
      'changedFiles': [changedFiles from Step 6]
    },
    {
      'op': 'run',
      'cmd': 'python3 ~/.claude/skills/tr/scripts/autoloop.py --repo-root . --once',
      'cwd': '.'
    }
  ]
}

Return FileOpsRES JSON only.
[END TASK]
"
```

### 8b. Task state -> PM updates session_state.json (only if ALL steps now done)

If executor's FileOpsRES indicates current.type == 'none' (all steps complete):
-> Go to Step 9.

If more steps remain:
-> Output "Step done. Next: [next step title]. Use /tr to continue."
-> Stop. Do NOT update session_state.json yet (task still in_progress).

---

## Step 9: Task Final Review (all steps complete)

Triggered when Step 8 executor reports current.type == 'none'.

### 9a. Full task review

```
/ask <reviewer> "
<<WORKER_CTX:reviewer>>
<<RUBRIC_B>>

[TASK]
[TASK REVIEW REQUEST]
Task: [task_title]
Acceptance Criteria: [acceptance_criteria from session_state.json]
All Changed Files: [aggregate changedFiles across all steps]
Step Summaries: [aggregate notes]

Return JSON: { verdict: 'pass|fail', blocking_issues: [], summary: '' }
[END TASK]
"
```

### 9b. Handle issues

- None -> 9c
- Minor (1 fix) -> executor fixes directly, re-review
- Medium (1-2 steps) -> add new steps via CCB (/ask executor autoflow_state_append_steps), re-run
- Major (>2 steps) -> record in notes, prompt user to create follow-up task

### 9c. Mark task done -- PM writes session_state.json

```bash
bash $TOOLS_ROOT/state_update.sh $project_path <task_id> done
bash $TOOLS_ROOT/audit_append.sh $project_path task_completed PM <task_id> <task_id> "all steps passed review"
```

Output:
```
TASK COMPLETE: [task_title]
Review: PASS
Changed files: [aggregate list]
Next: [next pending task from session_state.json, or "all tasks done"]
```

---

## Principles

1. session_state.json = task granularity only; .ccb/state.json = step granularity only
2. PM writes session_state.json via state_update.sh (bash). Never via /ask.
3. Executor writes .ccb/state.json via FileOpsREQ. Never calls state_update.sh.
4. No double-write. No sync between the two files. Each owns its layer.
5. Every /ask includes WORKER_CTX. Reviewer calls also include the relevant Rubric.
6. Max 2 execution attempts per step before marking task blocked.
7. session_state.json task status advances to done only after final review passes.

---

## Changelog (v1.9.0)

- **Knowledge agent**: Step 1 can query knowledge agent instead of FileOpsREQ for current step/context. Three+ query examples added.
- **Step4c**: PM writes task summary to knowledge_cache via write_knowledge_cache.py (--writer pm).
- **execution_mode**: Decision table added (auto vs semi-auto); TaskSpec supports execution_mode field.
- **Step 5–9 rdloop path**: New path documented — run_rdloop_task.sh invokes coordinator; READY_FOR_REVIEW triggers executor write to knowledge_cache; shared_contracts and state_update follow.
