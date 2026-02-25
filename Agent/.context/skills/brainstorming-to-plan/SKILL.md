---
name: brainstorming-to-plan
description: Use before any feature design, architecture decision, new service/agent addition, or significant change. Explores and scores requirements, produces an approved plan document before any implementation begins.
trigger: new feature / design / architecture / hub change / adding agent or service
lifecycle: DISCARD
mode: any
---

# Brainstorming to Plan

## Hard Gate

```
DO NOT write code, create files, or modify any system component
until design is presented AND user has approved it.
```

---

## Phase 1: Requirement Clarification (both modes)

Use the **5-Dimension Planning Readiness Model**.

| Dimension        | Weight | Focus                             | Priority |
|------------------|--------|-----------------------------------|----------|
| Problem Clarity  | 30pts  | What problem? Why solve it?       | 1        |
| Functional Scope | 25pts  | What does it DO? Key features     | 2        |
| Success Criteria | 20pts  | How to verify done?               | 3        |
| Constraints      | 15pts  | Time, resources, compatibility    | 4        |
| Priority/MVP     | 10pts  | What first? Phased delivery?      | 5        |

### Clarification Flow

```
ROUND 1:
  1. Parse initial requirement
  2. Identify 2 lowest-confidence dimensions (use Priority order for ties)
  3. Present 2 questions with lettered options (1 per dimension)
  4. User selects options -> update dimension scores
  5. Display Scorecard

IF readiness_score >= 80: skip Round 2
ELSE:
  ROUND 2:
    Ask 2 more questions for remaining weak dimensions
    Proceed regardless after Round 2 (with gap summary)

QUICK-START OVERRIDE:
  User selects "Proceed anyway" -> all dimensions marked as "assumption"
```

### Gap Classification

| Score vs Weight | Status       | Handling                            |
|-----------------|--------------|-------------------------------------|
| >=70%           | Defined      | Include in Design Brief             |
| 50-69%          | Assumption   | Carry forward as risk               |
| <50%            | Gap          | Flag in brief, may need validation  |

### Clarification Summary Output

```
CLARIFICATION SUMMARY
=====================
Readiness Score: [X]/100

Dimensions:
- Problem Clarity:  [X]/30 [ok/assumption/gap]
- Functional Scope: [X]/25 [ok/assumption/gap]
- Success Criteria: [X]/20 [ok/assumption/gap]
- Constraints:      [X]/15 [ok/assumption/gap]
- Priority/MVP:     [X]/10 [ok/assumption/gap]

Assumptions & Gaps:
- [Dimension]: [description]
```

### Design Brief

After clarification, produce:

```
DESIGN BRIEF
============
Readiness Score: [X]/100
Problem: [clear problem statement]
Context: [project context, tech stack, constraints]
Requirements: [list]
Success Criteria: [list]
Assumptions: [list]
Gaps to Validate: [list]
```

---

## Phase 2: Inspiration (collab mode only)

> solo mode: skip this phase, go to Phase 3.

Send Design Brief to `inspiration` provider (via `/ask`):

```
/ask <inspiration provider> "
[WORKER CONTEXT — read before acting]
You are operating as: inspiration
PM identity: claude (current session)
Worker rule: provide creative ideas only. PM will filter. Do NOT make decisions.
Async guardrail: if output contains [CCB_ASYNC_SUBMITTED], end turn immediately.
[END WORKER CONTEXT]

[TASK]
You are a creative brainstorming partner. Based on this design brief,
provide INSPIRATION and CREATIVE IDEAS - not a full implementation plan.

[design_brief]

Provide:
1) 3-5 creative approaches or angles others might miss
2) Naming suggestions (features, APIs, components) if applicable
3) Unconventional solutions worth considering
4) Analogies from other domains that could inform the design

Be bold. Practical feasibility is secondary - inspiration is the goal.
[END TASK]
"
```

After receiving response, designer (PM) MUST classify each idea:
- Adopt   -- improves the design, feasible within constraints
- Adapt   -- interesting kernel but needs reworking
- Discard -- impractical or contradicts requirements

Present filter result to user and ask for override if needed.

**Inspiration Constraint (HARD):**
```
inspiration output:
  - present to user as options list only
  - NEVER insert directly into plan without designer decision
  - designer must explicitly state: "adopting X because Y, rejecting Z"
```

---

## Phase 3: Designer Creates the Plan (both modes)

Designer is the sole planner. Use Design Brief + project context + adopted inspiration.

### Plan Draft Structure

```
IMPLEMENTATION PLAN
===================
Goal: [1-sentence]

Architecture:
- Approach: [chosen approach with rationale]
- Key Components: [list]
- Data Flow: [if applicable]

Implementation Steps:
1. [Step title]
   - Actions: [specific actions]
   - Deliverables: [what will be produced]
   - Dependencies: [what's needed first]
2. ...

Technical Considerations: [list]

Risks & Mitigations:
| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|

Acceptance Criteria:
- [ ] [criterion 1]
- [ ] [criterion 2]
```

---

## Phase 4: Scored Review

### solo mode

Designer self-reviews against each acceptance criterion. Present plan to user directly for approval. No scoring rubric required.

### collab mode

Submit plan to `reviewer` provider (via `/ask`) with this exact prompt:

```
/ask <reviewer provider> "
[WORKER CONTEXT — read before acting]
You are operating as: reviewer
PM identity: claude (current session)
Worker rules: score the plan using the rubric below. Return JSON only. Report to PM.
Async guardrail: if output contains [CCB_ASYNC_SUBMITTED], end turn immediately.
[END WORKER CONTEXT]

[RUBRIC A — use for scoring]
Dimensions (all 1-10):
  clarity 20% — unambiguous steps; another developer can follow without questions
  completeness 25% — all requirements, edge cases, deliverables covered
  feasibility 25% — steps achievable with current codebase and dependencies
  risk_assessment 15% — risks identified with concrete mitigations
  requirement_alignment 15% — every step traces to a stated requirement; no scope creep
Pass: overall >= 7.0 AND no dimension <= 3
[END RUBRIC A]

[TASK]
[PLAN REVIEW REQUEST]
Review the following implementation plan. Score EACH dimension.
Return JSON only:

{
  "review_type": "plan",
  "dimensions": {
    "clarity":               { "score": N, "strengths": [], "weaknesses": [], "fix": "" },
    "completeness":          { "score": N, "strengths": [], "weaknesses": [], "fix": "" },
    "feasibility":           { "score": N, "strengths": [], "weaknesses": [], "fix": "" },
    "risk_assessment":       { "score": N, "strengths": [], "weaknesses": [], "fix": "" },
    "requirement_alignment": { "score": N, "strengths": [], "weaknesses": [], "fix": "" }
  },
  "overall": N.N,
  "critical_issues": [],
  "verdict": "pass|fail"
}

--- PLAN START ---
[plan_draft]
--- PLAN END ---
[END TASK]
"
```

**Auto-Correction Loop:**
```
iteration = 1
WHILE verdict == fail AND iteration <= 3:
  1. Read weaknesses and fix suggestions per dimension
  2. Revise plan to address ALL critical_issues
  3. Re-submit to reviewer (same format)
  4. iteration += 1

IF iteration > 3 AND still fail:
  Present all rounds to user -> ask how to proceed
```

**On PASS - display score table:**
```
REVIEW: PASSED (Round [N])
| Dimension             | Score |
|-----------------------|-------|
| Clarity               | X/10  |
| Completeness          | X/10  |
| Feasibility           | X/10  |
| Risk Assessment       | X/10  |
| Requirement Alignment | X/10  |
| OVERALL               | X.X   |
```

---

## Phase 5: Save Plan & Transition

**Save plan to:** `docs/plans/YYYY-MM-DD-<feature>-plan.md`

Plan document must include:
- Goal, Readiness Score, Review Score (collab) or Self-Review (solo)
- Requirements Summary, Architecture, Implementation Steps
- Risk table, Acceptance Criteria
- Inspiration Credits (collab only)

**Output to user:**
```
PLAN COMPLETE
=============
Saved to: docs/plans/YYYY-MM-DD-<feature>-plan.md
Goal: [1-sentence]
Steps: [N]
Readiness: [X]/100
Review: [X.X]/10 round [N] (collab) | self-reviewed (solo)

Next: approve plan -> PM writes tasks to session_state.json -> begin execution
```

User must explicitly approve before PM creates tasks. Do NOT transition to execution without approval.

---

## Architecture Lens (for your system)

When exploring changes, always ask which layers are touched:

```
Interface Layer   -> new channel? new InboundUIEvent shape?
CallHub           -> routing rule change? registry update?
Credential Layer  -> new Principal? new Policy/Grant?
Agent Layer       -> Planner / Tool Runner scope change?
Service Layer     -> new service? API contract change?
Memory Layer      -> new namespace? retention change?
LLM Orchestrator  -> model tier routing? cost impact?
```

A change touching multiple layers requires a cross-layer design doc.
