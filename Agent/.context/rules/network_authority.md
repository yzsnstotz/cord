# network_authority.md v1.4.9
# Trigger: env=remote detected at STEP 0
# KEEP full session; MUST NOT load when env=local

## Context

env=remote: agent on Air (leo@MacBook-Air-2.local) — all project execution via SSH to mini
env=local:  agent on mini — execute directly, this file not loaded

## Primary target: mac-mini

```
user:  yzliu
alias: yzliu-mini (100.114.240.117 via Tailscale)
```

All yzliu commands from Air:
```bash
ssh yzliu-mini 'zsh -lc "<cmd>"'
```

Verify before critical actions:
```bash
ssh -o BatchMode=yes yzliu-mini "whoami; hostname; pwd"
# expected: yzliu / YZ-Mac-mini.local / <path>
# mismatch → STOP, Level 2 escalation
```

## Cross-user: ao000 / ao001 / ao002

Never sudo. Always SSH aliases.

| user  | alias       |
|-------|-------------|
| ao000 | local-ao000 |
| ao001 | local-ao001 |
| ao002 | local-ao002 |

```bash
# env=remote (from Air — two hops)
ssh yzliu-mini 'ssh local-ao001 "zsh -lc \"<cmd>\""'
ssh yzliu-mini 'ssh local-ao001 "whoami; echo $HOME"'   # verify

# env=local (from mini — one hop)
ssh local-ao001 'zsh -lc "<cmd>"'
ssh local-ao001 'whoami; echo $HOME'                     # verify
```

## Prohibited

```
✗ sudo -u/-H/-n <user> (any sudo for ao-users)
✗ direct execution on Air assuming mini context
✗ critical actions without identity verification
```
