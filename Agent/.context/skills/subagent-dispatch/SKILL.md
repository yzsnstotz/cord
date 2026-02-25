---
name: subagent-dispatch
description: Use when facing 2+ independent tasks that can run without shared state or sequential dependency — dispatches focused agents per domain instead of sequential execution. Only valid in cli_collab mode.
trigger: multiple independent tasks / parallel work / independent failures
lifecycle: DISCARD
mode: cli_collab
---

# Subagent Dispatch

## When to Use

```
Multiple tasks AND tasks are independent AND no shared state conflict?
  → dispatch in parallel (this skill)

Tasks are tightly coupled / sequential?
  → execute sequentially with executing-plans skill

Need worktrees / separate sessions?
  → dispatching-parallel-agents pattern
```

## Dispatch Pattern

### 1. Partition tasks by domain

Group by what's touched, not by surface similarity:

```
Domain A: CallHub routing logic (routes.json, hub.py)
Domain B: Credential Layer policy update (policies/, grants/)
Domain C: MemoryHub namespace isolation fix (memory_hub.py)
```

Each domain = one agent. No agent touches another domain's files.

### 2. Per-agent task package (in cli_collab /ask format)

```json
{
  "task_id": "T01-A",
  "scope": "CallHub routing only — do NOT touch Credential Layer or MemoryHub",
  "goal": "specific measurable outcome",
  "files_in_scope": ["exact/paths/only"],
  "files_forbidden": ["any/other/file"],
  "acceptance_criteria": "specific, verifiable",
  "report_format": "output_files + hash + what changed + why"
}
```

### 3. Integration after all agents return

- Read each agent's report
- Verify no file conflicts (same file touched by 2 agents = problem)
- Run full integration test suite
- If conflicts: resolve manually before marking any task done

## Two-Stage Review (per task, before marking done)

**Stage 1 — Spec compliance** (reviewer / L3):
- Did agent touch only files in scope?
- Are all acceptance_criteria met?
- No forbidden files modified?

**Stage 2 — Code quality** (reviewer / L3):
- Correctness, completeness, risk, scope (rubrics from cli_collab.md)
- Pass threshold: overall ≥ 7.0, no dimension ≤ 3

Only after both stages pass → PM calls state_update.sh with status=done.

## Hard Constraints

```
✗ Agents must not share mutable state during execution
✗ No agent modifies Hub routing AND Credential Layer in same task
✗ Never skip two-stage review even if "obviously correct"
✗ Do not mark task done based on agent self-report alone
```

## Degradation

If one agent fails/stalls → degrade per cli_collab.md degradation policy.
Do not hold up other independent agents waiting for a failed one.
