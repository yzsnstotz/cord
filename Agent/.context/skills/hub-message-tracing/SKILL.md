---
name: hub-message-tracing
description: Use when diagnosing any cross-layer issue in CallHub architecture — traces HubMessage through Interface → Hub → Agent/Service → Memory using trace_id, identifies where the signal breaks.
trigger: cross-layer issue / hub routing failure / message lost / unexpected routing / auth failure at hub
lifecycle: DISCARD
mode: any
---

# HubMessage Tracing

## Mental Model

Every event in the system carries a trace_id from entry to exit:

```
InboundUIEvent
  → [Interface] → HubMessage (trace_id assigned here)
  → [Hub] → auth gate → routing decision
  → [Agent/Service] → execution
  → [MemoryHub] → namespace-isolated write
  → [Hub] → HubAction
  → [Interface] → channel reply
```

A broken trace_id = you've lost the event. A missing log at any boundary = blind spot.

## Trace Investigation Protocol

### Step 1 — Find the trace_id

From user report, error log, or audit.jsonl:
```bash
grep "trace_id" $project_path/.context/audit.jsonl | grep "<partial-id>"
```

### Step 2 — Walk each boundary

For each layer, check: did the HubMessage arrive? Was it processed? What was the output?

```
Interface     → did InboundUIEvent get emitted? (channel log)
Hub intake    → did HubMessage get created? (trace_id in audit)
Credential    → PermissionSet returned? ALLOW or DENY? (auth log)
Routing       → which target was dispatched to? (routing log)
Agent/Service → did it receive HubMessage? (agent log with trace_id)
MemoryHub     → namespace correct? write confirmed? (memory log)
Return        → HubAction emitted? reply_channel delivered? (output log)
```

### Step 3 — Identify break point

The break is at the first boundary with no outgoing log.
That's where the bug lives — go to systematic-debugging skill.

## Common Break Patterns

| Symptom | Likely break point |
|---|---|
| User gets no reply | Interface return / reply_channel mismatch |
| "Permission denied" unexpected | Credential Layer: actor_id resolution |
| Agent receives empty context | MemoryHub: namespace isolation, wrong actor_id |
| Wrong agent dispatched | Hub routing: intent parsing or registry mismatch |
| Memory write missing | MemoryHub: write not called, or namespace filter blocked it |
| Replay diverges from original | trace_id not propagated through Service calls |

## Adding Trace Points (when blind spots exist)

```python
# Minimum: log at every boundary crossing
logger.info(f"[HUB-IN] trace_id={msg.trace_id} actor={msg.actor_id} intent={msg.intent}")
logger.info(f"[AUTH] trace_id={msg.trace_id} result={perm_set.decision}")
logger.info(f"[DISPATCH] trace_id={msg.trace_id} target={target}")
logger.info(f"[MEMORY-W] trace_id={msg.trace_id} ns={namespace} key={key}")
```

## Audit Integration

All trace events → `bash $TOOLS_ROOT/audit_append.sh $project_path hub_trace <task_id> <task_id> "trace_id=... boundary=... result=..."`

Enables replay: `grep trace_id audit.jsonl` reconstructs full event path.
