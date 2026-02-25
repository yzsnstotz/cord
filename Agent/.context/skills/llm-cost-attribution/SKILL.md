---
name: llm-cost-attribution
description: Use when routing a task to a model, reviewing model selection decisions, or auditing token costs by trace_id — enforces L0-L3 tier discipline and cost tracking.
trigger: choosing model / task routing / cost review / LLM orchestration
lifecycle: DISCARD
mode: any
---

# LLM Cost Attribution

## Tier Reference

| Tier | Role | Use for | Cost target |
|---|---|---|---|
| L0 | Dumb | classify / parse / extract / rewrite / template fill | < 5% of total |
| L1 | Mid | light reasoning / summarize / archive / small steps | bulk of token spend |
| L2 | Smart | complex planning / high-risk decisions / key outputs | < 20% of total |
| L3 | Verified | self-check / multi-sample / consistency vote | high-risk ops only |

## Routing Decision (run before every LLM call)

```
Can L0 script/tool handle this?         → L0 (zero tokens if possible)
Is it mechanical / lookup / template?   → L0 / L1
Is it a small execution step?           → L1
Is it task decomposition or planning?   → L2
Is it high-risk / publish / final gate? → L2 / L3
Is it Operational Memory archiving?     → L1 + rule constraints
```

## Hard Rules

```
✗ L2/L3 must NOT self-execute search, format conversion, template fill
✗ L0/L1 must NOT make architecture decisions or update task status
✗ Never use L2/L3 for what L0 tools/ scripts already handle
✗ LLM Orchestrator must log tier decision per trace_id
```

## Cost Attribution Log Format

Every LLM call must be attributable via trace_id:

```json
{
  "trace_id": "...",
  "task_id": "T01",
  "tier": "L1",
  "model": "provider/model-name",
  "tokens_in": 0,
  "tokens_out": 0,
  "decision_reason": "small execution step, no judgment required"
}
```

Log to audit via: `bash $TOOLS_ROOT/audit_append.sh $project_path llm_call <task_id> <task_id> "tier=L1, reason=..."`

## Cost Review Triggers

Run cost review when:
- A single task_id accumulates >10k tokens
- L2/L3 usage >20% of session total
- Any L3 call is made (always justified in audit)

## Integration with model_routing.md (cli_collab)

In cli_collab, model_routing.md handles provider/role assignment.
This skill handles **tier selection within each provider call**.
The two operate at different levels — both apply simultaneously.

```
cli_collab: who executes? → model_routing.md (designer/reviewer/executor)
any mode:   what tier?    → this skill (L0/L1/L2/L3 per call)
```
