# Execution summary: CCB health-check vs ask channel separation

**Task ID:** ccb-channel-separation  
**Completed:** 2026-02-26 (UTC)  
**Actor:** executor  

## Goal

Separate two channels that were incorrectly mixed:

1. **Health-check channel** — connectivity only; must not send any message to the AI pane.
2. **Ask channel** — send user/coordinator message to the AI and wait for reply.

Previously, callers used `cask/gask/lask/oask/dask "ping"` for health check, which sent the literal message "ping" to the pane and caused repeated "ping" traffic in Codex/Gemini panes.

## Actions taken

### 1. Reverted CCB ask scripts (5 files)

- **CCB/bin/cask, gask, lask, oask, dask**  
  Removed the special-case that treated the single message `"ping"` as a connectivity check (no send). These scripts now only handle the **ask channel**: every argument is the message to send. No in-band "ping" handling.

### 2. Switched callers to connectivity-only channel (Rdloop)

- **Rdloop/gui/server.js**
  - `pingCcbProvider`: when `cmd === 'ccb-ping'`, success = exit code 0 (no "pong" in stdout).
  - `/api/ccb/status`: uses `pingCcbProvider('ccb-ping', ['codex'], ...)` and `pingCcbProvider('ccb-ping', ['gemini'], ...)`.
  - All other CCB status/session checks: use `pingCcbProvider('ccb-ping', [provider], ...)` instead of `pingCcbProvider(pingCmd, ['--timeout', '2', 'ping'], ...)`.

- **Rdloop/coordinator/lib/call_coder_ccb.sh**
  - Introduced `ccb_provider` (codex, gemini, claude, opencode, droid) alongside `ccb_bin`.
  - Availability check: `ccb-ping "$ccb_provider"` with `CCB_SESSION_FILE` or `(cd "$worktree_dir" && ccb-ping "$ccb_provider")` instead of `"$ccb_bin" --timeout 5 "ping"`.
  - Messaging still uses `ccb_bin` (cask/gask/lask/oask/dask).

- **Rdloop/coordinator/lib/call_judge_ccb.sh**
  - Same: `ccb_provider` added; availability check uses `ccb-ping "$ccb_provider"`; messaging still uses `ccb_bin`.

## Outcome

- **Health check** → use only `ccb-ping <provider>` (or cping/gping/lping/oping/dping). No message is sent to any pane.
- **Send message** → use only cask/gask/lask/oask/dask. No overloaded "ping" semantics.

## Modified files (with hash for traceability)

| Path | Hash (sha256) |
|------|----------------|
| CCB/bin/cask | d0dde29801a434e3c510cc59cf8d507a82dbe39441e10a5834f19b14a05f1e1f |
| CCB/bin/gask | 622bd4e828dfb4997685b9c3402f63d4e6c05df816164d098776e15656ff5989 |
| CCB/bin/lask | 44aad182b32cae958de835628e36f98d8509cbffa0ba3202dcefceafb1f76104 |
| CCB/bin/oask | d510be5e2371c19e6de9488b08fb6ff5c1d4b65196cdf3a69bd53a48ebfe0db4 |
| CCB/bin/dask | 638d775a0cb3012bd3ebcc67d0ef2ec8c0bda69d72aeaaf1940c8f389034b77f |
| Rdloop/gui/server.js | d805b0c291f2c6751ee063a64d3ad2538211aef48f426f57d5c66b31cc575a48 |
| Rdloop/coordinator/lib/call_coder_ccb.sh | 03e416bfea851e884e643a4fff675677379bfe779ce274b43273ffd48bff52d3 |
| Rdloop/coordinator/lib/call_judge_ccb.sh | c6f838b4604d2e1d2c5c30f266f7ac3fb2e9e377ecc6db720ff8b8752e98a7b9 |

Index and audit records were updated under `$PROJECT_PATH/.context/` via Agent tools (hash.sh, index_upsert.sh, audit_append.sh).
