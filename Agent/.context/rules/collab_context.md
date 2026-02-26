# collab_context.md v2.0
# Single source of truth for all collab worker context (cli_collab mode).
# For git_collab mode, see rules/git_collab.md instead.
# PM embeds relevant sections into every /ask task package.
# CCB must NOT inject role or rubric content into CLAUDE.md / AGENTS.md / .clinerules.
# KEEP full session when cli_collab is active.
# v2.0: State Read Delegation removed (coordinator reads git state directly in git_collab mode).

## Purpose

This file owns all content that workers need to operate correctly in collab mode:
- Role Assignment (who does what)
- Async Guardrail (CCB protocol rule)
- Rubrics (scoring criteria for reviewer)
- Inspiration Constraint (for brainstorming)

When PM sends a task via /ask, it MUST prepend the [WORKER CONTEXT] block below
so workers are self-contained and never depend on CCB's file injection.
When embedding the block, replace the placeholder {pm_provider} with the current PM provider from the Role Assignment table (Settings → Roles).

---

## [WORKER CONTEXT] — embed this block at the top of every /ask message

Base block (all roles):

```
[WORKER CONTEXT — read before acting]

ROLE ASSIGNMENT
You are operating as: <role>          ← PM fills this in per /ask call
PM identity: {pm_provider} (current session) ← workers report back to PM only

| role        | provider | authority                                        |
|-------------|----------|--------------------------------------------------|
| PM          | claude   | sole owner: task assignment, status, user report |
| designer    | claude   | plan/architecture; PM may hold concurrently      |
| inspiration | gemini   | brainstorm only; output is reference, never final|
| reviewer    | codex    | scored quality gate; returns JSON verdict        |
| executor    | claude   | code implementation; writes files                |

WORKER RULES (HARD)
- You are a worker. Do NOT reassign tasks to other workers.
- Do NOT report results directly to user — report to PM only.
- Do NOT call state_update.sh — PM does that.
- Do NOT treat yourself as PM.

ASYNC GUARDRAIL (CCB MANDATORY)
If any bash output contains [CCB_ASYNC_SUBMITTED]:
  Reply with exactly: "<Provider> processing..."
  END YOUR TURN IMMEDIATELY.
  Do NOT poll, sleep, call pend, or add any follow-up.

REPORT FORMAT
Return JSON only at end of task. No prose outside JSON unless task explicitly allows it.
[END WORKER CONTEXT]
```

For reviewer tasks only — append Rubric A or B immediately after the base block:
(Do NOT append rubrics to executor or inspiration tasks — unnecessary token cost)

```
[RUBRIC — use for scoring]
<paste Rubric A or Rubric B from sections below depending on review type>
[END RUBRIC]
```

---

## Role Assignment (canonical)

| role        | provider | scope                                                         |
|-------------|----------|---------------------------------------------------------------|
| PM          | claude   | sole authority: task assignment, status updates, user reports |
| designer    | claude   | plan/architecture — PM may hold this role concurrently        |
| inspiration | gemini   | brainstorming only — output is reference, never inserted      |
| reviewer    | codex    | scored quality gate via Rubrics below                         |
| executor    | claude   | code implementation                                           |

To reassign a role: edit the provider column in this file only.
PM role is reassignable via Settings → Roles panel.

---

## Async Guardrail (canonical)

```
if /ask output contains [CCB_ASYNC_SUBMITTED]:
  reply exactly: "<Provider> processing..."
  END TURN IMMEDIATELY
  do NOT: poll / sleep / call pend / add follow-up
```

---

## Inspiration Constraint (canonical)

```
inspiration output:
  - present to user as options list only
  - NEVER insert directly into plan or code
  - designer must explicitly state: "adopting X because Y, rejecting Z"
```

---

## Rubric A — Plan Review (reviewer uses this)

Reviewer returns JSON. All dimensions scored 1–10.

```json
{
  "review_type": "plan",
  "dimensions": {
    "clarity":               { "score": 0, "strengths": [], "weaknesses": [], "fix": "" },
    "completeness":          { "score": 0, "strengths": [], "weaknesses": [], "fix": "" },
    "feasibility":           { "score": 0, "strengths": [], "weaknesses": [], "fix": "" },
    "risk_assessment":       { "score": 0, "strengths": [], "weaknesses": [], "fix": "" },
    "requirement_alignment": { "score": 0, "strengths": [], "weaknesses": [], "fix": "" }
  },
  "overall": 0.0,
  "critical_issues": [],
  "verdict": "pass|fail"
}
```

Weights: clarity 20%, completeness 25%, feasibility 25%, risk_assessment 15%, requirement_alignment 15%
Pass: overall >= 7.0 AND no single dimension <= 3

---

## Rubric B — Code Review (reviewer uses this)

```json
{
  "review_type": "code",
  "dimensions": {
    "correctness":     { "score": 0, "strengths": [], "weaknesses": [], "fix": "" },
    "security":        { "score": 0, "strengths": [], "weaknesses": [], "fix": "" },
    "maintainability": { "score": 0, "strengths": [], "weaknesses": [], "fix": "" },
    "performance":     { "score": 0, "strengths": [], "weaknesses": [], "fix": "" },
    "test_coverage":   { "score": 0, "strengths": [], "weaknesses": [], "fix": "" },
    "plan_adherence":  { "score": 0, "strengths": [], "weaknesses": [], "fix": "" }
  },
  "overall": 0.0,
  "critical_issues": [],
  "verdict": "pass|fail"
}
```

Weights: correctness 25%, security 15%, maintainability 20%, performance 10%, test_coverage 15%, plan_adherence 15%
Pass: overall >= 7.0 AND no single dimension <= 3
