# Three-Mode Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement three workflow modes (Single Flow / Solo Agent / Collab), knowledge shard system, and CCB agent start fix across the Cord system.

**Architecture:** Mode-driven new/edit modal in GUI controls `workflow_mode` field in task.json. Coordinator routes to mode-specific adapters. Knowledge uses module-based shard files instead of single cache. Solo agent uses extended bridge for coordinator-agent communication loops.

**Tech Stack:** Node.js/Express (server.js), vanilla JS (app.js), Bash (coordinator scripts), Python (decision logic, knowledge tools)

**Design doc:** `docs/plans/2026-02-26-three-mode-workflow-design.md`

---

## Dependency Graph

```
Task 1 (CCB Fix)           ─── independent
Task 2 (Knowledge Backend) ─── independent
Task 3 (Knowledge Migration)── depends on 2
Task 4 (Knowledge GUI)     ─── depends on 2
Task 5 (Cliproxy Adapter)  ─── independent
Task 6 (Solo Bridge+Adapt) ─── independent
Task 7 (Decision Solo)     ─── independent
Task 8 (Coordinator Route) ─── depends on 5, 6, 7
Task 9 (Three-Mode Modal)  ─── depends on 5, 6
Task 10 (Solo Progress GUI)─── depends on 6, 8
Task 11 (Integration)      ─── depends on all
```

Parallel tracks: {1}, {2→3→4}, {5, 6, 7}→8→{9, 10}→11

---

### Task 1: CCB Agent Start Button Fix

**Files:**
- Modify: `Rdloop/gui/server.js:1639-1729` (POST /api/ccb/session/start)
- Modify: `Rdloop/gui/public/app.js:683-729` (ccbStartProviders)

**Context:** `isCcbNativeSessionName()` at server.js:1306-1308 already matches `ccb_\d+`. The real bug is the 2-second single-check wait at line 1686. CCB needs more time to create the tmux session and start providers. Also, spawning per-provider creates duplicate sessions.

**Step 1: Add retry polling to session/start handler**

In `Rdloop/gui/server.js`, replace the single 2s wait at line 1686 with a retry loop:

```javascript
// Replace line 1686: await new Promise(r => setTimeout(r, 2000));
// With retry polling:
let foundSession = null;
for (const delay of [1500, 2000, 3000, 4000]) {
  await new Promise(r => setTimeout(r, delay));
  const checkResult = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
  const checkNames = (checkResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  foundSession = checkNames.find(n => isCcbNativeSessionName(n) || n.startsWith('ai-'));
  if (foundSession) break;
}
if (!foundSession) {
  // Final fallback: check once more after full 10s
  await new Promise(r => setTimeout(r, 3000));
}
```

Then update the `listResult` block (lines 1688-1692) to use `foundSession` if found, otherwise re-list.

**Step 2: Add existing-session check before spawn**

In `Rdloop/gui/server.js`, before the `spawn('python3', ...)` at line 1677, check if a CCB session already exists:

```javascript
// Before spawning, check for existing CCB session
const preList = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
const preNames = (preList.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
const existingCcb = preNames.find(n => isCcbNativeSessionName(n) || n.startsWith('ai-'));
if (existingCcb) {
  // Session exists — skip spawn, just ping providers and return status
  const sessions = [];
  for (const provider of validProviders) {
    const pingCmd = CCB_PING_CMD[provider];
    let status = 'off';
    if (pingCmd) {
      const pingResult = await pingCcbProvider(pingCmd, ['--timeout', '2', 'ping'], 2500);
      status = pingResult.status === 'ok' ? 'ok' : 'unavailable';
    } else {
      status = 'ok';
    }
    sessions.push({ provider, session_name: existingCcb, status });
  }
  return res.json({
    ok: true, sessions,
    session_ids: [existingCcb],
    errors: [], hint: 'Reused existing CCB session: ' + existingCcb
  });
}
```

**Step 3: Always surface stderr in response**

At line 1718, change the condition from `sessions.every(s => s.status !== 'ok')` to always include stderr:

```javascript
// Always include stderr snippet (not just on total failure)
if (stderrSnippet) {
  errors.push('CCB stderr: ' + stderrSnippet);
}
```

**Step 4: Extend frontend polling window**

In `Rdloop/gui/public/app.js`, at line 724, replace the polling delays:

```javascript
// Replace: [2000, 4000, 6000, 8000].forEach(ms => setTimeout(refreshCcbPanelContent, ms));
// With:
[2000, 4000, 6000, 8000, 12000, 16000].forEach(ms => setTimeout(refreshCcbPanelContent, ms));
```

At line 695, update the "Starting..." notice to persist longer:

```javascript
if (notice) {
  notice.textContent = 'Starting ' + providers.join(', ') + '... (waiting for session)';
  notice.style.color = '#8b949e';
}
```

**Step 5: Verify manually**

1. Start the GUI: `cd Rdloop/gui && npm start`
2. Go to Agents tab
3. Click "Start All" — should show "Starting..." then update to green status within 16s
4. Click individual "Start" for one provider — should reuse existing session
5. Check that "Stop All" then "Start All" works fresh

**Step 6: Commit**

```bash
git add Rdloop/gui/server.js Rdloop/gui/public/app.js
git commit -m "fix: CCB start buttons — retry polling + existing session reuse"
```

---

### Task 2: Knowledge Shard Backend (write_knowledge_cache.py + server.js API)

**Files:**
- Modify: `Agent/.context/tools/write_knowledge_cache.py` (add --shard, shard file I/O)
- Modify: `Rdloop/gui/server.js:2293-2312` (replace old /api/knowledge with shard endpoints)

**Step 1: Add shard support to write_knowledge_cache.py**

In `Agent/.context/tools/write_knowledge_cache.py`, add the following:

After `CACHE_VERSION = "1.0"` (line 27), add shard path helpers:

```python
SHARD_DIR_NAME = "knowledge"
META_FILENAME = "_meta.json"


def _knowledge_dir(project_path: str) -> str:
    return os.path.join(os.path.abspath(project_path), ".context", SHARD_DIR_NAME)


def _shard_path(project_path: str, shard_name: str) -> str:
    return os.path.join(_knowledge_dir(project_path), shard_name + ".json")


def _meta_path(project_path: str) -> str:
    return os.path.join(_knowledge_dir(project_path), META_FILENAME)


def _load_shard(shard_path: str, shard_name: str, project_name: str = "") -> dict:
    if os.path.isfile(shard_path):
        with open(shard_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "version": CACHE_VERSION,
        "shard": shard_name,
        "description": "",
        "last_updated": _now_iso(),
        "entries": {},
    }


def _load_meta(meta_path: str, project_name: str = "") -> dict:
    if os.path.isfile(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"version": CACHE_VERSION, "project": project_name, "shards": {}}


def _update_meta(project_path: str, shard_name: str, shard_data: dict) -> None:
    meta_p = _meta_path(project_path)
    project_name = os.path.basename(os.path.abspath(project_path).rstrip(os.sep))
    meta = _load_meta(meta_p, project_name)
    meta["shards"][shard_name] = {
        "description": shard_data.get("description", ""),
        "entry_count": len(shard_data.get("entries", {})),
        "last_updated": shard_data.get("last_updated", _now_iso()),
    }
    _atomic_write(meta_p, meta)


def _uses_shards(project_path: str) -> bool:
    return os.path.isdir(_knowledge_dir(project_path))
```

**Step 2: Update writer_pm and writer_executor to support --shard**

Add new shard-aware writer functions after the existing ones:

```python
def writer_pm_shard(project_path: str, task_id: str, shard_name: str, entry_data: dict) -> None:
    kdir = _knowledge_dir(project_path)
    os.makedirs(kdir, exist_ok=True)
    shard_p = _shard_path(project_path, shard_name)
    lock_p = shard_p + ".lock"
    # Reuse _write_lock pattern but on shard lock file
    fd = os.open(lock_p, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        data = _load_shard(shard_p, shard_name)
        key = f"task:{task_id}"
        entry = dict(entry_data)
        if "type" not in entry:
            entry["type"] = "task"
        if "written_by" not in entry:
            entry["written_by"] = "PM"
        data["entries"][key] = entry
        data["last_updated"] = _now_iso()
        _atomic_write(shard_p, data)
        _update_meta(project_path, shard_name, data)
    finally:
        if fcntl is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
        os.close(fd)


def writer_executor_shard(project_path: str, task_id: str, shard_name: str, final_summary_path: str) -> None:
    with open(final_summary_path, "r", encoding="utf-8") as f:
        summary = json.load(f)
    knowledge_entries = summary.get("knowledge_entries") or {}
    if not knowledge_entries:
        return
    kdir = _knowledge_dir(project_path)
    os.makedirs(kdir, exist_ok=True)
    shard_p = _shard_path(project_path, shard_name)
    lock_p = shard_p + ".lock"
    fd = os.open(lock_p, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        data = _load_shard(shard_p, shard_name)
        now = _now_iso()
        for filepath, summary_text in knowledge_entries.items():
            if not isinstance(summary_text, str):
                summary_text = json.dumps(summary_text) if summary_text is not None else ""
            interface_hash = hashlib.sha256(summary_text.encode()).hexdigest()[:8]
            data["entries"][filepath] = {
                "type": "file",
                "owner_task": task_id,
                "summary": summary_text,
                "interface_hash": interface_hash,
                "last_modified_by": task_id,
                "last_modified_at": now,
                "written_by": "executor",
            }
        data["last_updated"] = now
        _atomic_write(shard_p, data)
        _update_meta(project_path, shard_name, data)
    finally:
        if fcntl is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
        os.close(fd)
```

**Step 3: Update main() to accept --shard**

In the `main()` function (line 172), add `--shard` argument and route:

```python
parser.add_argument("--shard", default="", help="Shard name (e.g. auth, api). Required when using shard system.")
```

In the PM branch (line 199), add:
```python
if args.shard:
    writer_pm_shard(args.project_path, args.task_id, args.shard, entry_data)
else:
    writer_pm(args.project_path, args.task_id, entry_data)
```

In the executor branch (line 211), add:
```python
if args.shard:
    writer_executor_shard(args.project_path, args.task_id, args.shard, args.final_summary)
else:
    writer_executor(args.project_path, args.task_id, args.final_summary)
```

**Step 4: Add knowledge shard CRUD endpoints to server.js**

In `Rdloop/gui/server.js`, after the existing `GET /api/knowledge` handler (line 2312), add new endpoints. First add helpers:

```javascript
// Knowledge shard helpers
const VALID_SHARD_NAME = /^[a-z0-9_-]+$/;

function getKnowledgeDir() {
  const projectPath = getProjectPath();
  if (!projectPath) return null;
  return path.join(projectPath, '.context', 'knowledge');
}

function readShardFile(shardPath) {
  if (!fs.existsSync(shardPath)) return null;
  try { return JSON.parse(fs.readFileSync(shardPath, 'utf8')); } catch { return null; }
}

function writeShardFileAtomic(shardPath, data) {
  const dir = path.dirname(shardPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = shardPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, shardPath);
}

function updateMeta(knowledgeDir, shardName, shardData) {
  const metaPath = path.join(knowledgeDir, '_meta.json');
  let meta = { version: '1.0', project: '', shards: {} };
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  }
  meta.shards[shardName] = {
    description: shardData.description || '',
    entry_count: Object.keys(shardData.entries || {}).length,
    last_updated: shardData.last_updated || new Date().toISOString()
  };
  writeShardFileAtomic(metaPath, meta);
}
```

Then add the endpoints:

```javascript
// GET /api/knowledge/shards — list all shards from _meta.json
app.get('/api/knowledge/shards', (req, res) => {
  const kdir = getKnowledgeDir();
  if (!kdir) return res.status(404).json({ error: 'project_path not configured' });
  const metaPath = path.join(kdir, '_meta.json');
  if (!fs.existsSync(metaPath)) {
    // Check for legacy knowledge_cache.json
    const projectPath = getProjectPath();
    const legacyPath = path.join(projectPath, '.context', 'knowledge_cache.json');
    if (fs.existsSync(legacyPath)) {
      return res.json({ shards: {}, legacy: true, hint: 'Run migration to convert to shards' });
    }
    return res.json({ shards: {} });
  }
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/knowledge/shards/:shard — entries for one shard
app.get('/api/knowledge/shards/:shard', (req, res) => {
  const shard = req.params.shard;
  if (!VALID_SHARD_NAME.test(shard)) return res.status(400).json({ error: 'Invalid shard name' });
  const kdir = getKnowledgeDir();
  if (!kdir) return res.status(404).json({ error: 'project_path not configured' });
  const shardPath = path.join(kdir, shard + '.json');
  const data = readShardFile(shardPath);
  if (!data) return res.status(404).json({ error: 'Shard not found: ' + shard });
  res.json(data);
});

// POST /api/knowledge/shards — create new shard
app.post('/api/knowledge/shards', requireWritable, (req, res) => {
  const { name, description } = req.body || {};
  if (!name || !VALID_SHARD_NAME.test(name)) return res.status(400).json({ error: 'Invalid shard name (lowercase alphanumeric, underscore, hyphen)' });
  const kdir = getKnowledgeDir();
  if (!kdir) return res.status(404).json({ error: 'project_path not configured' });
  if (!fs.existsSync(kdir)) fs.mkdirSync(kdir, { recursive: true });
  const shardPath = path.join(kdir, name + '.json');
  if (fs.existsSync(shardPath)) return res.status(409).json({ error: 'Shard already exists' });
  const data = {
    version: '1.0', shard: name, description: description || '',
    last_updated: new Date().toISOString(), entries: {}
  };
  writeShardFileAtomic(shardPath, data);
  updateMeta(kdir, name, data);
  res.json({ ok: true, shard: name });
});

// PUT /api/knowledge/shards/:shard — update shard metadata
app.put('/api/knowledge/shards/:shard', requireWritable, (req, res) => {
  const shard = req.params.shard;
  if (!VALID_SHARD_NAME.test(shard)) return res.status(400).json({ error: 'Invalid shard name' });
  const kdir = getKnowledgeDir();
  if (!kdir) return res.status(404).json({ error: 'project_path not configured' });
  const shardPath = path.join(kdir, shard + '.json');
  const data = readShardFile(shardPath);
  if (!data) return res.status(404).json({ error: 'Shard not found' });
  if (req.body.description !== undefined) data.description = req.body.description;
  data.last_updated = new Date().toISOString();
  writeShardFileAtomic(shardPath, data);
  updateMeta(kdir, shard, data);
  res.json({ ok: true });
});

// PUT /api/knowledge/shards/:shard/entries/:key — create/update entry
app.put('/api/knowledge/shards/:shard/entries/:key', requireWritable, (req, res) => {
  const shard = req.params.shard;
  const key = decodeURIComponent(req.params.key);
  if (!VALID_SHARD_NAME.test(shard)) return res.status(400).json({ error: 'Invalid shard name' });
  if (!key) return res.status(400).json({ error: 'Missing entry key' });
  const kdir = getKnowledgeDir();
  if (!kdir) return res.status(404).json({ error: 'project_path not configured' });
  const shardPath = path.join(kdir, shard + '.json');
  let data = readShardFile(shardPath);
  if (!data) return res.status(404).json({ error: 'Shard not found' });
  const entry = req.body || {};
  data.entries[key] = entry;
  data.last_updated = new Date().toISOString();
  writeShardFileAtomic(shardPath, data);
  updateMeta(kdir, shard, data);
  res.json({ ok: true, key });
});

// DELETE /api/knowledge/shards/:shard/entries/:key — delete entry
app.delete('/api/knowledge/shards/:shard/entries/:key', requireWritable, (req, res) => {
  const shard = req.params.shard;
  const key = decodeURIComponent(req.params.key);
  if (!VALID_SHARD_NAME.test(shard)) return res.status(400).json({ error: 'Invalid shard name' });
  const kdir = getKnowledgeDir();
  if (!kdir) return res.status(404).json({ error: 'project_path not configured' });
  const shardPath = path.join(kdir, shard + '.json');
  let data = readShardFile(shardPath);
  if (!data) return res.status(404).json({ error: 'Shard not found' });
  delete data.entries[key];
  data.last_updated = new Date().toISOString();
  writeShardFileAtomic(shardPath, data);
  updateMeta(kdir, shard, data);
  res.json({ ok: true });
});

// DELETE /api/knowledge/shards/:shard — delete entire shard
app.delete('/api/knowledge/shards/:shard', requireWritable, (req, res) => {
  const shard = req.params.shard;
  if (!VALID_SHARD_NAME.test(shard)) return res.status(400).json({ error: 'Invalid shard name' });
  const kdir = getKnowledgeDir();
  if (!kdir) return res.status(404).json({ error: 'project_path not configured' });
  const shardPath = path.join(kdir, shard + '.json');
  if (fs.existsSync(shardPath)) fs.unlinkSync(shardPath);
  // Remove from _meta.json
  const metaPath = path.join(kdir, '_meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      delete meta.shards[shard];
      writeShardFileAtomic(metaPath, meta);
    } catch {}
  }
  res.json({ ok: true });
});
```

**Step 5: Verify API with curl**

```bash
# Start server
cd Rdloop/gui && npm start &

# Create a test shard
curl -X POST http://localhost:17333/api/knowledge/shards \
  -H 'Content-Type: application/json' \
  -d '{"name":"test","description":"Test shard"}'
# Expected: {"ok":true,"shard":"test"}

# List shards
curl http://localhost:17333/api/knowledge/shards
# Expected: {"version":"1.0","project":"...","shards":{"test":{...}}}

# Add entry
curl -X PUT http://localhost:17333/api/knowledge/shards/test/entries/src%2Fmain.py \
  -H 'Content-Type: application/json' \
  -d '{"type":"file","summary":"Main entry point","written_by":"executor"}'
# Expected: {"ok":true,"key":"src/main.py"}

# Read shard
curl http://localhost:17333/api/knowledge/shards/test
# Expected: entries with src/main.py

# Delete entry
curl -X DELETE http://localhost:17333/api/knowledge/shards/test/entries/src%2Fmain.py
# Expected: {"ok":true}

# Delete shard
curl -X DELETE http://localhost:17333/api/knowledge/shards/test
# Expected: {"ok":true}
```

**Step 6: Commit**

```bash
git add Agent/.context/tools/write_knowledge_cache.py Rdloop/gui/server.js
git commit -m "feat: knowledge shard backend — write_knowledge_cache.py --shard + CRUD API"
```

---

### Task 3: Knowledge Shard Migration Script

**Files:**
- Create: `Agent/.context/tools/migrate_knowledge_cache.py`

**Step 1: Write migration script**

Create `Agent/.context/tools/migrate_knowledge_cache.py`:

```python
#!/usr/bin/env python3
"""
migrate_knowledge_cache.py — One-time migration from single knowledge_cache.json
to module-based shard files under .context/knowledge/.
Groups entries by file path prefix heuristic. Entries that can't be grouped
go into a 'default' shard.
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

def infer_shard(key: str) -> str:
    """Infer shard name from entry key. task:* entries use 'tasks' shard."""
    if key.startswith("task:"):
        return "tasks"
    parts = key.replace("\\", "/").split("/")
    if len(parts) >= 2:
        return parts[0].lower().replace(".", "_").replace("-", "_")
    return "default"

def migrate(project_path: str, dry_run: bool = False) -> dict:
    base = os.path.abspath(project_path)
    cache_path = os.path.join(base, ".context", "knowledge_cache.json")
    knowledge_dir = os.path.join(base, ".context", "knowledge")

    if not os.path.isfile(cache_path):
        print(f"No knowledge_cache.json found at {cache_path}", file=sys.stderr)
        return {"migrated": 0}

    if os.path.isdir(knowledge_dir) and os.listdir(knowledge_dir):
        print(f"Knowledge dir already exists and is non-empty: {knowledge_dir}", file=sys.stderr)
        return {"migrated": 0, "skipped": True}

    with open(cache_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    entries = data.get("entries", {})
    project_name = data.get("project", os.path.basename(base))

    # Group entries by inferred shard
    shards = defaultdict(dict)
    for key, entry in entries.items():
        shard_name = infer_shard(key)
        shards[shard_name][key] = entry

    if dry_run:
        print("Dry run — would create shards:")
        for name, ents in sorted(shards.items()):
            print(f"  {name}.json: {len(ents)} entries")
        return {"migrated": len(entries), "shards": list(shards.keys()), "dry_run": True}

    os.makedirs(knowledge_dir, exist_ok=True)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    meta = {"version": "1.0", "project": project_name, "shards": {}}

    for shard_name, ents in shards.items():
        shard_data = {
            "version": "1.0",
            "shard": shard_name,
            "description": f"Auto-migrated from knowledge_cache.json ({len(ents)} entries)",
            "last_updated": now,
            "entries": ents,
        }
        shard_path = os.path.join(knowledge_dir, shard_name + ".json")
        with open(shard_path, "w", encoding="utf-8") as f:
            json.dump(shard_data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        meta["shards"][shard_name] = {
            "description": shard_data["description"],
            "entry_count": len(ents),
            "last_updated": now,
        }

    meta_path = os.path.join(knowledge_dir, "_meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # Rename original
    bak_path = cache_path + ".bak"
    os.rename(cache_path, bak_path)
    print(f"Migrated {len(entries)} entries into {len(shards)} shards.")
    print(f"Original backed up to {bak_path}")

    return {"migrated": len(entries), "shards": list(shards.keys())}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("project_path", help="Project root path")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done without writing")
    args = parser.parse_args()
    result = migrate(args.project_path, args.dry_run)
    print(json.dumps(result, indent=2))
```

**Step 2: Test with dry run**

```bash
# If a test project with knowledge_cache.json exists:
python3 Agent/.context/tools/migrate_knowledge_cache.py /path/to/test/project --dry-run
# Expected: list of shards that would be created
```

**Step 3: Commit**

```bash
git add Agent/.context/tools/migrate_knowledge_cache.py
git commit -m "feat: knowledge shard migration script"
```

---

### Task 4: Knowledge GUI (Settings Section + Viewer Modal)

**Files:**
- Modify: `Rdloop/gui/public/app.js:91-225` (openSettingsPanel — add knowledge section)
- Modify: `Rdloop/gui/public/app.js` (add knowledge viewer modal functions)
- Modify: `Rdloop/gui/public/style.css` (knowledge viewer styles)

**Step 1: Add knowledge section to settings panel**

In `Rdloop/gui/public/app.js`, inside `openSettingsPanel()`, after the WezTerm checkbox section (after line 180), insert a new knowledge agent section in the modal HTML string:

```javascript
<div style="margin-bottom:12px">
  <details>
    <summary class="form-label" style="cursor:pointer">Knowledge Agent</summary>
    <div style="margin-top:8px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
      <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px">
        <input type="checkbox" id="settings-knowledge-enabled" ${cfg.knowledge_enabled ? 'checked' : ''}>
        <span>Enable knowledge agent</span>
      </label>
      <div style="margin-bottom:8px">
        <label class="form-label" style="font-size:11px">Provider</label>
        <select id="settings-knowledge-provider" class="form-select" style="width:auto">
          ${['codex','gemini','claude','opencode'].map(p => '<option value="'+p+'" '+(cfg.knowledge_provider===p?'selected':'')+'>'+p+'</option>').join('')}
        </select>
      </div>
      <div style="margin-bottom:8px">
        <label class="form-label" style="font-size:11px">Project path</label>
        <input type="text" id="settings-knowledge-project" class="form-input" value="${escapeHtml(cfg.knowledge_project_path || cfg.ccb_work_dir || '')}" placeholder="/path/to/project" style="width:100%">
      </div>
      <button type="button" class="btn" onclick="openKnowledgeViewer()" style="font-size:12px">View Knowledge</button>
    </div>
  </details>
</div>
```

**Step 2: Include knowledge settings in submitSettings()**

In `submitSettings()` (around line 327), add the knowledge fields to the config payload:

```javascript
const knowledgeEnabled = document.getElementById('settings-knowledge-enabled')?.checked || false;
const knowledgeProvider = document.getElementById('settings-knowledge-provider')?.value || 'codex';
const knowledgeProject = (document.getElementById('settings-knowledge-project')?.value || '').trim();
```

Add to the PUT /api/config body:
```javascript
knowledge_enabled: knowledgeEnabled,
knowledge_provider: knowledgeProvider,
knowledge_project_path: knowledgeProject,
```

**Step 3: Add knowledge viewer modal**

Add new functions at the end of app.js (before DOMContentLoaded or after all other functions):

```javascript
// Knowledge Viewer Modal
let currentKnowledgeShard = null;

async function openKnowledgeViewer() {
  const old = document.getElementById('knowledge-modal');
  if (old) old.remove();

  const modalHtml = `
    <div id="knowledge-modal" class="modal-overlay" onclick="if(event.target===this)closeKnowledgeViewer()">
      <div class="modal-box" style="max-width:900px;max-height:90vh;overflow:hidden;display:flex;flex-direction:column">
        <h3 style="margin-top:0;flex-shrink:0">Knowledge Viewer</h3>
        <div style="display:flex;flex:1;gap:12px;overflow:hidden;min-height:0">
          <div id="knowledge-shard-list" style="width:180px;flex-shrink:0;overflow-y:auto;border-right:1px solid #30363d;padding-right:12px">
            <div style="color:#8b949e;font-size:12px">Loading shards...</div>
          </div>
          <div id="knowledge-entry-panel" style="flex:1;overflow-y:auto">
            <div style="color:#8b949e;font-size:12px">Select a shard to view entries.</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-shrink:0">
          <button class="btn" onclick="closeKnowledgeViewer()">Close</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  await loadKnowledgeShardList();
}

function closeKnowledgeViewer() {
  const m = document.getElementById('knowledge-modal');
  if (m) m.remove();
}

async function loadKnowledgeShardList() {
  const wrap = document.getElementById('knowledge-shard-list');
  if (!wrap) return;
  try {
    const data = await api('/knowledge/shards');
    const shards = data.shards || {};
    const names = Object.keys(shards).sort();
    if (names.length === 0 && data.legacy) {
      wrap.innerHTML = '<div style="font-size:12px;color:#d29922">Legacy knowledge_cache.json found. Run migration to use shards.</div>';
      return;
    }
    if (names.length === 0) {
      wrap.innerHTML = '<div style="font-size:12px;color:#8b949e">No shards yet.</div>';
    } else {
      wrap.innerHTML = names.map(n => {
        const s = shards[n];
        return '<div class="knowledge-shard-item" data-shard="'+escapeHtml(n)+'" onclick="selectKnowledgeShard(\''+escapeHtml(n)+'\')" style="padding:6px 8px;cursor:pointer;border-radius:4px;margin-bottom:4px;font-size:13px'+(currentKnowledgeShard===n?';background:#30363d':'')+'">'+escapeHtml(n)+' <span style="color:#8b949e;font-size:11px">('+escapeHtml(String(s.entry_count || 0))+')</span></div>';
      }).join('');
    }
    wrap.innerHTML += '<div style="margin-top:8px"><button class="btn write-action" style="font-size:11px;width:100%" onclick="createKnowledgeShard()">+ New Shard</button></div>';
  } catch (e) {
    wrap.innerHTML = '<div style="font-size:12px;color:#f85149">'+escapeHtml(e?.message || 'Failed')+'</div>';
  }
}

async function selectKnowledgeShard(name) {
  currentKnowledgeShard = name;
  await loadKnowledgeShardList(); // refresh highlight
  const panel = document.getElementById('knowledge-entry-panel');
  if (!panel) return;
  panel.innerHTML = '<div style="color:#8b949e;font-size:12px">Loading...</div>';
  try {
    const data = await api('/knowledge/shards/' + encodeURIComponent(name));
    const entries = data.entries || {};
    const keys = Object.keys(entries).sort();
    let html = '<div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between"><strong>'+escapeHtml(name)+'</strong> <span style="font-size:11px;color:#8b949e">'+escapeHtml(data.description||'')+'</span></div>';
    if (keys.length === 0) {
      html += '<div style="color:#8b949e;font-size:12px">No entries.</div>';
    } else {
      html += '<table style="width:100%;font-size:12px;border-collapse:collapse">';
      html += '<thead><tr><th style="text-align:left;padding:4px;border-bottom:1px solid #30363d">Key</th><th style="text-align:left;padding:4px;border-bottom:1px solid #30363d">Type</th><th style="text-align:left;padding:4px;border-bottom:1px solid #30363d">Summary</th><th style="padding:4px;border-bottom:1px solid #30363d;width:40px"></th></tr></thead><tbody>';
      for (const k of keys) {
        const e = entries[k];
        html += '<tr data-key="'+escapeHtml(k)+'">';
        html += '<td style="padding:4px;font-family:monospace;font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+escapeHtml(k)+'">'+escapeHtml(k)+'</td>';
        html += '<td style="padding:4px">'+escapeHtml(e.type||'')+'</td>';
        html += '<td style="padding:4px;cursor:pointer" onclick="editKnowledgeEntry(\''+escapeHtml(name)+'\',\''+escapeHtml(k)+'\')" title="Click to edit">'+escapeHtml((e.summary||'').slice(0,120))+'</td>';
        html += '<td style="padding:4px"><button class="btn btn-danger write-action" style="padding:1px 6px;font-size:10px" onclick="deleteKnowledgeEntry(\''+escapeHtml(name)+'\',\''+escapeHtml(k)+'\')">x</button></td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '<div style="margin-top:8px;display:flex;gap:8px"><button class="btn write-action" style="font-size:11px" onclick="addKnowledgeEntry(\''+escapeHtml(name)+'\')">+ Add Entry</button>';
    html += '<button class="btn btn-danger write-action" style="font-size:11px" onclick="deleteKnowledgeShard(\''+escapeHtml(name)+'\')">Delete Shard</button></div>';
    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = '<div style="color:#f85149;font-size:12px">'+escapeHtml(e?.message||'Failed')+'</div>';
  }
}

async function createKnowledgeShard() {
  const name = prompt('Shard name (lowercase, alphanumeric, underscore, hyphen):');
  if (!name || !/^[a-z0-9_-]+$/.test(name)) { if (name) alert('Invalid name'); return; }
  const desc = prompt('Description (optional):') || '';
  try {
    await fetch('/api/knowledge/shards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: desc }) });
    await loadKnowledgeShardList();
    selectKnowledgeShard(name);
  } catch (e) { alert(e?.message || 'Failed'); }
}

async function deleteKnowledgeShard(name) {
  if (!confirm('Delete shard "'+name+'" and all its entries?')) return;
  try {
    await fetch('/api/knowledge/shards/' + encodeURIComponent(name), { method: 'DELETE' });
    currentKnowledgeShard = null;
    await loadKnowledgeShardList();
    document.getElementById('knowledge-entry-panel').innerHTML = '<div style="color:#8b949e;font-size:12px">Select a shard.</div>';
  } catch (e) { alert(e?.message || 'Failed'); }
}

async function addKnowledgeEntry(shardName) {
  const key = prompt('Entry key (e.g. src/auth.py or task:T01):');
  if (!key) return;
  const type = prompt('Type (file or task):', 'file') || 'file';
  const summary = prompt('Summary:') || '';
  try {
    await fetch('/api/knowledge/shards/' + encodeURIComponent(shardName) + '/entries/' + encodeURIComponent(key), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, summary, written_by: 'manual', last_modified_at: new Date().toISOString() })
    });
    selectKnowledgeShard(shardName);
  } catch (e) { alert(e?.message || 'Failed'); }
}

async function editKnowledgeEntry(shardName, key) {
  const data = await api('/knowledge/shards/' + encodeURIComponent(shardName));
  const entry = (data.entries || {})[key];
  if (!entry) { alert('Entry not found'); return; }
  const summary = prompt('Edit summary:', entry.summary || '');
  if (summary === null) return;
  entry.summary = summary;
  entry.last_modified_at = new Date().toISOString();
  try {
    await fetch('/api/knowledge/shards/' + encodeURIComponent(shardName) + '/entries/' + encodeURIComponent(key), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry)
    });
    selectKnowledgeShard(shardName);
  } catch (e) { alert(e?.message || 'Failed'); }
}

async function deleteKnowledgeEntry(shardName, key) {
  if (!confirm('Delete entry "'+key+'"?')) return;
  try {
    await fetch('/api/knowledge/shards/' + encodeURIComponent(shardName) + '/entries/' + encodeURIComponent(key), { method: 'DELETE' });
    selectKnowledgeShard(shardName);
  } catch (e) { alert(e?.message || 'Failed'); }
}
```

**Step 4: Verify in browser**

1. Open GUI at localhost:17333
2. Settings → Knowledge Agent section visible
3. Click "View Knowledge" → modal opens
4. Create shard, add entry, edit entry, delete entry, delete shard all work

**Step 5: Commit**

```bash
git add Rdloop/gui/public/app.js Rdloop/gui/public/style.css
git commit -m "feat: knowledge GUI — settings section + viewer modal with CRUD"
```

---

### Task 5: Single Flow Adapter (call_coder_cliproxy.sh)

**Files:**
- Create: `Rdloop/coordinator/lib/call_coder_cliproxy.sh`
- Create: `Rdloop/coordinator/lib/call_judge_cliproxy.sh`

**Step 1: Create call_coder_cliproxy.sh**

Reference existing adapter pattern from `call_coder_ccb.sh`. The cliproxy adapter makes a direct LLM API call via the CLI proxy.

Create `Rdloop/coordinator/lib/call_coder_cliproxy.sh`:

```bash
#!/usr/bin/env bash
# call_coder_cliproxy.sh — Single Flow adapter (LLM API call, no coding agent)
# Makes a one-shot LLM call via CLI proxy API. No file I/O, no tool use.

task_json="$1"; attempt_dir="$2"; worktree_dir="$3"; instruction_path="$4"
mkdir -p "${attempt_dir}/coder"

run_log="${attempt_dir}/coder/run.log"
output_file="${attempt_dir}/coder/stdout.log"

timeout_s=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('coder_timeout_seconds',600))
except: print(600)
" 2>/dev/null || echo "600")

coder_model="${CODER_MODEL:-}"
instruction=$(cat "$instruction_path" 2>/dev/null || echo "")

# Resolve CLI proxy endpoint from cliapi_providers.json
RDLOOP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIAPI_CONFIG="${RDLOOP_ROOT}/config/cliapi_providers.json"

base_url=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('$CLIAPI_CONFIG'))
    providers = cfg.get('providers', {})
    # Find provider that has the model
    model = '${coder_model}'
    for name, p in providers.items():
        models = p.get('models', [])
        if isinstance(models, list):
            model_ids = [m.get('id','') if isinstance(m,dict) else str(m) for m in models]
        else:
            model_ids = []
        if model in model_ids or not model:
            print(p.get('base_url', 'http://127.0.0.1:8317/v1'))
            sys.exit(0)
    print('http://127.0.0.1:8317/v1')
except: print('http://127.0.0.1:8317/v1')
" 2>/dev/null || echo "http://127.0.0.1:8317/v1")

{
  echo "[CODER][single/cliproxy] $(date -u +%Y-%m-%dT%H:%M:%SZ) LLM API call"
  echo "[CODER][single/cliproxy] model=${coder_model} timeout=${timeout_s}s"
  echo "[CODER][single/cliproxy] base_url=${base_url}"

  # Make LLM API call via curl
  response=$(timeout "$timeout_s" curl -s -X POST "${base_url}/chat/completions" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json, sys
msg = sys.stdin.read()
payload = {
    'model': '${coder_model}' or 'default',
    'messages': [{'role': 'user', 'content': msg}],
    'max_tokens': 8192,
    'temperature': 0.7
}
print(json.dumps(payload))
" <<< "$instruction")" 2>&1)

  rc=$?
  if [ "$rc" = "124" ]; then
    echo "[CODER][single/cliproxy] TIMEOUT after ${timeout_s}s"
    echo "TIMEOUT" >> "$run_log"
  fi

  # Extract content from response
  python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    print(content)
except Exception as e:
    print(f'Error parsing response: {e}', file=sys.stderr)
    print(sys.stdin.read() if hasattr(sys.stdin, 'read') else '')
" <<< "$response" > "$output_file" 2>&1

  echo "[CODER][single/cliproxy] $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
} > "$run_log" 2>&1

echo "$rc" > "${attempt_dir}/coder/rc.txt"
exit "${rc:-0}"
```

**Step 2: Create call_judge_cliproxy.sh**

Same pattern but for judge evaluation. Create `Rdloop/coordinator/lib/call_judge_cliproxy.sh`:

```bash
#!/usr/bin/env bash
# call_judge_cliproxy.sh — Single Flow judge adapter (LLM API call)
# Evaluates coder output against acceptance criteria via LLM API.

task_json="$1"; attempt_dir="$2"; worktree_dir="$3"
mkdir -p "${attempt_dir}/judge"

run_log="${attempt_dir}/judge/run.log"
output_file="${attempt_dir}/judge/stdout.log"
verdict_file="${attempt_dir}/judge/verdict.json"

timeout_s=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('judge_timeout_seconds',300))
except: print(300)
" 2>/dev/null || echo "300")

judge_model="${JUDGE_MODEL:-}"

# Build judge prompt from coder output + acceptance criteria
coder_output=$(cat "${attempt_dir}/coder/stdout.log" 2>/dev/null || echo "(no coder output)")
goal=$(python3 -c "import json; print(json.load(open('$task_json')).get('goal',''))" 2>/dev/null || echo "")
acceptance=$(python3 -c "import json; print(json.load(open('$task_json')).get('acceptance',''))" 2>/dev/null || echo "")

judge_prompt="You are a quality judge. Evaluate the following output against the acceptance criteria.

GOAL: ${goal}
ACCEPTANCE CRITERIA: ${acceptance}

CODER OUTPUT:
${coder_output}

Respond with a JSON verdict:
{\"verdict\": \"PASS\" or \"FAIL\", \"score\": 1-10, \"reasoning\": \"...\", \"feedback\": \"...\"}"

RDLOOP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIAPI_CONFIG="${RDLOOP_ROOT}/config/cliapi_providers.json"

base_url=$(python3 -c "
import json
try:
    cfg = json.load(open('$CLIAPI_CONFIG'))
    for name, p in cfg.get('providers', {}).items():
        print(p.get('base_url', 'http://127.0.0.1:8317/v1'))
        break
except: print('http://127.0.0.1:8317/v1')
" 2>/dev/null || echo "http://127.0.0.1:8317/v1")

{
  echo "[JUDGE][single/cliproxy] $(date -u +%Y-%m-%dT%H:%M:%SZ) LLM API call"

  response=$(timeout "$timeout_s" curl -s -X POST "${base_url}/chat/completions" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json, sys
payload = {
    'model': '${judge_model}' or 'default',
    'messages': [{'role': 'user', 'content': sys.stdin.read()}],
    'max_tokens': 4096,
    'temperature': 0.3
}
print(json.dumps(payload))
" <<< "$judge_prompt")" 2>&1)

  rc=$?

  # Extract and write verdict
  python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    print(content)
    # Try to parse as JSON verdict
    import re
    match = re.search(r'\{[^}]*\"verdict\"[^}]*\}', content, re.DOTALL)
    if match:
        verdict = json.loads(match.group())
        json.dump(verdict, open('${verdict_file}', 'w'), indent=2)
    else:
        json.dump({'verdict': 'FAIL', 'score': 0, 'reasoning': 'Could not parse verdict', 'raw': content}, open('${verdict_file}', 'w'), indent=2)
except Exception as e:
    json.dump({'verdict': 'FAIL', 'score': 0, 'reasoning': str(e)}, open('${verdict_file}', 'w'), indent=2)
" <<< "$response" > "$output_file" 2>&1

  echo "[JUDGE][single/cliproxy] $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
} > "$run_log" 2>&1

echo "$rc" > "${attempt_dir}/judge/rc.txt"
exit "${rc:-0}"
```

**Step 3: Make executable and commit**

```bash
chmod +x Rdloop/coordinator/lib/call_coder_cliproxy.sh Rdloop/coordinator/lib/call_judge_cliproxy.sh
git add Rdloop/coordinator/lib/call_coder_cliproxy.sh Rdloop/coordinator/lib/call_judge_cliproxy.sh
git commit -m "feat: single flow adapters — call_coder_cliproxy.sh + call_judge_cliproxy.sh"
```

---

### Task 6: Solo Bridge + Adapter

**Files:**
- Create: `Rdloop/coordinator/lib/solo_bridge.sh`
- Create: `Rdloop/coordinator/lib/call_coder_solo.sh`

**Step 1: Create solo_bridge.sh**

Create `Rdloop/coordinator/lib/solo_bridge.sh` — the bridge process that runs inside a visible tmux pane and dispatches requests to the coding agent:

```bash
#!/usr/bin/env bash
# solo_bridge.sh — Provider-agnostic bridge for solo agent mode
# Runs in visible tmux pane. Coordinator communicates via JSON files.
#
# Usage: solo_bridge.sh <provider> <session_dir> <attempt_dir> [--fresh-per-step]
#
# Protocol:
#   Coordinator writes: <session_dir>/request.json (with newer mtime than response)
#   Bridge detects new request, sends to agent, writes <session_dir>/response.json
#   Coordinator writes: <session_dir>/control.json {"action":"exit"} to terminate

set -euo pipefail

PROVIDER="$1"
SESSION_DIR="$2"
ATTEMPT_DIR="$3"
FRESH_PER_STEP=false
[ "${4:-}" = "--fresh-per-step" ] && FRESH_PER_STEP=true

SESSION_FILE="${SESSION_DIR}/agent.session"
LAST_REQUEST_MTIME=0

echo "[BRIDGE] Started. provider=${PROVIDER} session_dir=${SESSION_DIR} fresh=${FRESH_PER_STEP}"

dispatch_to_agent() {
  local request_file="$1"
  local response_file="$2"
  local step_log="$3"

  local instruction
  instruction=$(python3 -c "import json; print(json.load(open('${request_file}')).get('instruction',''))" 2>/dev/null || echo "")

  local instruction_file="${SESSION_DIR}/_current_instruction.md"
  echo "$instruction" > "$instruction_file"

  local session_flag=""
  if [ "$FRESH_PER_STEP" = "false" ] && [ -f "$SESSION_FILE" ]; then
    session_flag="--session-file ${SESSION_FILE}"
  fi

  local rc=0
  case "$PROVIDER" in
    claude)
      # Claude CLI: -p for prompt, --cwd for working directory
      local cwd
      cwd=$(python3 -c "import json; print(json.load(open('${SESSION_DIR}/../../../task.json')).get('repo_path','.'))" 2>/dev/null || echo ".")
      set +e
      claude -p "$(cat "$instruction_file")" \
        --cwd "$cwd" \
        --dangerously-skip-permissions \
        --output-format text \
        2>&1 | tee "$step_log" > "${SESSION_DIR}/_raw_output.txt"
      rc=${PIPESTATUS[0]}
      set -e
      ;;
    codex)
      set +e
      codex --prompt "$(cat "$instruction_file")" \
        --auto-edit \
        2>&1 | tee "$step_log" > "${SESSION_DIR}/_raw_output.txt"
      rc=${PIPESTATUS[0]}
      set -e
      ;;
    *)
      echo "[BRIDGE] Unknown provider: ${PROVIDER}" >&2
      echo '{"self_eval":"dead_loop","summary":"Unknown provider: '"${PROVIDER}"'"}' > "$response_file"
      return 1
      ;;
  esac

  # Extract structured JSON from agent output (last JSON block)
  python3 -c "
import json, re, sys

raw = open('${SESSION_DIR}/_raw_output.txt').read()

# Find last JSON block in output
matches = list(re.finditer(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', raw, re.DOTALL))
parsed = None
for m in reversed(matches):
    try:
        candidate = json.loads(m.group())
        if 'self_eval' in candidate or 'step_completed' in candidate:
            parsed = candidate
            break
    except: continue

if parsed is None:
    # Agent didn't produce structured output — wrap raw output
    parsed = {
        'step_completed': 'unknown',
        'self_eval': 'partial' if ${rc} == 0 else 'dead_loop',
        'confidence': 0.5,
        'summary': raw[-500:] if len(raw) > 500 else raw,
        'files_modified': [],
        'issues': [],
        'next_action': 'fix_and_retry',
        'knowledge_entries': {}
    }

json.dump(parsed, open('${response_file}', 'w'), indent=2)
" 2>/dev/null || echo '{"self_eval":"dead_loop","summary":"Failed to parse agent output"}' > "$response_file"
}

# Main loop: watch for new requests
while true; do
  # Check for exit signal
  if [ -f "${SESSION_DIR}/control.json" ]; then
    action=$(python3 -c "import json; print(json.load(open('${SESSION_DIR}/control.json')).get('action',''))" 2>/dev/null || echo "")
    if [ "$action" = "exit" ]; then
      echo "[BRIDGE] Received exit signal."
      break
    fi
  fi

  # Check for new request (request.json newer than response.json)
  if [ -f "${SESSION_DIR}/request.json" ]; then
    req_mtime=$(stat -f%m "${SESSION_DIR}/request.json" 2>/dev/null || stat -c%Y "${SESSION_DIR}/request.json" 2>/dev/null || echo 0)
    resp_mtime=0
    [ -f "${SESSION_DIR}/response.json" ] && resp_mtime=$(stat -f%m "${SESSION_DIR}/response.json" 2>/dev/null || stat -c%Y "${SESSION_DIR}/response.json" 2>/dev/null || echo 0)

    if [ "$req_mtime" -gt "$resp_mtime" ] && [ "$req_mtime" -ne "$LAST_REQUEST_MTIME" ]; then
      LAST_REQUEST_MTIME="$req_mtime"
      iteration=$(python3 -c "import json; print(json.load(open('${SESSION_DIR}/request.json')).get('iteration',0))" 2>/dev/null || echo "0")
      step_dir="${SESSION_DIR}/step_$(printf '%03d' "$iteration")"
      mkdir -p "$step_dir"

      echo "[BRIDGE] Processing request iteration=${iteration}"
      dispatch_to_agent "${SESSION_DIR}/request.json" "${SESSION_DIR}/response.json" "${step_dir}/agent.log"
      echo "[BRIDGE] Response written for iteration=${iteration}"
    fi
  fi

  sleep 2
done

echo "[BRIDGE] Exiting."
```

**Step 2: Create call_coder_solo.sh**

Use the code from the design doc section 3.9. Create `Rdloop/coordinator/lib/call_coder_solo.sh` with the full coordinator-agent loop logic as specified in the design doc (lines 488-681).

The script is already fully specified in the design doc. Copy it as-is, ensuring:
- The `json_read` function is available (it's defined in run_task.sh and exported)
- `COORDINATOR_LIB` env var points to the lib directory
- Shebang is `#!/usr/bin/env bash`

**Step 3: Make executable and commit**

```bash
chmod +x Rdloop/coordinator/lib/solo_bridge.sh Rdloop/coordinator/lib/call_coder_solo.sh
git add Rdloop/coordinator/lib/solo_bridge.sh Rdloop/coordinator/lib/call_coder_solo.sh
git commit -m "feat: solo agent adapter — solo_bridge.sh + call_coder_solo.sh"
```

---

### Task 7: Solo Decision Logic (decision_solo.py)

**Files:**
- Create: `Rdloop/coordinator/lib/decision_solo.py`

**Step 1: Create decision_solo.py**

Use the code from design doc section 3.10 (lines 687-743). Copy as-is.

**Step 2: Test with sample input**

```bash
echo '{"self_eval":"partial","confidence":0.6,"test_result":{"passed":3,"total":5}}' > /tmp/test_response.json
python3 Rdloop/coordinator/lib/decision_solo.py \
  --response /tmp/test_response.json \
  --iteration 2 --max-iterations 10 \
  --approval-mode agent_decides \
  --auto-pass-threshold 0.85
# Expected: {"action": "CONTINUE", "reason": "continuing to next iteration"}

echo '{"self_eval":"goal_met","confidence":0.95}' > /tmp/test_response2.json
python3 Rdloop/coordinator/lib/decision_solo.py \
  --response /tmp/test_response2.json \
  --iteration 3 --max-iterations 10
# Expected: {"action": "READY_FOR_REVIEW", "reason": "agent reports goal met"}
```

**Step 3: Commit**

```bash
git add Rdloop/coordinator/lib/decision_solo.py
git commit -m "feat: solo decision logic — deterministic coordinator decisions"
```

---

### Task 8: Coordinator Routing (run_task.sh)

**Files:**
- Modify: `Rdloop/coordinator/run_task.sh:1000-1008` (execution_mode routing)

**Step 1: Add workflow_mode routing before execution_mode**

At line 1000, before the `execution_mode` block, insert `workflow_mode` routing that takes precedence:

```bash
  # workflow_mode (v4.0): takes precedence over execution_mode
  local workflow_mode; workflow_mode=$(json_read "$TASK_JSON" "workflow_mode" "")
  if [ -n "$workflow_mode" ]; then
    case "$workflow_mode" in
      single)
        coder_type="cliproxy"
        local judge_enabled_flag; judge_enabled_flag=$(json_read "$TASK_JSON" "judge_enabled" "true")
        if [ "$judge_enabled_flag" = "false" ]; then
          judge_type="none"
        else
          judge_type="cliproxy"
        fi
        ;;
      solo)
        coder_type="solo"
        judge_type="none"  # agent self-reviews
        ;;
      collab)
        coder_type="ccb"
        judge_type="ccb"
        ;;
    esac
  else
    # Legacy: execution_mode routing (v3.0)
    local execution_mode; execution_mode=$(json_read "$TASK_JSON" "execution_mode" "auto")
    if [ "$execution_mode" = "auto" ]; then
      coder_type="bridge"
      judge_type="bridge"
    elif [ "$execution_mode" = "semi-auto" ]; then
      coder_type="ccb"
      judge_type="ccb"
    fi
  fi
```

**Step 2: Handle judge_type="none" in the judge invocation**

Find where the judge is called (around line 1110+). Add a check:

```bash
  # Skip judge if judge_type is "none" (solo mode, or judge_enabled=false)
  if [ "$judge_type" = "none" ]; then
    # Auto-PASS: use coder exit code as verdict
    if [ "$coder_rc" = "0" ]; then
      echo '{"verdict":"PASS","score":8,"reasoning":"Solo mode auto-pass (coder exit 0)"}' > "${att_dir}/judge/verdict.json"
    elif [ "$coder_rc" = "2" ]; then
      echo '{"verdict":"NEED_USER_INPUT","score":0,"reasoning":"Agent requested user input"}' > "${att_dir}/judge/verdict.json"
    else
      echo '{"verdict":"FAIL","score":3,"reasoning":"Coder exited with non-zero: '"$coder_rc"'"}' > "${att_dir}/judge/verdict.json"
    fi
  else
    # Existing judge invocation
    ...
  fi
```

**Step 3: Add solo-specific worktree handling**

For `workflow_mode=single` without `repo_path`, skip worktree creation. Find the worktree setup section and add:

```bash
  # Single flow: skip worktree if no repo_path
  if [ "$workflow_mode" = "single" ]; then
    local repo_path_check; repo_path_check=$(json_read "$TASK_JSON" "repo_path" "")
    if [ -z "$repo_path_check" ] || [ "$repo_path_check" = "dummy_repo" ]; then
      wt="${TASK_DIR}"
      mkdir -p "$wt"
      # Skip git worktree — write directly to task dir
    else
      # Normal worktree setup
      ...
    fi
  fi
```

**Step 4: Export COORDINATOR_LIB for solo adapter**

Near the top of run_task.sh where env vars are set, add:

```bash
export COORDINATOR_LIB="$(cd "$(dirname "$0")/lib" && pwd)"
```

**Step 5: Commit**

```bash
git add Rdloop/coordinator/run_task.sh
git commit -m "feat: coordinator routing — workflow_mode (single/solo/collab)"
```

---

### Task 9: Three-Mode New/Edit Modal (app.js)

**Files:**
- Modify: `Rdloop/gui/public/app.js:2278-2530` (openNewSpecModal)
- Modify: `Rdloop/gui/public/app.js:2762+` (openEditSpecModal)
- Modify: `Rdloop/gui/public/app.js:2582+` (saveNewSpec)

This is the largest task. The modal needs to be refactored to:
1. Add workflow mode toggle at top
2. Merge template + task_type into single "Type" dropdown
3. Show/hide sections based on mode
4. Add solo-specific fields (loop config, knowledge, observation)
5. Filter adapter options by mode (LLM API only for single, coding agent for solo, CCB for collab)

**Step 1: Add workflow mode toggle and merged type selector**

Replace the existing Template + Task Type dropdowns (lines 2364-2390) with:

```javascript
<div style="margin-bottom:12px">
  <label class="form-label">Workflow Mode</label>
  <div style="display:flex;gap:8px;margin-top:6px">
    <button type="button" class="btn ${defaultWorkflowMode === 'single' ? 'btn-primary' : ''}" id="mode-btn-single" onclick="setWorkflowMode('single')">Single Flow</button>
    <button type="button" class="btn ${defaultWorkflowMode === 'solo' ? 'btn-primary' : ''}" id="mode-btn-solo" onclick="setWorkflowMode('solo')">Solo Agent</button>
    <button type="button" class="btn ${defaultWorkflowMode === 'collab' ? 'btn-primary' : ''}" id="mode-btn-collab" onclick="setWorkflowMode('collab')">Collab</button>
  </div>
</div>

<div style="margin-bottom:12px">
  <label class="form-label">Type</label>
  <select id="modal-type" class="form-select" onchange="onTypeChange(); syncFormToJson()">
    <option value="requirements_doc">Requirements Doc</option>
    <option value="engineering_impl">Engineering Implementation</option>
    <option value="douyin_script">Douyin Script</option>
    <option value="storyboard">Storyboard</option>
    <option value="paid_mini_drama">Paid Mini Drama</option>
    <option value="custom">Custom (blank)</option>
  </select>
</div>
```

Where `defaultWorkflowMode` is derived from the existing `execution_mode` config or defaults to `'solo'`:

```javascript
// Before the modal HTML string, compute default mode from execution_mode
const executionMode = cfg.execution_mode || 'auto';
const defaultWorkflowMode = executionMode === 'semi-auto' ? 'collab' : 'solo';
```

**Step 2: Add setWorkflowMode() function**

Add this function before `openNewSpecModal()` or after `closeModal()`:

```javascript
let _currentWorkflowMode = 'solo';

function setWorkflowMode(mode) {
  _currentWorkflowMode = mode;
  // Update toggle button highlights
  ['single', 'solo', 'collab'].forEach(m => {
    const btn = document.getElementById('mode-btn-' + m);
    if (btn) {
      btn.classList.toggle('btn-primary', m === mode);
    }
  });

  // Show/hide sections based on mode
  const showIf = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  };

  // Section visibility matrix:
  //              single   solo    collab
  // provider     yes      yes     no
  // collab-cfg   no       no      yes
  // repo-git     no       yes     yes
  // loop-config  no       yes     no
  // knowledge    no       yes     yes
  // observation  no       yes     no
  // acceptance   yes      no      yes
  // channel-type no       no      no (hidden — mode determines adapter)
  // exec-mode    no       no      no (hidden — replaced by workflow_mode)

  showIf('section-provider', mode !== 'collab');
  showIf('collab-config-wrap', mode === 'collab');
  showIf('section-repo-git', mode !== 'single');
  showIf('section-loop-config', mode === 'solo');
  showIf('section-knowledge', mode !== 'single');
  showIf('section-observation', mode === 'solo');
  showIf('section-acceptance', mode !== 'solo');
  showIf('section-channel-type', false);  // always hidden
  showIf('section-execution-mode', false); // always hidden
  showIf('section-adapter-grid', mode !== 'solo'); // solo: auto-selected

  // Update adapter options based on mode
  updateAdaptersByMode(mode);
  syncFormToJson();
}

function updateAdaptersByMode(mode) {
  const coderSel = document.getElementById('adapter-coder');
  if (!coderSel) return;

  // Clear and rebuild coder options
  coderSel.innerHTML = '';
  if (mode === 'single') {
    // LLM API providers only
    ['cliproxyapi', 'cursorcliapi'].forEach(v => {
      coderSel.innerHTML += '<option value="' + v + '">' + v + '</option>';
    });
  } else if (mode === 'solo') {
    // Coding agent providers only
    ['claude_cli', 'codex_cli', 'cursor_cli'].forEach(v => {
      coderSel.innerHTML += '<option value="' + v + '">' + v + '</option>';
    });
  } else {
    // Collab: CCB only
    coderSel.innerHTML += '<option value="ccb">ccb</option>';
  }
}
```

**Step 3: Add mode-specific sections to modal HTML**

Wrap existing sections with `id`s and add new solo-specific sections. After the provider/adapter section, add:

```javascript
<!-- Solo: Agent Loop Config -->
<div id="section-loop-config" style="margin-bottom:12px;display:none">
  <label class="form-label">Agent Loop Config</label>
  <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <div>
        <label class="form-label" style="font-size:11px">Max iterations</label>
        <input type="number" id="modal-max-iterations" class="form-input" value="10" min="1" max="100">
      </div>
      <div>
        <label class="form-label" style="font-size:11px">Auto-pass threshold</label>
        <input type="number" id="modal-auto-pass-threshold" class="form-input" value="0.85" min="0" max="1" step="0.05">
      </div>
    </div>
    <div style="margin-bottom:8px">
      <label class="form-label" style="font-size:11px">Test command</label>
      <input type="text" id="modal-test-cmd-solo" class="form-input" placeholder="bash run_tests.sh">
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div>
        <label class="form-label" style="font-size:11px">Approval mode</label>
        <select id="modal-approval-mode" class="form-select">
          <option value="agent_decides">Agent decides when to exit</option>
          <option value="step2step">Step-by-step approval</option>
        </select>
      </div>
      <div>
        <label class="form-label" style="font-size:11px">Session strategy</label>
        <select id="modal-session-strategy" class="form-select">
          <option value="continuous">Continuous session</option>
          <option value="fresh_per_step">Fresh session per step</option>
        </select>
      </div>
    </div>
  </div>
</div>

<!-- Solo: Observation -->
<div id="section-observation" style="margin-bottom:12px;display:none">
  <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
    <input type="checkbox" id="modal-open-terminal" checked>
    <span class="form-label" style="display:inline;margin:0">Open agent terminal on start</span>
  </label>
</div>

<!-- Knowledge section (solo + collab) -->
<div id="section-knowledge" style="margin-bottom:12px;display:none">
  <details>
    <summary class="form-label" style="cursor:pointer">Knowledge Settings</summary>
    <div style="margin-top:8px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
      <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px">
        <input type="checkbox" id="modal-knowledge-enabled" checked>
        <span>Enable knowledge read/write</span>
      </label>
      <div style="margin-bottom:8px">
        <label class="form-label" style="font-size:11px">Project path</label>
        <input type="text" id="modal-knowledge-project" class="form-input" placeholder="/path/to/project">
      </div>
      <div>
        <label class="form-label" style="font-size:11px">Relevant shards (comma-separated)</label>
        <input type="text" id="modal-knowledge-shards" class="form-input" placeholder="auth, api, frontend">
      </div>
    </div>
  </details>
</div>
```

**Step 4: Wrap existing sections with proper IDs**

Add `id` attributes to existing sections:
- Wrap the coder/judge adapter grid in `<div id="section-adapter-grid">`
- Wrap the provider selectors in `<div id="section-provider">`
- Wrap the execution mode dropdown in `<div id="section-execution-mode">`
- Wrap the channel type dropdown in `<div id="section-channel-type">`
- Wrap the repo/git section in `<div id="section-repo-git">`
- Wrap the acceptance section in `<div id="section-acceptance">`

**Step 5: Update saveNewSpec() to include workflow_mode and solo_config**

In `saveNewSpec()` (line 2582), after building the spec object, add workflow_mode fields:

```javascript
// Add workflow_mode to spec
spec.workflow_mode = _currentWorkflowMode;

// Map workflow_mode to execution_mode for backward compat
if (_currentWorkflowMode === 'single') {
  spec.execution_mode = 'auto';
} else if (_currentWorkflowMode === 'solo') {
  spec.execution_mode = 'auto'; // coordinator handles routing via workflow_mode
} else if (_currentWorkflowMode === 'collab') {
  spec.execution_mode = 'semi-auto';
}

// Solo-specific config
if (_currentWorkflowMode === 'solo') {
  spec.solo_config = {
    max_iterations: parseInt(document.getElementById('modal-max-iterations')?.value || '10', 10),
    approval_mode: document.getElementById('modal-approval-mode')?.value || 'agent_decides',
    session_strategy: document.getElementById('modal-session-strategy')?.value || 'continuous',
    auto_pass_threshold: parseFloat(document.getElementById('modal-auto-pass-threshold')?.value || '0.85'),
    knowledge_shards: (document.getElementById('modal-knowledge-shards')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    open_terminal: document.getElementById('modal-open-terminal')?.checked || false
  };
  // Test command goes in spec root
  const testCmd = (document.getElementById('modal-test-cmd-solo')?.value || '').trim();
  if (testCmd) spec.test_cmd = testCmd;
}

// Knowledge settings for solo + collab
if (_currentWorkflowMode !== 'single') {
  const knEnabled = document.getElementById('modal-knowledge-enabled')?.checked;
  if (knEnabled) {
    spec.knowledge_enabled = true;
    spec.knowledge_project_path = (document.getElementById('modal-knowledge-project')?.value || '').trim();
  }
}
```

**Step 6: Update openEditSpecModal() to restore workflow_mode**

In `openEditSpecModal()` (line 2762), after building the edit modal HTML, add workflow mode restoration:

```javascript
// After DOM insertion, restore workflow mode from spec
const editMode = spec.workflow_mode || (spec.execution_mode === 'semi-auto' ? 'collab' : 'solo');
_currentWorkflowMode = editMode;
setWorkflowMode(editMode);

// Restore solo_config fields if present
if (spec.solo_config) {
  const sc = spec.solo_config;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
  setVal('modal-max-iterations', sc.max_iterations || 10);
  setVal('modal-auto-pass-threshold', sc.auto_pass_threshold || 0.85);
  setVal('modal-approval-mode', sc.approval_mode || 'agent_decides');
  setVal('modal-session-strategy', sc.session_strategy || 'continuous');
  setChk('modal-open-terminal', sc.open_terminal !== false);
  if (sc.knowledge_shards) setVal('modal-knowledge-shards', sc.knowledge_shards.join(', '));
}
```

**Step 7: Update server.js validateTaskSpecData() to accept workflow_mode**

In `Rdloop/gui/server.js`, at line 2643 (inside `validateTaskSpecData()`), add `workflow_mode` validation:

```javascript
// After execution_mode validation
if (data.workflow_mode && !['single', 'solo', 'collab'].includes(data.workflow_mode)) {
  return 'Invalid workflow_mode (must be single, solo, or collab)';
}
```

**Step 8: Verify manually**

1. Start GUI: `cd Rdloop/gui && npm start`
2. Click "New TaskSpec" — should show mode toggle at top
3. Toggle between Single/Solo/Collab — sections should show/hide correctly
4. Create a Solo spec with loop config — verify task.json includes `workflow_mode` and `solo_config`
5. Edit the spec — mode should be restored correctly
6. Create a Single spec — verify no repo/git section, has acceptance criteria
7. Create a Collab spec — verify has collab roles, no loop config

**Step 9: Commit**

```bash
git add Rdloop/gui/public/app.js Rdloop/gui/server.js
git commit -m "feat: three-mode new/edit modal — workflow_mode toggle + solo_config fields"
```

---

### Task 10: Solo Progress GUI

**Files:**
- Modify: `Rdloop/gui/server.js` (add solo-steps API endpoint)
- Modify: `Rdloop/gui/public/app.js` (add solo progress panel in attempt view)

**Step 1: Add solo-steps API endpoint to server.js**

After the task spec routes section, add:

```javascript
// GET /api/task/:taskId/attempt/:n/solo-steps — read solo agent step progress
app.get('/api/task/:taskId/attempt/:n/solo-steps', (req, res) => {
  const { taskId, n } = req.params;
  const taskDir = getTaskDir(taskId);
  if (!taskDir) return res.status(404).json({ error: 'Task not found' });

  const attDir = path.join(taskDir, 'attempts', `attempt_${n}`);
  if (!fs.existsSync(attDir)) return res.status(404).json({ error: 'Attempt not found' });

  const soloDir = path.join(attDir, 'solo');
  if (!fs.existsSync(soloDir)) return res.json({ steps: [], mode: 'not_solo' });

  // Read step_NNN directories
  const steps = [];
  const stepDirs = fs.readdirSync(soloDir)
    .filter(d => d.startsWith('step_'))
    .sort();

  for (const stepDir of stepDirs) {
    const stepPath = path.join(soloDir, stepDir);
    const responsePath = path.join(stepPath, 'response.json');
    const agentLogPath = path.join(stepPath, 'agent.log');

    let response = null;
    if (fs.existsSync(responsePath)) {
      try { response = JSON.parse(fs.readFileSync(responsePath, 'utf8')); } catch {}
    }

    const stepNum = parseInt(stepDir.replace('step_', ''), 10);
    steps.push({
      step: stepNum,
      dir: stepDir,
      has_response: !!response,
      self_eval: response?.self_eval || null,
      confidence: response?.confidence || null,
      summary: response?.summary || null,
      test_result: response?.test_result || null,
      files_modified: response?.files_modified || [],
      issues: response?.issues || [],
      next_action: response?.next_action || null,
      has_agent_log: fs.existsSync(agentLogPath),
    });
  }

  // Read current state from control/request files
  const requestPath = path.join(soloDir, 'request.json');
  const responsePath = path.join(soloDir, 'response.json');
  const controlPath = path.join(soloDir, 'control.json');

  let currentIteration = null;
  if (fs.existsSync(requestPath)) {
    try {
      const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
      currentIteration = req.iteration;
    } catch {}
  }

  let bridgeExited = false;
  if (fs.existsSync(controlPath)) {
    try {
      const ctrl = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
      bridgeExited = ctrl.action === 'exit';
    } catch {}
  }

  // Read solo_config from task.json for max_iterations
  let maxIterations = 10;
  const taskJsonPath = path.join(taskDir, 'task.json');
  if (fs.existsSync(taskJsonPath)) {
    try {
      const task = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'));
      maxIterations = task.solo_config?.max_iterations || 10;
    } catch {}
  }

  res.json({
    steps,
    current_iteration: currentIteration,
    max_iterations: maxIterations,
    bridge_exited: bridgeExited,
  });
});
```

**Step 2: Add solo-step approval endpoint**

```javascript
// POST /api/task/:taskId/attempt/:n/solo-proceed — approve paused solo step
app.post('/api/task/:taskId/attempt/:n/solo-proceed', requireWritable, (req, res) => {
  const { taskId, n } = req.params;
  const taskDir = getTaskDir(taskId);
  if (!taskDir) return res.status(404).json({ error: 'Task not found' });

  const soloDir = path.join(taskDir, 'attempts', `attempt_${n}`, 'solo');
  if (!fs.existsSync(soloDir)) return res.status(404).json({ error: 'Solo dir not found' });

  const feedback = req.body?.feedback || '';
  const controlPath = path.join(soloDir, 'control.json');

  // Write proceed signal
  const control = { action: 'proceed', feedback, timestamp: new Date().toISOString() };
  fs.writeFileSync(controlPath, JSON.stringify(control, null, 2) + '\n');

  res.json({ ok: true });
});

// POST /api/task/:taskId/attempt/:n/solo-abort — abort solo agent
app.post('/api/task/:taskId/attempt/:n/solo-abort', requireWritable, (req, res) => {
  const { taskId, n } = req.params;
  const taskDir = getTaskDir(taskId);
  if (!taskDir) return res.status(404).json({ error: 'Task not found' });

  const soloDir = path.join(taskDir, 'attempts', `attempt_${n}`, 'solo');
  if (!fs.existsSync(soloDir)) return res.status(404).json({ error: 'Solo dir not found' });

  const controlPath = path.join(soloDir, 'control.json');
  const control = { action: 'exit', reason: 'user_abort', timestamp: new Date().toISOString() };
  fs.writeFileSync(controlPath, JSON.stringify(control, null, 2) + '\n');

  res.json({ ok: true });
});
```

**Step 3: Add solo progress panel to app.js**

In `app.js`, find the attempt detail view (where coder/judge logs are shown — search for `attempt_` rendering). Add a new function:

```javascript
// Solo Progress Panel — shows step-by-step agent progress
async function renderSoloProgress(taskId, attemptNum, container) {
  try {
    const data = await api(`/task/${encodeURIComponent(taskId)}/attempt/${attemptNum}/solo-steps`);
    if (data.mode === 'not_solo' || !data.steps || data.steps.length === 0) {
      container.innerHTML = '';
      return;
    }

    let html = '<div style="border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px;background:#0d1117">';
    html += '<h4 style="margin-top:0;color:#58a6ff">Solo Agent Progress</h4>';

    for (const step of data.steps) {
      const isCompleted = step.self_eval === 'goal_met' || step.self_eval === 'partial';
      const isFailed = step.self_eval === 'dead_loop';
      const isInProgress = !step.has_response;

      let icon = '○';
      let color = '#8b949e';
      if (isCompleted && step.self_eval === 'goal_met') { icon = '✓'; color = '#3fb950'; }
      else if (isCompleted) { icon = '◐'; color = '#d29922'; }
      else if (isFailed) { icon = '✗'; color = '#f85149'; }
      else if (isInProgress) { icon = '●'; color = '#58a6ff'; }

      html += '<div style="margin-bottom:12px;padding:8px;border-left:3px solid ' + color + ';padding-left:12px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center">';
      html += '<strong style="color:' + color + '">' + icon + ' Step ' + (step.step + 1) + '/' + data.max_iterations + '</strong>';
      if (step.self_eval) html += '<span style="font-size:11px;color:#8b949e">' + escapeHtml(step.self_eval) + (step.confidence ? ' (' + Math.round(step.confidence * 100) + '%)' : '') + '</span>';
      html += '</div>';

      if (step.summary) {
        html += '<div style="font-size:12px;margin-top:4px;color:#c9d1d9">' + escapeHtml(step.summary.slice(0, 300)) + '</div>';
      }
      if (step.test_result) {
        const t = step.test_result;
        html += '<div style="font-size:11px;margin-top:4px;color:#8b949e">Tests: ' + (t.passed || 0) + '/' + (t.total || 0) + ' pass</div>';
      }
      if (step.files_modified && step.files_modified.length > 0) {
        html += '<div style="font-size:11px;margin-top:4px;color:#8b949e">Files: ' + step.files_modified.map(f => escapeHtml(f)).join(', ') + '</div>';
      }
      html += '</div>';
    }

    // Action buttons
    html += '<div style="display:flex;gap:8px;margin-top:12px">';
    // Abort button
    html += '<button class="btn btn-danger write-action" style="font-size:12px" onclick="abortSoloAgent(\'' + escapeHtml(taskId) + '\',' + attemptNum + ')">Abort</button>';
    html += '</div>';

    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div style="color:#f85149;font-size:12px">Failed to load solo progress: ' + escapeHtml(e?.message || 'unknown') + '</div>';
  }
}

async function abortSoloAgent(taskId, attemptNum) {
  if (!confirm('Abort the solo agent? This will terminate the current run.')) return;
  try {
    await fetch('/api/task/' + encodeURIComponent(taskId) + '/attempt/' + attemptNum + '/solo-abort', { method: 'POST' });
    showFlash('Solo agent abort signal sent', 'info');
  } catch (e) {
    showFlash('Failed to abort: ' + (e?.message || ''), 'error');
  }
}

async function proceedSoloStep(taskId, attemptNum) {
  const feedback = prompt('Optional feedback for next step (leave blank to just proceed):') || '';
  try {
    await fetch('/api/task/' + encodeURIComponent(taskId) + '/attempt/' + attemptNum + '/solo-proceed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback })
    });
    showFlash('Proceed signal sent', 'info');
  } catch (e) {
    showFlash('Failed: ' + (e?.message || ''), 'error');
  }
}
```

**Step 4: Integrate solo progress into attempt detail view**

Find the existing attempt detail rendering (where it shows coder/judge logs). Add a `<div id="solo-progress-container">` and call `renderSoloProgress()` when the task has `workflow_mode === 'solo'`. Look for the attempt section rendering and add:

```javascript
// After the attempt header, before coder logs:
const soloWrap = document.createElement('div');
soloWrap.id = 'solo-progress-' + attemptNum;
attemptContainer.insertBefore(soloWrap, attemptContainer.firstChild.nextSibling);

// Check if this is a solo task
const taskData = await api('/task_specs/' + encodeURIComponent(taskId));
if (taskData.workflow_mode === 'solo') {
  renderSoloProgress(taskId, attemptNum, soloWrap);
  // Auto-refresh every 5s while running
  const refreshInterval = setInterval(async () => {
    const status = await api('/tasks/' + encodeURIComponent(taskId) + '/status');
    if (status.state === 'running') {
      renderSoloProgress(taskId, attemptNum, soloWrap);
    } else {
      clearInterval(refreshInterval);
      renderSoloProgress(taskId, attemptNum, soloWrap);
    }
  }, 5000);
}
```

**Step 5: Verify manually**

1. Create a Solo task spec with `max_iterations: 3`
2. Run the task (if solo bridge is available) or mock the solo step files:
   ```bash
   mkdir -p /path/to/task/attempts/attempt_1/solo/step_000
   echo '{"self_eval":"partial","confidence":0.6,"summary":"Analyzed codebase","files_modified":["src/auth.py"]}' > /path/to/task/attempts/attempt_1/solo/step_000/response.json
   ```
3. Open the attempt detail view — solo progress panel should appear
4. Verify abort button sends control signal

**Step 6: Commit**

```bash
git add Rdloop/gui/server.js Rdloop/gui/public/app.js
git commit -m "feat: solo progress GUI — step tracker + abort/proceed controls"
```

---

### Task 11: Full Integration Testing

**Files:**
- No new files — this task validates end-to-end operation

**Step 1: Validate GUI startup and settings**

```bash
cd Rdloop/gui && npm start
# Verify:
# - Settings panel shows Knowledge Agent section
# - Settings Save includes knowledge config
# - "View Knowledge" opens modal
```

**Step 2: Test knowledge shard CRUD (API)**

```bash
# Create shard
curl -s -X POST http://localhost:17333/api/knowledge/shards \
  -H 'Content-Type: application/json' \
  -d '{"name":"integration_test","description":"Integration test shard"}'

# Add entry
curl -s -X PUT http://localhost:17333/api/knowledge/shards/integration_test/entries/test_file.py \
  -H 'Content-Type: application/json' \
  -d '{"type":"file","summary":"Test file for integration","written_by":"manual"}'

# Read shard
curl -s http://localhost:17333/api/knowledge/shards/integration_test | python3 -m json.tool

# List shards
curl -s http://localhost:17333/api/knowledge/shards | python3 -m json.tool

# Delete entry
curl -s -X DELETE http://localhost:17333/api/knowledge/shards/integration_test/entries/test_file.py

# Delete shard
curl -s -X DELETE http://localhost:17333/api/knowledge/shards/integration_test
```

**Step 3: Test three-mode modal (GUI)**

1. Open browser to localhost:17333
2. Click "New TaskSpec"
3. Verify:
   - Mode toggle shows Single Flow / Solo Agent / Collab
   - Switching modes shows/hides correct sections
   - Single: shows provider, acceptance, hides repo/loop-config
   - Solo: shows provider, repo, loop-config, knowledge, observation, hides acceptance/collab
   - Collab: shows collab roles, repo, acceptance, knowledge, hides loop-config/observation
4. Create specs in each mode and verify task.json content:
   - Single: has `workflow_mode: "single"`, no `solo_config`
   - Solo: has `workflow_mode: "solo"`, has `solo_config` with all fields
   - Collab: has `workflow_mode: "collab"`, has `collab_roles`
5. Edit each spec — verify mode is restored correctly

**Step 4: Test coordinator routing (dry run)**

```bash
# Create a mock single-mode task
cat > /tmp/test_single_task.json << 'EOF'
{
  "task_id": "TEST_SINGLE",
  "workflow_mode": "single",
  "goal": "Test single flow",
  "coder_model": "gpt-4o-mini"
}
EOF

# Create a mock solo-mode task
cat > /tmp/test_solo_task.json << 'EOF'
{
  "task_id": "TEST_SOLO",
  "workflow_mode": "solo",
  "goal": "Test solo flow",
  "repo_path": "/tmp/test_repo",
  "solo_config": {
    "max_iterations": 3,
    "approval_mode": "agent_decides",
    "session_strategy": "continuous",
    "auto_pass_threshold": 0.85
  }
}
EOF

# Verify adapter resolution with bash -x (dry-run trace)
# Check that workflow_mode=single → coder_type=cliproxy
# Check that workflow_mode=solo → coder_type=solo
# Check that workflow_mode=collab → coder_type=ccb
```

**Step 5: Test write_knowledge_cache.py with --shard**

```bash
# Create a test project structure
mkdir -p /tmp/test_proj/.context/knowledge

# Write a PM shard entry
python3 Agent/.context/tools/write_knowledge_cache.py \
  --role PM --task-id TEST01 \
  --project-path /tmp/test_proj \
  --shard test_module \
  --key "goal" --value "Integration test"

# Verify shard file
cat /tmp/test_proj/.context/knowledge/test_module.json | python3 -m json.tool

# Verify _meta.json
cat /tmp/test_proj/.context/knowledge/_meta.json | python3 -m json.tool

# Cleanup
rm -rf /tmp/test_proj
```

**Step 6: Test CCB agent start button (if CCB available)**

1. Open GUI → Agents tab
2. Click "Start All"
3. Verify polling waits up to 16s
4. Status should turn green when session is detected
5. Click "Start" for individual provider — should reuse existing session
6. Click "Stop All" then "Start All" — should work fresh

**Step 7: Regression check**

1. Create a Collab task (equivalent to old `semi-auto`) — run it and verify existing flow works
2. Create an Auto task via Advanced JSON with `execution_mode: "auto"` — verify legacy routing still works
3. Check that old task specs without `workflow_mode` field still function normally (backward compat)

**Step 8: Final commit if any fixes needed**

```bash
# If any integration fixes were needed:
git add -A
git commit -m "fix: integration test fixes for three-mode workflow"
```

---

## Summary

| Task | Description | Files | Depends on |
|------|-------------|-------|------------|
| 1 | CCB Agent Start Button Fix | server.js, app.js | — |
| 2 | Knowledge Shard Backend | write_knowledge_cache.py, server.js | — |
| 3 | Knowledge Shard Migration | migrate_knowledge_cache.py (new) | 2 |
| 4 | Knowledge GUI | app.js, style.css | 2 |
| 5 | Single Flow Adapter | call_coder_cliproxy.sh, call_judge_cliproxy.sh (new) | — |
| 6 | Solo Bridge + Adapter | solo_bridge.sh, call_coder_solo.sh (new) | — |
| 7 | Solo Decision Logic | decision_solo.py (new) | — |
| 8 | Coordinator Routing | run_task.sh | 5, 6, 7 |
| 9 | Three-Mode Modal | app.js, server.js | 5, 6 |
| 10 | Solo Progress GUI | server.js, app.js | 6, 8 |
| 11 | Integration Testing | — | all |

**Parallel tracks:** {1}, {2→3→4}, {5, 6, 7}→8→{9, 10}→11