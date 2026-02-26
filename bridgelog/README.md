# Bridge communication logs

This directory holds **communication logs** for CCB and Claude bridge. Log files are created on first write. Directory is created automatically if missing.

## Log files

| File | Description |
|------|-------------|
| **ccb_comm.log** | CCB communication: FIFO send/receive, bridge→pane, and Codex reply (when caller waits or fetches). Each line is JSON. |
| **claude_bridge_comm.log** | Claude bridge IPC: permission/limit requests created by bridge, responses written/read, and openclaw→Telegram forwards. Each line is JSON. |

## Enabling logs

- **CCB (Python)**: Set `BRIDGELOG_DIR` to this directory (e.g. `/path/to/Cord/bridgelog`). If unset, logs go to `./bridgelog` relative to the process cwd.
- **Claude bridge (Node)**: Same: set `BRIDGELOG_DIR` so both the bridge process and openclaw write to the same folder.

Example:

```bash
export BRIDGELOG_DIR=/Users/yzliu/work/Cord/bridgelog
```

## CCB log events (ccb_comm.log)

- `event: "send"` — Caller sent to Codex (marker, content).
- `event: "reply"` — Codex reply received by caller (marker, reply; marker correlates with send).
- `event: "fifo_in"` — Bridge read one request from FIFO (marker, content).
- `event: "fifo_out"` — Bridge sent content to Codex pane (marker, content).

## Claude bridge log events (claude_bridge_comm.log)

- `event: "request_created"` — Bridge wrote a permission or usage_limit request to pending (from: bridge, to: pending, id, type).
- `event: "response_written"` — Someone wrote a response (from: telegram/caller, to: bridge, id, choice).
- `event: "response_read"` — Bridge read a response file (from: responses, to: bridge, id, choice).
- `event: "forward_to_telegram"` — Openclaw forwarded a pending request to Telegram (from: openclaw, to: telegram, id, type).
