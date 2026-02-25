# model_routing.md v1.4.9
# Trigger: choosing provider/role for a task
# ONLY VALID in cli_collab mode — MUST NOT load in solo
# DISCARD after routing decision

## Rule: delegate to lowest sufficient level

| level | provider/role           | use for                                               |
|-------|-------------------------|-------------------------------------------------------|
| L0    | tools/ scripts          | hash, audit, index I/O — 0 tokens, always try first   |
| L1    | designer (claude)       | architecture, complex bugs, judgment, verdict         |
| L2    | executor (claude)       | code (complex), docs, consolidation                   |
| L3    | reviewer (codex)        | templated code, search, summary, format conversion    |

```
L0 can handle?              → tools/ script
mechanical/lookup?          → /ask reviewer (L3)
moderate execution?         → /ask executor (L2)
architecture/judgment?      → /ask designer or self if designer (L1)
```

L3 response must include:
```json
{ "result": "...", "confidence": "high|medium|low", "reason": "..." }
```
high → L1 accepts | medium → L1 flags | low → retry L3 once then escalate to L1

## Prohibited
```
✗ L1 self-executing search or format conversion
✗ LLM doing what L0 handles
✗ L3 making architecture decisions or updating task status
```
