# git_collab.md v2.1
# Trigger: git_collab activated
# KEEP full session when git_collab is active
# Replaces cli_collab.md state-write rules for git_collab mode.

## Purpose

Defines PM and Executor behavior constraints in git_collab mode, where Git is the single source of truth for task state, and coordinator handles all git operations programmatically.

---

## PM Behavior Constraints (HARD)

These constraints are non-negotiable. Violation constitutes a protocol breach.

### 1. PM does NOT execute any git commands

PM never runs `git`, `gh`, or any version control command directly.
All git operations go through coordinator scripts (`git_ops.sh`).

### 2. PM issues structured JSON intents

**To create branches (start a task):**

PM emits a `BranchInitSpec` JSON. Coordinator receives it and executes `git_ops.sh create-branches`.

```json
{
  "type": "BranchInitSpec",
  "task_slug": "<descriptive-slug>",
  "date": "<YYYYMMDD>",
  "repo_path": "<absolute/path/to/repo>",
  "base_ref": "main",
  "workers": [
    {
      "task_id": "<task_id>",
      "task_type": "copywriting | solo | multi_agent",
      "label": "<branch-label-suffix>"
    }
  ]
}
```

**Fields:**
- `type`: Must be `"BranchInitSpec"` (literal).
- `task_slug`: Short descriptive name, used in branch naming. No spaces or special chars.
- `date`: Date in `YYYYMMDD` format. Used in task branch name.
- `repo_path`: Absolute filesystem path to the git repository.
- `base_ref`: Git ref to branch from (default: `"main"`).
- `workers[]`: Array of worker definitions.
  - `task_id`: Unique task identifier.
  - `task_type`: One of `copywriting`, `solo`, `multi_agent`.
  - `label`: Suffix for worker branch name (e.g., `"content"`, `"executor-a"`, `"reviewer"`).

**Resulting branches:**
- Task branch: `task/<YYYYMMDD>-<slug>`
- Worker branches: `worker/<slug>-<label>` (naming varies by task split plan)

### 3. PM issues merge decisions

**To merge or request changes:**

PM emits a `MergeDecision` JSON. Coordinator executes `git_ops.sh merge-pr`.

```json
{
  "type": "MergeDecision",
  "task_id": "<task_id>",
  "verdict": "approve | request_changes",
  "repo_path": "<absolute/path/to/repo>",
  "worker_branch": "<worker/branch-name>",
  "task_branch": "<task/branch-name>",
  "blocking_issues": [],
  "merge_after": []
}
```

**Fields:**
- `type`: Must be `"MergeDecision"` (literal).
- `task_id`: The task being reviewed.
- `verdict`: `"approve"` to merge, `"request_changes"` to block with feedback.
- `repo_path`: Absolute path to repository.
- `worker_branch`: The worker branch to merge (required for `approve`).
- `task_branch`: The target task branch (required for `approve`).
- `blocking_issues[]`: Array of strings describing blocking issues (for `request_changes`).
- `merge_after[]`: Array of branch names that must be merged first (dependency ordering).

### 4. PM reads structured reports, not raw diffs

PM receives review information via coordinator's `git_ops.sh review-prep` output:
- Structured JSON with `contract_check`, `diff_summary`, `judge_scores`
- PM never reads `git diff` output directly

### 5. session_state.json is coordinator-maintained

- `session_state.json` is derived by coordinator from git branch states
- PM does NOT call `state_update.sh` in git_collab mode
- PM reads `session_state.json` for awareness but never writes to it

---

## Executor Behavior Constraints (HARD)

### 1. Worker branch isolation

Executor works **only** on its assigned worker branch.
- MUST NOT modify other worker branches
- MUST NOT modify the task branch directly
- MUST NOT push to `main`

### 1.5 role-commit is coordinator-owned

- During role transitions, coordinator executes `git_ops.sh role-commit`.
- Agents do NOT run `git commit` as a transition operation.
- Agent responsibility is to finish artifacts in workspace; coordinator records phase commit.

### 2. Local tests before push

Executor MUST confirm local tests pass before committing/pushing.
If `test_cmd` is defined in the task spec, it must return rc=0.

### 3. Contract adherence (multi_agent)

For `multi_agent` tasks with a `design_contract.md`:
- Implement all interfaces declared for this worker
- Do NOT modify files owned by other workers (per File Ownership table)
- If deviation from contract is necessary, document it clearly in PR description under `## Deviation from Contract`
- Silent deviation (not documented) is a protocol breach

### 4. PR description format

When work is complete, executor's PR description follows the unified template:

```markdown
## Task
task_id: <id> | task_type: <type> | launch_mode: <mode>

## Summary
[What was implemented]

## Quality Score (if judge enabled)
- decision: pass | fail | need_user_input
- final_score_0_5: <0.0-5.0>
- final_score_0_100: <0-100>
- top_issues:
  - <issue 1>
- fix_suggestions:
  - <suggestion 1>

## Contract Compliance (multi_agent)
- [x] <export_name>: implemented at <file_path>

## Deviation from Contract (if any)
- None / [description and reason]

## Known Debt (if any)
- [description of temporary implementations or incomplete aspects]

## Verification
- [x] test_cmd passed / manual verification: [description]
```

---

## Branch State Semantics (unified)

| Git State | Task Status |
|-----------|-------------|
| Branch exists, no PR | Task assigned, not started |
| PR open | Task in progress |
| PR changes_requested | Task blocked, awaiting fixes |
| PR merged | Task done |

---

## Coordinator Responsibilities

The coordinator (programmatic, no LLM) handles:
1. `git_ops.sh create-branches` — on BranchInitSpec from PM
2. `git_ops.sh merge-pr` — on MergeDecision from PM
3. `git_ops.sh review-prep` — generates structured report for PM
4. `loop_lifecycle.sh on-loop-complete` — post-merge automation
5. `session_state.json` derivation from git branch states
6. `events.jsonl` event logging
