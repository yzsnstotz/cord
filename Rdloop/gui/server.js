const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync, execSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = 17333;
const OUT_DIR = process.env.RDLOOP_OUT_DIR
  ? path.resolve(process.env.RDLOOP_OUT_DIR)
  : path.resolve(__dirname, '..', 'out');
const COORDINATOR = path.resolve(__dirname, '..', 'coordinator', 'run_task.sh');
const TASKS_DIR = path.resolve(__dirname, '..', 'tasks');
const EXAMPLES_DIR = path.resolve(__dirname, '..', 'examples');
const COORDINATOR_LIB = path.resolve(__dirname, '..', 'coordinator', 'lib');
const RUBRIC_PATH = path.resolve(__dirname, '..', 'schemas', 'judge_rubric.json');
const PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts');
const RDLOOP_CONFIG_PATH = path.resolve(__dirname, '..', 'rdloop.config.json');
const CLIAPI_PROVIDERS_PATH = path.resolve(__dirname, '..', 'config', 'cliapi_providers.json');
const WORKTREES_DIR = path.resolve(__dirname, '..', 'worktrees');
const RDLOOP_ROOT = path.resolve(__dirname, '..');

// CCB GUI operations log: every start/stop/kill and key events for debugging
const CCB_GUI_LOG_PATH = path.join(RDLOOP_ROOT, 'ccb-gui.log');
const CCB_GUI_LOG_MAX_LINES = 2000;
let CCB_GUI_LOG_ACTUAL_PATH = CCB_GUI_LOG_PATH;

function appendToCcbGuiLog(operation, detail) {
  const writeTo = (logPath) => {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const line = typeof detail === 'string' ? detail : JSON.stringify(detail);
    const entry = `[${ts}] ${operation} ${line}`;
    fs.appendFileSync(logPath, entry + '\n', 'utf8');
    return logPath;
  };
  try {
    writeTo(CCB_GUI_LOG_ACTUAL_PATH);
    const stat = fs.statSync(CCB_GUI_LOG_ACTUAL_PATH);
    if (stat.size > 1024 * 512) {
      const buf = fs.readFileSync(CCB_GUI_LOG_ACTUAL_PATH, 'utf8');
      const lines = buf.split('\n').filter(Boolean);
      if (lines.length > CCB_GUI_LOG_MAX_LINES) {
        fs.writeFileSync(CCB_GUI_LOG_ACTUAL_PATH, lines.slice(-CCB_GUI_LOG_MAX_LINES).join('\n') + '\n', 'utf8');
      }
    }
  } catch (err) {
    if (CCB_GUI_LOG_ACTUAL_PATH === CCB_GUI_LOG_PATH) {
      try {
        const fallback = path.join(os.tmpdir(), 'rdloop-ccb-gui.log');
        writeTo(fallback);
        CCB_GUI_LOG_ACTUAL_PATH = fallback;
        console.error('[CCB GUI log] Primary path failed, using fallback:', fallback, err.message);
      } catch (e2) {
        console.error('[CCB GUI log] Write failed:', CCB_GUI_LOG_PATH, err.message);
      }
    } else {
      console.error('[CCB GUI log] Write failed:', CCB_GUI_LOG_ACTUAL_PATH, err.message);
    }
  }
}

function readCcbGuiLogTail(maxLines) {
  try {
    const logPath = CCB_GUI_LOG_ACTUAL_PATH;
    if (!fs.existsSync(logPath)) return '';
    const buf = fs.readFileSync(logPath, 'utf8');
    const lines = buf.split('\n').filter(Boolean);
    return lines.slice(-(maxLines || 50)).join('\n');
  } catch {
    return '';
  }
}
function ensureRepoPathExists(repoPath) {
  if (!repoPath || typeof repoPath !== 'string') return;
  const trimmed = repoPath.trim();
  if (!trimmed) return;
  let absPath;
  if (path.isAbsolute(trimmed)) {
    absPath = path.normalize(trimmed);
  } else {
    absPath = path.normalize(path.join(RDLOOP_ROOT, trimmed));
  }
  // Only create if under RDLOOP_ROOT or OUT_DIR to avoid creating arbitrary system paths
  const underRoot = absPath === RDLOOP_ROOT || (absPath.startsWith(RDLOOP_ROOT + path.sep));
  const underOut = absPath === OUT_DIR || (absPath.startsWith(OUT_DIR + path.sep));
  if (underRoot || underOut) {
    try {
      if (!fs.existsSync(absPath)) fs.mkdirSync(absPath, { recursive: true });
    } catch (err) { /* ignore; coordinator may still fail later with not a git repo */ }
  }
}

// Resolve CCB root path from config (so ccb/cask/gask are found when starting CCB sessions)
function getCcbPath() {
  try {
    const cfg = readRdloopConfig();
    const raw = (cfg.ccb_path && typeof cfg.ccb_path === 'string') ? cfg.ccb_path.trim() : '';
    if (!raw) return null;
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(RDLOOP_ROOT, raw);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  } catch {}
  return null;
}

// Env for coordinator so cursor-agent/codex and CCB (ccb/cask/gask) are found (GUI may run with minimal PATH)
function getCoordinatorEnv() {
  const base = process.env.PATH || '';
  const prepend = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'bin')
  ].filter(p => p && fs.existsSync(p));
  const ccbRoot = getCcbPath();
  if (ccbRoot) {
    prepend.push(ccbRoot);
    const ccbBin = path.join(ccbRoot, 'bin');
    if (fs.existsSync(ccbBin)) prepend.push(ccbBin);
  }
  const seen = new Set(base.split(path.delimiter).filter(Boolean));
  const added = prepend.filter(p => !seen.has(p));
  added.forEach(p => seen.add(p));
  const newPath = [...added, base].join(path.delimiter);
  return { ...process.env, PATH: newPath };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: validate taskId — alphanumeric, underscore, hyphen only (C0-2)
const VALID_TASK_ID = /^[A-Za-z0-9_-]+$/;
const TASK_LIST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function isValidTaskId(taskId) {
  return typeof taskId === 'string' && VALID_TASK_ID.test(taskId);
}

// Middleware: validate taskId param and guard path traversal (C0-2)
function validateTaskId(req, res, next) {
  const taskId = req.params.taskId;
  if (!isValidTaskId(taskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }
  const resolved = path.resolve(OUT_DIR, taskId);
  if (!resolved.startsWith(OUT_DIR + path.sep)) {
    return res.status(400).json({ error: 'Invalid task_id: path traversal detected' });
  }
  next();
}

// Helper: safe JSON read
function readJSON(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch { return null; }
}

// Read knowledge_cache.json with shared lock when .lock exists (avoids race with write_knowledge_cache.py)
function readKnowledgeCacheWithLock(cachePath) {
  const lockPath = cachePath + '.lock';
  if (!fs.existsSync(lockPath)) {
    return readJSON(cachePath);
  }
  try {
    const out = execSync('flock', ['-s', lockPath, 'cat', cachePath], { encoding: 'utf8' });
    return out ? JSON.parse(out) : null;
  } catch {
    return readJSON(cachePath);
  }
}

// Helper: safe file read
function readFile(filepath, maxLines) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    if (maxLines) {
      const lines = content.split('\n');
      return lines.slice(-maxLines).join('\n');
    }
    return content;
  } catch { return null; }
}

// K1-5: Current time in second-level UTC Z (for runtime_overrides.updated_at)
function nowSecZ() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// E1-1: Normalize updated_at to second-level UTC Z (K1-5)
function normalizeUpdatedAt(ts) {
  if (ts == null || ts === '') return ts;
  const s = String(ts).trim();
  if (!s) return ts;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return s;
  const msMatch = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+Z$/);
  if (msMatch) return msMatch[1] + 'Z';
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {}
  return ts;
}

function isSecUtcZ(ts) {
  return typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ts);
}

// Helper: read events.jsonl with half-line tolerance (K3-6)
function readEvents(filepath, tail) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const rawLines = content.split('\n').filter(l => l.trim());
    const parsed = [];
    for (const line of rawLines) {
      try { parsed.push(JSON.parse(line)); } catch { /* drop half-line */ }
    }
    if (typeof tail === 'number' && tail > 0) {
      return parsed.slice(-tail);
    }
    return parsed;
  } catch { return []; }
}

// Helper: map READY -> READY_FOR_REVIEW (5.4 compat)
function normalizeState(state) {
  if (state === 'READY') return 'READY_FOR_REVIEW';
  return state;
}

// Helper: state rank for cursor-based pagination ordering
function stateRank(state) {
  switch (normalizeState(state)) {
    case 'RUNNING':          return 0;
    case 'PAUSED':           return 1;
    case 'READY_FOR_REVIEW': return 2;
    case 'FAILED':           return 3;
    default:                 return 4;
  }
}

// Helper: encode/decode cursor
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function decodeCursor(str) {
  try {
    return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
  } catch { return null; }
}

// Helper: compute etag for a file (K4-1)
function computeFileEtag(filepath) {
  try {
    const stat = fs.statSync(filepath);
    const raw = `${filepath}|${stat.mtimeMs}|${stat.size}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  } catch { return null; }
}

// D1-1: Atomic write helper — temp → flush → fsync → rename (K1-3)
function atomicWriteJSON(filepath, data) {
  const dir = path.dirname(filepath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filepath + '.tmp.' + crypto.randomBytes(6).toString('hex');
  const fd = fs.openSync(tmp, 'w');
  try {
    const content = JSON.stringify(data, null, 2) + '\n';
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, filepath);
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// GET /api/tasks — cursor-based pagination (5.1)
app.get('/api/tasks', (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const cursorStr = req.query.cursor || null;
    const cursor = cursorStr ? decodeCursor(cursorStr) : null;

    const dirs = fs.readdirSync(OUT_DIR).filter(d => {
      if (!TASK_LIST_ID.test(d)) return false;
      if (d.startsWith('_')) return false;
      const p = path.join(OUT_DIR, d);
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });

    let tasks = dirs.map(taskId => {
      const status = readJSON(path.join(OUT_DIR, taskId, 'status.json'));
      if (!status) return null;
      const rawState = status?.state || 'UNKNOWN';
      const state = normalizeState(rawState);
      const updatedAt = normalizeUpdatedAt(status?.updated_at);
      if (!isSecUtcZ(updatedAt)) {
        console.warn(`[api/tasks] skip task=${taskId}: invalid updated_at=${JSON.stringify(status?.updated_at)}`);
        return null;
      }
      const taskJson = readJSON(path.join(OUT_DIR, taskId, 'task.json'));
      const execution_mode = (taskJson && taskJson.execution_mode === 'semi-auto') ? 'semi-auto' : 'auto';
      return {
        task_id: taskId,
        state,
        current_attempt: status?.current_attempt || 0,
        last_decision: status?.last_decision || '',
        message: status?.message || '',
        updated_at: updatedAt,
        execution_mode,
        _rank: stateRank(state)
      };
    }).filter(Boolean);

    // Sort: state_rank ASC, updated_at DESC, task_id ASC
    tasks.sort((a, b) => {
      if (a._rank !== b._rank) return a._rank - b._rank;
      if (a.updated_at !== b.updated_at) return (b.updated_at || '').localeCompare(a.updated_at || '');
      return a.task_id.localeCompare(b.task_id);
    });

    // Apply cursor: skip past cursor position
    if (cursor) {
      const idx = tasks.findIndex(t =>
        t._rank === cursor.state_rank &&
        t.updated_at === cursor.updated_at &&
        t.task_id === cursor.task_id
      );
      if (idx >= 0) {
        tasks = tasks.slice(idx + 1);
      }
    }

    // Take limit + 1 to determine if there's a next page
    const page = tasks.slice(0, limit);
    const hasMore = tasks.length > limit;

    // Build next_cursor
    let next_cursor = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      next_cursor = encodeCursor({
        state_rank: last._rank,
        updated_at: last.updated_at,
        task_id: last.task_id
      });
    }

    // Strip internal _rank
    const items = page.map(({ _rank, ...rest }) => rest);

    res.json({ items, next_cursor });
  } catch (err) {
    res.json({ items: [], next_cursor: null, error: err.message });
  }
});

// Task instance routes: allow taskId with slashes (e.g. requirements_doc/test/run_001)
// GET /api/tasks/:id/events — events with tail support (5.2); K4-2: since_offset / since_ts (v1.2 optional)
app.get('/api/tasks/:taskId/events', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const tail = req.query.tail ? parseInt(req.query.tail, 10) : undefined;
  const sinceOffset = req.query.since_offset != null ? parseInt(req.query.since_offset, 10) : undefined;
  const sinceTs = req.query.since_ts;
  let events = readEvents(path.join(taskDir, 'events.jsonl'), tail);
  if (typeof sinceOffset === 'number' && sinceOffset >= 0) {
    events = events.slice(sinceOffset);
  }
  if (sinceTs && typeof sinceTs === 'string' && sinceTs.trim()) {
    const ts = sinceTs.trim();
    events = events.filter(e => e.ts && String(e.ts) > ts);
  }
  res.json({ events });
});

// GET /api/task/:taskId — full task detail
app.get('/api/task/:taskId', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);

  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const taskJson = readJSON(path.join(taskDir, 'task.json'));
  const status = readJSON(path.join(taskDir, 'status.json'));
  if (status) {
    if (status.state) status.state = normalizeState(status.state);
    if (status.updated_at) status.updated_at = normalizeUpdatedAt(status.updated_at);
  }
  const finalSummary = readJSON(path.join(taskDir, 'final_summary.json'));
  const events = readEvents(path.join(taskDir, 'events.jsonl'));

  // Scan attempts
  const attempts = [];
  try {
    const entries = fs.readdirSync(taskDir).filter(d => d.startsWith('attempt_')).sort();
    for (const dir of entries) {
      const attDir = path.join(taskDir, dir);
      const testRc = readFile(path.join(attDir, 'test', 'rc.txt'));
      const diffStat = readFile(path.join(attDir, 'diff.stat')) || readFile(path.join(attDir, 'git', 'diff.stat'));
      const verdict = readJSON(path.join(attDir, 'judge', 'verdict.json'));
      attempts.push({
        name: dir,
        test_rc: testRc ? testRc.trim() : null,
        diff_stat: diffStat,
        judge_decision: verdict?.decision || null
      });
    }
  } catch {}

  res.json({
    task: taskJson,
    status,
    final_summary: finalSummary,
    attempts,
    timeline: events
  });
});

// B2-1: Resolve live log path — stdout.log/stderr.log → run.log → old naming fallback
function resolveLiveLogPath(taskDir, logName) {
  const guiDir = path.join(taskDir, 'gui');
  const roleByLog = { 'coordinator.log': 'coordinator', 'coder.log': 'coder', 'judge.log': 'judge' };
  const role = roleByLog[logName];
  if (logName === 'run.log') {
    const p = path.join(guiDir, 'run.log');
    return fs.existsSync(p) ? p : null;
  }
  if (role === 'coordinator') {
    const candidates = [
      path.join(guiDir, 'run.log'),
      path.join(guiDir, 'coordinator.log')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  if (role === 'coder' || role === 'judge') {
    let attempts = [];
    try {
      attempts = fs.readdirSync(taskDir)
        .filter(d => /^attempt_\d+$/.test(d))
        .sort()
        .reverse();
    } catch {}
    for (const attDir of attempts) {
      const roleDir = path.join(taskDir, attDir, role);
      const runLog = path.join(roleDir, 'run.log');
      const stdoutLog = path.join(roleDir, 'stdout.log');
      const stderrLog = path.join(roleDir, 'stderr.log');
      const parts = [];
      if (fs.existsSync(stdoutLog)) { const c = readFile(stdoutLog); if (c) parts.push(c); }
      if (fs.existsSync(stderrLog)) { const c = readFile(stderrLog); if (c) parts.push(c); }
      if (parts.length) return { synthetic: parts.join('\n--- stderr ---\n') };
      if (fs.existsSync(runLog)) return runLog;
      const oldNames = role === 'coder'
        ? [path.join(roleDir, 'cursor_stdout.log'), path.join(roleDir, 'cursor_stderr.log')]
        : [path.join(roleDir, 'codex_stderr.log')];
      for (const p of oldNames) {
        if (fs.existsSync(p)) return p;
      }
      // Judge adapters (e.g. antigravity) often write only verdict.json; use it as live "log" for the Judge tab
      if (role === 'judge') {
        const verdictPath = path.join(roleDir, 'verdict.json');
        if (fs.existsSync(verdictPath)) {
          try {
            const verdict = readJSON(verdictPath);
            return { synthetic: JSON.stringify(verdict, null, 2) };
          } catch {}
        }
      }
    }
    const guiRoleLog = path.join(guiDir, logName);
    if (fs.existsSync(guiRoleLog)) return guiRoleLog;
    return null;
  }
  return null;
}

// GET /api/task/:taskId/log/:logName — live log with etag/304 (K4-1), B2-1 unified path (always latest attempt for coder/judge)
app.get('/api/task/:taskId/log/:logName', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const logName = req.params.logName;
  const allowedLogs = ['run.log', 'coordinator.log', 'coder.log', 'judge.log'];
  if (!allowedLogs.includes(logName)) {
    return res.status(400).json({ error: 'Unknown log name' });
  }
  const taskDir = path.join(OUT_DIR, taskId);
  const resolved = resolveLiveLogPath(taskDir, logName);
  const roleByLog = { 'coordinator.log': 'coordinator', 'coder.log': 'coder', 'judge.log': 'judge' };
  const role = roleByLog[logName] || logName.replace('.log', '');
  if (!resolved) {
    const msg = `No logs found for role=${role}`;
    const etag = crypto.createHash('sha256').update(msg).digest('hex').slice(0, 16);
    if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();
    res.set('ETag', `"${etag}"`);
    return res.type('text/plain').send(msg);
  }
  let logPath = typeof resolved === 'string' ? resolved : null;
  let content = null;
  if (typeof resolved === 'object' && resolved.synthetic) {
    content = resolved.synthetic;
  } else if (logPath) {
    content = readFile(logPath, req.query.tail ? parseInt(req.query.tail, 10) : undefined);
  }
  if (content == null || content === '') {
    const msg = `No logs found for role=${role}`;
    const etag = crypto.createHash('sha256').update(msg).digest('hex').slice(0, 16);
    if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();
    res.set('ETag', `"${etag}"`);
    return res.type('text/plain').send(msg);
  }
  const etag = logPath ? computeFileEtag(logPath) : crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 16);
  if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();
  res.set('ETag', `"${etag}"`);
  res.type('text/plain').send(content);
});

// GET /api/task/:taskId/attempt/:n — attempt detail (B3: fixed field set)
app.get('/api/task/:taskId/attempt/:n', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const n = parseInt(req.params.n, 10);
  const pad = String(n).padStart(3, '0');
  const attDir = path.join(OUT_DIR, taskId, `attempt_${pad}`);

  if (!fs.existsSync(attDir)) {
    return res.status(404).json({ error: 'Attempt not found' });
  }

  // B3-1: Fixed field set — paths (null if absent), rc, verdict_summary
  const coderDir = path.join(attDir, 'coder');
  const judgeDir = path.join(attDir, 'judge');

  function existsOrNull(p) {
    return fs.existsSync(p) ? p.replace(OUT_DIR + path.sep, '') : null;
  }

  const paths = {
    prompt: existsOrNull(path.join(coderDir, 'prompt.txt')),
    stdout: existsOrNull(path.join(coderDir, 'stdout.log')),
    stderr: existsOrNull(path.join(coderDir, 'stderr.log')),
    run_log: existsOrNull(path.join(coderDir, 'run.log')),
    rc: existsOrNull(path.join(coderDir, 'rc.txt')),
    verdict: existsOrNull(path.join(judgeDir, 'verdict.json')),
    extract_err: existsOrNull(path.join(judgeDir, 'extract_err.log'))
  };

  // rc: read numeric rc from coder/rc.txt (or judge/rc.txt fallback)
  let rc = null;
  const rcRaw = readFile(path.join(coderDir, 'rc.txt'))?.trim() || readFile(path.join(attDir, 'test', 'rc.txt'))?.trim();
  if (rcRaw !== null && rcRaw !== undefined) {
    const parsed = parseInt(rcRaw, 10);
    if (!isNaN(parsed)) rc = parsed;
  }

  // updated_at: from status.json or attempt dir mtime
  let updated_at = null;
  const status = readJSON(path.join(OUT_DIR, taskId, 'status.json'));
  if (status?.updated_at) {
    updated_at = status.updated_at;
  } else {
    try {
      const stat = fs.statSync(attDir);
      updated_at = stat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
    } catch {}
  }

  // verdict_summary: from verdict.json
  const verdict = readJSON(path.join(judgeDir, 'verdict.json'));
  const verdictSummary = {
    final_score_0_100: verdict?.final_score_0_100 ?? null,
    gated: verdict?.gated ?? null,
    pause_reason_code: status?.pause_reason_code ?? null,
    top_issues: Array.isArray(verdict?.top_issues) ? verdict.top_issues.slice(0, 2) : []
  };

  // Legacy fields for backward compat
  const evidence = readJSON(path.join(attDir, 'evidence.json'));
  const metrics = readJSON(path.join(attDir, 'metrics.json'));
  const testLog = readFile(path.join(attDir, 'test', 'stdout.log'), 400);
  const diffStat = readFile(path.join(attDir, 'git', 'diff.stat'));
  const instruction = readFile(path.join(coderDir, 'instruction.txt')) || readFile(path.join(attDir, 'coder', 'instruction.txt'));
  const env = readJSON(path.join(attDir, 'env.json'));

  // Coder/Judge input and output for attempt detail (full display)
  const coderOutput = readFile(path.join(coderDir, 'run.log'));
  const taskJson = readJSON(path.join(OUT_DIR, taskId, 'task.json'));
  const taskType = taskJson?.task_type || '';
  let judgePromptPath = path.join(PROMPTS_DIR, 'judge.prompt.md');
  if (taskType && fs.existsSync(path.join(PROMPTS_DIR, `judge.prompt.${taskType}.md`))) {
    judgePromptPath = path.join(PROMPTS_DIR, `judge.prompt.${taskType}.md`);
  }
  const judgePromptText = fs.existsSync(judgePromptPath) ? readFile(judgePromptPath) : null;

  res.json({
    // B3-1: Fixed field set
    task_id: taskId,
    attempt: n,
    role: 'coder',
    paths,
    rc,
    updated_at,
    verdict_summary: verdictSummary,
    task_type: taskType,
    // Legacy fields for backward compat (B3-2 frontend uses fixed fields above)
    verdict,
    evidence,
    metrics,
    test_rc: rcRaw || null,
    test_log: testLog,
    diff_stat: diffStat,
    instruction,
    env,
    // Coder/Judge input and output for attempt detail panels
    coder_output: coderOutput,
    judge_prompt_text: judgePromptText
  });
});

// POST /api/task/:taskId/control — write control.json
app.post('/api/task/:taskId/control', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);

  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { action, payload } = req.body;
  const control = {
    action: action || 'PAUSE',
    payload: payload || {},
    nonce: crypto.randomUUID(),
    created_at: new Date().toISOString()
  };

  fs.writeFileSync(path.join(taskDir, 'control.json'), JSON.stringify(control, null, 2));
  res.json({ ok: true, nonce: control.nonce });
});

// POST /api/task/:taskId/run — trigger coordinator
app.post('/api/task/:taskId/run', requireWritable, validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  const force = req.query.force === '1';

  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Check lockdir (§13.1)
  const lockDir = path.join(taskDir, '.lockdir');
  if (!force && fs.existsSync(lockDir)) {
    return res.status(409).json({ error: 'Task is already running (lockdir exists)', hint: 'Use ?force=1 to force' });
  }

  // Spawn coordinator
  const guiDir = path.join(taskDir, 'gui');
  if (!fs.existsSync(guiDir)) fs.mkdirSync(guiDir, { recursive: true });

  const logFile = path.join(guiDir, 'run.log');
  const logFd = fs.openSync(logFile, 'a');

  const child = spawn('bash', [COORDINATOR, '--continue', taskId], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: path.resolve(__dirname, '..'),
    env: getCoordinatorEnv()
  });

  fs.writeFileSync(path.join(guiDir, 'runner.pid'), String(child.pid));
  child.unref();

  res.json({ ok: true, pid: child.pid });
});

// GET /api/task/:taskId/runtime_overrides — read current overrides for instance (e.g. adjust params modal)
app.get('/api/task/:taskId/runtime_overrides', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const overridesPath = path.join(taskDir, 'runtime_overrides.json');
  const payload = readJSON(overridesPath);
  res.json({ overrides: payload?.overrides ?? {}, request_id: payload?.request_id ?? null });
});

// PUT /api/task/:taskId/task_json — patch task.json for a run instance (only when PAUSED; for adjust params & re-run)
app.put('/api/task/:taskId/task_json', requireWritable, validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const status = readJSON(path.join(taskDir, 'status.json'));
  if (status?.state !== 'PAUSED') {
    return res.status(400).json({ error: 'Only PAUSED tasks can have task_json updated. Pause the task first.' });
  }
  const taskPath = path.join(taskDir, 'task.json');
  const current = readJSON(taskPath);
  if (!current) {
    return res.status(500).json({ error: 'Failed to read task.json' });
  }
  const allowed = ['goal', 'acceptance', 'repo_path', 'base_ref', 'max_attempts', 'test_cmd', 'coder', 'judge', 'coder_model', 'judge_model', 'attempt_context_mode'];
  const patch = req.body && typeof req.body === 'object' ? req.body : {};
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      if (key === 'max_attempts') {
        const n = Number(patch[key]);
        if (!Number.isInteger(n) || n < 1 || n > 50) {
          return res.status(400).json({ error: 'max_attempts must be integer 1–50' });
        }
        current[key] = n;
      } else if (key === 'attempt_context_mode') {
        if (!['fresh_each', 'iterative'].includes(patch[key])) {
          return res.status(400).json({ error: 'attempt_context_mode must be fresh_each or iterative' });
        }
        current[key] = patch[key];
      } else {
        current[key] = patch[key];
      }
    }
  }
  if (current.repo_path) ensureRepoPathExists(current.repo_path);
  try {
    atomicWriteJSON(taskPath, current);
  } catch (err) {
    return res.status(500).json({ error: `Failed to write task.json: ${err.message}` });
  }
  res.json({ ok: true, task_id: taskId });
});

// ================================================================
// API extensions for OpenClaw Telegram integration (Epic A)
// ================================================================

const START_TIME = Date.now();
const AUDIT_DIR = path.join(OUT_DIR, '_audit');
const DELETED_RECORDS_DIR = path.join(OUT_DIR, '_deleted');

// Helper: safe filename segment for state (no path traversal)
function stateToFileSegment(state) {
  if (state == null || state === '') return 'UNKNOWN';
  const s = String(state).replace(/[^A-Za-z0-9_-]/g, '_');
  return s || 'UNKNOWN';
}

// Helper: record a task as "deleted from sidebar" — append to manifest and by_state (categorized)
function recordDeletedFromSidebar(taskId, status) {
  try {
    const isNewDir = !fs.existsSync(DELETED_RECORDS_DIR);
    if (isNewDir) {
      fs.mkdirSync(DELETED_RECORDS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DELETED_RECORDS_DIR, 'README.md'),
        '# Deleted-from-sidebar records\n\nTasks removed from the GUI sidebar (×) are recorded here.\n\n- `manifest.jsonl` — one JSON object per line: task_id, deleted_at, state, last_decision, message, current_attempt, updated_at.\n- `by_state/` — same records grouped by state (e.g. READY_FOR_REVIEW.jsonl, FAILED.jsonl).\n'
      );
    }
    const state = normalizeState(status?.state || 'UNKNOWN');
    const deletedAt = new Date().toISOString();
    const record = {
      task_id: taskId,
      deleted_at: deletedAt,
      state,
      last_decision: status?.last_decision ?? '',
      message: (status?.message ?? '').slice(0, 500),
      current_attempt: status?.current_attempt ?? 0,
      updated_at: normalizeUpdatedAt(status?.updated_at) || ''
    };
    const line = JSON.stringify(record) + '\n';
    const manifestPath = path.join(DELETED_RECORDS_DIR, 'manifest.jsonl');
    fs.appendFileSync(manifestPath, line);
    const byStateDir = path.join(DELETED_RECORDS_DIR, 'by_state');
    if (!fs.existsSync(byStateDir)) fs.mkdirSync(byStateDir, { recursive: true });
    const stateFile = path.join(byStateDir, stateToFileSegment(state) + '.jsonl');
    fs.appendFileSync(stateFile, line);
  } catch (err) {
    console.error('recordDeletedFromSidebar:', err.message);
  }
}

// Helper: ensure audit dir exists and append to audit log (K7-3)
function auditLog(entry) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(path.join(AUDIT_DIR, 'gui_actions.jsonl'), line);
  } catch { /* best effort */ }
}

// GET /api/health — uptime + task count
app.get('/api/health', (req, res) => {
  try {
    let taskCount = 0;
    if (fs.existsSync(OUT_DIR)) {
      const dirs = fs.readdirSync(OUT_DIR).filter(d => {
        if (!isValidTaskId(d)) return false;
        try { return fs.statSync(path.join(OUT_DIR, d)).isDirectory(); } catch { return false; }
      });
      taskCount = dirs.length;
    }
    res.json({
      status: 'ok',
      uptime_ms: Date.now() - START_TIME,
      task_count: taskCount,
      read_only: READ_ONLY,
      allow_partial_run: ALLOW_PARTIAL_RUN
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// GET /api/tasks/:taskId/status — status.json content (normalized)
app.get('/api/tasks/:taskId/status', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const status = readJSON(path.join(taskDir, 'status.json'));
  if (!status) {
    return res.status(404).json({ error: 'status.json not found' });
  }
  if (status.state) status.state = normalizeState(status.state);
  if (status.updated_at) status.updated_at = normalizeUpdatedAt(status.updated_at);
  res.json(status);
});

// POST /api/tasks/:taskId/record-hidden — record task as removed from sidebar (for _deleted folder)
app.post('/api/tasks/:taskId/record-hidden', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const status = readJSON(path.join(taskDir, 'status.json'));
  recordDeletedFromSidebar(taskId, status || {});
  res.json({ ok: true });
});

// POST /api/tasks/:taskId/runtime_overrides — D1: atomic write + max_attempts range [current_attempt, 50] (K7-1: READ_ONLY blocks)
app.post('/api/tasks/:taskId/runtime_overrides', requireWritable, validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { overrides, request_id } = req.body || {};
  if (!request_id || typeof request_id !== 'string') {
    return res.status(400).json({ error: 'request_id is required' });
  }
  if (!overrides || typeof overrides !== 'object') {
    return res.status(400).json({ error: 'overrides object is required' });
  }

  // D1-2: max_attempts validation range [current_attempt, 50]
  if (overrides.max_attempts !== undefined) {
    const ma = overrides.max_attempts;
    if (!Number.isInteger(ma) || ma > 50) {
      return res.status(400).json({ error: 'max_attempts must be integer ≤ 50' });
    }
    // Read current_attempt from status.json
    const status = readJSON(path.join(taskDir, 'status.json'));
    const currentAttempt = status?.current_attempt ?? 0;
    if (ma < currentAttempt) {
      return res.status(400).json({
        error: `max_attempts must be >= current_attempt (${currentAttempt})`,
        current_attempt: currentAttempt
      });
    }
  }

  // D1-1: Read old value for audit history; E4-3: idempotency — same request_id already written → 200 + dedup, no write
  const overridesPath = path.join(taskDir, 'runtime_overrides.json');
  const oldPayload = readJSON(overridesPath);
  if (oldPayload && oldPayload.request_id === request_id) {
    auditLog({
      actor: 'http',
      source: 'http',
      action: 'runtime_overrides',
      task_id: taskId,
      request_id,
      dedup: true
    });
    return res.status(200).json({ ok: true, request_id, deduplicated: true });
  }

  // E4-3/K1-5: task_id, updated_at (sec Z), actor; use updated_at not written_at
  const payload = {
    overrides,
    request_id,
    task_id: taskId,
    updated_at: nowSecZ(),
    actor: { source: 'http', id: 'gui' }
  };

  // D1-1: Atomic write — temp → flush → fsync → rename (K1-3). E4-4: on failure return WRITE_FAILED, audit, do not modify status.
  try {
    atomicWriteJSON(overridesPath, payload);
  } catch (writeErr) {
    auditLog({
      actor: 'gui',
      source: 'http',
      action: 'runtime_overrides',
      task_id: taskId,
      request_id,
      error: 'WRITE_FAILED',
      message: writeErr.message
    });
    return res.status(500).json({
      error: 'WRITE_FAILED',
      message: 'Failed to write runtime_overrides. Status was not modified.',
      request_id
    });
  }

  // Audit with old/new for rollback support (A5-0)
  auditLog({
    actor: 'gui',
    source: 'http',
    action: 'runtime_overrides',
    task_id: taskId,
    request_id,
    old: oldPayload?.overrides ?? null,
    new: overrides
  });

  // Append to runtime_overrides_history.jsonl for rollback (A5-0)
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const histLine = JSON.stringify({
      ts: new Date().toISOString(),
      task_id: taskId,
      request_id,
      old: oldPayload?.overrides ?? null,
      new: overrides
    }) + '\n';
    fs.appendFileSync(path.join(AUDIT_DIR, 'runtime_overrides_history.jsonl'), histLine);
  } catch { /* best effort */ }

  res.json({ ok: true, request_id });
});

// POST /api/tasks/:taskId/user_input — append to user_input.jsonl + audit (K7-1: READ_ONLY blocks)
app.post('/api/tasks/:taskId/user_input', requireWritable, validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { text, request_id } = req.body || {};
  if (!request_id || typeof request_id !== 'string') {
    return res.status(400).json({ error: 'request_id is required' });
  }
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }

  // Dedup: check request_id in last 100 lines (A5-4)
  const inputFile = path.join(taskDir, 'user_input.jsonl');
  try {
    if (fs.existsSync(inputFile)) {
      const content = fs.readFileSync(inputFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim()).slice(-100);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.request_id === request_id) {
            return res.json({ ok: true, request_id, deduplicated: true });
          }
        } catch { /* skip malformed lines */ }
      }
    }
  } catch { /* if read fails, proceed */ }

  const entry = {
    ts: new Date().toISOString(),
    text,
    request_id
  };
  const line = JSON.stringify(entry) + '\n';
  const fd = fs.openSync(inputFile, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // K3-4: Append USER_INPUT_RECEIVED to events.jsonl (source, author, len)
  const eventsPath = path.join(taskDir, 'events.jsonl');
  const userInputEvent = {
    ts: entry.ts,
    task_id: taskId,
    type: 'USER_INPUT_RECEIVED',
    source: 'http',
    author: 'gui',
    len: text.length,
    request_id
  };
  try {
    const evFd = fs.openSync(eventsPath, 'a');
    try {
      fs.writeSync(evFd, JSON.stringify(userInputEvent) + '\n');
      fs.fsyncSync(evFd);
    } finally {
      fs.closeSync(evFd);
    }
  } catch (evErr) {
    // best effort; do not fail the request
  }

  auditLog({
    actor: 'gui',
    source: 'http',
    action: 'user_input',
    task_id: taskId,
    request_id,
    payload: { text }
  });

  res.json({ ok: true, request_id });
});

// ================================================================
// A4: GET /api/rubric/:task_type — rubric dimensions/weights/gates
// ================================================================
app.get('/api/rubric/:task_type', (req, res) => {
  const taskType = req.params.task_type;
  const rubric = readJSON(RUBRIC_PATH);
  if (!rubric) {
    return res.status(500).json({ error: 'Failed to load judge_rubric.json' });
  }
  // Resolve alias (e.g. engineering_implementation → engineering_impl)
  const aliasMap = rubric.alias_map || {};
  const resolved = aliasMap[taskType] || taskType;
  const typeData = rubric.task_types?.[resolved];
  if (!typeData) {
    return res.status(404).json({
      error: `Unknown task_type: ${taskType}`,
      available: Object.keys(rubric.task_types || {})
    });
  }
  // B4-3a: support dimensions as array of { dim_key, weight, is_hard_gate } or legacy [names] + weights + hard_gates
  let dimensions = typeData.dimensions || [];
  let weights = typeData.weights || {};
  let hard_gates = typeData.hard_gates || [];
  if (dimensions.length && typeof dimensions[0] === 'object' && dimensions[0] != null && 'dim_key' in dimensions[0]) {
    dimensions = dimensions.map(d => d.dim_key);
    weights = Object.fromEntries((typeData.dimensions || []).map(d => [d.dim_key, d.weight]));
    hard_gates = (typeData.dimensions || []).filter(d => d.is_hard_gate).map(d => d.dim_key);
  }
  res.json({
    task_type: resolved,
    dimensions,
    weights,
    hard_gates,
    gate_threshold: typeData.gate_threshold ?? typeData.hard_gate_threshold ?? 2.0,
    penalty_rules: typeData.penalty_rules || []
  });
});

// ================================================================
// A5: GET /api/adapters — adapter list + healthcheck (C1-1)
// ================================================================

// A5-1: Detect known adapters from coordinator/lib/call_* scripts
function detectAdapters() {
  const adapters = [];
  let files = [];
  try {
    files = fs.readdirSync(COORDINATOR_LIB).filter(f => f.startsWith('call_'));
  } catch {
    return adapters;
  }

  for (const file of files) {
    // Parse name: call_coder_cursor.sh → type=coder, name=cursor-agent
    const match = file.match(/^call_(coder|judge)_(.+)\.sh$/);
    if (!match) continue;
    const role = match[1]; // 'coder' or 'judge'
    const rawName = match[2]; // e.g. 'cursor', 'mock', 'codex', 'mock_timeout'

    const scriptPath = path.join(COORDINATOR_LIB, file);

    // Map raw name to adapter name
    const nameMap = {
      'cursor': 'cursor-agent',
      'mock': 'mock',
      'mock_timeout': 'mock-timeout',
      'codex': 'codex-cli',
      'claude': 'claude-cli',
      'claude_bridge': 'claude-cli',
      'antigravity': 'antigravity-cli',
      'openai': 'openai-api',
      'moonshot': 'moonshot-api',
      'openrouter': 'openrouter-api'
    };
    const adapterName = nameMap[rawName] || rawName;

    // A5-1: healthcheck
    const health = adapterHealthcheck(adapterName, role, scriptPath);
    const supportLevel = health.support_level || (health.status === 'OK' ? 'SUPPORTED' : 'UNSUPPORTED');
    adapters.push({
      name: adapterName,
      type: role,
      script: file,
      status: health.status,
      reason: health.reason,
      supports_ssh_headless: health.supports_ssh_headless,
      support_level: supportLevel
    });
  }

  return adapters;
}

function adapterHealthcheck(name, role, scriptPath) {
  // Check if script file exists and is executable
  if (!fs.existsSync(scriptPath)) {
    return { status: 'UNAVAILABLE', reason: 'script not found', supports_ssh_headless: false, support_level: 'UNSUPPORTED' };
  }

  const platform = os.platform();

  // Mock adapters are always available
  if (name.startsWith('mock')) {
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  // cursor-agent: via cliapi (cursorcliapi 8000), same API key as other adapters
  if (name === 'cursor-agent') {
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  // codex-cli: demo/PARTIAL per requirement (C1-1 / K8-5)
  if (name === 'codex-cli') {
    const exists = commandExists('codex');
    if (!exists) {
      return { status: 'UNAVAILABLE', reason: 'missing binary: codex', supports_ssh_headless: true, support_level: 'PARTIAL' };
    }
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'PARTIAL' };
  }

  // claude-cli: demo/PARTIAL per requirement (C1-1 / K8-5)
  if (name === 'claude-cli') {
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'PARTIAL' };
  }

  // antigravity-cli: via CLIProxyAPI 8317; script exists and uses OPENCLAW_API_KEY/openclawaousers
  if (name === 'antigravity-cli') {
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  // openai-api: check key — SUPPORTED for K8-5
  if (name === 'openai-api') {
    if (!process.env.OPENAI_API_KEY) {
      return { status: 'UNAVAILABLE', reason: 'missing key: OPENAI_API_KEY', supports_ssh_headless: true, support_level: 'SUPPORTED' };
    }
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  // moonshot-api: check key
  if (name === 'moonshot-api') {
    if (!process.env.MOONSHOT_API_KEY) {
      return { status: 'UNAVAILABLE', reason: 'missing key: MOONSHOT_API_KEY', supports_ssh_headless: true, support_level: 'SUPPORTED' };
    }
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  // openrouter-api: check key
  if (name === 'openrouter-api') {
    if (!process.env.OPENROUTER_API_KEY) {
      return { status: 'UNAVAILABLE', reason: 'missing key: OPENROUTER_API_KEY', supports_ssh_headless: true, support_level: 'SUPPORTED' };
    }
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  return { status: 'UNKNOWN', reason: 'unrecognized adapter', supports_ssh_headless: false, support_level: 'UNSUPPORTED' };
}

function commandExists(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// C1-1: ALLOW_PARTIAL_RUN — when false, PARTIAL adapters must not be selectable as default or for Run
const ALLOW_PARTIAL_RUN = process.env.ALLOW_PARTIAL_RUN === 'true';

// K7-1: READ_ONLY — when true, all write operations return 403
const READ_ONLY = process.env.READ_ONLY === 'true';
function requireWritable(req, res, next) {
  if (READ_ONLY) {
    return res.status(403).json({ error: 'READ_ONLY mode: writes are disabled' });
  }
  next();
}

// P07: CCB health — use ccb-ping <provider> (connectivity-only channel); do not use ask commands (cask/gask "ping") which send messages to the pane.
// cwd: run in this directory so ccb-ping finds .ccb/ session files (status lights depend on correct project).
// When cmd is 'ccb-ping', args[0] is provider name; success = exit code 0 (no "pong" in output).
function pingCcbProvider(cmd, args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const start = Date.now();
    const env = getCoordinatorEnv();
    const opts = { env, stdio: ['ignore', 'pipe', 'pipe'] };
    if (cwd && typeof cwd === 'string' && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
      opts.cwd = cwd;
    }
    let runCmd = cmd;
    let runArgs = Array.isArray(args) ? args.slice() : [];
    // Prefer modern Python runtime for ccb-ping scripts that may use 3.10+ syntax.
    if (cmd === 'ccb-ping') {
      try {
        const pingPath = String(execFileSync('which', ['ccb-ping'], { encoding: 'utf8' }) || '').trim();
        const pyCmd = ['python3.12', 'python3.11', 'python3.10', 'python'].find(commandExists);
        if (pingPath && pyCmd) {
          runCmd = pyCmd;
          runArgs = [pingPath, ...runArgs];
        }
      } catch {}
    }
    const child = spawn(runCmd, runArgs, opts);
    let out = '';
    let done = false;
    const finish = (status, pingMs) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve(status === 'ok' ? { status: 'ok', ping_ms: pingMs } : { status: status });
    };
    const t = setTimeout(() => {
      finish('unavailable');
    }, timeoutMs);
    child.on('error', (err) => {
      if (err.code === 'ENOENT' || err.errno === -2) {
        finish('not_installed');
      } else {
        finish('unavailable');
      }
    });
    child.stdout.on('data', (chunk) => { out += (chunk && chunk.toString()) || ''; });
    child.stderr.on('data', (chunk) => { out += (chunk && chunk.toString()) || ''; });
    child.on('close', (code) => {
      clearTimeout(t);
      if (done) return;
      const pingMs = Date.now() - start;
      // ccb-ping: connectivity-only; success = exit 0. Ask commands (legacy) used "pong" in stdout.
      const ok = (cmd === 'ccb-ping') ? (code === 0) : (code === 0 && /pong/i.test(out));
      if (ok) {
        finish('ok', pingMs);
      } else {
        if (cmd === 'ccb-ping' && /no active .* session found/i.test(out)) {
          finish('off');
          return;
        }
        finish('unavailable');
      }
    });
  });
}

app.get('/api/ccb/status', (req, res) => {
  const timeoutMs = 3100;
  let workDir = '';
  try {
    const cfg = readRdloopConfig();
    workDir = (cfg.ccb_work_dir && typeof cfg.ccb_work_dir === 'string') ? cfg.ccb_work_dir.trim() : '';
  } catch {}
  if (!workDir) workDir = getProjectPath() || process.cwd();
  Promise.all([
    pingCcbProvider('ccb-ping', ['codex'], timeoutMs, workDir),
    pingCcbProvider('ccb-ping', ['gemini'], timeoutMs, workDir)
  ]).then(([caskResult, gaskResult]) => {
    res.json({ cask: caskResult, gask: gaskResult });
  }).catch((err) => {
    res.json({
      cask: { status: 'unavailable' },
      gask: { status: 'unavailable' },
      error: err.message
    });
  });
});

// P09: GET /api/ccb/guard-status — run ccb_guard.sh --check
app.get('/api/ccb/guard-status', (req, res) => {
  const agentRoot = getAgentRoot();
  if (!agentRoot) {
    return res.json({ injected: false, files_affected: [], detail: 'agent_root not configured' });
  }
  const scriptPath = path.join(agentRoot, '.context', 'tools', 'ccb_guard.sh');
  if (!fs.existsSync(scriptPath)) {
    return res.json({ injected: false, files_affected: [], detail: 'ccb_guard.sh not found' });
  }
  const env = getCoordinatorEnv();
  const child = spawn('bash', [scriptPath, '--check'], { env, cwd: agentRoot });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += (chunk && chunk.toString()) || ''; });
  child.stderr.on('data', (chunk) => { stderr += (chunk && chunk.toString()) || ''; });
  child.on('close', (code) => {
    const out = stdout + stderr;
    const filesAffected = [];
    const re = /FOUND:\s*CCB[^i]*in\s+(.+)/g;
    let m;
    while ((m = re.exec(out)) !== null) {
      const p = m[1].trim();
      if (p && !filesAffected.includes(p)) filesAffected.push(p);
    }
    const injected = code === 1 || filesAffected.length > 0;
    res.json({
      injected,
      files_affected: filesAffected,
      detail: injected ? `Found CCB injection in ${filesAffected.length} file(s)` : 'OK: No CCB injection blocks found.'
    });
  });
  child.on('error', (err) => {
    res.json({
      injected: false,
      files_affected: [],
      detail: 'spawn error: ' + (err.message || 'unknown')
    });
  });
});

// P09: POST /api/ccb/guard-clean — run ccb_guard.sh (no args); v3.3: require confirm=true
app.post('/api/ccb/guard-clean', requireWritable, (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'confirm=true required in body to prevent accidental cleanup' });
  }
  const agentRoot = getAgentRoot();
  if (!agentRoot) {
    return res.status(400).json({ error: 'agent_root not configured' });
  }
  const scriptPath = path.join(agentRoot, '.context', 'tools', 'ccb_guard.sh');
  if (!fs.existsSync(scriptPath)) {
    return res.status(400).json({ error: 'ccb_guard.sh not found' });
  }
  const env = getCoordinatorEnv();
  const child = spawn('bash', [scriptPath], { env, cwd: agentRoot });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += (chunk && chunk.toString()) || ''; });
  child.stderr.on('data', (chunk) => { stderr += (chunk && chunk.toString()) || ''; });
  child.on('close', (code) => {
    const output = stdout + stderr;
    const filesModified = [];
    const re = /REMOVED:[^f]*from\s+(.+)/g;
    let m;
    while ((m = re.exec(output)) !== null) {
      const p = m[1].trim();
      if (p && !filesModified.includes(p)) filesModified.push(p);
    }
    res.json({
      cleaned: code === 0,
      files_modified: filesModified,
      output
    });
  });
  child.on('error', (err) => {
    res.status(500).json({ error: 'spawn error: ' + (err.message || 'unknown') });
  });
});

// P12: CCB session management — tmux-based; macOS/Linux only
const CCB_SESSION_PREFIX = 'ccb_';
const CCB_PROVIDERS = ['codex', 'gemini', 'opencode', 'claude', 'droid'];
const CCB_PING_CMD = { codex: 'cask', gemini: 'gask', opencode: 'oask', claude: 'lask', droid: 'dask' };
// Session names from CCB: ccb-* (native layout) or ccb_<pid> (GUI auto-tmux in cmd_start)
function isCcbNativeSessionName(name) {
  return typeof name === 'string' && (name.startsWith('ccb-') || /^ccb_\d+$/.test(name));
}
function normalizeCcbAgentLabel(label) {
  const s = String(label || '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'opencode') return 'opencode';
  return s.replace(/[^a-z]/g, '');
}
function providerFromPaneMeta(agentLabel, paneTitle) {
  const norm = normalizeCcbAgentLabel(agentLabel);
  if (CCB_PROVIDERS.includes(norm)) return norm;
  const title = String(paneTitle || '').trim().toLowerCase();
  if (title.startsWith('ccb-codex')) return 'codex';
  if (title.startsWith('ccb-gemini')) return 'gemini';
  if (title.startsWith('ccb-opencode')) return 'opencode';
  if (title.startsWith('ccb-claude')) return 'claude';
  if (title.startsWith('ccb-droid')) return 'droid';
  return '';
}

// P20: CCB instance lock detection (same semantics as CCB ProviderLock: ~/.ccb/run/ccb-{md5(cwd)[:8]}.lock)
function ccbCwdHash(workDir) {
  return crypto.createHash('md5').update((workDir || '').toString()).digest('hex').slice(0, 8);
}
function getCcbLockPath(workDir) {
  return path.join(os.homedir(), '.ccb', 'run', 'ccb-' + ccbCwdHash(workDir) + '.lock');
}
/** P25: Scan ~/.ccb/run/ for all ccb-*.lock; return first alive PID instance or { running: false }. */
function findCcbInstanceFromLockScan(workDirFromConfig) {
  const runDir = path.join(os.homedir(), '.ccb', 'run');
  if (!fs.existsSync(runDir)) return { running: false };
  let files = [];
  try {
    files = fs.readdirSync(runDir).filter(f => f.startsWith('ccb-') && f.endsWith('.lock'));
  } catch (_) {
    return { running: false };
  }
  for (const f of files) {
    const lockPath = path.join(runDir, f);
    try {
      const pidStr = fs.readFileSync(lockPath, 'utf8').trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && isPidAlive(pid)) {
        const work_dir = (workDirFromConfig && getCcbLockPath(workDirFromConfig) === lockPath)
          ? workDirFromConfig
          : undefined;
        return { running: true, pid, lockPath, work_dir };
      }
    } catch (_) {}
  }
  return { running: false };
}
function isPidAlive(pid) {
  if (pid == null || isNaN(Number(pid))) return false;
  const p = Number(pid);
  if (p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    throw e;
  }
}
async function findCcbSessionNameByPid(pid, env) {
  const e = env || getCoordinatorEnv();
  const pidStr = String(pid);
  const listResult = await runTmux(['list-sessions', '-F', '#{session_name}'], e, 2000);
  const allNames = (listResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  const ccbName = CCB_SESSION_PREFIX + pidStr;
  if (allNames.includes(ccbName)) return ccbName;
  const aiMatch = allNames.find(n => n.startsWith('ai-') && n.endsWith('-' + pidStr));
  if (aiMatch) return aiMatch;
  // Lock is held by inner python; session name is ccb_{outer_pid}. Find session that has a pane with this pid.
  const panesResult = await runTmux(['list-panes', '-a', '-F', '#{session_name} #{pane_pid}'], e, 2000);
  const lines = (panesResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length >= 2 && parts[1] === pidStr) {
      const name = parts[0];
      if (allNames.includes(name) && (name.startsWith(CCB_SESSION_PREFIX) || name.startsWith('ai-'))) return name;
    }
  }
  return null;
}

function runTmux(args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { env: env || getCoordinatorEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += (c && c.toString()) || ''; });
    child.stderr.on('data', (c) => { err += (c && c.toString()) || ''; });
    const t = timeoutMs ? setTimeout(() => { try { child.kill(); } catch {} resolve({ stdout: out, code: -1 }); }, timeoutMs) : null;
    child.on('close', (code) => {
      if (t) clearTimeout(t);
      resolve({ stdout: out, stderr: err, code: code });
    });
    child.on('error', (e) => reject(e));
  });
}

function tmuxAvailable() {
  try {
    execFileSync('which', ['tmux'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function weztermAvailable() {
  const env = getCoordinatorEnv();
  try {
    const out = execSync('command -v wezterm 2>/dev/null || true', { encoding: 'utf8', env: { PATH: env.PATH || process.env.PATH } }).trim();
    if (out) return true;
  } catch (_) {}
  if (process.platform === 'darwin' && fs.existsSync('/Applications/WezTerm.app/Contents/MacOS/wezterm')) return true;
  return false;
}

// GET /api/ccb/debug-path — show what ccb_path the server sees (for troubleshooting "exited immediately")
app.get('/api/ccb/debug-path', (req, res) => {
  try {
    const cfg = readRdloopConfig();
    const raw = (cfg.ccb_path && typeof cfg.ccb_path === 'string') ? cfg.ccb_path.trim() : '';
    const ccbRoot = getCcbPath();
    const ccbBin = ccbRoot ? path.join(ccbRoot, 'bin') : null;
    const ccbScript = ccbRoot ? path.join(ccbRoot, 'ccb') : null;
    const pathEnv = (getCoordinatorEnv().PATH || process.env.PATH || '').trim();
    let python3Version = '';
    let tmuxVersion = '';
    try {
      python3Version = execSync('python3 --version 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
    } catch (e) {
      python3Version = (e.message || 'unknown').slice(0, 100);
    }
    try {
      tmuxVersion = execSync('tmux -V 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
    } catch (e) {
      tmuxVersion = (e.message || 'unknown').slice(0, 100);
    }
    res.json({
      config_raw: raw,
      resolved_ccb_root: ccbRoot || null,
      has_bin_dir: ccbBin ? fs.existsSync(ccbBin) : false,
      has_ccb_script: ccbScript ? fs.existsSync(ccbScript) : false,
      config_path: RDLOOP_CONFIG_PATH,
      path_preview: pathEnv.slice(0, 800),
      path_length: pathEnv.length,
      python3_version: python3Version,
      tmux_version: tmuxVersion
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ccb/session-status — list providers with tmux session, pid, ping status (supports ccb_* and CCB-native ccb-* sessions)
// P21: add ccb_instance { running, pid?, session_name?, work_dir? } from lock file + PID alive check
// P22: CCB_PROVIDERS includes claude/droid; CCB_PING_CMD includes lask/dask
app.get('/api/ccb/session-status', async (req, res) => {
  if (os.platform() === 'win32') {
    return res.status(400).json({ error: 'CCB session management is not supported on Windows. Please use WSL or macOS.' });
  }
  if (!tmuxAvailable()) {
    try {
      let workDirForLock = '';
      try {
        const cfg = readRdloopConfig();
        workDirForLock = (cfg.ccb_work_dir && typeof cfg.ccb_work_dir === 'string') ? cfg.ccb_work_dir.trim() : '';
      } catch {}
      if (!workDirForLock) workDirForLock = getProjectPath() || process.cwd();
      const lockScan = findCcbInstanceFromLockScan(workDirForLock);
      let ccb_instance = { running: false };
      let terminal_mode = 'unknown';
      const providers = [];
      if (lockScan.running) {
        ccb_instance = { running: true, pid: lockScan.pid, work_dir: lockScan.work_dir || workDirForLock };
        terminal_mode = 'wezterm';
      }
      // Always ping every provider so status lights are correct (even without tmux)
      const env = getCoordinatorEnv();
      for (const provider of CCB_PROVIDERS) {
        let status = 'off';
        let ping_ms = null;
        if (CCB_PING_CMD[provider]) {
          const pingResult = await pingCcbProvider('ccb-ping', [provider], 2500, workDirForLock);
          status = pingResult.status === 'ok' ? 'ok' : (pingResult.status === 'not_installed' ? 'not_installed' : 'unavailable');
          ping_ms = pingResult.ping_ms != null ? pingResult.ping_ms : null;
        } else status = 'ok';
        providers.push({ provider, session_name: null, pid: null, status, ping_ms, pane_id: null });
      }
      return res.json({ providers, tmux_available: false, message: 'tmux not installed', ccb_instance, terminal_mode, wezterm_available: weztermAvailable() });
    } catch (e) {
      return res.json({ providers: [], tmux_available: false, message: 'tmux not installed', ccb_instance: { running: false }, terminal_mode: 'unknown', wezterm_available: weztermAvailable() });
    }
  }
  try {
    let workDirForLock = '';
    try {
      const cfg = readRdloopConfig();
      workDirForLock = (cfg.ccb_work_dir && typeof cfg.ccb_work_dir === 'string') ? cfg.ccb_work_dir.trim() : '';
    } catch {}
    if (!workDirForLock) workDirForLock = getProjectPath() || process.cwd();

    const env = getCoordinatorEnv();
    // P25: ccb_instance from scanning all ccb-*.lock (any alive PID = running)
    const lockScan = findCcbInstanceFromLockScan(workDirForLock);
    let ccb_instance = { running: false };
    let sessionNameForInstance = null;
    if (lockScan.running) {
      sessionNameForInstance = await findCcbSessionNameByPid(lockScan.pid, env);
      ccb_instance = {
        running: true,
        pid: lockScan.pid,
        session_name: sessionNameForInstance || undefined,
        work_dir: lockScan.work_dir || workDirForLock
      };
    }
    const terminal_mode = ccb_instance.running
      ? (sessionNameForInstance ? 'tmux' : 'wezterm')
      : 'unknown';

    // P27: helper to get pane_id for a provider in a session (tmux user option @ccb_agent = Codex/Gemini/...)
    async function getPaneIdForProvider(sessionName, provider) {
      const cap = provider.charAt(0).toUpperCase() + provider.slice(1);
      const panesResult = await runTmux(['list-panes', '-t', sessionName, '-s', '-F', '#{pane_id} #{@ccb_agent}'], env, 1000);
      const lines = (panesResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        const match = line.match(/^(\S+)\s+(.*)$/);
        if (match && (match[2] === cap || match[2] === provider)) return match[1];
      }
      return null;
    }

    const listResult = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
    const allNames = (listResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
    const legacySessions = allNames.filter(s => {
      if (!s.startsWith(CCB_SESSION_PREFIX)) return false;
      const suffix = s.slice(CCB_SESSION_PREFIX.length);
      return CCB_PROVIDERS.includes(suffix); // only ccb_codex, ccb_gemini etc — not ccb_56113
    });
    const ccbNativeSessions = allNames.filter(s => isCcbNativeSessionName(s));
    const aiSessions = allNames.filter(s => s.startsWith('ai-'));

    // Always ping every provider first (source of truth for status lights; works regardless of tmux/wezterm/manual start)
    const providers = [];
    for (const provider of CCB_PROVIDERS) {
      let status = 'off';
      let ping_ms = null;
      if (CCB_PING_CMD[provider]) {
        const pingResult = await pingCcbProvider('ccb-ping', [provider], 2500, workDirForLock);
        status = pingResult.status === 'ok' ? 'ok' : (pingResult.status === 'not_installed' ? 'not_installed' : 'unavailable');
        ping_ms = pingResult.ping_ms != null ? pingResult.ping_ms : null;
      } else {
        status = 'ok';
      }
      providers.push({ provider, session_name: null, pid: null, status, ping_ms, pane_id: null });
    }

    // Enrich with tmux session info when available (session_name, pid, pane_id; keep status from ping)
    const sessionToProvider = new Map();
    for (const sessionName of legacySessions) {
      const provider = sessionName.slice(CCB_SESSION_PREFIX.length);
      if (CCB_PROVIDERS.includes(provider)) sessionToProvider.set(provider, sessionName);
    }
    const paneByProvider = new Map();
    const paneSessions = [...ccbNativeSessions, ...aiSessions];
    for (const sessionName of paneSessions) {
      const panesResult = await runTmux(['list-panes', '-t', sessionName, '-F', '#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}\t#{@ccb_agent}\t#{pane_title}'], env, 1200);
      const lines = (panesResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 6) continue;
        const paneId = (parts[0] || '').trim();
        const panePidRaw = (parts[1] || '').trim();
        const paneDeadRaw = (parts[2] || '').trim();
        const paneCmd = (parts[3] || '').trim();
        const agent = (parts[4] || '').trim();
        const paneTitle = (parts[5] || '').trim();
        const provider = providerFromPaneMeta(agent, paneTitle);
        if (!provider || paneByProvider.has(provider)) continue;
        paneByProvider.set(provider, {
          session_name: sessionName,
          pane_id: paneId || null,
          pid: /^\d+$/.test(panePidRaw) ? parseInt(panePidRaw, 10) : null,
          pane_dead: paneDeadRaw === '1',
          pane_command: paneCmd || null
        });
      }
    }
    for (const prov of providers) {
      const sessionName = sessionToProvider.get(prov.provider);
      const paneInfo = paneByProvider.get(prov.provider);
      if (paneInfo) {
        prov.session_name = paneInfo.session_name || null;
        prov.pane_id = paneInfo.pane_id || null;
        prov.pid = paneInfo.pid || null;
        prov.pane_dead = paneInfo.pane_dead === true;
        prov.pane_command = paneInfo.pane_command || null;
      } else if (sessionName) {
        prov.session_name = sessionName;
        prov.pane_id = await getPaneIdForProvider(sessionName, prov.provider);
        const panesResult = await runTmux(['list-panes', '-t', sessionName, '-F', '#{pane_pid}\t#{pane_dead}\t#{pane_current_command}'], env, 1000);
        const firstLine = (panesResult.stdout || '').split('\n')[0] || '';
        const firstParts = firstLine.split('\t');
        const firstPid = (firstParts[0] || '').trim();
        const firstDead = (firstParts[1] || '').trim();
        const firstCmd = (firstParts[2] || '').trim();
        if (firstPid && /^\d+$/.test(firstPid)) prov.pid = parseInt(firstPid, 10);
        prov.pane_dead = firstDead === '1';
        prov.pane_command = firstCmd || null;
      }
      const hasProviderRuntime = !!prov.pane_id || prov.session_name === (CCB_SESSION_PREFIX + prov.provider);
      if (prov.pane_dead === true && prov.status === 'ok') {
        prov.status = 'off';
        prov.ping_ms = null;
      } else if (!hasProviderRuntime && prov.status === 'ok' && terminal_mode === 'tmux') {
        // Daemon might still answer ping while provider pane/session is gone; show provider as off.
        prov.status = 'off';
        prov.ping_ms = null;
      }
    }

    providers.sort((a, b) => CCB_PROVIDERS.indexOf(a.provider) - CCB_PROVIDERS.indexOf(b.provider));

    res.json({ providers, tmux_available: true, ccb_instance, terminal_mode, wezterm_available: weztermAvailable() });
  } catch (err) {
    res.status(500).json({ providers: [], error: err.message, ccb_instance: { running: false }, terminal_mode: 'unknown', wezterm_available: weztermAvailable() });
  }
});

// POST /api/ccb/session/start — start CCB via native entry script (ccb <providers>); CCB manages tmux session, PATH, remain-on-exit
app.post('/api/ccb/session/start', requireWritable, async (req, res) => {
  if (os.platform() === 'win32') {
    return res.status(400).json({ error: 'CCB session management is not supported on Windows.' });
  }
  if (!tmuxAvailable()) {
    return res.status(400).json({ error: 'tmux not installed', hint: 'Install tmux (e.g. brew install tmux) to manage CCB sessions from GUI.' });
  }
  const body = req.body || {};
  const providers = Array.isArray(body.providers) ? body.providers : ['codex', 'gemini'];
  const workDir = (body.work_dir && typeof body.work_dir === 'string') ? body.work_dir.trim() : getProjectPath() || process.cwd();
  appendToCcbGuiLog('start', { providers, work_dir: workDir });

  const ccbRoot = getCcbPath();
  const ccbScript = ccbRoot && fs.existsSync(path.join(ccbRoot, 'ccb')) ? path.join(ccbRoot, 'ccb') : null;

  if (!ccbRoot) {
    appendToCcbGuiLog('start_error', { error: 'ccb_path not configured' });
    return res.status(400).json({
      ok: false,
      error: 'ccb_path not configured',
      hint: 'Set Settings → CCB directory (ccb_path) to your CCB repo root and save, then try again.'
    });
  }
  if (!ccbScript) {
    appendToCcbGuiLog('start_error', { error: 'CCB script not found', ccb_root: ccbRoot });
    return res.status(404).json({
      ok: false,
      error: 'CCB script not found',
      hint: 'Check that ccb_path points to a directory containing the "ccb" script (e.g. ' + ccbRoot + '/ccb).'
    });
  }

  const env = getCoordinatorEnv();
  const validProviders = providers.filter(p => CCB_PROVIDERS.includes(p));
  if (validProviders.length === 0) {
    return res.json({ ok: true, sessions: [], errors: [] });
  }

  // Check for existing CCB session before spawning a new one
  const preList = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
  const preNames = (preList.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  const existingCcb = preNames.find(n => isCcbNativeSessionName(n) || n.startsWith('ai-'));
  if (existingCcb) {
    appendToCcbGuiLog('start_reuse', { session: existingCcb });
    // Session exists — skip spawn, just ping providers and return status
    const sessions = [];
    for (const provider of validProviders) {
      let status = 'off';
      if (CCB_PING_CMD[provider]) {
        const pingResult = await pingCcbProvider('ccb-ping', [provider], 2500, workDir);
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

  // Run CCB inside a real terminal so tmux can attach to a TTY (headless spawn fails with "open terminal failed: not a terminal")
  const cmd = 'cd "' + workDir.replace(/"/g, '\\"') + '" && python3 "' + ccbScript.replace(/"/g, '\\"') + '" ' + validProviders.map(p => p.replace(/"/g, '\\"')).join(' ');
  if (os.platform() === 'darwin') {
    const script = 'tell application "Terminal" to do script "' + cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
  } else {
    const term = process.env.GNOME_TERMINAL ? 'gnome-terminal' : (process.env.KONSOLE_VERSION ? 'konsole' : 'xterm');
    const args = term === 'gnome-terminal' ? ['--', 'bash', '-c', cmd] : (term === 'konsole' ? ['-e', 'bash -c "' + cmd.replace(/"/g, '\\"') + '"'] : ['-e', cmd]);
    spawn(term, args, { stdio: 'ignore', detached: true }).unref();
  }
  appendToCcbGuiLog('start_spawn', { via: 'terminal', cmd: 'cd ' + workDir + ' && python3 ccb ' + validProviders.join(' ') });

  let stderrChunks = [];
  // No child stderr to capture; CCB runs in the opened terminal

  // Retry polling: CCB needs time to create tmux session and start providers
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

  const listResult = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
  const allNames = (listResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  const ccbSessionNames = allNames.filter(n => isCcbNativeSessionName(n));
  const aiSessionNames = allNames.filter(n => n.startsWith('ai-'));
  const firstCcbSession = foundSession || ccbSessionNames[0] || aiSessionNames[0] || null;

  const sessions = [];
  const errors = [];
  for (const provider of validProviders) {
    let status = 'off';
    if (CCB_PING_CMD[provider]) {
      const pingResult = await pingCcbProvider('ccb-ping', [provider], 2500, workDir);
      status = pingResult.status === 'ok' ? 'ok' : (pingResult.status === 'not_installed' ? 'not_installed' : 'unavailable');
    } else {
      status = firstCcbSession ? 'ok' : 'off';
    }
    sessions.push({
      provider,
      session_name: firstCcbSession || (status === 'ok' ? 'unknown' : null),
      status
    });
    if (status !== 'ok' && status !== 'off') {
      errors.push(provider + ': ' + status);
    }
  }

  const stderrSnippet = stderrChunks.length
    ? Buffer.concat(stderrChunks).toString('utf8').trim().split('\n').slice(-12).join('\n').slice(0, 500)
    : null;
  if (stderrSnippet) {
    errors.push('CCB stderr: ' + stderrSnippet);
    appendToCcbGuiLog('start_stderr', { snippet: stderrSnippet.slice(0, 300) });
  }
  appendToCcbGuiLog('start_done', {
    found_session: firstCcbSession || null,
    sessions: sessions.map(s => ({ provider: s.provider, status: s.status })),
    errors: errors.length ? errors : undefined
  });

  res.json({
    ok: true,
    sessions,
    session_ids: [...new Set(sessions.map(s => s.session_name).filter(Boolean))],
    errors: errors,
    ccb_stderr: stderrSnippet || undefined
  });
});

// GET /api/ccb/session/attach?provider=codex | ?session_name=ccb-xxx | ?terminal_mode=wezterm | ?pane_id=%0
// P28: When pane_id provided, select-pane then attach. When terminal_mode=wezterm, activate WezTerm.app.
app.get('/api/ccb/session/attach', async (req, res) => {
  if (os.platform() === 'win32') {
    return res.status(400).json({ error: 'Attach is not supported on Windows.' });
  }
  const terminalMode = (req.query.terminal_mode || '').trim();
  if (terminalMode === 'wezterm') {
    if (!weztermAvailable()) {
      return res.status(400).json({ error: 'WezTerm not installed', hint: 'Install WezTerm: brew install wezterm. Then start CCB from WezTerm and switch tabs to the desired provider.' });
    }
    try {
      execSync('osascript -e \'tell application "WezTerm" to activate\'', { stdio: 'pipe', timeout: 2000 });
    } catch (e) {
      return res.status(500).json({ error: 'Could not activate WezTerm', hint: 'Ensure WezTerm is installed and try again. You can also switch to the provider tab manually in WezTerm.' });
    }
    return res.json({ ok: true, action: 'wezterm_activate', message: 'WezTerm 管理多 pane，请在 WezTerm 内切换 tab 到对应 provider。' });
  }

  const env = getCoordinatorEnv();
  const listResult = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
  const allNames = (listResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);

  const sessionNameParam = (req.query.session_name || '').trim();
  if (sessionNameParam && allNames.includes(sessionNameParam)) {
    const paneId = (req.query.pane_id || '').trim();
    const attachCmd = paneId
      ? 'tmux select-pane -t ' + paneId + ' \\; attach-session -t ' + sessionNameParam
      : 'tmux attach -t ' + sessionNameParam;
    if (os.platform() === 'darwin') {
      const script = 'tell application "Terminal" to do script "' + attachCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
    } else {
      const term = process.env.GNOME_TERMINAL ? 'gnome-terminal' : (process.env.KONSOLE_VERSION ? 'konsole' : 'xterm');
      const args = term === 'gnome-terminal' ? ['--', 'tmux', 'select-pane', '-t', paneId, ';', 'attach-session', '-t', sessionNameParam] : (term === 'konsole' ? ['-e', attachCmd] : ['-e', attachCmd]);
      spawn(term, args, { stdio: 'ignore', detached: true }).unref();
    }
    return res.json({ ok: true, session: sessionNameParam, message: 'Terminal window should open; attach with: ' + attachCmd });
  }

  const provider = (req.query.provider || '').trim();
  if (!CCB_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'Invalid provider', hint: 'Use provider=codex|gemini|opencode|claude|droid or session_name=ccb-xxx' });
  }
  const legacyName = CCB_SESSION_PREFIX + provider;
  let sessionName = null;
  if (allNames.includes(legacyName)) {
    sessionName = legacyName;
  } else {
    const ccbNative = allNames.filter(n => isCcbNativeSessionName(n));
    if (CCB_PING_CMD[provider]) {
      let workDirForPing = '';
      try {
        const cfg = readRdloopConfig();
        workDirForPing = (cfg.ccb_work_dir && typeof cfg.ccb_work_dir === 'string') ? cfg.ccb_work_dir.trim() : '';
      } catch {}
      if (!workDirForPing) workDirForPing = getProjectPath() || process.cwd();
      const pingResult = await pingCcbProvider('ccb-ping', [provider], 2500, workDirForPing);
      if (pingResult.status === 'ok') {
        if (ccbNative.length > 0) {
          sessionName = ccbNative[0];
        } else {
          const aiSessions = allNames.filter(n => n.startsWith('ai-'));
          if (aiSessions.length > 0) sessionName = aiSessions[0];
        }
      }
    }
  }
  if (!sessionName) {
    return res.status(400).json({ error: 'Session not running', hint: 'Click "启动" for ' + provider + ' first, then "打开终端".' });
  }
  const paneId = (req.query.pane_id || '').trim();
  const attachCmd = paneId
    ? 'tmux select-pane -t ' + paneId + ' \\; attach-session -t ' + sessionName
    : 'tmux attach -t ' + sessionName;
  if (os.platform() === 'darwin') {
    const script = 'tell application "Terminal" to do script "' + attachCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
  } else {
    const term = process.env.GNOME_TERMINAL ? 'gnome-terminal' : (process.env.KONSOLE_VERSION ? 'konsole' : 'xterm');
    const fullCmd = paneId ? ('tmux select-pane -t ' + paneId + ' ; tmux attach -t ' + sessionName) : ('tmux attach -t ' + sessionName);
    const args = term === 'gnome-terminal' ? ['--', 'bash', '-c', fullCmd] : (term === 'konsole' ? ['-e', fullCmd] : ['-e', fullCmd]);
    spawn(term, args, { stdio: 'ignore', detached: true }).unref();
  }
  res.json({ ok: true, session: sessionName, message: 'Terminal window should open; attach with: ' + attachCmd });
});

// POST /api/ccb/session/open-terminal — open Terminal.app (or system terminal) and run ccb <providers> in it so user sees a terminal and session is created there
// P20: If an active CCB instance exists (lock file + PID alive), attach to its tmux session instead of starting a new one; if stale lock, remove it then start.
app.post('/api/ccb/session/open-terminal', requireWritable, async (req, res) => {
  if (os.platform() === 'win32') {
    return res.status(400).json({ error: 'Open terminal is not supported on Windows.' });
  }
  const ccbRoot = getCcbPath();
  const ccbScript = ccbRoot && fs.existsSync(path.join(ccbRoot, 'ccb')) ? path.join(ccbRoot, 'ccb') : null;
  if (!ccbScript) {
    return res.status(400).json({
      error: 'CCB script not found',
      hint: 'Set Settings → CCB directory (ccb_path) and save, then try again.'
    });
  }
  const body = req.body || {};
  const providers = Array.isArray(body.providers) && body.providers.length > 0
    ? body.providers.filter(p => CCB_PROVIDERS.includes(p))
    : ['codex'];
  if (providers.length === 0) {
    return res.status(400).json({ error: 'No valid providers', hint: 'Use providers: [\'codex\'] or [\'codex\', \'gemini\']' });
  }
  let workDir = (body.work_dir && typeof body.work_dir === 'string') ? body.work_dir.trim() : '';
  if (!workDir) {
    try {
      const cfg = readRdloopConfig();
      workDir = (cfg.ccb_work_dir && typeof cfg.ccb_work_dir === 'string') ? cfg.ccb_work_dir.trim() : '';
    } catch {}
  }
  if (!workDir) {
    const projectPath = getProjectPath();
    workDir = projectPath || process.cwd();
  }
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    return res.status(400).json({ error: 'Work directory does not exist', work_dir: workDir });
  }

  const lockPath = getCcbLockPath(workDir);
  let cleanedStale = false;
  if (fs.existsSync(lockPath)) {
    try {
      const pidStr = fs.readFileSync(lockPath, 'utf8').trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && isPidAlive(pid)) {
        const env = getCoordinatorEnv();
        const sessionName = await findCcbSessionNameByPid(pid, env);
        if (sessionName) {
          const attachCmd = 'tmux attach -t ' + sessionName;
          if (os.platform() === 'darwin') {
            const script = 'tell application "Terminal" to do script "' + attachCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
            spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
          } else {
            const term = process.env.GNOME_TERMINAL ? 'gnome-terminal' : (process.env.KONSOLE_VERSION ? 'konsole' : 'xterm');
            const args = term === 'gnome-terminal' ? ['--', 'tmux', 'attach', '-t', sessionName] : (term === 'konsole' ? ['-e', attachCmd] : ['-e', attachCmd]);
            spawn(term, args, { stdio: 'ignore', detached: true }).unref();
          }
          return res.json({ ok: true, action: 'attached', pid, session_name: sessionName });
        }
        return res.json({ ok: true, action: 'no_session', pid, message: 'CCB process running but no tmux session found; attach manually if needed.' });
      }
      fs.unlinkSync(lockPath);
      cleanedStale = true;
    } catch (e) {
      try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch {}
      cleanedStale = true;
    }
  }

  const cmd = 'cd "' + workDir.replace(/"/g, '\\"') + '" && python3 "' + ccbScript.replace(/"/g, '\\"') + '" ' + providers.map(p => p.replace(/"/g, '\\"')).join(' ');
  if (os.platform() === 'darwin') {
    const script = 'tell application "Terminal" to do script "' + cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
  } else {
    const term = process.env.GNOME_TERMINAL ? 'gnome-terminal' : (process.env.KONSOLE_VERSION ? 'konsole' : 'xterm');
    const attachCmd = term === 'gnome-terminal' ? ['--', 'bash', '-c', cmd] : (term === 'konsole' ? ['-e', 'bash -c "' + cmd.replace(/"/g, '\\"') + '"'] : ['-e', cmd]);
    spawn(term, attachCmd, { stdio: 'ignore', detached: true }).unref();
  }
  res.json({ ok: true, action: 'started', message: 'Terminal should open with: cd ' + workDir + ' && ccb ' + providers.join(' '), ...(cleanedStale ? { cleaned_stale: true } : {}) });
});

// POST /api/ccb/session/open-wezterm — open WezTerm and run ccb <providers> (all agents in one WezTerm window)
app.post('/api/ccb/session/open-wezterm', requireWritable, async (req, res) => {
  if (os.platform() === 'win32') {
    return res.status(400).json({ error: 'Open WezTerm from GUI is not supported on Windows.', hint: 'Run WezTerm manually and execute ccb in it.' });
  }
  const ccbRoot = getCcbPath();
  const ccbScript = ccbRoot && fs.existsSync(path.join(ccbRoot, 'ccb')) ? path.join(ccbRoot, 'ccb') : null;
  if (!ccbScript) {
    return res.status(400).json({
      error: 'CCB script not found',
      hint: 'Set Settings → CCB directory (ccb_path) and save, then try again.'
    });
  }
  const env = getCoordinatorEnv();
  let weztermPath = '';
  try {
    weztermPath = execSync('command -v wezterm 2>/dev/null || true', {
      encoding: 'utf8',
      env: { PATH: env.PATH || process.env.PATH }
    }).trim();
  } catch (_) {}
  if (!weztermPath && process.platform === 'darwin') {
    const appCli = '/Applications/WezTerm.app/Contents/MacOS/wezterm';
    if (fs.existsSync(appCli)) {
      weztermPath = appCli;
    }
  }
  if (!weztermPath) {
    return res.status(400).json({
      error: 'WezTerm not found',
      hint: 'Install WezTerm (e.g. brew install wezterm) or run ccb manually inside WezTerm. See CCB README for WezTerm setup.'
    });
  }
  const weztermBin = weztermPath || 'wezterm';
  const body = req.body || {};
  const providers = Array.isArray(body.providers) && body.providers.length > 0
    ? body.providers.filter(p => CCB_PROVIDERS.includes(p))
    : ['codex'];
  if (providers.length === 0) {
    return res.status(400).json({ error: 'No valid providers', hint: 'Use providers: [\'codex\'] or [\'codex\', \'gemini\']' });
  }
  let workDir = (body.work_dir && typeof body.work_dir === 'string') ? body.work_dir.trim() : '';
  if (!workDir) {
    try {
      const cfg = readRdloopConfig();
      workDir = (cfg.ccb_work_dir && typeof cfg.ccb_work_dir === 'string') ? cfg.ccb_work_dir.trim() : '';
    } catch {}
  }
  if (!workDir) {
    workDir = getProjectPath() || process.cwd();
  }
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    return res.status(400).json({ error: 'Work directory does not exist', work_dir: workDir });
  }
  const cmd = 'cd "' + workDir.replace(/"/g, '\\"') + '" && python3 "' + ccbScript.replace(/"/g, '\\"') + '" ' + providers.map(p => p.replace(/"/g, '\\"')).join(' ');
  spawn(weztermBin, ['start', '--', 'bash', '-c', cmd], {
    env: { ...env, CCB_TERMINAL: 'wezterm' },
    stdio: 'ignore',
    detached: true
  }).unref();
  res.json({ ok: true, message: 'WezTerm window should open with CCB; all agents will appear in one window.' });
});

// POST /api/ccb/session/stop — kill tmux session(s) (legacy ccb_* and CCB-native ccb-*)
app.post('/api/ccb/session/stop', requireWritable, async (req, res) => {
  if (os.platform() === 'win32') return res.status(400).json({ error: 'Not supported on Windows.' });
  if (!tmuxAvailable()) return res.status(400).json({ error: 'tmux not installed' });
  const body = req.body || {};
  const toStop = Array.isArray(body.providers) && body.providers.length > 0 ? body.providers : null;
  const env = getCoordinatorEnv();
  const listResult = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
  const allNames = (listResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  let sessionNames = [];
  const killedPanes = [];
  if (toStop) {
    const targetProviders = [...new Set(toStop.filter(p => CCB_PROVIDERS.includes(p)))];
    sessionNames = targetProviders
      .map(p => CCB_SESSION_PREFIX + p)
      .filter(name => allNames.includes(name));

    // CCB native multi-provider sessions: only kill panes belonging to target provider(s).
    const multiSessions = allNames.filter(n => isCcbNativeSessionName(n) || n.startsWith('ai-'));
    for (const sessionName of multiSessions) {
      const panesResult = await runTmux(['list-panes', '-t', sessionName, '-F', '#{pane_id}\t#{@ccb_agent}\t#{pane_title}'], env, 1000);
      const lines = (panesResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const paneId = (parts[0] || '').trim();
        const provider = providerFromPaneMeta(parts[1], parts[2]);
        if (!paneId || !provider || !targetProviders.includes(provider)) continue;
        await runTmux(['kill-pane', '-t', paneId], env, 1500);
        killedPanes.push({ provider, pane_id: paneId, session_name: sessionName });
      }
    }
  } else {
    // Stop All should target CCB-managed sessions only.
    sessionNames = allNames.filter(s => s.startsWith(CCB_SESSION_PREFIX) || isCcbNativeSessionName(s));
    const lockScan = findCcbInstanceFromLockScan('');
    if (lockScan.running && lockScan.pid != null) {
      const sessionByPid = await findCcbSessionNameByPid(lockScan.pid, env);
      if (sessionByPid && !sessionNames.includes(sessionByPid)) sessionNames.push(sessionByPid);
    }
  }
  for (const name of sessionNames) {
    await runTmux(['kill-session', '-t', name], env, 2000);
  }
  appendToCcbGuiLog('stop', {
    providers_requested: toStop || 'all',
    sessions_killed: sessionNames,
    panes_killed: killedPanes
  });
  res.json({ ok: true, stopped: sessionNames, panes_stopped: killedPanes });
});

// POST /api/ccb/session/kill-instance — kill the currently active CCB process (lock-holder PID)
app.post('/api/ccb/session/kill-instance', requireWritable, async (req, res) => {
  if (os.platform() === 'win32') return res.status(400).json({ error: 'Not supported on Windows.' });
  let workDirForLock = '';
  try {
    const cfg = readRdloopConfig();
    workDirForLock = (cfg.ccb_work_dir && typeof cfg.ccb_work_dir === 'string') ? cfg.ccb_work_dir.trim() : '';
  } catch (_) {}
  if (!workDirForLock) workDirForLock = getProjectPath() || process.cwd();
  const lockScan = findCcbInstanceFromLockScan(workDirForLock);
  if (!lockScan.running || lockScan.pid == null) {
    appendToCcbGuiLog('kill_instance', { result: 'not_found', work_dir: workDirForLock });
    return res.status(404).json({ error: 'No active CCB instance found.', hint: 'CCB may already be stopped.' });
  }
  const pid = lockScan.pid;
  try {
    if (!isPidAlive(pid)) {
      appendToCcbGuiLog('kill_instance', { pid, result: 'already_exited' });
      return res.status(404).json({ error: 'CCB process no longer running.', pid });
    }
    process.kill(pid, 'SIGTERM');
    appendToCcbGuiLog('kill_instance', { pid, result: 'SIGTERM_sent' });
    res.json({ ok: true, pid, message: 'CCB process sent SIGTERM.' });
  } catch (err) {
    if (err && err.code === 'ESRCH') {
      appendToCcbGuiLog('kill_instance', { pid, result: 'ESRCH_already_exited' });
      return res.status(404).json({ error: 'CCB process already exited.', pid });
    }
    appendToCcbGuiLog('kill_instance', { pid, result: 'error', error: err.message });
    res.status(500).json({ ok: false, error: err.message, pid });
  }
});

// P21: POST /api/ccb/session/cleanup — run ccb-cleanup --clean to remove stale locks and state files
app.post('/api/ccb/session/cleanup', requireWritable, async (req, res) => {
  if (os.platform() === 'win32') return res.status(400).json({ error: 'Not supported on Windows.' });
  const ccbRoot = getCcbPath();
  const ccbBin = ccbRoot && fs.existsSync(path.join(ccbRoot, 'bin')) ? path.join(ccbRoot, 'bin', 'ccb-cleanup') : null;
  const cleanupBin = (ccbBin && fs.existsSync(ccbBin)) ? ccbBin : 'ccb-cleanup';
  const env = getCoordinatorEnv();
  const cleaned_sessions = [];
  const cmd = (ccbBin && fs.existsSync(ccbBin)) ? 'python3' : 'ccb-cleanup';
  const cmdArgs = cmd === 'python3' ? [ccbBin, '--clean'] : ['--clean'];
  appendToCcbGuiLog('cleanup', {});
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { env: { ...env, PATH: env.PATH || process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += (c && c.toString()) || ''; });
    child.on('close', (code) => {
      const lines = (out || '').split('\n').filter(Boolean);
      for (const line of lines) {
        const m = line.match(/Removed (?:stale lock: |stale state file: )?(.+)/);
        if (m) cleaned_sessions.push(m[1].trim());
      }
      appendToCcbGuiLog('cleanup_done', { cleaned_sessions });
      res.json({ ok: true, cleaned_sessions });
      resolve();
    });
    child.on('error', (e) => {
      res.status(500).json({ ok: false, error: e.message, cleaned_sessions: [] });
      resolve();
    });
  });
});

// POST /api/ccb/session/restart — stop then start via CCB native entry
app.post('/api/ccb/session/restart', requireWritable, async (req, res) => {
  if (os.platform() === 'win32') return res.status(400).json({ error: 'Not supported on Windows.' });
  if (!tmuxAvailable()) return res.status(400).json({ error: 'tmux not installed' });
  const body = req.body || {};
  const providers = Array.isArray(body.providers) && body.providers.length > 0 ? body.providers : ['codex', 'gemini'];
  const workDir = (body.work_dir && typeof body.work_dir === 'string') ? body.work_dir.trim() : getProjectPath() || process.cwd();
  const env = getCoordinatorEnv();
  appendToCcbGuiLog('restart', { providers, work_dir: workDir });
  const listResult = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
  const allNames = (listResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  const toKill = allNames.filter(s => s.startsWith(CCB_SESSION_PREFIX) || isCcbNativeSessionName(s) || s.startsWith('ai-'));
  for (const name of toKill) {
    await runTmux(['kill-session', '-t', name], env, 2000);
  }
  appendToCcbGuiLog('restart_stopped', { sessions: toKill });
  const ccbRoot = getCcbPath();
  const ccbScript = ccbRoot && fs.existsSync(path.join(ccbRoot, 'ccb')) ? path.join(ccbRoot, 'ccb') : null;
  const validProviders = providers.filter(p => CCB_PROVIDERS.includes(p));
  if (ccbScript && validProviders.length > 0) {
    const noTmuxEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !['TMUX', 'TMUX_PANE', 'WEZTERM_PANE'].includes(k)));
    const child = spawn('python3', [ccbScript, ...validProviders], {
      env: { ...noTmuxEnv, CCB_GUI_LAUNCH: '1' },
      cwd: fs.existsSync(workDir) ? workDir : process.cwd(),
      stdio: 'ignore',
      detached: true
    });
    child.unref();
    appendToCcbGuiLog('restart_spawn', { pid: child.pid });
  }
  res.json({ ok: true, restarted: validProviders });
});

// GET /api/ccb/session/log — GUI operations log (primary) + optional tmux pane capture
app.get('/api/ccb/session/log', async (req, res) => {
  if (os.platform() === 'win32') return res.status(400).json({ error: 'Not supported on Windows.' });
  const linesParam = Math.min(parseInt(req.query.lines, 10) || 50, 200);
  const guiLog = readCcbGuiLogTail(linesParam);
  let paneLog = '';
  if (tmuxAvailable()) {
    const env = getCoordinatorEnv();
    const listResult = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
    const sessionNames = (listResult.stdout || '').split('\n').map(s => s.trim()).filter(s => s.startsWith(CCB_SESSION_PREFIX) || isCcbNativeSessionName(s) || s.startsWith('ai-'));
    const firstSession = sessionNames[0];
    if (firstSession) {
      const capResult = await runTmux(['capture-pane', '-t', firstSession, '-p', '-S', String(-Math.min(50, linesParam))], env, 2000);
      paneLog = (capResult.stdout || '').trim();
    }
  }
  res.json({
    log: guiLog || '(no CCB GUI log yet)',
    log_path: CCB_GUI_LOG_ACTUAL_PATH,
    lines: guiLog ? guiLog.split('\n').filter(Boolean).length : 0,
    pane_log: paneLog || undefined
  });
});

// GET /api/ccb/agent-status — run script/ccb-agent-status.sh (text or --json), env includes CCB bin in PATH
app.get('/api/ccb/agent-status', (req, res) => {
  if (os.platform() === 'win32') return res.status(400).json({ error: 'Not supported on Windows.' });
  const jsonMode = (req.query.format || '').toLowerCase() === 'json';
  const scriptPath = path.join(RDLOOP_ROOT, '..', 'script', 'ccb-agent-status.sh');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'ccb-agent-status.sh not found', path: scriptPath });
  }
  const env = getCoordinatorEnv();
  const args = jsonMode ? ['--json'] : [];
  return new Promise((resolve) => {
    const child = spawn('bash', [scriptPath, ...args], {
      env: { ...env, PATH: env.PATH || process.env.PATH },
      cwd: getProjectPath() || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += (c && c.toString()) || ''; });
    child.stderr.on('data', (c) => { err += (c && c.toString()) || ''; });
    child.on('close', (code) => {
      if (jsonMode) {
        try {
          const data = JSON.parse(out.trim());
          res.json({ ok: true, ...data, stderr: err || undefined });
        } catch (e) {
          res.status(500).json({ ok: false, error: 'Invalid JSON from script', stdout: out.slice(0, 500), stderr: err });
        }
        resolve();
        return;
      }
      res.json({ ok: true, text: out.trim() || '(no output)', stderr: err || undefined });
      resolve();
    });
    child.on('error', (e) => {
      res.status(500).json({ ok: false, error: e.message });
      resolve();
    });
  });
});

// P13: ccb.config under project_path .ccb/ccb.config
const CCB_CONFIG_PROVIDERS = ['codex', 'gemini', 'opencode', 'claude', 'droid'];

app.get('/api/ccb/config', (req, res) => {
  try {
    const projectPath = getProjectPathOrCcbWorkDir();
    if (!projectPath) {
      return res.status(404).json({ error: 'project_path or ccb_work_dir not configured (set in Rdloop config or CCB 工作目录)' });
    }
    const ccbDir = path.join(projectPath, '.ccb');
    const configPath = path.join(ccbDir, 'ccb.config');
    let raw_text = '';
    if (fs.existsSync(configPath)) {
      raw_text = fs.readFileSync(configPath, 'utf8');
    }
    const providers = [];
    const seen = new Set();
    for (const line of raw_text.split(/\r?\n/)) {
      const p = line.trim().toLowerCase();
      if (CCB_CONFIG_PROVIDERS.includes(p) && !seen.has(p)) {
        providers.push(p);
        seen.add(p);
      }
    }
    res.json({ providers, raw_text, path: configPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/ccb/config', requireWritable, (req, res) => {
  try {
    const projectPath = getProjectPathOrCcbWorkDir();
    if (!projectPath) {
      return res.status(404).json({ error: 'project_path or ccb_work_dir not configured (set in Rdloop config or CCB 工作目录)' });
    }
    const body = req.body || {};
    const providers = Array.isArray(body.providers) ? body.providers : [];
    const valid = providers.filter(p => CCB_CONFIG_PROVIDERS.includes(String(p).toLowerCase()));
    const ccbDir = path.join(projectPath, '.ccb');
    if (!fs.existsSync(ccbDir)) fs.mkdirSync(ccbDir, { recursive: true });
    const configPath = path.join(ccbDir, 'ccb.config');
    const content = valid.join('\n') + (valid.length ? '\n' : '');
    const tmpPath = configPath + '.tmp.' + crypto.randomBytes(6).toString('hex');
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, content, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, configPath);
    res.json({ ok: true, providers: valid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/adapters', (req, res) => {
  try {
    const adapters = detectAdapters();
    res.json({ adapters, allow_partial_run: ALLOW_PARTIAL_RUN });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cliapi: provider -> models (for second-level model selector). API key: openclawaousers.
app.get('/api/cliapi-providers', (req, res) => {
  try {
    if (!fs.existsSync(CLIAPI_PROVIDERS_PATH)) {
      return res.json({ api_key_profile: 'openclawaousers', providers: {} });
    }
    const data = readJSON(CLIAPI_PROVIDERS_PATH);
    res.json({
      api_key_profile: data.api_key_profile || 'openclawaousers',
      providers: data.providers || {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Map providerId to gateway-owned_by so we only show that provider's models (8317 returns all channels in one list).
const PROVIDER_OWNED_BY = {
  'antigravity-cli': 'antigravity',
  'codex-cli': 'openai',
  'claude-cli': 'anthropic'
};

// Live models from provider gateway (GET /v1/models). Used when provider is selected so dropdown shows actual supported models.
app.get('/api/cliapi-providers/:providerId/models', async (req, res) => {
  try {
    const data = readJSON(CLIAPI_PROVIDERS_PATH);
    const providers = (data && data.providers) || {};
    const providerId = req.params.providerId;
    const p = providers[providerId];
    if (!p || !p.base_url) {
      return res.json({ models: [] });
    }
    const baseUrl = String(p.base_url).replace(/\/$/, '');
    const apiKey = process.env.OPENCLAW_API_KEY || 'openclawaousers';
    const url = `${baseUrl}/models`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.json({ models: [], error: body?.error?.message || response.statusText });
    }
    let dataList = Array.isArray(body.data) ? body.data : [];
    const ownedBy = PROVIDER_OWNED_BY[providerId];
    if (ownedBy) {
      dataList = dataList.filter((m) => (m.owned_by || '') === ownedBy);
    }
    const models = dataList.map((m) => {
      const id = m.id || m.model || '';
      return { id, alias: m.name || m.alias || id };
    }).filter((m) => m.id);
    return res.json({ models });
  } catch (err) {
    return res.json({ models: [], error: err.message });
  }
});

// A6-1: GET/PUT /api/config — default coder/judge from rdloop.config.json (C1-2)
function readRdloopConfig() {
  try {
    if (fs.existsSync(RDLOOP_CONFIG_PATH)) {
      const data = readJSON(RDLOOP_CONFIG_PATH);
      return data || {};
    }
  } catch {}
  return {};
}

// Resolve project path for read-only aggregate APIs (v3.0): env > config
function getProjectPath() {
  if (process.env.RDLOOP_PROJECT_PATH) {
    const p = path.resolve(process.env.RDLOOP_PROJECT_PATH);
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p; } catch {}
  }
  try {
    const cfg = readRdloopConfig();
    if (cfg.project_path && typeof cfg.project_path === 'string') {
      const p = path.isAbsolute(cfg.project_path) ? path.normalize(cfg.project_path) : path.resolve(RDLOOP_ROOT, cfg.project_path);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    }
  } catch {}
  return null;
}

// For CCB config (P13): use project path, or fall back to ccb_work_dir so saving "default providers" works when only ccb_work_dir is set
function getProjectPathOrCcbWorkDir() {
  const p = getProjectPath();
  if (p) return p;
  try {
    const cfg = readRdloopConfig();
    const raw = (cfg.ccb_work_dir && typeof cfg.ccb_work_dir === 'string') ? cfg.ccb_work_dir.trim() : '';
    if (!raw) return null;
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(RDLOOP_ROOT, raw);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  } catch {}
  return null;
}

// GET /api/project/tasks — read-only aggregate: session_state.json (task list + shared_contracts)
app.get('/api/project/tasks', (req, res) => {
  try {
    const projectPath = getProjectPath();
    if (!projectPath) return res.status(404).json({ error: 'project_path not configured or invalid (set RDLOOP_PROJECT_PATH or rdloop.config.json project_path)' });
    const sessionStatePath = path.join(projectPath, '.context', 'session_state.json');
    if (!fs.existsSync(sessionStatePath)) return res.status(404).json({ error: 'session_state.json not found' });
    const data = readJSON(sessionStatePath);
    if (!data) return res.status(404).json({ error: 'session_state.json unreadable' });
    res.json({
      tasks: data.tasks || [],
      shared_contracts: data.shared_contracts || {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/project/steps/:task_id — read-only aggregate: .ccb/state.json (step list + current step)
// When steps[].task_id exists, filter to steps matching req.params.task_id; else return all (backward compat).
app.get('/api/project/steps/:task_id', (req, res) => {
  try {
    const projectPath = getProjectPath();
    if (!projectPath) return res.status(404).json({ error: 'project_path not configured or invalid' });
    const ccbStatePath = path.join(projectPath, '.ccb', 'state.json');
    if (!fs.existsSync(ccbStatePath)) return res.status(404).json({ error: '.ccb/state.json not found' });
    const data = readJSON(ccbStatePath);
    if (!data) return res.status(404).json({ error: '.ccb/state.json unreadable' });
    let steps = data.steps || [];
    const taskId = req.params.task_id;
    const hasTaskId = steps.length > 0 && steps[0].task_id !== undefined;
    if (hasTaskId && taskId) {
      steps = steps.filter(s => s.task_id === taskId);
    }
    res.json({
      steps,
      current_step: data.current || null,
      step_index: data.stepIndex
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge — read-only aggregate: knowledge_cache.json entries (by last_modified_at desc)
// Uses shared file lock when .lock exists so PM does not read while executor is writing.
app.get('/api/knowledge', (req, res) => {
  try {
    const projectPath = getProjectPath();
    if (!projectPath) return res.status(404).json({ error: 'project_path not configured or invalid' });
    const cachePath = path.join(projectPath, '.context', 'knowledge_cache.json');
    if (!fs.existsSync(cachePath)) return res.status(404).json({ error: 'knowledge_cache.json not found' });
    const data = readKnowledgeCacheWithLock(cachePath);
    if (!data) return res.status(404).json({ error: 'knowledge_cache.json unreadable' });
    const entries = data.entries || {};
    const list = Object.entries(entries).map(([key, val]) => ({
      key,
      ...val,
      last_modified_at: val.last_modified_at || val.last_updated || ''
    }));
    list.sort((a, b) => (b.last_modified_at || '').localeCompare(a.last_modified_at || ''));
    res.json({ entries: list, last_updated: data.last_updated || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Knowledge Shard CRUD API ─────────────────────────────────────────────
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

function updateShardMeta(knowledgeDir, shardName, shardData) {
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
  updateShardMeta(kdir, name, data);
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
  updateShardMeta(kdir, shard, data);
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
  updateShardMeta(kdir, shard, data);
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
  updateShardMeta(kdir, shard, data);
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

// P10: Validate agent_root — must exist and contain .context/rules/collab_context.md
function validateAgentRoot(agentRoot) {
  if (!agentRoot || typeof agentRoot !== 'string') return { valid: true, value: '' };
  const trimmed = agentRoot.trim();
  if (!trimmed) return { valid: true, value: '' };
  const absPath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(RDLOOP_ROOT, trimmed);
  if (!fs.existsSync(absPath)) {
    return { valid: false, error: 'Path does not exist' };
  }
  try {
    if (!fs.statSync(absPath).isDirectory()) {
      return { valid: false, error: 'Path is not a directory' };
    }
  } catch (e) {
    return { valid: false, error: e.message || 'Invalid path' };
  }
  const collabPath = path.join(absPath, '.context', 'rules', 'collab_context.md');
  if (!fs.existsSync(collabPath)) {
    return { valid: false, error: 'Path must contain .context/rules/collab_context.md' };
  }
  return { valid: true, value: absPath };
}

// P08: Resolve Agent root from config (for /api/agent/roles)
function getAgentRoot() {
  const cfg = readRdloopConfig();
  const raw = (cfg.agent_root && typeof cfg.agent_root === 'string') ? cfg.agent_root.trim() : '';
  if (!raw) return null;
  const validation = validateAgentRoot(raw);
  return validation.valid && validation.value ? validation.value : null;
}

const ALLOWED_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode', 'droid'];

// P08: Parse Role Assignment table from collab_context.md (| role | provider | scope |)
function parseRoleTable(content) {
  const roles = [];
  const sectionMatch = content.match(/##\s*Role Assignment\s*\(canonical\)\s*\n\n(\|[^\n]+\|\n\|[^\n]+\|\n(?:\|[^\n]+\|\n)*)/);
  if (!sectionMatch) return roles;
  const tableBlock = sectionMatch[1];
  const lines = tableBlock.split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 2) return roles;
  const header = lines[0];
  const sep = lines[1];
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 2) {
      const role = cells[0];
      const provider = cells[1];
      const scope = cells[2] || '';
      const assignable = true;
      roles.push({ role, provider, scope, assignable });
    }
  }
  return roles;
}

// P08: Update only provider column in Role Assignment table; other content byte-identical
function updateRoleTableProvider(content, updates) {
  const updateMap = {};
  (updates || []).forEach(u => {
    if (u && u.role && ALLOWED_PROVIDERS.includes(u.provider)) {
      updateMap[u.role] = u.provider;
    }
  });
  if (Object.keys(updateMap).length === 0) return content;

  let inRoleTable = false;
  const lines = content.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/##\s*Role Assignment\s*\(canonical\)/.test(line)) {
      inRoleTable = true;
      out.push(line);
      continue;
    }
    if (inRoleTable) {
      const match = line.match(/^(\|[^|]+\|\s*)[^|]+(\s*\|.*)$/);
      if (match) {
        const roleCell = match[1];
        const rest = match[2];
        const role = match[1].replace(/\|/g, '').trim();
        const newProvider = updateMap[role];
        if (newProvider !== undefined) {
          out.push(roleCell + newProvider + rest);
          continue;
        }
      } else if (line.trim() === '' || line.startsWith('|')) {
        out.push(line);
        continue;
      } else {
        inRoleTable = false;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

// P08: GET /api/agent/roles — read collab_context.md Role Assignment
app.get('/api/agent/roles', (req, res) => {
  try {
    const agentRoot = getAgentRoot();
    if (!agentRoot) {
      return res.status(404).json({ error: 'agent_root not configured', detail: 'Set agent_root in Settings (rdloop.config.json)' });
    }
    const collabPath = path.join(agentRoot, '.context', 'rules', 'collab_context.md');
    if (!fs.existsSync(collabPath)) {
      return res.status(404).json({ error: 'collab_context.md not found' });
    }
    const content = fs.readFileSync(collabPath, 'utf8');
    const roles = parseRoleTable(content);
    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// P08: PUT /api/agent/roles — update only provider column; atomic write
app.put('/api/agent/roles', requireWritable, (req, res) => {
  try {
    const agentRoot = getAgentRoot();
    if (!agentRoot) {
      return res.status(404).json({ error: 'agent_root not configured', detail: 'Set agent_root in Settings (rdloop.config.json)' });
    }
    const collabPath = path.join(agentRoot, '.context', 'rules', 'collab_context.md');
    if (!fs.existsSync(collabPath)) {
      return res.status(404).json({ error: 'collab_context.md not found' });
    }
    const updates = req.body;
    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: 'Body must be an array of { role, provider }' });
    }
    if (updates.some(u => u && u.role === 'PM' && u.provider !== undefined && !ALLOWED_PROVIDERS.includes(u.provider))) {
      return res.status(400).json({ error: 'PM provider must be one of: ' + ALLOWED_PROVIDERS.join(', ') });
    }
    const content = fs.readFileSync(collabPath, 'utf8');
    const newContent = updateRoleTableProvider(content, updates);
    if (newContent === content) {
      return res.json(parseRoleTable(content));
    }
    const dir = path.dirname(collabPath);
    const tmpPath = path.join(dir, 'collab_context.md.tmp.' + crypto.randomBytes(6).toString('hex'));
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, newContent, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, collabPath);
    const roles = parseRoleTable(newContent);
    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// P15: Validate repo_path for form feedback (exists, is directory)
app.get('/api/validate-path', (req, res) => {
  try {
    const raw = (req.query.path || req.body?.path || '').trim();
    if (!raw) {
      return res.json({ valid: false, exists: false, isDirectory: false, error: 'path is empty' });
    }
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(RDLOOP_ROOT, raw);
    const exists = fs.existsSync(resolved);
    let isDirectory = false;
    if (exists) {
      try {
        isDirectory = fs.statSync(resolved).isDirectory();
      } catch (_) {}
    }
    const valid = exists && isDirectory;
    res.json({ valid, exists, isDirectory, resolvedPath: resolved, error: valid ? null : (exists ? 'Not a directory' : 'Path does not exist') });
  } catch (err) {
    res.status(500).json({ valid: false, exists: false, isDirectory: false, error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  try {
    const cfg = readRdloopConfig();
    let agent_root = (cfg.agent_root && typeof cfg.agent_root === 'string') ? cfg.agent_root.trim() : '';
    if (!agent_root && RDLOOP_ROOT) {
      const inferred = path.resolve(RDLOOP_ROOT, '..', 'Agent');
      if (fs.existsSync(inferred) && fs.existsSync(path.join(inferred, '.context', 'rules', 'collab_context.md'))) {
        agent_root = inferred;
      }
    }
    const project_path = getProjectPath();
    const ccb_path = (cfg.ccb_path && typeof cfg.ccb_path === 'string') ? cfg.ccb_path.trim() : '';
    const ccb_work_dir = (cfg.ccb_work_dir && typeof cfg.ccb_work_dir === 'string') ? cfg.ccb_work_dir.trim() : '';
    const ccb_auto_open_terminal = cfg.ccb_auto_open_terminal !== false;
    const use_wezterm_for_all = cfg.use_wezterm_for_all === true;
    res.json({
      default_coder: cfg.default_coder || null,
      default_judge: cfg.default_judge || null,
      default_coder_model: cfg.default_coder_model || null,
      default_judge_model: cfg.default_judge_model || null,
      default_execution_mode: cfg.default_execution_mode || 'auto',
      agent_root: agent_root || null,
      project_path: project_path || null,
      ccb_path: ccb_path || null,
      ccb_work_dir: ccb_work_dir || null,
      ccb_auto_open_terminal,
      use_wezterm_for_all,
      wezterm_available: weztermAvailable()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', requireWritable, (req, res) => {
  try {
    const body = req.body || {};
    const { default_coder, default_judge, default_coder_model, default_judge_model, default_execution_mode, agent_root: agentRootIn, ccb_path: ccbPathIn, ccb_work_dir: ccbWorkDirIn, ccb_auto_open_terminal: ccbAutoOpenTerminalIn, use_wezterm_for_all: useWeztermForAllIn } = body;
    const cfg = readRdloopConfig();
    if (default_coder !== undefined) cfg.default_coder = default_coder;
    if (default_judge !== undefined) cfg.default_judge = default_judge;
    if (default_coder_model !== undefined) cfg.default_coder_model = default_coder_model;
    if (default_judge_model !== undefined) cfg.default_judge_model = default_judge_model;
    if (default_execution_mode !== undefined) {
      if (!['auto', 'semi-auto'].includes(default_execution_mode)) {
        return res.status(400).json({ error: 'default_execution_mode must be auto or semi-auto' });
      }
      cfg.default_execution_mode = default_execution_mode;
    }
    if (agentRootIn !== undefined) {
      const validation = validateAgentRoot(agentRootIn);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error || 'Invalid agent_root' });
      }
      cfg.agent_root = validation.value || '';
    }
    if (ccbPathIn !== undefined) {
      const raw = typeof ccbPathIn === 'string' ? ccbPathIn.trim() : '';
      cfg.ccb_path = raw;
    }
    if (ccbWorkDirIn !== undefined) {
      const raw = typeof ccbWorkDirIn === 'string' ? ccbWorkDirIn.trim() : '';
      cfg.ccb_work_dir = raw;
    }
    if (ccbAutoOpenTerminalIn !== undefined) {
      cfg.ccb_auto_open_terminal = Boolean(ccbAutoOpenTerminalIn);
    }
    if (useWeztermForAllIn !== undefined) {
      cfg.use_wezterm_for_all = Boolean(useWeztermForAllIn);
    }
    atomicWriteJSON(RDLOOP_CONFIG_PATH, cfg);
    res.json({
      ok: true,
      default_coder: cfg.default_coder || null,
      default_judge: cfg.default_judge || null,
      default_coder_model: cfg.default_coder_model || null,
      default_judge_model: cfg.default_judge_model || null,
      default_execution_mode: cfg.default_execution_mode || 'auto',
      agent_root: (cfg.agent_root && cfg.agent_root.length) ? cfg.agent_root : null,
      ccb_path: (cfg.ccb_path && cfg.ccb_path.length) ? cfg.ccb_path : null,
      ccb_work_dir: (cfg.ccb_work_dir && cfg.ccb_work_dir.length) ? cfg.ccb_work_dir : null,
      ccb_auto_open_terminal: cfg.ccb_auto_open_terminal !== false,
      use_wezterm_for_all: cfg.use_wezterm_for_all === true,
      wezterm_available: weztermAvailable()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// P10: Validate agent_root only (for Settings panel blur validation)
app.get('/api/config/validate-agent-root', (req, res) => {
  try {
    const raw = req.query.path != null ? String(req.query.path).trim() : '';
    const validation = validateAgentRoot(raw);
    if (validation.valid) {
      return res.json({ valid: true });
    }
    return res.json({ valid: false, error: validation.error || 'Invalid path' });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// ================================================================
// A2: TaskSpec CRUD — /api/task_specs (E2)
// ================================================================

// Helper: find task spec dirs (tasks/ then examples/)
function getTaskSpecDirs() {
  return [TASKS_DIR, EXAMPLES_DIR].filter(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}

function findTaskSpec(taskId) {
  for (const dir of getTaskSpecDirs()) {
    const p = path.join(dir, `${taskId}.json`);
    if (fs.existsSync(p)) return { filepath: p, dir };
  }
  return null;
}

function validateTaskSpecId(id) {
  return VALID_TASK_ID.test(id);
}

// A3-1/A3-2: Validate task spec data — JSON already parsed; optional schema-style checks
function validateTaskSpecData(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') {
    return { valid: false, errors: ['spec must be an object'] };
  }
  if (spec.task_id !== undefined && !validateTaskSpecId(String(spec.task_id))) {
    errors.push('task_id: invalid format (alphanumeric, underscore, hyphen only)');
  }
  if (spec.max_attempts !== undefined && (typeof spec.max_attempts !== 'number' || spec.max_attempts < 1 || spec.max_attempts > 50)) {
    errors.push('max_attempts: must be number between 1 and 50');
  }
  if (spec.task_type && !['requirements_doc', 'engineering_impl', 'douyin_script', 'storyboard', 'paid_mini_drama', ''].includes(spec.task_type)) {
    errors.push('task_type: invalid enum value');
  }
  if (spec.scoring_mode && !['rubric_analytic', 'holistic_impression', ''].includes(spec.scoring_mode)) {
    errors.push('scoring_mode: invalid enum value');
  }
  if (spec.attempt_context_mode !== undefined && !['fresh_each', 'iterative'].includes(spec.attempt_context_mode)) {
    errors.push('attempt_context_mode: must be fresh_each or iterative');
  }
  if (spec.execution_mode !== undefined && !['auto', 'semi-auto'].includes(spec.execution_mode)) {
    errors.push('execution_mode: must be auto or semi-auto');
  }
  if (spec.workflow_mode !== undefined && !['single', 'solo', 'collab'].includes(spec.workflow_mode)) {
    errors.push('workflow_mode: must be single, solo, or collab');
  }
  // v5.0 validation
  if (spec.executor_type !== undefined && !['api_call', 'solo_agent', 'multi_agent'].includes(spec.executor_type)) {
    errors.push('executor_type: must be api_call, solo_agent, or multi_agent');
  }
  if (spec.session_mode !== undefined && !['fresh', 'iterative', 'continuous'].includes(spec.session_mode)) {
    errors.push('session_mode: must be fresh, iterative, or continuous');
  }
  // v5.0 constraint: api_call cannot use continuous; solo_agent/multi_agent cannot use fresh/iterative
  if (spec.executor_type === 'api_call' && spec.session_mode === 'continuous') {
    errors.push('session_mode: api_call does not support continuous');
  }
  if ((spec.executor_type === 'solo_agent' || spec.executor_type === 'multi_agent') && (spec.session_mode === 'fresh' || spec.session_mode === 'iterative')) {
    errors.push('session_mode: ' + spec.executor_type + ' only supports continuous');
  }
  const COLLAB_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode', 'droid'];
  if (spec.collab_roles !== undefined && spec.collab_roles !== null) {
    if (typeof spec.collab_roles !== 'object' || Array.isArray(spec.collab_roles)) {
      errors.push('collab_roles: must be an object');
    } else {
      for (const [role, provider] of Object.entries(spec.collab_roles)) {
        if (provider !== undefined && provider !== null && !COLLAB_PROVIDERS.includes(String(provider))) {
          errors.push('collab_roles.' + role + ': must be one of ' + COLLAB_PROVIDERS.join(', '));
        }
      }
    }
  }
  if (spec.channel_type !== undefined && spec.channel_type !== null && !['coding-agent-cli', 'cliapi-proxy', 'ccb'].includes(spec.channel_type)) {
    errors.push('channel_type: must be coding-agent-cli, cliapi-proxy, or ccb');
  }
  return { valid: errors.length === 0, errors };
}

// GET /api/task_specs — list all task specs from tasks/ and examples/ (A1-1)
app.get('/api/task_specs', (req, res) => {
  try {
    const specs = [];
    for (const dir of getTaskSpecDirs()) {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
      for (const file of files) {
        const taskId = file.replace(/\.json$/, '');
        if (!validateTaskSpecId(taskId)) continue;
        const filePath = path.join(dir, file);
        const data = readJSON(filePath);
        if (!data) continue;
        let updated_at = null;
        try {
          const stat = fs.statSync(filePath);
          updated_at = stat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
        } catch {}
        specs.push({
          task_id: taskId,
          file_path: filePath,
          updated_at: normalizeUpdatedAt(updated_at),
          task_type: data.task_type || null,
          scoring_mode: data.scoring_mode || null,
          coder: data.coder || null,
          judge: data.judge || null,
          goal: data.goal || null,
          source_dir: path.basename(dir)
        });
      }
    }
    res.json({ specs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/task_specs/:taskId — read a task spec
app.get('/api/task_specs/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  if (!validateTaskSpecId(taskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }
  const found = findTaskSpec(taskId);
  if (!found) {
    return res.status(404).json({ error: 'Task spec not found' });
  }
  const data = readJSON(found.filepath);
  if (!data) {
    return res.status(500).json({ error: 'Failed to read task spec' });
  }
  res.json({ task_id: taskId, spec: data, source_dir: path.basename(found.dir) });
});

// POST /api/task_specs — create a new task spec (A2-2), A3 validation
app.post('/api/task_specs', requireWritable, (req, res) => {
  const { task_id, spec, target_dir } = req.body || {};
  if (!task_id || !validateTaskSpecId(task_id)) {
    return res.status(400).json({ error: 'Invalid or missing task_id' });
  }
  if (!spec || typeof spec !== 'object') {
    return res.status(400).json({ error: 'spec object is required' });
  }
  const validation = validateTaskSpecData(spec);
  if (!validation.valid) {
    return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
  }

  // Normalize task_type alias
  if (spec.task_type === 'engineering_implementation') {
    spec.task_type = 'engineering_impl';
  }

  // Choose save directory: tasks/ preferred, fallback to examples/
  let saveDir;
  if (target_dir === 'examples') {
    saveDir = EXAMPLES_DIR;
  } else {
    saveDir = TASKS_DIR;
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  }

  const filepath = path.join(saveDir, `${task_id}.json`);
  // C0-2: path traversal check
  if (!filepath.startsWith(saveDir + path.sep) && filepath !== path.join(saveDir, `${task_id}.json`)) {
    return res.status(400).json({ error: 'Path traversal detected' });
  }

  if (fs.existsSync(filepath)) {
    return res.status(409).json({ error: `Task spec '${task_id}' already exists` });
  }

  const data = { ...spec, task_id, created_at: spec.created_at || new Date().toISOString() };
  if (data.repo_path) ensureRepoPathExists(data.repo_path);

  try {
    atomicWriteJSON(filepath, data);
  } catch (err) {
    return res.status(500).json({ error: `Failed to write task spec: ${err.message}` });
  }

  auditLog({ action: 'task_spec_create', task_id, source_dir: path.basename(saveDir) });
  res.json({ ok: true, task_id, source_dir: path.basename(saveDir) });
});

// PUT /api/task_specs/:taskId — update an existing task spec (A2-5), A3 validation
app.put('/api/task_specs/:taskId', requireWritable, (req, res) => {
  const taskId = req.params.taskId;
  if (!validateTaskSpecId(taskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }
  const { spec } = req.body || {};
  if (!spec || typeof spec !== 'object') {
    return res.status(400).json({ error: 'spec object is required' });
  }
  const validation = validateTaskSpecData(spec);
  if (!validation.valid) {
    return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
  }

  // Normalize task_type alias
  if (spec.task_type === 'engineering_implementation') {
    spec.task_type = 'engineering_impl';
  }

  const found = findTaskSpec(taskId);
  if (!found) {
    return res.status(404).json({ error: 'Task spec not found' });
  }

  const data = { ...spec, task_id: taskId };
  if (data.repo_path) ensureRepoPathExists(data.repo_path);
  try {
    atomicWriteJSON(found.filepath, data);
  } catch (err) {
    return res.status(500).json({ error: `Failed to write task spec: ${err.message}` });
  }

  auditLog({ action: 'task_spec_update', task_id: taskId, source_dir: path.basename(found.dir) });
  res.json({ ok: true, task_id: taskId });
});

// DELETE /api/task_specs/:taskId — soft-delete to trash/ (A2-4)
app.delete('/api/task_specs/:taskId', requireWritable, (req, res) => {
  const taskId = req.params.taskId;
  if (!validateTaskSpecId(taskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }

  const found = findTaskSpec(taskId);
  if (!found) {
    return res.status(404).json({ error: 'Task spec not found' });
  }

  // Soft-delete to trash/ within the same parent directory
  const trashDir = path.join(found.dir, 'trash');
  if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const trashName = `${taskId}_${ts}.json`;
  const trashPath = path.join(trashDir, trashName);

  try {
    fs.renameSync(found.filepath, trashPath);
  } catch (err) {
    return res.status(500).json({ error: `Failed to move to trash: ${err.message}` });
  }

  auditLog({ action: 'task_spec_delete', task_id: taskId, trash_path: trashPath });
  res.json({ ok: true, task_id: taskId, trash_path: trashPath });
});

// ── Solo Agent Progress API ──────────────────────────────────────────────────

// GET /api/task/:taskId/attempt/:n/solo-steps — read solo agent step progress
app.get('/api/task/:taskId/attempt/:n/solo-steps', (req, res) => {
  const { taskId, n } = req.params;
  const outDir = path.join(RDLOOP_ROOT, 'out');
  const taskDir = path.join(outDir, taskId);
  if (!fs.existsSync(taskDir)) return res.status(404).json({ error: 'Task not found' });

  const attDir = path.join(taskDir, 'attempts', `attempt_${n}`);
  if (!fs.existsSync(attDir)) return res.status(404).json({ error: 'Attempt not found' });

  const soloDir = path.join(attDir, 'solo');
  if (!fs.existsSync(soloDir)) return res.json({ steps: [], mode: 'not_solo' });

  // Read step_NNN directories
  const steps = [];
  let stepDirs = [];
  try { stepDirs = fs.readdirSync(soloDir).filter(d => d.startsWith('step_')).sort(); } catch {}

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
    max_iterations: maxIterations,
  });
});

// POST /api/task/:taskId/attempt/:n/solo-proceed — approve paused solo step
app.post('/api/task/:taskId/attempt/:n/solo-proceed', requireWritable, (req, res) => {
  const { taskId, n } = req.params;
  const outDir = path.join(RDLOOP_ROOT, 'out');
  const taskDir = path.join(outDir, taskId);
  if (!fs.existsSync(taskDir)) return res.status(404).json({ error: 'Task not found' });

  const soloDir = path.join(taskDir, 'attempts', `attempt_${n}`, 'solo');
  if (!fs.existsSync(soloDir)) return res.status(404).json({ error: 'Solo dir not found' });

  const feedback = req.body?.feedback || '';
  const controlPath = path.join(soloDir, 'control.json');
  const control = { action: 'proceed', feedback, timestamp: new Date().toISOString() };
  fs.writeFileSync(controlPath, JSON.stringify(control, null, 2) + '\n');
  res.json({ ok: true });
});

// POST /api/task/:taskId/attempt/:n/solo-abort — abort solo agent
app.post('/api/task/:taskId/attempt/:n/solo-abort', requireWritable, (req, res) => {
  const { taskId, n } = req.params;
  const outDir = path.join(RDLOOP_ROOT, 'out');
  const taskDir = path.join(outDir, taskId);
  if (!fs.existsSync(taskDir)) return res.status(404).json({ error: 'Task not found' });

  const soloDir = path.join(taskDir, 'attempts', `attempt_${n}`, 'solo');
  if (!fs.existsSync(soloDir)) return res.status(404).json({ error: 'Solo dir not found' });

  const controlPath = path.join(soloDir, 'control.json');
  const control = { action: 'exit', reason: 'user_abort', timestamp: new Date().toISOString() };
  fs.writeFileSync(controlPath, JSON.stringify(control, null, 2) + '\n');
  res.json({ ok: true });
});

// POST /api/task_specs/:taskId/run — new instance: unique task_id per run (spec_id + timestamp) so sidebar shows each run
app.post('/api/task_specs/:taskId/run', requireWritable, (req, res) => {
  const specTaskId = req.params.taskId;
  if (!validateTaskSpecId(specTaskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }
  const found = findTaskSpec(specTaskId);
  if (!found) {
    return res.status(404).json({ error: 'Task spec not found' });
  }
  const spec = readJSON(found.filepath);
  if (!spec) {
    return res.status(500).json({ error: 'Failed to read task spec' });
  }
  // Unique run task_id so each Run appears as a new row in sidebar and does not overwrite previous run
  const now = new Date();
  const stamp = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const runTaskId = `${specTaskId}_${stamp}`;
  if (!VALID_TASK_ID.test(runTaskId)) {
    return res.status(400).json({ error: 'Generated run task_id invalid (chars)' });
  }

  const taskDir = path.join(OUT_DIR, runTaskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const taskJsonPath = path.join(taskDir, 'task.json');
  const taskPayload = { ...spec, task_id: runTaskId };
  try {
    atomicWriteJSON(taskJsonPath, taskPayload);
  } catch (err) {
    return res.status(500).json({ error: `Failed to write task.json: ${err.message}` });
  }
  const guiDir = path.join(taskDir, 'gui');
  fs.mkdirSync(guiDir, { recursive: true });
  const logFile = path.join(guiDir, 'run.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn('bash', [COORDINATOR, '--continue', runTaskId], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: path.resolve(__dirname, '..'),
    env: getCoordinatorEnv()
  });
  fs.writeFileSync(path.join(guiDir, 'runner.pid'), String(child.pid));
  child.unref();
  res.json({ ok: true, pid: child.pid, task_id: runTaskId });
});

// POST /api/task_specs/:taskId/copy — copy task spec with auto-rename (A2-3)
app.post('/api/task_specs/:taskId/copy', requireWritable, (req, res) => {
  const srcTaskId = req.params.taskId;
  if (!validateTaskSpecId(srcTaskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }

  const found = findTaskSpec(srcTaskId);
  if (!found) {
    return res.status(404).json({ error: 'Task spec not found' });
  }

  const srcData = readJSON(found.filepath);
  if (!srcData) {
    return res.status(500).json({ error: 'Failed to read source task spec' });
  }

  // Auto-rename: hello_world → hello_world_copy → hello_world_copy_2 → ...
  let newId = `${srcTaskId}_copy`;
  let counter = 2;
  while (findTaskSpec(newId)) {
    newId = `${srcTaskId}_copy_${counter++}`;
  }

  const saveDir = found.dir;
  const newPath = path.join(saveDir, `${newId}.json`);
  const newData = {
    ...srcData,
    task_id: newId,
    created_at: new Date().toISOString()
  };

  try {
    atomicWriteJSON(newPath, newData);
  } catch (err) {
    return res.status(500).json({ error: `Failed to copy task spec: ${err.message}` });
  }

  auditLog({ action: 'task_spec_copy', src_task_id: srcTaskId, new_task_id: newId });
  res.json({ ok: true, task_id: newId, source_dir: path.basename(saveDir) });
});

// ============================================================
// D1/D2: Prompt directory management
// ============================================================

// Validate prompt file name: only [A-Za-z0-9_.-]+.md, no path separators
const VALID_PROMPT_NAME = /^[A-Za-z0-9_.\-]+\.md$/;
function validatePromptName(name) {
  return VALID_PROMPT_NAME.test(name) && !name.includes('..') && !name.includes('/') && !name.includes('\\');
}

// Atomic write for plain text files (D1/D2 — temp → fsync → rename)
function atomicWriteText(filepath, content) {
  const dir = path.dirname(filepath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filepath + '.tmp.' + crypto.randomBytes(6).toString('hex');
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, filepath);
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// GET /api/prompts — list all .md files in prompts/ (D1)
app.get('/api/prompts', (req, res) => {
  try {
    let files = [];
    try { files = fs.readdirSync(PROMPTS_DIR); } catch { /* dir not found */ }
    const prompts = files
      .filter(f => f.endsWith('.md') && validatePromptName(f))
      .map(f => {
        const fp = path.join(PROMPTS_DIR, f);
        let size = 0, updated_at = null;
        try {
          const stat = fs.statSync(fp);
          size = stat.size;
          updated_at = stat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
        } catch {}
        return { name: f, size, updated_at };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ prompts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prompts/:name — read a prompt file (D1)
app.get('/api/prompts/:name', (req, res) => {
  const { name } = req.params;
  if (!validatePromptName(name)) {
    return res.status(400).json({ error: 'Invalid prompt file name' });
  }
  const filepath = path.resolve(PROMPTS_DIR, name);
  // Path traversal check (D2)
  if (!filepath.startsWith(PROMPTS_DIR + path.sep) && filepath !== PROMPTS_DIR) {
    return res.status(400).json({ error: 'Path traversal denied' });
  }
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Prompt not found' });
  }
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    let updated_at = null;
    try { updated_at = fs.statSync(filepath).mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'); } catch {}
    res.json({ name, content, updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/prompts/:name — save a prompt file (D1/D2). K7-1: READ_ONLY blocks; K7-2: overwrite confirmed by client.
app.put('/api/prompts/:name', requireWritable, (req, res) => {
  const { name } = req.params;
  if (!validatePromptName(name)) {
    return res.status(400).json({ error: 'Invalid prompt file name' });
  }
  const filepath = path.resolve(PROMPTS_DIR, name);
  // Path traversal check (D2)
  if (!filepath.startsWith(PROMPTS_DIR + path.sep) && filepath !== PROMPTS_DIR) {
    return res.status(400).json({ error: 'Path traversal denied' });
  }
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  // Backup existing file with timestamp (D1 optional versioning)
  let backup_path = null;
  if (fs.existsSync(filepath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    backup_path = filepath + '.bak.' + ts;
    try { fs.copyFileSync(filepath, backup_path); } catch { backup_path = null; }
  }
  try {
    atomicWriteText(filepath, content);
    auditLog({ action: 'prompt_save', name, size: content.length, backup: backup_path });
    let updated_at = null;
    try { updated_at = fs.statSync(filepath).mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'); } catch {}
    res.json({ ok: true, name, updated_at, backup: backup_path ? path.basename(backup_path) : null });
  } catch (err) {
    auditLog({ action: 'prompt_save_failed', name, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── v5.0 Endpoints ──────────────────────────────────────────────────────────

// GET /api/task/:taskId/git-status — worker branch states + contract_check + judge_scores
app.get('/api/task/:taskId/git-status', (req, res) => {
  const taskId = req.params.taskId;
  if (!taskId || !/^[A-Za-z0-9_-]+$/.test(taskId)) return res.status(400).json({ error: 'invalid taskId' });
  try {
    // Find task directory in OUT_DIR
    const taskDir = findTaskDir(taskId);
    if (!taskDir) return res.status(404).json({ error: 'task directory not found' });

    const taskJsonPath = path.join(taskDir, 'task.json');
    if (!fs.existsSync(taskJsonPath)) return res.status(404).json({ error: 'task.json not found' });
    const taskJson = readJSON(taskJsonPath);
    const repoPath = taskJson.repo_path || '';

    // Read branch state from git if repo exists
    let branches = [];
    if (repoPath && fs.existsSync(repoPath)) {
      try {
        const branchOut = execSync(`git -C "${repoPath}" branch --list "task/${taskId}*" "worker/${taskId}*" 2>/dev/null || true`, { encoding: 'utf8', timeout: 5000 });
        branches = branchOut.split('\n').map(b => b.trim().replace(/^\* /, '')).filter(Boolean);
      } catch {}
    }

    // Read worker status files if they exist
    const workers = [];
    for (const branch of branches) {
      const info = { branch, status: 'open' };
      // Check for merge status file
      const statusFile = path.join(taskDir, 'branch_status', branch.replace(/\//g, '_') + '.json');
      if (fs.existsSync(statusFile)) {
        try {
          const st = readJSON(statusFile);
          info.status = st.status || 'open';
          if (st.action) info.action = st.action;
        } catch {}
      }
      workers.push(info);
    }

    // Read contract_check from review-prep output if available
    let contractCheck = null;
    const reviewPath = path.join(taskDir, 'review_prep.json');
    if (fs.existsSync(reviewPath)) {
      try {
        const rp = readJSON(reviewPath);
        contractCheck = rp.contract_check || null;
      } catch {}
    }

    // Read judge_scores from latest attempt
    let judgeScores = null;
    const attempts = fs.readdirSync(taskDir).filter(d => d.startsWith('attempt_')).sort();
    if (attempts.length > 0) {
      const latestAttempt = path.join(taskDir, attempts[attempts.length - 1]);
      const verdictPath = path.join(latestAttempt, 'judge', 'verdict.json');
      if (fs.existsSync(verdictPath)) {
        try {
          const verdict = readJSON(verdictPath);
          judgeScores = verdict.dimensions || verdict.scores || null;
        } catch {}
      }
    }

    res.json({ task_id: taskId, branches, workers, contract_check: contractCheck, judge_scores: judgeScores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: find task directory by taskId
function findTaskDir(taskId) {
  if (!fs.existsSync(OUT_DIR)) return null;
  // Direct match
  const direct = path.join(OUT_DIR, taskId);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
  // Scan for matching task.json
  try {
    const dirs = fs.readdirSync(OUT_DIR);
    for (const d of dirs) {
      const dp = path.join(OUT_DIR, d);
      if (!fs.statSync(dp).isDirectory()) continue;
      const tjp = path.join(dp, 'task.json');
      if (fs.existsSync(tjp)) {
        try {
          const tj = readJSON(tjp);
          if (tj.task_id === taskId) return dp;
        } catch {}
      }
    }
  } catch {}
  return null;
}

// GET /api/knowledge/shards/debt — debt shard entries grouped by severity and loop_id
app.get('/api/knowledge/shards/debt', (req, res) => {
  const kdir = getKnowledgeDir();
  if (!kdir) return res.status(404).json({ error: 'project_path not configured' });
  const debtPath = path.join(kdir, 'debt.json');
  if (!fs.existsSync(debtPath)) return res.status(404).json({ entries: {}, message: 'no debt shard found' });
  try {
    const data = JSON.parse(fs.readFileSync(debtPath, 'utf8'));
    const entries = data.entries || {};
    // Group by severity and loop_id
    const bySeverity = {};
    const byLoopId = {};
    for (const [key, entry] of Object.entries(entries)) {
      const sev = entry.severity || 'unknown';
      const lid = entry.loop_id || 'unknown';
      if (!bySeverity[sev]) bySeverity[sev] = [];
      bySeverity[sev].push({ key, ...entry });
      if (!byLoopId[lid]) byLoopId[lid] = [];
      byLoopId[lid].push({ key, ...entry });
    }
    res.json({ entries, by_severity: bySeverity, by_loop_id: byLoopId, total: Object.keys(entries).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/loop-stats — loop execution stats from loop_stats.jsonl
app.get('/api/loop-stats', (req, res) => {
  const statsPath = path.join(OUT_DIR, 'loop_stats.jsonl');
  if (!fs.existsSync(statsPath)) return res.status(404).json({ stats: [], message: 'no loop_stats.jsonl found' });
  try {
    const lines = fs.readFileSync(statsPath, 'utf8').split('\n').filter(l => l.trim());
    const stats = [];
    for (const line of lines) {
      try { stats.push(JSON.parse(line)); } catch {}
    }
    res.json({ stats, total: stats.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`rdloop GUI running at http://localhost:${PORT}`);
  console.log(`OUT_DIR: ${OUT_DIR}`);
});
