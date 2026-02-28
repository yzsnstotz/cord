// rdloop GUI — Frontend Application
// B1: Live Panel with tab persistence, etag/304 no-flash refresh
// A2: TaskSpec CRUD (new/copy/delete/edit)
// A4: task_type selector + rubric_thresholds config
// A5: Adapter healthcheck selector
// B3: Attempt API fixed field set
// E2: XSS prevention — all dynamic DOM insertion uses escapeHtml

let currentTaskId = null;
let currentAttempt = null;
let promptCenterSelectedTarget = '';
const LIFECYCLE_STEP_BATCH = 30;
const LIFECYCLE_STEP_MAX = 500;
let lifecycleLogsByTask = {};
let lifecycleVisibleCountByTask = {};

// B1-1: activeTab persisted in sessionStorage
let activeTab = sessionStorage.getItem('rdloop_activeTab') || 'coordinator';

// B1-4: AutoScroll persisted in localStorage
let autoScroll = localStorage.getItem('rdloop_autoScroll') !== 'false';

// Sidebar toggle state
let sidebarCollapsed = localStorage.getItem('rdloop_sidebarCollapsed') === 'true';

function updateSidebarUI() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('toggle-sidebar');
  if (sidebar) {
    sidebar.classList.toggle('collapsed', sidebarCollapsed);
  }
  if (toggle) {
    const svg = toggle.querySelector('svg');
    if (svg) {
      svg.style.transform = sidebarCollapsed ? 'rotate(0deg)' : 'rotate(180deg)';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggle-sidebar');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      sidebarCollapsed = !sidebarCollapsed;
      localStorage.setItem('rdloop_sidebarCollapsed', sidebarCollapsed);
      updateSidebarUI();
    });
  }
  updateSidebarUI();
});

window.addEventListener('error', function(event) {
  console.error('Unhandled error:', event.error);
  // alert('GUI Error: ' + (event.error?.message || event.message));
});

window.addEventListener('unhandledrejection', function(event) {
  console.error('Unhandled rejection:', event.reason);
  // alert('GUI Promise Error: ' + (event.reason?.message || String(event.reason)));
});

// B1-2: etag per logName for If-None-Match
let liveLogEtag = {};

// Tab → logName mapping
const TAB_LOG_MAP = {
  coordinator: 'coordinator.log',
  coder: 'coder.log',
  judge: 'judge.log'
};

const TEMPLATES = {
  hello_world: {
    schema_version: 'v1',
    task_id: 'my_task',
    task_type: 'solo',
    launch_mode: 'bridge',
    launch_mode_locked: false,
    repo_path: 'dummy_repo',
    base_ref: 'main',
    goal: 'Describe what the task should achieve',
    acceptance: 'Describe acceptance criteria',
    test_cmd: 'true',
    max_attempts: 3,
    coder: 'mock',
    judge: 'mock',
    constraints: [],
    created_at: '',
    target_type: 'external_repo',
    allowed_paths: [],
    forbidden_globs: ['**/.env', '**/secrets*', '**/*.pem'],
    coder_timeout_seconds: 600,
    judge_timeout_seconds: 300,
    test_timeout_seconds: 300
  },
  requirements_doc: {
    schema_version: 'v1',
    task_id: 'req_doc_task',
    task_type: 'solo',
    launch_mode: 'bridge',
    launch_mode_locked: false,
    repo_path: 'dummy_repo',
    base_ref: 'main',
    goal: 'Write a product requirements document',
    acceptance: 'All dimensions score above threshold',
    test_cmd: 'true',
    max_attempts: 3,
    coder: 'mock',
    judge: 'mock',
    scoring_mode: 'rubric_analytic',
    constraints: [],
    created_at: '',
    target_type: 'external_repo',
    allowed_paths: [],
    forbidden_globs: ['**/.env']
  },
  engineering_impl: {
    schema_version: 'v1',
    task_id: 'eng_impl_task',
    task_type: 'solo',
    launch_mode: 'bridge',
    launch_mode_locked: false,
    repo_path: 'dummy_repo',
    base_ref: 'main',
    goal: 'Implement the feature described in the requirements',
    acceptance: 'Tests pass, code review score above threshold',
    test_cmd: './run_tests.sh',
    max_attempts: 5,
    coder: 'mock',
    judge: 'mock',
    scoring_mode: 'rubric_analytic',
    constraints: [],
    created_at: '',
    target_type: 'external_repo',
    allowed_paths: [],
    forbidden_globs: ['**/.env', '**/secrets*']
  }
};

async function openNewSpecModalWithTemplate(templateId) {
  await openNewSpecModal();
  const templateSelect = document.getElementById('modal-template');
  if (templateSelect) {
    templateSelect.value = templateId;
    applyTemplate();
  }
}

// ================================================================
// E2: C0-1: XSS prevention — escapeHtml applied to ALL dynamic content
// ================================================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

function providerDisplayName(provider) {
  const p = String(provider || '').toLowerCase();
  return (p === 'gemini' || p === 'antigravity' || p === 'googleantigravity') ? 'Gemini' : String(provider || '');
}

// Decode JSON-style Unicode escapes (\uXXXX) so coder_output and evidence display correctly
function decodeUnicodeEscapes(str) {
  if (str == null || typeof str !== 'string') return '';
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// ================================================================
// §v5.1.4 Task Specification Helpers (F1/F2/F4)
// ================================================================

function getV51Schema() {
  return {
    task_types: ['copywriting', 'solo', 'multi_agent'],
    launch_modes: ['ccb', 'bridge']
  };
}

const LEGACY_TASK_FIELDS = ['executor_type', 'workflow_mode', 'session_mode', 'channel_type', 'run_surface', 'execution_mode'];

function mapLegacyExecutorTypeToTaskType(execType) {
  switch (execType) {
    case 'api_call': return 'copywriting';
    case 'solo_agent': return 'solo';
    case 'multi_agent': return 'multi_agent';
    default: return '';
  }
}

function mapLegacyWorkflowModeToTaskType(workflowMode) {
  switch (workflowMode) {
    case 'single': return 'copywriting';
    case 'solo': return 'solo';
    case 'collab': return 'multi_agent';
    default: return '';
  }
}

function inferLaunchModeFromLegacy(spec) {
  if (spec.run_surface === 'visual_ccb' || spec.execution_mode === 'semi-auto' || spec.channel_type === 'ccb') {
    return 'ccb';
  }
  if (spec.run_surface === 'bridge' || spec.execution_mode === 'auto' || spec.channel_type === 'coding-agent-cli' || spec.channel_type === 'cliapi-proxy') {
    return 'bridge';
  }
  return 'bridge'; // default
}

function normalizeTaskTypeAlias(taskType) {
  const t = String(taskType || '').trim().toLowerCase();
  if (t === 'copywrite') return 'copywriting';
  return t;
}

function normalizeProviderFromAny(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'codex' || v === 'codex-cli' || v === 'codex_cli') return 'codex';
  if (v === 'gemini' || v === 'gemini-cli' || v === 'antigravity' || v === 'antigravity-cli' || v === 'googleantigravity') return 'gemini';
  if (v === 'claude' || v === 'claude-cli' || v === 'claude_bridge') return 'claude';
  if (v === 'opencode' || v === 'opencode-cli') return 'opencode';
  if (v === 'droid' || v === 'droid-cli') return 'droid';
  return v;
}

function stripLegacyFields(spec) {
  const out = { ...(spec || {}) };
  LEGACY_TASK_FIELDS.forEach((f) => { if (out[f] !== undefined) delete out[f]; });
  return out;
}

/** 
 * Returns a normalized v5.1 view of a spec. 
 * If fields missing, attempts to infer from legacy.
 */
function normalizeSpecToV51(spec) {
  const out = { ...(spec || {}) };
  const notes = [];
  out.task_type = normalizeTaskTypeAlias(out.task_type);
  
  if (!out.task_type) {
    const fromExec = mapLegacyExecutorTypeToTaskType(out.executor_type);
    const fromWorkflow = mapLegacyWorkflowModeToTaskType(out.workflow_mode);
    out.task_type = fromExec || fromWorkflow || 'solo';
    if (fromExec || fromWorkflow) notes.push(`task_type inferred from legacy executor/workflow`);
  }
  
  if (!out.launch_mode) {
    out.launch_mode = inferLaunchModeFromLegacy(out);
    notes.push(`launch_mode inferred from legacy execution fields`);
  }
  
  if (out.launch_mode_locked === undefined) {
    out.launch_mode_locked = false;
  }

  return { spec: stripLegacyFields(out), notes };
}

function isLegacyTask(spec) {
  if (!spec) return false;
  return LEGACY_TASK_FIELDS.some(f => spec[f] !== undefined);
}

// Badge helper (state display only — no user content)
function badge(state) {
  const cls = {
    'RUNNING': 'badge-running', 'PAUSED': 'badge-paused',
    'READY_FOR_REVIEW': 'badge-ready', 'FAILED': 'badge-failed'
  }[state] || '';
  return `<span class="badge ${cls}">${escapeHtml(state || 'UNKNOWN')}</span>`;
}

// Fetch helper
async function api(path, opts) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    return { error: err.error || String(res.status) };
  }
  return res.json().catch(e => ({ error: 'JSON parse error: ' + e.message }));
}

function setButtonLoading(btn, isLoading) {
  if (!btn) return;
  if (isLoading) {
    btn.dataset.originalText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
    btn.classList.add('btn-loading');
  } else {
    if (btn.dataset.originalText) {
      btn.innerHTML = btn.dataset.originalText;
    }
    btn.disabled = false;
    btn.classList.remove('btn-loading');
  }
}

// K7-1: READ_ONLY from /api/health; disable write buttons and show banner
let readOnlyMode = false;
async function loadHealth() {
  try {
    const d = await api('/health');
    readOnlyMode = d.read_only === true;
  } catch { readOnlyMode = false; }
  const banner = document.getElementById('read-only-banner');
  if (readOnlyMode) {
    if (!banner) {
      const el = document.createElement('div');
      el.id = 'read-only-banner';
      el.style.cssText = 'padding:8px 16px;background:#d2992233;border-bottom:1px solid #d29922;color:#d29922;font-size:13px;text-align:center';
      el.textContent = 'Read-only mode: writes are disabled.';
      document.body.prepend(el);
    }
    document.querySelectorAll('.write-action').forEach(b => { b.disabled = true; });
  } else {
    if (banner) banner.remove();
    document.querySelectorAll('.write-action').forEach(b => { b.disabled = false; });
  }
}

// K7-1: Re-apply read-only disabled state to all .write-action buttons (call after dynamic content that adds write buttons)
function updateReadOnlyBanner() {
  document.querySelectorAll('.write-action').forEach(b => { b.disabled = readOnlyMode; });
}

// P10: Settings panel — agent_root + run-surface default + coder/judge defaults
let settingsConfigSnapshot = null;
let useDefaultRunSurface = localStorage.getItem('rdloop_use_default_run_surface') === 'true';

const ALLOWED_ROLE_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode', 'droid'];

function normalizeRoleProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'antigravity' || p === 'googleantigravity') return 'gemini';
  return p;
}

function resolveSettingsDefaultProvider(defaultCoder, defaultCoderModel, fallback) {
  const coderNorm = normalizeProviderFromAny(defaultCoder || '');
  const modelNorm = normalizeProviderFromAny(defaultCoderModel || '');
  if (coderNorm === 'ccb') return modelNorm || fallback;
  return coderNorm || fallback;
}

async function openSettingsPanel() {
  const old = document.getElementById('settings-modal');
  if (old) old.remove();
  await loadAdapters();
  let cfg = {};
  let roles = [];
  try {
    cfg = await api('/config');
  } catch (e) {
    alert('Failed to load config: ' + (e?.message || String(e)));
    return;
  }
  try {
    roles = await api('/agent/roles');
  } catch (_) {
    roles = [];
  }
  let guardStatus = { injected: false, files_affected: [], detail: '' };
  try {
    guardStatus = await api('/ccb/guard-status');
  } catch (_) {}
  settingsConfigSnapshot = { ...cfg };
  const agentRoot = (cfg.agent_root && cfg.agent_root.length) ? cfg.agent_root : '';
  const ccbPath = (cfg.ccb_path && cfg.ccb_path.length) ? cfg.ccb_path : '';
  const defaultLaunchMode = cfg.default_run_surface === 'visual_ccb' ? 'ccb' : 'bridge';
  const defaultCoderProvider = resolveSettingsDefaultProvider(cfg.default_coder, cfg.default_coder_model, 'codex');
  const defaultJudgeProvider = resolveSettingsDefaultProvider(cfg.default_judge, cfg.default_judge_model, 'gemini');
  const settingsProviderOptions = ALLOWED_ROLE_PROVIDERS.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(providerDisplayName(p))}</option>`).join('');

  const rolesHtml = Array.isArray(roles) && roles.length
    ? roles.map(r => {
        const opts = ALLOWED_ROLE_PROVIDERS.map(p => `<option value="${escapeHtml(p)}" ${r.provider === p ? 'selected' : ''}>${escapeHtml(providerDisplayName(p))}</option>`).join('');
        const disabled = !r.assignable ? 'disabled' : '';
        return `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="width:100px;font-size:12px">${escapeHtml(r.role)}</span>
            <select class="form-select settings-role-provider" data-role="${escapeHtml(r.role)}" ${disabled} style="flex:1;font-size:12px">${opts}</select>
            ${!r.assignable ? '<span style="font-size:11px;color:#8b949e">(fixed)</span>' : ''}
          </div>`;
      }).join('')
    : '<div style="font-size:12px;color:#8b949e">Configure agent_root above and save to load roles.</div>';

  const modalHtml = `
    <div id="settings-modal" class="modal-overlay" onclick="if(event.target===this)closeSettingsPanel()">
      <div class="modal-box" style="max-width:560px;max-height:90vh;overflow-y:auto">
        <h3 style="margin-top:0">Settings</h3>

        <div style="margin-bottom:12px">
          <label class="form-label">Agent directory (agent_root)</label>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="text" id="settings-agent-root" class="form-input" value="${escapeHtml(agentRoot)}" placeholder="Absolute path to Agent (e.g. /path/to/Agent)" style="flex:1">
            <span id="settings-agent-root-status" style="font-size:14px;min-width:24px" title="Validate on blur"></span>
          </div>
          <div id="settings-agent-root-msg" style="font-size:12px;margin-top:4px;color:#8b949e">Optional. Must contain .context/rules/collab_context.md</div>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">CCB directory (ccb_path)</label>
          <input type="text" id="settings-ccb-path" class="form-input" value="${escapeHtml(ccbPath)}" placeholder="e.g. /path/to/CCB" style="width:100%;margin-top:4px">
          <div style="font-size:12px;margin-top:4px;color:#8b949e">Required for starting CCB sessions from GUI. Must contain <code>ccb</code> and <code>bin/cask</code>, <code>bin/gask</code>.</div>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">Default launch mode (used when "Use default" is enabled at Run)</label>
          <select id="settings-default-launch-mode" class="form-select" style="width:auto;margin-top:6px">
            <option value="bridge" ${defaultLaunchMode === 'bridge' ? 'selected' : ''}>bridge (non-visible)</option>
            <option value="ccb" ${defaultLaunchMode === 'ccb' ? 'selected' : ''}>ccb (visible CCB session)</option>
          </select>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">CCB injection status</label>
          <div id="settings-guard-wrap" style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px;font-size:12px">
            ${guardStatus.injected
              ? `发现注入块（${guardStatus.files_affected.length} 个文件）。<br><button type="button" class="btn btn-primary write-action" style="margin-top:8px" onclick="if(confirm('确认清理 CCB 注入块？')) submitGuardClean(true)">一键清理</button><span id="settings-guard-msg" style="margin-left:8px"></span>`
              : escapeHtml(guardStatus.detail || 'OK: No CCB injection blocks found.')}
          </div>
        </div>

        <div style="margin-bottom:12px">
          <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="settings-use-wezterm-for-all" ${cfg.use_wezterm_for_all ? 'checked' : ''} ${cfg.wezterm_available ? '' : 'disabled'}>
            <span>使用 WezTerm 打开所有 CI 窗口</span>
          </label>
          <div style="font-size:12px;margin-top:4px;color:#8b949e">${cfg.wezterm_available ? '勾选后，点击任意 provider 的「打开终端」将改为在 WezTerm 中打开并传入当前配置的全部 providers。' : '需安装 WezTerm：brew install wezterm'}</div>
        </div>

        <div style="margin-bottom:12px" id="settings-roles-section">
          <label class="form-label">Role configuration (collab_context.md)</label>
          <div id="settings-roles-wrap" style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px">${rolesHtml}</div>
          <div id="settings-roles-hint" style="font-size:11px;color:#8b949e;margin-top:4px">角色配置用于 multi-agent 的 visual CCB 运行。</div>
          <button type="button" class="btn write-action" style="margin-top:8px;font-size:12px" onclick="submitAgentRoles()">Save roles</button>
          <span id="settings-roles-msg" style="margin-left:8px;font-size:12px;color:#3fb950"></span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div>
            <label class="form-label">Default Coder Provider</label>
            <select id="adapter-settings-coder" class="form-select">
              ${settingsProviderOptions}
            </select>
          </div>
          <div>
            <label class="form-label">Default Judge Provider</label>
            <select id="adapter-settings-judge" class="form-select">
              ${settingsProviderOptions}
            </select>
          </div>
        </div>

        <div id="settings-save-msg" style="font-size:12px;margin-bottom:8px;min-height:18px;color:#f85149"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" onclick="closeSettingsPanel()">Cancel</button>
          <button class="btn btn-primary write-action" onclick="submitSettings()">Save</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();

  const agentRootEl = document.getElementById('settings-agent-root');
  if (agentRootEl) {
    agentRootEl.addEventListener('blur', validateSettingsAgentRoot);
  }
  const coderSelect = document.getElementById('adapter-settings-coder');
  const judgeSelect = document.getElementById('adapter-settings-judge');
  if (coderSelect) coderSelect.value = defaultCoderProvider;
  if (judgeSelect) judgeSelect.value = defaultJudgeProvider;
}

async function submitAgentRoles() {
  const msgEl = document.getElementById('settings-roles-msg');
  if (msgEl) msgEl.textContent = '';
  const selects = document.querySelectorAll('.settings-role-provider:not([disabled])');
  const payload = [];
  selects.forEach(el => {
    const role = el.dataset.role;
    const provider = el.value;
    if (role && provider) payload.push({ role, provider });
  });
  if (payload.length === 0) {
    if (msgEl) msgEl.textContent = 'No changes or agent_root not set.';
    return;
  }
  try {
    const res = await fetch('/api/agent/roles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (msgEl) { msgEl.textContent = data.error || 'Failed'; msgEl.style.color = '#f85149'; }
      return;
    }
    if (msgEl) { msgEl.textContent = '角色已更新'; msgEl.style.color = '#3fb950'; }
    setTimeout(() => { if (msgEl) msgEl.textContent = ''; }, 3000);
  } catch (e) {
    if (msgEl) { msgEl.textContent = e?.message || 'Request failed'; msgEl.style.color = '#f85149'; }
  }
}

async function submitGuardClean(confirmed) {
  const msgEl = document.getElementById('settings-guard-msg');
  const wrap = document.getElementById('settings-guard-wrap');
  if (msgEl) msgEl.textContent = 'Cleaning...';
  try {
    const res = await fetch('/api/ccb/guard-clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: !!confirmed })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (msgEl) msgEl.textContent = data.error || 'Failed';
      return;
    }
    if (msgEl) msgEl.textContent = 'Cleaned.';
    if (wrap) {
      wrap.innerHTML = data.cleaned
        ? escapeHtml('OK: No CCB injection blocks found.')
        : escapeHtml(data.output || data.detail || 'Done.');
    }
    if (msgEl) setTimeout(() => { msgEl.textContent = ''; }, 3000);
  } catch (e) {
    if (msgEl) msgEl.textContent = e?.message || 'Request failed';
  }
}

function closeSettingsPanel() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.remove();
}

async function validateSettingsAgentRoot() {
  const input = document.getElementById('settings-agent-root');
  const status = document.getElementById('settings-agent-root-status');
  const msg = document.getElementById('settings-agent-root-msg');
  if (!input || !status || !msg) return;
  const val = (input.value || '').trim();
  if (!val) {
    status.textContent = '';
    status.title = '';
    msg.style.color = '#8b949e';
    msg.textContent = 'Optional. Must contain .context/rules/collab_context.md';
    return;
  }
  try {
    const res = await fetch('/api/config/validate-agent-root?path=' + encodeURIComponent(val));
    const data = await res.json().catch(() => ({}));
    if (data.valid) {
      status.textContent = '✓';
      status.style.color = '#3fb950';
      status.title = 'Valid';
      msg.style.color = '#3fb950';
      msg.textContent = 'Path is valid.';
    } else {
      status.textContent = '✗';
      status.style.color = '#f85149';
      status.title = data.error || 'Invalid';
      msg.style.color = '#f85149';
      msg.textContent = data.error || 'Invalid path';
    }
  } catch (e) {
    status.textContent = '?';
    status.style.color = '#8b949e';
    msg.textContent = 'Validation failed: ' + (e?.message || '');
  }
}

async function submitSettings() {
  const msgEl = document.getElementById('settings-save-msg');
  if (msgEl) msgEl.textContent = '';

  function rollbackSettingsUI() {
    const s = settingsConfigSnapshot;
    if (!s) return;
    const agentRootEl = document.getElementById('settings-agent-root');
    if (agentRootEl) agentRootEl.value = s.agent_root || '';
    const ccbPathEl = document.getElementById('settings-ccb-path');
    if (ccbPathEl) ccbPathEl.value = s.ccb_path || '';
    const launchModeEl = document.getElementById('settings-default-launch-mode');
    if (launchModeEl) launchModeEl.value = s.default_run_surface === 'visual_ccb' ? 'ccb' : 'bridge';
    const coderSel = document.getElementById('adapter-settings-coder');
    const judgeSel = document.getElementById('adapter-settings-judge');
    if (coderSel) coderSel.value = resolveSettingsDefaultProvider(s.default_coder, s.default_coder_model, 'codex');
    if (judgeSel) judgeSel.value = resolveSettingsDefaultProvider(s.default_judge, s.default_judge_model, 'gemini');
    const weztermCb = document.getElementById('settings-use-wezterm-for-all');
    if (weztermCb) weztermCb.checked = s.use_wezterm_for_all === true;
  }

  const agentRoot = (document.getElementById('settings-agent-root')?.value ?? '').trim();
  const ccbPath = (document.getElementById('settings-ccb-path')?.value ?? '').trim();
  const selectedLaunchMode = document.getElementById('settings-default-launch-mode')?.value || 'bridge';
  const default_run_surface = selectedLaunchMode === 'ccb' ? 'visual_ccb' : 'bridge';
  const default_coder = normalizeProviderFromAny(document.getElementById('adapter-settings-coder')?.value ?? '');
  const default_judge = normalizeProviderFromAny(document.getElementById('adapter-settings-judge')?.value ?? '');
  const snapshot = settingsConfigSnapshot || {};
  const default_coder_model = normalizeProviderFromAny(snapshot.default_coder || '') === default_coder
    ? (snapshot.default_coder_model || null)
    : null;
  const default_judge_model = normalizeProviderFromAny(snapshot.default_judge || '') === default_judge
    ? (snapshot.default_judge_model || null)
    : null;
  const use_wezterm_for_all = document.getElementById('settings-use-wezterm-for-all')?.checked === true;
  const payloadCoder = default_coder || null;
  const payloadJudge = default_judge || null;
  const payloadCoderModel = default_coder_model;
  const payloadJudgeModel = default_judge_model;
  const payload = {
    agent_root: agentRoot || '',
    ccb_path: ccbPath || '',
    default_run_surface,
    default_coder: payloadCoder,
    default_judge: payloadJudge,
    default_coder_model: payloadCoderModel,
    default_judge_model: payloadJudgeModel,
    use_wezterm_for_all,
  };

  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      rollbackSettingsUI();
      if (msgEl) {
        msgEl.textContent = data.error || 'Save failed';
        msgEl.style.color = '#f85149';
      }
      return;
    }
    if (msgEl) {
      msgEl.textContent = 'Settings saved.';
      msgEl.style.color = '#3fb950';
    }
    setTimeout(closeSettingsPanel, 800);
  } catch (e) {
    rollbackSettingsUI();
    if (msgEl) {
      msgEl.textContent = 'Request failed: ' + (e?.message || String(e));
      msgEl.style.color = '#f85149';
    }
  }
}

// Permanently hidden task IDs (frontend). × removes from sidebar; no "Show all" to restore.
function getHiddenTasks() {
  try {
    const raw = localStorage.getItem('rdloop_hiddenTasks');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function setHiddenTasks(ids) {
  localStorage.setItem('rdloop_hiddenTasks', JSON.stringify(ids));
}
async function hideTask(taskId, e) {
  if (e) e.stopPropagation();
  try {
    await fetch(`/api/tasks/${encodeURIComponent(taskId)}/record-hidden`, { method: 'POST' });
  } catch (_) { /* best effort */ }
  const ids = getHiddenTasks();
  if (!ids.includes(taskId)) ids.push(taskId);
  setHiddenTasks(ids);
  loadTasks();
}

// P07/P12: CCB status and banner — v3.3: guide to CCB session panel
let ccbStatus = { cask: { status: 'unavailable' }, gask: { status: 'unavailable' } };
let configForBanner = { project_path: null };
let ccbBannerDismissed = false;

function dismissCcbBanner() {
  ccbBannerDismissed = true;
  const el = document.getElementById('ccb-warn-banner');
  if (el) el.remove();
}

function switchView(view) {
  const isTasks = view === 'tasks';
  const isPrompts = view === 'prompts';
  const isCcb = view === 'ccb';
  const isSimulator = view === 'simulator';
  document.getElementById('content').style.display = isTasks ? 'block' : 'none';
  document.getElementById('prompts-panel').style.display = isPrompts ? 'block' : 'none';
  document.getElementById('ccb-panel').style.display = isCcb ? 'block' : 'none';
  document.getElementById('simulator-panel').style.display = isSimulator ? 'block' : 'none';
  document.getElementById('nav-tasks').classList.toggle('active', isTasks);
  document.getElementById('nav-prompts').classList.toggle('active', isPrompts);
  document.getElementById('nav-ccb').classList.toggle('active', isCcb);
  document.getElementById('nav-simulator').classList.toggle('active', isSimulator);
  if (isPrompts) {
    renderPromptCenterPanel();
    stopCcbPanelPolling();
    stopSimulatorPanelPolling();
    return;
  }
  if (isCcb) {
    renderCcbPanel();
    startCcbPanelPolling();
    stopSimulatorPanelPolling();
    return;
  }
  if (isSimulator) {
    renderSimulatorPanel();
    startSimulatorPanelPolling();
    stopCcbPanelPolling();
    return;
  }
  stopCcbPanelPolling();
  stopSimulatorPanelPolling();
}

let ccbPanelPollTimer = null;
function startCcbPanelPolling() {
  stopCcbPanelPolling();
  function tick() {
    if (document.getElementById('ccb-panel')?.style.display === 'block') {
      refreshCcbPanelContent();
      ccbPanelPollTimer = setTimeout(tick, 5000);
    }
  }
  tick();
}
function stopCcbPanelPolling() {
  if (ccbPanelPollTimer) { clearTimeout(ccbPanelPollTimer); ccbPanelPollTimer = null; }
}

let simulatorPanelPollTimer = null;
let simulatorDetailHovering = false;
let simulatorDetailPendingRefresh = false;
function startSimulatorPanelPolling() {
  stopSimulatorPanelPolling();
  function tick() {
    if (document.getElementById('simulator-panel')?.style.display === 'block') {
      refreshSimulatorPanelContent();
      simulatorPanelPollTimer = setTimeout(tick, 3000);
    }
  }
  tick();
}
function stopSimulatorPanelPolling() {
  if (simulatorPanelPollTimer) {
    clearTimeout(simulatorPanelPollTimer);
    simulatorPanelPollTimer = null;
  }
}

async function refreshCcbPanelContent() {
  const wrap = document.getElementById('ccb-panel');
  if (!wrap || wrap.style.display !== 'block') return;
  try {
    const [sessionRes, logRes] = await Promise.all([
      api('/ccb/session-status').catch(() => ({ providers: [], tmux_available: false, ccb_instance: { running: false }, terminal_mode: 'unknown', wezterm_available: false })),
      api('/ccb/session/log?lines=50').catch(() => ({ log: '' }))
    ]);
    window._lastCcbSessionStatus = sessionRes;
    const providers = sessionRes.providers || [];
    const tmuxOk = sessionRes.tmux_available !== false;
    updateCcbProviderRows(providers, tmuxOk);
    const logEl = document.getElementById('ccb-log-content');
    if (logEl) logEl.textContent = (logRes.log || '').trim() || '(no log)';
  } catch (_) {}
}

function updateCcbProviderRows(providers, tmuxOk) {
  providers.forEach(p => {
    const statusEl = document.getElementById('ccb-status-' + p.provider);
    const statusTextEl = document.getElementById('ccb-status-text-' + p.provider);
    const card = document.getElementById('ccb-card-' + p.provider);

    const hasProviderSession = !!p.pane_id || (typeof p.session_name === 'string' && p.session_name === ('ccb_' + p.provider));
    const isOn = p.status === 'ok';
    const isRunning = p.status === 'running_no_daemon' || (hasProviderSession && !isOn);
    const isOff = p.status === 'off';
    const isNotInstalled = p.status === 'not_installed';

    let dot, text;
    if (isOn) { dot = '🟢'; text = p.ping_ms != null ? p.ping_ms + 'ms' : 'online'; }
    else if (isRunning) { dot = '🟡'; text = 'session active'; }
    else if (isOff) { dot = '⚪'; text = 'off'; }
    else if (isNotInstalled) { dot = '⚫'; text = 'not installed'; }
    else { dot = '🔴'; text = 'unavailable'; }

    if (statusEl) statusEl.textContent = dot;
    if (statusTextEl) statusTextEl.textContent = text;

    // Update action buttons based on current state
    if (card) {
      const actionsDiv = card.querySelector('.ccb-card-actions');
      if (actionsDiv) {
        let primaryBtn = '';
        let secondaryBtn = '';
        primaryBtn = `<button type="button" class="btn btn-primary write-action ccb-card-btn" id="ccb-btn-start-${escapeHtml(p.provider)}" onclick="ccbStartProviders(['${escapeHtml(p.provider)}'], event)" ${!tmuxOk ? 'disabled' : ''}>Start</button>`;
        if (!(isOff || (!isOn && !isRunning))) {
          secondaryBtn = `<button type="button" class="btn btn-danger write-action ccb-card-btn-sm" id="ccb-btn-stop-${escapeHtml(p.provider)}" onclick="ccbStopProviders(['${escapeHtml(p.provider)}'], false, event)" title="Stop ${escapeHtml(providerDisplayName(p.provider))}">Stop</button>`;
        }
        actionsDiv.innerHTML = primaryBtn + secondaryBtn;
      }
    }
  });

  // Update summary count
  const summaryEl = document.querySelector('.ccb-summary');
  if (summaryEl) {
    const onlineCount = providers.filter(p => p.status === 'ok').length;
    summaryEl.textContent = onlineCount + '/' + providers.length + ' online';
  }

  // Update CCB process info
  const last = window._lastCcbSessionStatus || {};
  const ccbInstance = last.ccb_instance || { running: false };
  const processInfo = document.querySelector('.ccb-process-info');
  if (processInfo) {
    const processHtml = ccbInstance.running
      ? `CCB: <span style="color:#3fb950">PID ${escapeHtml(String(ccbInstance.pid))}${ccbInstance.session_name ? ' · ' + escapeHtml(ccbInstance.session_name) : ''}</span>`
      : `CCB: <span style="color:#8b949e">not running</span>`;
    processInfo.innerHTML = processHtml;
  }

  updateReadOnlyBanner();
}

function updateCcbInstanceRow(ccbInstance) {
  // Legacy compat — now handled inline by updateCcbProviderRows
}

async function renderCcbPanel() {
  const wrap = document.getElementById('ccb-panel');
  if (!wrap) return;
  let config = { project_path: '' };
  let sessionRes = { providers: [], tmux_available: true };
  let ccbConfig = { providers: [], raw_text: '' };
  try {
    config = await api('/config');
    sessionRes = await api('/ccb/session-status').catch(() => ({ providers: [], tmux_available: false, terminal_mode: 'unknown', wezterm_available: false }));
    ccbConfig = await api('/ccb/config').catch(() => ({ providers: [] }));
  } catch (_) {}
  const workDir = (config.project_path || '').trim();
  window._lastCcbSessionStatus = sessionRes;
  const providers = sessionRes.providers.length ? sessionRes.providers : [
    { provider: 'codex', session_name: null, pid: null, status: 'off', ping_ms: null },
    { provider: 'gemini', session_name: null, pid: null, status: 'off', ping_ms: null },
    { provider: 'opencode', session_name: null, pid: null, status: 'off', ping_ms: null },
    { provider: 'claude', session_name: null, pid: null, status: 'off', ping_ms: null },
    { provider: 'droid', session_name: null, pid: null, status: 'off', ping_ms: null }
  ];
  const tmuxOk = sessionRes.tmux_available !== false;
  const weztermAvailable = sessionRes.wezterm_available === true;
  const terminalMode = sessionRes.terminal_mode || 'unknown';
  const ccbInstance = sessionRes.ccb_instance || { running: false };
  const onlineCount = providers.filter(p => p.status === 'ok').length;
  const totalCount = providers.length;

  // Build provider cards
  const providerCards = providers.map(p => {
    const hasProviderSession = !!p.pane_id || (typeof p.session_name === 'string' && p.session_name === ('ccb_' + p.provider));
    const isOn = p.status === 'ok';
    const isRunning = p.status === 'running_no_daemon' || (hasProviderSession && !isOn);
    const isOff = p.status === 'off';
    const isNotInstalled = p.status === 'not_installed';
    let statusDot, statusText;
    if (isOn) { statusDot = '🟢'; statusText = p.ping_ms != null ? p.ping_ms + 'ms' : 'online'; }
    else if (isRunning) { statusDot = '🟡'; statusText = 'session active'; }
    else if (isOff) { statusDot = '⚪'; statusText = 'off'; }
    else if (isNotInstalled) { statusDot = '⚫'; statusText = 'not installed'; }
    else { statusDot = '🔴'; statusText = 'unavailable'; }

    // Primary action: Start if off, Open if running
    let primaryBtn = '';
    let secondaryBtn = '';
    primaryBtn = `<button type="button" class="btn btn-primary write-action ccb-card-btn" id="ccb-btn-start-${escapeHtml(p.provider)}" onclick="ccbStartProviders(['${escapeHtml(p.provider)}'], event)" ${!tmuxOk ? 'disabled' : ''}>Start</button>`;
    if (!(isOff || (!isOn && !isRunning))) {
      secondaryBtn = `<button type="button" class="btn btn-danger write-action ccb-card-btn-sm" id="ccb-btn-stop-${escapeHtml(p.provider)}" onclick="ccbStopProviders(['${escapeHtml(p.provider)}'], false, event)" title="Stop ${escapeHtml(providerDisplayName(p.provider))}">Stop</button>`;
    }

    return `
      <div class="ccb-card" id="ccb-card-${escapeHtml(p.provider)}">
        <div class="ccb-card-header">
          <span class="ccb-card-status" id="ccb-status-${escapeHtml(p.provider)}">${statusDot}</span>
          <span class="ccb-card-name">${escapeHtml(providerDisplayName(p.provider))}</span>
          <span class="ccb-card-status-text" id="ccb-status-text-${escapeHtml(p.provider)}">${statusText}</span>
        </div>
        <div class="ccb-card-actions">
          ${primaryBtn}
          ${secondaryBtn}
        </div>
      </div>`;
  }).join('');

  // CCB process status line
  const ccbProcessHtml = ccbInstance.running
    ? `<span style="color:#3fb950">PID ${escapeHtml(String(ccbInstance.pid))}${ccbInstance.session_name ? ' · ' + escapeHtml(ccbInstance.session_name) : ''}</span>`
    : `<span style="color:#8b949e">not running</span>`;

  wrap.innerHTML = `
    <div class="ccb-panel-header">
      <h2 style="margin:0">Coding Agents</h2>
      <span class="ccb-summary">${onlineCount}/${totalCount} online</span>
    </div>

    <div id="ccb-panel-notice" style="min-height:0;font-size:13px;margin-bottom:4px"></div>

    ${!tmuxOk ? `
    <div class="ccb-warning">
      tmux not installed. Install with <code>brew install tmux</code> to manage sessions from GUI.
    </div>` : ''}

    <div class="ccb-cards-grid">${providerCards}</div>

    <div class="ccb-global-actions">
      <button type="button" class="btn btn-primary write-action" onclick="ccbStartAll(event)" ${!tmuxOk ? 'disabled' : ''}>Start All</button>
      <button type="button" class="btn btn-danger write-action" onclick="ccbStopAll(event)">Stop All</button>
      ${ccbInstance.running ? `<button type="button" class="btn btn-danger write-action" onclick="ccbKillInstance(event)" title="Kill the currently active CCB process (PID ${escapeHtml(String(ccbInstance.pid))})">Kill CCB</button>` : ''}
      ${weztermAvailable ? `<button type="button" class="btn write-action" onclick="ccbOpenWezTermWithConfig(event)" title="Open all agents in WezTerm">WezTerm</button>` : ''}
      <button type="button" class="btn write-action" onclick="ccbAgentStatus(event)" title="Run ccb-agent-status.sh (askd, legacy daemons, provider ping)">Agent status</button>
      <span class="ccb-process-info">CCB: ${ccbProcessHtml}</span>
    </div>

    <details class="ccb-config-section">
      <summary>Settings</summary>
      <div class="ccb-config-body">
        <div class="ccb-config-row">
          <label class="form-label">Work Directory</label>
          <input type="text" id="ccb-work-dir" class="form-input" value="${escapeHtml(workDir)}" placeholder="${escapeHtml(config.project_path || '/path/to/project')}" style="flex:1" readonly>
        </div>
        <div class="ccb-config-row">
          <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="ccb-auto-open-terminal" ${config.ccb_auto_open_terminal !== false ? 'checked' : ''} onchange="saveCcbAutoOpenTerminal(this.checked)">
            Auto-open terminal after start
          </label>
        </div>
        <div class="ccb-config-row">
          <label class="form-label">Default Providers <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#6e7681">(used by "Start All" &amp; WezTerm)</span></label>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px">
            ${['codex', 'gemini', 'opencode', 'claude', 'droid'].map(p => `<label style="cursor:pointer;font-size:13px"><input type="checkbox" class="ccb-config-cb" data-provider="${escapeHtml(p)}" ${(ccbConfig.providers || []).includes(p) ? 'checked' : ''}> ${escapeHtml(providerDisplayName(p))}</label>`).join('')}
          </div>
          <div style="margin-top:8px;display:flex;gap:8px">
            <button type="button" class="btn write-action" onclick="saveCcbConfig()">Save Config</button>
            <span id="ccb-config-msg" style="font-size:12px;line-height:32px"></span>
          </div>
        </div>
        <div class="ccb-config-row">
          <button type="button" class="btn write-action" onclick="ccbCleanup()" style="font-size:12px">Cleanup stale sessions</button>
        </div>
      </div>
    </details>

    <details class="ccb-config-section">
      <summary>Logs (last 50 lines)</summary>
      <pre id="ccb-log-content" style="margin-top:8px;max-height:300px;overflow-y:auto;font-size:11px">Loading...</pre>
    </details>
  `;
  updateReadOnlyBanner();
  const logRes = await api('/ccb/session/log?lines=50').catch(() => ({}));
  const logEl = document.getElementById('ccb-log-content');
  if (logEl) logEl.textContent = (logRes.log || '').trim() || '(no log)';
}

async function ccbStartProviders(providers, e) {
  const btn = e ? e.currentTarget : null;
  setButtonLoading(btn, true);
  try {
    const cfg = await api('/config').catch(() => ({}));
    const notice = document.getElementById('ccb-panel-notice');

    // If use_wezterm_for_all is enabled, route through WezTerm instead of tmux
    if (cfg.use_wezterm_for_all) {
      await ccbOpenWezTermAndRun(providers);
      return;
    }

    if (notice) { notice.textContent = 'Starting ' + providers.map(providerDisplayName).join(', ') + '... (waiting for session)'; notice.style.color = '#8b949e'; }
    try {
      const res = await fetch('/api/ccb/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (notice) notice.textContent = '';
        alert(data.error || data.hint || 'Start failed');
        return;
      }
      const ids = (data.session_ids || []).join(', ') || providers.map(providerDisplayName).join(', ');
      if (notice) {
        notice.textContent = 'Started: ' + ids + (data.hint ? '. ' + data.hint : '');
        notice.style.color = '#3fb950';
        setTimeout(() => { if (notice) notice.textContent = ''; }, 5000);
      }
      // Auto-open terminal if configured
      const hasAttachableSession = Array.isArray(data.session_ids) && data.session_ids.length > 0;
      // Avoid duplicate windows: fresh start already opens a terminal window from backend.
      // Auto-attach only when reusing an existing session.
      if (hasAttachableSession && data.reused === true) {
        const providerToOpen = (providers && providers.length > 0) ? providers[0] : 'codex';
        setTimeout(() => {
          ccbAttachProvider(providerToOpen);
        }, 1500);
      }
      // Poll status so cards update
      [2000, 4000, 6000, 8000, 12000, 16000].forEach(ms => setTimeout(refreshCcbPanelContent, ms));
    } catch (e) {
      if (notice) notice.textContent = '';
      alert(e?.message || 'Start failed');
    }
  } finally {
    setButtonLoading(btn, false);
  }
}

async function saveCcbAutoOpenTerminal(checked) {
  try {
    await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ccb_auto_open_terminal: checked })
    });
  } catch (_) {}
}

async function ccbOpenTerminalAndRun(providers) {
  const cfg = await api('/config').catch(() => ({}));
  if (cfg.use_wezterm_for_all) {
    const ccbCfg = await api('/ccb/config').catch(() => ({ providers: [] }));
    const allProviders = (ccbCfg.providers && ccbCfg.providers.length) ? ccbCfg.providers : (providers && providers.length ? providers : ['codex', 'gemini']);
    await ccbOpenWezTermAndRun(allProviders);
    return;
  }
  const notice = document.getElementById('ccb-panel-notice');
  if (notice) { notice.textContent = 'Opening terminal...'; notice.style.color = '#8b949e'; }
  try {
    const res = await fetch('/api/ccb/session/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: providers || ['codex'] })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (notice) notice.textContent = '';
      alert(data.error || data.hint || 'Failed to open terminal');
      return;
    }
    if (notice) {
      notice.textContent = 'Terminal opened.';
      notice.style.color = '#3fb950';
      setTimeout(() => { notice.textContent = ''; }, 5000);
    }
    setTimeout(refreshCcbPanelContent, 3000);
  } catch (e) {
    if (notice) notice.textContent = '';
    alert(e?.message || 'Failed to open terminal');
  }
}

async function ccbOpenWezTermWithConfig() {
  const cfg = await api('/ccb/config').catch(() => ({ providers: [] }));
  const providers = (cfg.providers && cfg.providers.length) ? cfg.providers : ['codex', 'gemini'];
  await ccbOpenWezTermAndRun(providers);
}

async function ccbOpenWezTermAndRun(providers) {
  const cfg = await api('/config').catch(() => ({}));
  const notice = document.getElementById('ccb-panel-notice');
  if (notice) { notice.textContent = 'Opening WezTerm...'; notice.style.color = '#8b949e'; }
  try {
    const res = await fetch('/api/ccb/session/open-wezterm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: providers || ['codex'] })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (notice) notice.textContent = '';
      alert(data.error || data.hint || 'Failed to open WezTerm');
      return;
    }
    if (notice) {
      notice.textContent = 'WezTerm opened.';
      notice.style.color = '#3fb950';
      setTimeout(() => { notice.textContent = ''; }, 5000);
    }
    setTimeout(refreshCcbPanelContent, 3000);
  } catch (e) {
    if (notice) notice.textContent = '';
    alert(e?.message || 'Failed to open WezTerm');
  }
}

// Legacy: kept for compat but simplified
async function ccbInstanceAttach() {
  await ccbOpenTerminalAndRun(['codex']);
}

async function ccbInstanceRestart() {
  await ccbStopAll();
  await new Promise(r => setTimeout(r, 500));
  await ccbStartAll();
}

async function ccbCleanup() {
  const notice = document.getElementById('ccb-panel-notice');
  if (notice) { notice.textContent = 'Cleaning up...'; notice.style.color = '#8b949e'; }
  try {
    const res = await fetch('/api/ccb/session/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (notice) notice.textContent = '';
      alert(data.error || 'Cleanup failed');
      return;
    }
    const n = (data.cleaned_sessions || []).length;
    if (notice) {
      notice.textContent = n ? 'Cleaned ' + n + ' session(s).' : 'Nothing to clean.';
      notice.style.color = '#3fb950';
      setTimeout(() => { notice.textContent = ''; }, 4000);
    }
    refreshCcbPanelContent();
  } catch (e) {
    if (notice) notice.textContent = '';
    alert(e?.message || 'Cleanup failed');
  }
}

async function ccbAttachProvider(provider) {
  try {
    const cfg = await api('/config').catch(() => ({}));
    if (cfg.use_wezterm_for_all) {
      // Open WezTerm for this specific provider (not all providers)
      await ccbOpenWezTermAndRun([provider]);
      return;
    }
    const last = window._lastCcbSessionStatus || {};
    const prov = (last.providers || []).find(p => p.provider === provider);
    const paneId = prov && prov.pane_id ? encodeURIComponent(prov.pane_id) : '';
    let url = '/api/ccb/session/attach?provider=' + encodeURIComponent(provider);
    if (paneId) {
      url += '&pane_id=' + paneId;
    }
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.error || data.hint || 'Open failed');
      return;
    }
    const notice = document.getElementById('ccb-panel-notice');
    if (notice) {
      notice.textContent = 'Opening ' + providerDisplayName(provider) + ' terminal...';
      notice.style.color = '#3fb950';
      setTimeout(() => { notice.textContent = ''; }, 4000);
    }
  } catch (e) {
    alert(e?.message || 'Open failed');
  }
}

async function ccbAttachSession(sessionName) {
  try {
    const res = await fetch('/api/ccb/session/attach?session_name=' + encodeURIComponent(sessionName));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.error || data.hint || 'Attach failed');
      return;
    }
    const notice = document.getElementById('ccb-panel-notice');
    if (notice) {
      notice.textContent = 'Opening session ' + sessionName + '...';
      notice.style.color = '#3fb950';
      setTimeout(() => { notice.textContent = ''; }, 4000);
    }
  } catch (e) {
    alert(e?.message || 'Attach failed');
  }
}

async function ccbStopProviders(providers, skipRunningCheck, e) {
  const btn = e ? e.currentTarget : null;
  if (!skipRunningCheck) {
    const tasksRes = await api('/tasks?limit=100').catch(() => ({ items: [] }));
    const runningSemi = (tasksRes.items || []).filter(t => t.state === 'RUNNING' && t.execution_mode === 'semi-auto');
    if (runningSemi.length > 0 && !confirm(runningSemi.length + ' semi-auto task(s) running. Stopping will pause them. Continue?')) return;
  }
  setButtonLoading(btn, true);
  try {
    await fetch('/api/ccb/session/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers })
    });
    setTimeout(refreshCcbPanelContent, 1000);
  } catch (e) {
    alert(e?.message || 'Stop failed');
  } finally {
    setButtonLoading(btn, false);
  }
}

async function ccbStopAll(e) {
  const tasksRes = await api('/tasks?limit=100').catch(() => ({ items: [] }));
  const runningSemi = (tasksRes.items || []).filter(t => t.state === 'RUNNING' && t.execution_mode === 'semi-auto');
  const msg = runningSemi.length > 0
    ? runningSemi.length + ' semi-auto task(s) running. Stopping CCB will pause them. Continue?'
    : 'Stop all CCB sessions?';
  if (!confirm(msg)) return;
  await ccbStopProviders([], true, e);
}

/** Kill the currently active CCB process (lock-holder). */
async function ccbKillInstance(e) {
  const btn = e ? e.currentTarget : null;
  if (!confirm('Kill the currently active CCB process? This will terminate the CCB daemon (tmux/WezTerm session may remain until closed).')) return;
  const notice = document.getElementById('ccb-panel-notice');
  if (notice) { notice.textContent = 'Killing CCB...'; notice.style.color = '#8b949e'; }
  setButtonLoading(btn, true);
  try {
    const res = await fetch('/api/ccb/session/kill-instance', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (notice) notice.textContent = '';
      alert(data.error || data.hint || 'Kill failed');
      return;
    }
    if (notice) {
      notice.textContent = 'CCB process killed (PID ' + (data.pid || '') + ').';
      notice.style.color = '#3fb950';
      setTimeout(() => { if (notice) notice.textContent = ''; }, 5000);
    }
    [500, 1500, 3000].forEach(ms => setTimeout(refreshCcbPanelContent, ms));
  } catch (e) {
    if (notice) notice.textContent = '';
    alert(e?.message || 'Kill failed');
  } finally {
    setButtonLoading(btn, false);
  }
}

/** Run ccb-agent-status.sh and show result in Logs section. */
async function ccbAgentStatus() {
  const notice = document.getElementById('ccb-panel-notice');
  const logContent = document.getElementById('ccb-log-content');
  if (notice) { notice.textContent = 'Running agent status...'; notice.style.color = '#8b949e'; }
  try {
    const res = await fetch('/api/ccb/agent-status');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (notice) notice.textContent = '';
      alert(data.error || 'Agent status failed');
      return;
    }
    const text = data.text || (data.provider_ping ? 'Provider ping: ' + JSON.stringify(data.provider_ping) : '') || '(no output)';
    if (logContent) {
      logContent.textContent = text + (data.stderr ? '\n\nstderr:\n' + data.stderr : '');
    }
    if (notice) {
      notice.textContent = 'Agent status done. See Logs below.';
      notice.style.color = '#3fb950';
      setTimeout(() => { if (notice) notice.textContent = ''; }, 4000);
    }
    const details = logContent?.closest('details');
    if (details) details.open = true;
    refreshCcbPanelContent();
  } catch (e) {
    if (notice) notice.textContent = '';
    alert(e?.message || 'Agent status failed');
  }
}

// Start all configured providers (or default set)
async function ccbStartAll(e) {
  const cfg = await api('/ccb/config').catch(() => ({ providers: [] }));
  const providers = (cfg.providers && cfg.providers.length) ? cfg.providers : ['codex', 'gemini', 'opencode', 'claude'];
  await ccbStartProviders(providers, e);
}

async function saveCcbConfig() {
  const checkboxes = document.querySelectorAll('.ccb-config-cb:checked');
  const providers = Array.from(checkboxes).map(el => el.dataset.provider);
  const msgEl = document.getElementById('ccb-config-msg');
  if (msgEl) msgEl.textContent = '';
  try {
    const res = await fetch('/api/ccb/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers })
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { if (msgEl) msgEl.textContent = d.error || 'Failed'; return; }
    if (msgEl) { msgEl.textContent = 'Saved'; msgEl.style.color = '#3fb950'; setTimeout(() => { msgEl.textContent = ''; }, 3000); }
  } catch (e) {
    if (msgEl) msgEl.textContent = e?.message || 'Failed';
  }
}

async function startWithCcbConfig() {
  const cfg = await api('/ccb/config').catch(() => ({ providers: [] }));
  const providers = cfg.providers && cfg.providers.length ? cfg.providers : ['codex', 'gemini'];
  await ccbStartProviders(providers);
}

function renderCcbBanner(items, status, config, sessionStatus) {
  const hasSemiAuto = Array.isArray(items) && items.some(t => t.execution_mode === 'semi-auto');
  // Use session-status ccb_instance.running as primary signal (daemon ping is unreliable for WezTerm/FIFO-only setups)
  const ccbInstanceRunning = sessionStatus && sessionStatus.ccb_instance && sessionStatus.ccb_instance.running;
  const anyProviderOnline = sessionStatus && Array.isArray(sessionStatus.providers) && sessionStatus.providers.some(p => {
    if (p.status === 'ok' || p.status === 'running_no_daemon') return true;
    return !!p.pane_id || (typeof p.session_name === 'string' && p.session_name === ('ccb_' + p.provider));
  });
  const ccbUnavailable = !ccbInstanceRunning && !anyProviderOnline;
  if (!hasSemiAuto || !ccbUnavailable) {
    const el = document.getElementById('ccb-warn-banner');
    if (el) el.remove();
    if (!hasSemiAuto) ccbBannerDismissed = false;
    return;
  }
  if (ccbBannerDismissed) return;
  if (document.getElementById('ccb-warn-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'ccb-warn-banner';
  banner.style.cssText = 'padding:10px 16px;background:#d2992233;border-bottom:1px solid #d29922;color:#d29922;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:12px';
  banner.innerHTML = `
    <span>CCB/providers currently offline. Run/Resume will auto-bootstrap provider sessions when needed.</span>
    <button type="button" class="btn" style="padding:2px 8px" onclick="dismissCcbBanner()">Dismiss</button>
  `;
  document.body.prepend(banner);
}

// Load task list (sidebar) — running tasks from out/; filter hidden
// P07: concurrently fetch /api/ccb/status and /api/config for banner
async function loadTasks() {
  const [data, statusRes, configRes, sessionStatusRes] = await Promise.all([
    api('/tasks?limit=100'),
    api('/ccb/status').catch(() => ({ cask: { status: 'unavailable' }, gask: { status: 'unavailable' } })),
    api('/config').catch(() => ({})),
    api('/ccb/session-status').catch(() => ({ providers: [], ccb_instance: { running: false } }))
  ]);
  ccbStatus = statusRes;
  configForBanner = configRes;

  const list = document.getElementById('task-list');
  const allItems = data.items || data.tasks || [];
  const hidden = getHiddenTasks();
  const items = allItems.filter(t => !hidden.includes(t.task_id));
  const hiddenCount = allItems.length - items.length;

  renderCcbBanner(items, ccbStatus, configForBanner, sessionStatusRes);

  if (items.length === 0) {
    let msg = 'No tasks found.<br>Run examples/run_hello.sh first.';
    if (allItems.length > 0) {
      msg = escapeHtml(String(allItems.length)) + ' task(s) in total; all have been removed from the list.';
    }
    list.innerHTML = `<div style="padding:16px;color:#8b949e">${msg}</div>`;
    return;
  }
  list.innerHTML = `
    ${hiddenCount > 0 ? `<div style="padding:8px 12px 4px;font-size:11px;color:#8b949e">${escapeHtml(String(hiddenCount))} removed from list</div>` : ''}
    ${items.map(t => `
    <div class="task-item ${t.task_id === currentTaskId ? 'active' : ''}" data-task-id="${escapeHtml(t.task_id)}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4px">
        <div style="min-width:0;flex:1">
          <div class="task-id">${escapeHtml(t.task_id)}${t.launch_mode === 'ccb' ? ' <span style="font-size:10px;color:#8b949e" title="launch_mode: ccb (visible tmux)">⟳</span>' : ''}</div>
          <div class="task-meta">
            <span class="task-state-tag">${escapeHtml(t.state)}</span>
            <span style="font-size:11px;color:#8b949e">att ${escapeHtml(String(t.current_attempt || 0))} · ${escapeHtml(t.last_decision || '-')}</span>
          </div>
        </div>
        <button type="button" class="btn write-action" style="flex-shrink:0;padding:2px 6px;font-size:12px;line-height:1;opacity:0.7" onclick="hideTask('${escapeHtml(t.task_id)}', event)" title="Hide from list">×</button>
      </div>
    </div>
  `).join('')}
  `;
}

// B1-2/B1-3/B1-4: Fetch log for a specific tab (always latest content for live panel).
async function fetchTabLog(taskId, logName, force) {
  const logContainer = document.getElementById('live-log-content');
  const lastRefreshed = document.getElementById('live-log-ts');
  if (!logContainer || taskId !== currentTaskId) return;

  const headers = {};
  // B1-2: send If-None-Match unless forcing full fetch
  if (!force && liveLogEtag[logName]) {
    headers['If-None-Match'] = `"${liveLogEtag[logName]}"`;
  }

  let res;
  try {
    res = await fetch(`/api/task/${taskId}/log/${logName}`, { headers });
  } catch {
    return; // network error, silently skip
  }

  // B1-3: 304 → only update timestamp, NO DOM replacement
  if (res.status === 304) {
    if (lastRefreshed) lastRefreshed.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
    return;
  }

  if (!res.ok) {
    // C2-3: fixed "no logs" message when file absent
    logContainer.textContent = `No logs found for role=${activeTab}`;
    if (lastRefreshed) lastRefreshed.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
    return;
  }

  // Update etag from response
  const etag = res.headers.get('ETag');
  if (etag) {
    liveLogEtag[logName] = etag.replace(/^"|"$/g, '');
  }

  const text = await res.text();

  // B1-4: save scroll position before updating content
  const scrollEl = document.getElementById('live-log-scroll');
  let wasAtBottom = true;
  let savedScrollTop = 0;
  if (scrollEl) {
    savedScrollTop = scrollEl.scrollTop;
    wasAtBottom = (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) < 40;
  }

  // Update content (only the log container, not the full page — B1-3)
  logContainer.textContent = text;

  // B1-4: restore scroll position
  if (scrollEl) {
    if (autoScroll && wasAtBottom) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    } else {
      scrollEl.scrollTop = savedScrollTop;
    }
  }

  if (lastRefreshed) lastRefreshed.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
}

// B1-1: Switch tab — persist + load log
function switchTab(tab) {
  activeTab = tab;
  sessionStorage.setItem('rdloop_activeTab', tab);

  // Update tab button active state without re-rendering tabs
  ['coordinator', 'coder', 'judge'].forEach(t => {
    const btn = document.getElementById(`tab-${t}`);
    if (btn) btn.className = `tab-btn${t === tab ? ' active' : ''}`;
  });

  // Force-load this tab (clear etag to force fresh fetch)
  const logName = TAB_LOG_MAP[tab];
  if (logName && currentTaskId) {
    const logContainer = document.getElementById('live-log-content');
    if (logContainer) logContainer.textContent = 'Loading...';
    fetchTabLog(currentTaskId, logName, true);
  }
}

// B1-4: AutoScroll toggle
function toggleAutoScroll(val) {
  autoScroll = val;
  localStorage.setItem('rdloop_autoScroll', val ? 'true' : 'false');
}

// B1 timer: refresh only current tab's log (not full selectTask)
function refreshLiveLog() {
  if (!currentTaskId) return;
  const logName = TAB_LOG_MAP[activeTab];
  if (logName) fetchTabLog(currentTaskId, logName, false);
}

// Lightweight meta update — does NOT reset tab/scroll (B1-1)
async function refreshCurrentTaskMeta() {
  if (!currentTaskId) return;
  try {
    const data = await api(`/task/${currentTaskId}`);
    updateTaskMeta(data);
    refreshLifecycleSteps(currentTaskId);
  } catch { /* silently skip */ }
}

// Update only the info-grid elements by ID — no innerHTML full-replace
function updateTaskMeta(data) {
  const s = data.status || {};

  const headingBadge = document.getElementById('task-heading-badge');
  if (headingBadge) headingBadge.innerHTML = badge(s.state);

  const metaState = document.getElementById('meta-state');
  if (metaState) metaState.innerHTML = badge(s.state);

  const metaAttempt = document.getElementById('meta-attempt');
  if (metaAttempt) metaAttempt.textContent = `${s.current_attempt || 0} / ${s.max_attempts || s.effective_max_attempts || '-'}`;

  const metaDecision = document.getElementById('meta-decision');
  if (metaDecision) metaDecision.textContent = s.last_decision || '-';

  const metaTaskType = document.getElementById('meta-task-type');
  if (metaTaskType) metaTaskType.textContent = s.task_type || '-';

  const metaLaunchMode = document.getElementById('meta-launch-mode');
  if (metaLaunchMode) metaLaunchMode.textContent = s.launch_mode || '-';

  const metaResolvedView = document.getElementById('meta-resolved-view');
  if (metaResolvedView) {
    metaResolvedView.textContent = s.launch_mode_source ? `Source: ${s.launch_mode_source}` : '-';
  }

  const metaMsg = document.getElementById('meta-message');
  if (metaMsg) metaMsg.textContent = s.message || '-';

  const questionsContainer = document.getElementById('questions-for-user-container');
  if (questionsContainer) {
    if (s.state !== 'RUNNING' && Array.isArray(s.questions_for_user) && s.questions_for_user.length > 0) {
      questionsContainer.innerHTML = `
        <div class="questions-banner">
          <strong>Questions for user:</strong>
          <ul>
            ${s.questions_for_user.map(q => `<li>${escapeHtml(q)}</li>`).join('')}
          </ul>
        </div>`;
    } else {
      questionsContainer.innerHTML = '';
    }
  }
}

function formatLifecycleTime(ts) {
  if (!ts || typeof ts !== 'string') return '--:--:--';
  return ts.length >= 19 ? ts.substring(11, 19) : ts;
}

function safeLifecycleText(value, maxLen = 220) {
  if (value == null) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (!raw) return '';
  return raw.length > maxLen ? `${raw.slice(0, maxLen)}...` : raw;
}

function lifecycleReadableEventName(log) {
  const et = String(log?.event_type || log?.what_happened || '').trim();
  const role = log?.details?.role || log?.delivery?.to || log?.delivery?.role || '';
  const fromRole = log?.details?.from || log?.delivery?.from || '';
  const toRole = log?.details?.to || log?.delivery?.to || '';
  const launchMode = log?.details?.launch_mode || log?.details?.launchMode || '';
  const modeLocked = log?.details?.locked;
  const reqCode = log?.delivery?.req_code || log?.details?.req_code || '';
  const sessionId = log?.delivery?.session_id || log?.details?.session_id || '';

  switch (et) {
    case 'launch_mode_selected':
      return `Launch mode selected: ${launchMode || '-'}${modeLocked === true ? ' (locked)' : (modeLocked === false ? ' (unlocked)' : '')}`;
    case 'knowledge_inject':
      return `Knowledge injected ${fromRole ? `from ${fromRole}` : ''}${toRole ? ` to ${toRole}` : ''}`.trim();
    case 'session_id_assigned':
      return `Session assigned${role ? ` for ${role}` : ''}${sessionId ? `: ${sessionId}` : ''}`;
    case 'req_code_assigned':
      return `Request code assigned${reqCode ? `: ${reqCode}` : ''}`;
    case 'role_start':
      return `${role || 'role'} started${launchMode ? ` via ${launchMode}` : ''}`;
    case 'role_end':
      return `${role || 'role'} finished`;
    case 'role_transition':
      return `Role transition: ${fromRole || '?'} -> ${toRole || '?'}`;
    case 'handoff_pointer_written':
      return `Handoff pointer written: ${fromRole || '?'} -> ${toRole || '?'}`;
    case 'bridge_call':
      return `Bridge call dispatched${role ? ` to ${role}` : ''}`;
    case 'ccb_call':
      return `CCB call dispatched${role ? ` to ${role}` : ''}${reqCode ? ` (${reqCode})` : ''}`;
    case 'coder_dispatch':
      return 'Coder dispatched';
    case 'judge_dispatch':
      return 'Judge dispatched';
    case 'command_executed':
      return `Command executed (${safeLifecycleText(log?.delivery?.content || '', 120)})`;
    case 'CONTROL_ACTION_REQUESTED':
      return `Control action requested: ${log?.details?.action || '-'}`;
    case 'CONTROL_RESUME_APPLIED':
      return 'Control resume applied';
    case 'CONTROL_RUN_NEXT_APPLIED':
      return 'Control run-next applied';
    case 'CONTROL_EDIT_INSTRUCTION_APPLIED':
      return 'Control edit-instruction applied';
    case 'CONTROL_PAUSE_REQUESTED':
    case 'CONTROL_PAUSE_AT_CHECKPOINT':
      return 'Control pause requested';
    case 'USER_INPUT_RECEIVED':
      return `User input received${log?.details?.len != null ? ` (${log.details.len} chars)` : ''}`;
    case 'USER_INPUT_CONSUMED':
      return `User input consumed${log?.details?.consumed_count != null ? ` (${log.details.consumed_count} entries)` : ''}`;
    default:
      return et || 'lifecycle_event';
  }
}

function lifecycleReadableSummary(log) {
  const parts = [];
  const actor = log?.triggered_by?.actor || '';
  const source = log?.triggered_by?.source || '';
  const channel = log?.channel?.name || '';
  const next = log?.next || {};
  const nextTo = next.to || next.target || next.state || '';
  const rc = log?.details?.rc;
  const msg = log?.details?.summary || log?.details?.message || '';

  if (actor || source) parts.push(`trigger: ${[actor, source].filter(Boolean).join('/')}`);
  if (channel) parts.push(`channel: ${channel}`);
  if (nextTo) parts.push(`next: ${safeLifecycleText(nextTo, 80)}`);
  if (rc != null) parts.push(`rc=${rc}`);
  if (msg) parts.push(safeLifecycleText(msg, 180));

  return parts.join(' · ');
}

function renderLifecycleSteps(taskId, logs) {
  const panel = document.getElementById('lifecycle-steps');
  const countEl = document.getElementById('lifecycle-count');
  const moreBtn = document.getElementById('lifecycle-more-btn');
  const resetBtn = document.getElementById('lifecycle-reset-btn');
  if (!panel) return;

  const all = Array.isArray(logs) ? logs.slice() : [];
  all.sort((a, b) => String(b?.ts || '').localeCompare(String(a?.ts || '')));

  const visibleCount = Math.min(
    LIFECYCLE_STEP_MAX,
    Math.max(LIFECYCLE_STEP_BATCH, lifecycleVisibleCountByTask[taskId] || LIFECYCLE_STEP_BATCH)
  );
  lifecycleVisibleCountByTask[taskId] = visibleCount;
  const shown = all.slice(0, visibleCount);

  if (countEl) {
    countEl.textContent = `${shown.length}/${all.length}`;
  }
  if (moreBtn) {
    moreBtn.style.display = shown.length < all.length ? 'inline-flex' : 'none';
  }
  if (resetBtn) {
    resetBtn.style.display = shown.length > LIFECYCLE_STEP_BATCH ? 'inline-flex' : 'none';
  }

  if (shown.length === 0) {
    panel.innerHTML = `<div class="lifecycle-empty">No lifecycle steps yet.</div>`;
    return;
  }

  panel.innerHTML = shown.map((log, idx) => {
    const rawType = String(log?.event_type || log?.what_happened || '');
    const title = lifecycleReadableEventName(log);
    const summary = lifecycleReadableSummary(log);
    const content = safeLifecycleText(log?.delivery?.content || '', 220);
    return `
      <div class="lifecycle-step">
        <span class="ts">${escapeHtml(formatLifecycleTime(log?.ts))}</span>
        <span class="type">${escapeHtml(rawType || 'event')}</span>
        <span class="summary">${escapeHtml(title)}</span>
        ${summary ? `<div class="lifecycle-meta">${escapeHtml(summary)}</div>` : ''}
        ${content ? `<div class="lifecycle-content">${escapeHtml(content)}</div>` : ''}
      </div>
    `;
  }).join('');
}

async function refreshLifecycleSteps(taskId) {
  if (!taskId) return;
  const panel = document.getElementById('lifecycle-steps');
  if (!panel) return;
  const requestTaskId = taskId;
  try {
    const data = await api(`/tasks/${encodeURIComponent(taskId)}/lifecycle?tail=${LIFECYCLE_STEP_MAX}`);
    if (requestTaskId !== currentTaskId) return;
    lifecycleLogsByTask[taskId] = Array.isArray(data?.logs) ? data.logs : [];
    renderLifecycleSteps(taskId, lifecycleLogsByTask[taskId]);
  } catch (e) {
    if (requestTaskId !== currentTaskId) return;
    panel.innerHTML = `<div class="lifecycle-empty" style="color:#f85149">Failed to load lifecycle steps: ${escapeHtml(e?.message || String(e))}</div>`;
  }
}

function showMoreLifecycleSteps() {
  if (!currentTaskId) return;
  const cur = lifecycleVisibleCountByTask[currentTaskId] || LIFECYCLE_STEP_BATCH;
  lifecycleVisibleCountByTask[currentTaskId] = Math.min(LIFECYCLE_STEP_MAX, cur + LIFECYCLE_STEP_BATCH);
  renderLifecycleSteps(currentTaskId, lifecycleLogsByTask[currentTaskId] || []);
}

function resetLifecycleSteps() {
  if (!currentTaskId) return;
  lifecycleVisibleCountByTask[currentTaskId] = LIFECYCLE_STEP_BATCH;
  renderLifecycleSteps(currentTaskId, lifecycleLogsByTask[currentTaskId] || []);
}

// Select and load task (full render only on task change)
async function selectTask(taskId) {
  if (!taskId || typeof taskId !== 'string') return;
  const needsFullRender = (taskId !== currentTaskId);
  currentTaskId = taskId;
  currentAttempt = null;

  // Reset etags on task change
  if (needsFullRender) liveLogEtag = {};

  const content = document.getElementById('content');
  try {
    const data = await api(`/task/${encodeURIComponent(taskId)}`);
    if (data && data.error) {
      if (content) content.innerHTML = `<div class="empty-state" style="padding:24px"><h2>${escapeHtml(taskId)}</h2><p style="color:#f85149">${escapeHtml(data.error)}</p></div>`;
      content.className = '';
      loadTasks();
      return;
    }
    if (needsFullRender) {
      renderTask(data);
    } else {
      updateTaskMeta(data);
    }
  } catch (e) {
    if (content) content.innerHTML = `<div class="empty-state" style="padding:24px"><h2>${escapeHtml(taskId)}</h2><p style="color:#f85149">Failed to load: ${escapeHtml(e.message || String(e))}</p></div>`;
    content.className = '';
  }
  loadTasks(); // refresh active state in sidebar
}

// Full task render — called once per task switch
function renderTask(data) {
  const { task, status, final_summary, attempts, timeline } = data;
  const s = status || {};
  const content = document.getElementById('content');

  content.innerHTML = `
    <h2 id="task-heading">${escapeHtml(s.task_id || currentTaskId)} <span id="task-heading-badge">${badge(s.state)}</span></h2>

    <div class="info-grid">
      <div class="info-card">
        <div class="label">State</div>
        <div class="value" id="meta-state">${badge(s.state)}</div>
      </div>
      <div class="info-card">
        <div class="label">Task Type / Mode</div>
        <div class="value" style="font-size:13px">
          <span id="meta-task-type">${escapeHtml(task?.task_type || s.task_type || '-')}</span> / 
          <span id="meta-launch-mode">${escapeHtml(task?.launch_mode || s.launch_mode || '-')}</span>
          ${(task?.launch_mode_locked || s.launch_mode_locked) ? '<span title="Locked" style="cursor:help">🔒</span>' : '<span title="Unlocked (prompts at Run)" style="cursor:help">🔓</span>'}
        </div>
      </div>
      <div class="info-card">
        <div class="label">Attempt</div>
        <div class="value" id="meta-attempt">${escapeHtml(String(s.current_attempt || 0))} / ${escapeHtml(String(s.max_attempts || s.effective_max_attempts || '-'))}</div>
      </div>
      <div class="info-card">
        <div class="label">Last Decision</div>
        <div class="value" id="meta-decision">${escapeHtml(s.last_decision || '-')}</div>
      </div>
      <div class="info-card">
        <div class="label">Run Config (v5.1)</div>
        <div class="value" id="meta-resolved-view" style="font-size:11px; color:var(--text-muted)">
          ${s.launch_mode_source ? `Source: ${escapeHtml(s.launch_mode_source)}` : '-'}
        </div>
      </div>
    </div>

    <div id="questions-for-user-container">
      ${s.state !== 'RUNNING' && Array.isArray(s.questions_for_user) && s.questions_for_user.length > 0 ? `
        <div class="questions-banner">
          <strong>Questions for user:</strong>
          <ul>
            ${s.questions_for_user.map(q => `<li>${escapeHtml(q)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
    </div>

    <div class="controls">
      <button class="btn btn-danger write-action" ${(s.state !== 'RUNNING') ? 'disabled' : ''} onclick="doControl('PAUSE', null, event)" title="Takes effect at next checkpoint when coordinator is running">Pause</button>
      <button class="btn btn-primary write-action" ${(s.state === 'RUNNING') ? 'disabled' : ''} onclick="doResume(event)" title="Resume and start coordinator">Resume</button>
      <button class="btn btn-primary write-action" ${(s.state === 'RUNNING') ? 'disabled' : ''} onclick="doRunNext(event)" title="Set RUN_NEXT and start coordinator (when PAUSED)">Run Next</button>
      <button class="btn btn-warn write-action" onclick="doForceRun(event)" title="Start coordinator ignoring lock (only if task is stuck)">Force Run</button>
      ${(s.state === 'PAUSED') ? `<button class="btn btn-primary write-action" onclick="openAdjustParamsModal()" title="Edit instance params (goal, repo_path, max_attempts) then run">Adjust params &amp; Run</button>` : ''}
      <button class="btn write-action" onclick="openUserInputModal()" title="E5/E5-2: Insert user input (written to user_input.jsonl; coordinator consumes on next run)">Insert user input</button>
      <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#8b949e;margin-left:6px">
        <input type="checkbox" class="run-surface-default-toggle" ${useDefaultRunSurface ? 'checked' : ''} onchange="setUseDefaultRunSurface(this.checked)">
        Use default run surface (no popup)
      </label>
    </div>
    <div id="controls-help" style="font-size:11px;color:#8b949e;margin-top:6px;margin-bottom:8px">
      <strong>Resume</strong>: 将状态设为 RUNNING 并启动 coordinator（一键恢复并运行）。 &nbsp;
      <strong>Run Next</strong>: 任务为 PAUSED 时，设置 RUN_NEXT 并启动 coordinator，从当前 attempt 继续执行。 &nbsp;
      <strong>Force Run</strong>: 忽略运行锁直接启动 coordinator，仅当任务卡住时使用。
    </div>

    <!-- B1: Live Log Panel with tab persistence -->
    <div class="live-panel">
      <div class="live-panel-header">
        <div class="tab-bar">
          <button id="tab-coordinator" class="tab-btn${activeTab === 'coordinator' ? ' active' : ''}" onclick="switchTab('coordinator')">Coordinator</button>
          <button id="tab-coder" class="tab-btn${activeTab === 'coder' ? ' active' : ''}" onclick="switchTab('coder')">Coder</button>
          <button id="tab-judge" class="tab-btn${activeTab === 'judge' ? ' active' : ''}" onclick="switchTab('judge')">Judge</button>
        </div>
        <div class="live-panel-controls">
          <button type="button" class="btn" style="font-size:11px;padding:2px 8px" onclick="if(currentTaskId){ fetchTabLog(currentTaskId, TAB_LOG_MAP[activeTab], true); }" title="Refresh current tab log">Refresh</button>
          <label style="font-size:12px;color:#8b949e;cursor:pointer">
            <input type="checkbox" id="autoscroll-toggle" ${autoScroll ? 'checked' : ''} onchange="toggleAutoScroll(this.checked)">
            AutoScroll
          </label>
          <span id="live-log-ts" style="font-size:11px;color:#8b949e;margin-left:8px"></span>
        </div>
      </div>
      <div id="live-log-scroll" class="live-log-scroll">
        <pre id="live-log-content" class="live-log-content">Loading...</pre>
      </div>
    </div>

    <h3>Attempts</h3>
    <div class="attempt-list" id="attempt-list">
      ${(attempts || []).map(a => `
        <div class="attempt-item" onclick="loadAttempt('${escapeHtml(currentTaskId)}', ${parseInt(a.name.replace('attempt_', ''))})">
          <strong>${escapeHtml(a.name)}</strong>
          — test rc: ${escapeHtml(String(a.test_rc ?? '?'))}
          — judge: ${escapeHtml(a.judge_decision || '?')}
          ${(task && (task.task_type === 'engineering_impl' || task.task_type === 'engineering_implementation') && a.diff_stat) ? `<br><small style="color:#8b949e">${escapeHtml(a.diff_stat.substring(0, 100))}</small>` : ''}
        </div>
      `).join('') || '<div style="color:#8b949e">No attempts yet</div>'}
    </div>

    <div id="attempt-detail"></div>

    <h3>Lifecycle Steps (<span id="lifecycle-count">0/0</span>)</h3>
    <div class="lifecycle-controls">
      <button id="lifecycle-more-btn" class="btn" type="button" onclick="showMoreLifecycleSteps()">Show ${LIFECYCLE_STEP_BATCH} more</button>
      <button id="lifecycle-reset-btn" class="btn" type="button" onclick="resetLifecycleSteps()">Reset to ${LIFECYCLE_STEP_BATCH}</button>
    </div>
    <div id="lifecycle-steps" class="lifecycle-steps">
      <div class="lifecycle-empty">Loading lifecycle steps...</div>
    </div>

    <h3>Raw Timeline (${escapeHtml(String((timeline || []).length))} events)</h3>
    <div class="timeline">
      ${(timeline || []).slice().reverse().slice(0, 50).map(e => `
        <div class="timeline-item">
          <span class="ts">${escapeHtml(e.ts ? e.ts.substring(11, 19) : '')}</span>
          <span class="type">${escapeHtml(e.type)}</span>
          <span class="summary">${escapeHtml(e.summary || '')}</span>
        </div>
      `).join('')}
    </div>
  `;
  content.className = '';

  // K7-1: apply read-only state to write-action buttons in task panel
  updateReadOnlyBanner();

  if (!lifecycleVisibleCountByTask[currentTaskId]) {
    lifecycleVisibleCountByTask[currentTaskId] = LIFECYCLE_STEP_BATCH;
  }
  refreshLifecycleSteps(currentTaskId);

  // Immediately load the active tab's log
  const logName = TAB_LOG_MAP[activeTab];
  if (logName) fetchTabLog(currentTaskId, logName, true);
}

// B3-2: Load attempt detail — uses fixed field set from API. Live panel always shows latest attempt logs (not tied to selected attempt).
let _soloProgressRefreshIntervalId = null;

async function loadAttempt(taskId, n) {
  currentAttempt = n;
  if (_soloProgressRefreshIntervalId != null) {
    clearInterval(_soloProgressRefreshIntervalId);
    _soloProgressRefreshIntervalId = null;
  }
  const data = await api(`/task/${taskId}/attempt/${n}`);
  const detail = document.getElementById('attempt-detail');

  // B3-2: Use fixed fields from API (task_id, attempt, role, paths, rc, updated_at, verdict_summary)
  const vs = data.verdict_summary || {};
  const paths = data.paths || {};

  detail.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin:16px 0">
      <div id="solo-progress-container"></div>
      <h3>Attempt ${escapeHtml(String(n))} Detail
        <small style="color:#8b949e;font-size:13px;margin-left:8px">role: ${escapeHtml(data.role || 'coder')}</small>
      </h3>

      ${vs.final_score_0_100 !== null && vs.final_score_0_100 !== undefined ? `
        <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;margin-bottom:12px">
          <strong>Verdict Summary</strong>
          <div style="margin-top:6px;font-size:13px">
            Score: <strong>${escapeHtml(String(vs.final_score_0_100))}/100</strong>
            · Gated: <strong>${escapeHtml(String(vs.gated ?? '-'))}</strong>
            ${vs.pause_reason_code ? ` · Reason: <strong>${escapeHtml(vs.pause_reason_code)}</strong>` : ''}
          </div>
          ${vs.top_issues && vs.top_issues.length > 0 ? `
            <div style="margin-top:6px;font-size:12px;color:#8b949e">
              Top issues: ${vs.top_issues.map(i => escapeHtml(i)).join(' · ')}
            </div>
          ` : ''}
        </div>
      ` : ''}

      ${Object.values(paths).some(v => v !== null) ? `
        <div style="margin-bottom:12px;font-size:12px;color:#8b949e">
          <strong>Paths:</strong>
          ${Object.entries(paths).filter(([, v]) => v !== null).map(([k, v]) =>
            `<div>${escapeHtml(k)}: <code>${escapeHtml(v)}</code></div>`
          ).join('')}
        </div>
      ` : ''}

      <div style="margin-bottom:8px;font-size:12px;color:#8b949e">
        RC: ${escapeHtml(String(data.rc ?? '?'))} · Updated: ${escapeHtml(data.updated_at || '-')}
      </div>

      <h3>Coder input (instruction)</h3>
      <textarea id="instruction-edit">${escapeHtml(data.instruction || '(none)')}</textarea>
      <button class="btn write-action" onclick="saveInstruction(${escapeHtml(String(n))})" style="margin-top:8px">Save Instruction</button>

      <h3>Coder output</h3>
      <pre class="attempt-block">${escapeHtml(decodeUnicodeEscapes(data.coder_output) || '(no coder output)')}</pre>

      <h3>Judge input (prompt + evidence)</h3>
      <p style="font-size:12px;color:#8b949e">Prompt given to judge:</p>
      <pre class="attempt-block">${escapeHtml(data.judge_prompt_text || '(no prompt file)')}</pre>
      <p style="font-size:12px;color:#8b949e;margin-top:8px">Evidence JSON appended to prompt:</p>
      <pre class="attempt-block">${escapeHtml(data.evidence ? decodeUnicodeEscapes(JSON.stringify(data.evidence, null, 2)) : '(no evidence)')}</pre>

      <h3>Judge output (verdict)</h3>
      <pre class="attempt-block">${escapeHtml(data.verdict ? JSON.stringify(data.verdict, null, 2) : '(no verdict)')}</pre>

      ${(data.task_type === 'engineering_impl' || data.task_type === 'engineering_implementation') ? `
      <h3>Test Result (rc: ${escapeHtml(String(data.test_rc || data.rc || '?'))})</h3>
      <pre class="attempt-block">${escapeHtml(data.test_log || '(no log)')}</pre>

      <h3>Diff Stat</h3>
      <pre class="attempt-block">${escapeHtml(data.diff_stat || '(no diff)')}</pre>
      ` : ''}

      <h3>Metrics</h3>
      <pre class="attempt-block">${escapeHtml(data.metrics ? JSON.stringify(data.metrics, null, 2) : '(no metrics)')}</pre>
    </div>
  `;
  // Task 10 Step 4: Solo progress panel + 5s refresh when executor_type === 'solo_agent' (or legacy workflow_mode === 'solo')
  const soloContainer = document.getElementById('solo-progress-container');
  if (soloContainer) {
    const runData = await api(`/task/${encodeURIComponent(taskId)}`).catch(() => ({}));
    const isSolo = runData.task && (runData.task.executor_type === 'solo_agent' || runData.task.workflow_mode === 'solo');
    if (isSolo) {
      await renderSoloProgress(taskId, n, soloContainer);
      _soloProgressRefreshIntervalId = setInterval(async () => {
        const status = await api(`/tasks/${encodeURIComponent(taskId)}/status`).catch(() => ({}));
        if (status.state === 'running') {
          await renderSoloProgress(taskId, n, soloContainer);
        } else {
          if (_soloProgressRefreshIntervalId != null) {
            clearInterval(_soloProgressRefreshIntervalId);
            _soloProgressRefreshIntervalId = null;
          }
          await renderSoloProgress(taskId, n, soloContainer);
        }
      }, 5000);
    }
  }
  updateReadOnlyBanner();
}

// Control actions — B1-1: use refreshCurrentTaskMeta instead of selectTask to preserve tab
async function doControl(action, payload, e) {
  if (!currentTaskId) return;
  const btn = e ? e.currentTarget : null;
  setButtonLoading(btn, true);
  try {
    const res = await api(`/task/${currentTaskId}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload: payload || {} })
    });
    if (res && res.cleaned_up) {
      alert('Task was stuck (ghost process); lock cleaned up and status reset to PAUSED.');
    } else if (res && res.signalled) {
      alert('Pause signal sent to active process group. Task should pause shortly.');
    }
    // B1-1: only refresh meta, do NOT trigger full re-render / tab reset
    setTimeout(refreshCurrentTaskMeta, 500);
  } finally {
    setButtonLoading(btn, false);
  }
}

function resolveExecutorTypeFromSpec(spec) {
  if (!spec || typeof spec !== 'object') return '';
  if (spec.executor_type) return spec.executor_type;
  return workflowModeToExecutorType(spec.workflow_mode);
}

function setUseDefaultRunSurface(checked) {
  useDefaultRunSurface = checked === true;
  localStorage.setItem('rdloop_use_default_run_surface', useDefaultRunSurface ? 'true' : 'false');
  document.querySelectorAll('.run-surface-default-toggle').forEach(el => {
    el.checked = useDefaultRunSurface;
  });
}

async function getConfiguredDefaultRunSurface() {
  try {
    const cfg = await api('/config');
    return cfg.default_run_surface === 'visual_ccb' ? 'visual_ccb' : 'bridge';
  } catch {
    return 'bridge';
  }
}

function inferRunSurfaceFromSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'bridge';
  if (spec.run_surface === 'visual_ccb') return 'visual_ccb';
  return spec.execution_mode === 'semi-auto' ? 'visual_ccb' : 'bridge';
}

function openRunSurfaceModal(defaultSurface, titleText) {
  return new Promise((resolve) => {
    const old = document.getElementById('run-surface-modal');
    if (old) old.remove();
    const initial = defaultSurface === 'visual_ccb' ? 'visual_ccb' : 'bridge';
    const title = titleText || 'Choose run mode';
    const modalHtml = `
      <div id="run-surface-modal" class="modal-overlay" onclick="if(event.target===this){ this.remove(); window.__resolveRunSurface && window.__resolveRunSurface(null); window.__resolveRunSurface=null; }">
        <div class="modal-box" style="max-width:520px">
          <h3 style="margin-top:0">${escapeHtml(title)}</h3>
          <div style="font-size:12px;color:#8b949e;margin-bottom:10px">Select run mode for this start only.</div>
          <label style="display:block;padding:8px 10px;border:1px solid #30363d;border-radius:6px;margin-bottom:8px;cursor:pointer">
            <input type="radio" name="run-surface-choice" value="bridge" ${initial === 'bridge' ? 'checked' : ''} style="margin-right:8px">
            Non-visible (bridge / solo_bridge)
          </label>
          <label style="display:block;padding:8px 10px;border:1px solid #30363d;border-radius:6px;cursor:pointer">
            <input type="radio" name="run-surface-choice" value="visual_ccb" ${initial === 'visual_ccb' ? 'checked' : ''} style="margin-right:8px">
            Visible (CCB session)
          </label>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
            <button class="btn" onclick="const m=document.getElementById('run-surface-modal'); if(m)m.remove(); window.__resolveRunSurface && window.__resolveRunSurface(null); window.__resolveRunSurface=null;">Cancel</button>
            <button class="btn btn-primary write-action" onclick="const c=document.querySelector('input[name=run-surface-choice]:checked'); const v=c?c.value:'bridge'; const m=document.getElementById('run-surface-modal'); if(m)m.remove(); window.__resolveRunSurface && window.__resolveRunSurface(v); window.__resolveRunSurface=null;">Run</button>
          </div>
        </div>
      </div>`;
    window.__resolveRunSurface = (value) => resolve(value);
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    updateReadOnlyBanner();
  });
}

/**
 * v5.1.4: Resolves launch_mode for task start. (F3)
 * If locked=true, returns task.launch_mode.
 * If locked=false, shows modal to choose.
 */
async function pickLaunchModeForStart(spec, titleText) {
  const normalized = normalizeSpecToV51(spec);
  const nSpec = normalized.spec;
  
  if (nSpec.launch_mode_locked === true && nSpec.launch_mode) {
    return { cancelled: false, launch_mode: nSpec.launch_mode, save_and_lock: false };
  }
  
  // F3: Always show dialog if not locked (or launch_mode missing)
  const result = await openV51RunDialog(nSpec.launch_mode || 'bridge', titleText);
  if (!result) return { cancelled: true };
  
  return { 
    cancelled: false, 
    launch_mode: result.launch_mode, 
    save_and_lock: result.save_and_lock 
  };
}

function openV51RunDialog(defaultMode, titleText) {
  return new Promise((resolve) => {
    const old = document.getElementById('run-v51-modal');
    if (old) old.remove();
    
    const title = titleText || 'Run Task (v5.1)';
    const modalHtml = `
      <div id="run-v51-modal" class="modal-overlay" onclick="if(event.target===this){ resolve(null); this.remove(); }">
        <div class="modal-box" style="max-width:480px">
          <h3 style="margin-top:0">${escapeHtml(title)}</h3>
          <p style="font-size:13px; color:var(--text-muted); margin-bottom:16px">Task launch mode is not locked. Please select how to run this task:</p>
          
          <div style="margin-bottom:20px">
            <label class="form-label">Launch Mode</label>
            <select id="run-v51-launch-mode" class="form-select">
              <option value="bridge" ${defaultMode === 'bridge' ? 'selected' : ''}>bridge (non-visible)</option>
              <option value="ccb" ${defaultMode === 'ccb' ? 'selected' : ''}>ccb (visible tmux)</option>
            </select>
          </div>
          
          <div style="display:flex; gap:12px; justify-content:flex-end">
            <button class="btn" onclick="document.getElementById('run-v51-modal').remove(); resolve(null);">Cancel</button>
            <button class="btn btn-primary" id="run-v51-once">Run once</button>
            <button class="btn btn-primary" id="run-v51-save-lock" style="background:var(--accent-blue)">Save &amp; Lock</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    document.getElementById('run-v51-once').onclick = () => {
      const mode = document.getElementById('run-v51-launch-mode').value;
      document.getElementById('run-v51-modal').remove();
      resolve({ launch_mode: mode, save_and_lock: false });
    };
    
    document.getElementById('run-v51-save-lock').onclick = () => {
      const mode = document.getElementById('run-v51-launch-mode').value;
      document.getElementById('run-v51-modal').remove();
      resolve({ launch_mode: mode, save_and_lock: true });
    };
  });
}

// Legacy compat wrapper
async function pickRunSurfaceForStart(spec, titleText) {
  const result = await pickLaunchModeForStart(spec, titleText);
  if (result.cancelled) return { cancelled: true };
  return { 
    cancelled: false, 
    runSurface: result.launch_mode === 'ccb' ? 'visual_ccb' : 'bridge',
    saveAndLock: result.save_and_lock
  };
}

// Run Next: set RUN_NEXT (so --continue will advance from PAUSED) then start coordinator
async function doRunNext(e) {
  if (!currentTaskId) return;
  const btn = e ? e.currentTarget : null;
  setButtonLoading(btn, true);
  try {
    const runData = await api(`/task/${encodeURIComponent(currentTaskId)}`).catch(() => ({}));
    const picked = await pickLaunchModeForStart(runData.task || {}, `Run Task: ${currentTaskId}`);
    if (picked.cancelled) return;
    
    await api(`/task/${currentTaskId}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'RUN_NEXT', payload: {} })
    });
    
    const result = await api(`/run/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        task_id: currentTaskId,
        task_snapshot: runData.task,
        runtime_overrides: { launch_mode: picked.launch_mode },
        save_and_lock: picked.save_and_lock
      })
    }).catch(e => ({ error: e?.message || String(e) }));
    
    if (result && result.error) {
      if (String(result.error).includes('already running')) {
        alert('Task is already running.');
        return;
      }
      alert(result.error);
      return;
    }
    setTimeout(refreshCurrentTaskMeta, 1000);
  } finally {
    setButtonLoading(btn, false);
  }
}

// Resume: set RESUME then start coordinator (one click = resume + run)
async function doResume(e) {
  if (!currentTaskId) return;
  const btn = e ? e.currentTarget : null;
  setButtonLoading(btn, true);
  try {
    const runData = await api(`/task/${encodeURIComponent(currentTaskId)}`).catch(() => ({}));
    const picked = await pickLaunchModeForStart(runData.task || {}, `Resume Task: ${currentTaskId}`);
    if (picked.cancelled) return;
    
    await api(`/task/${currentTaskId}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'RESUME', payload: {} })
    });
    
    const result = await api(`/run/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        task_id: currentTaskId,
        task_snapshot: runData.task,
        runtime_overrides: { launch_mode: picked.launch_mode },
        save_and_lock: picked.save_and_lock
      })
    }).catch(e => ({ error: e?.message || String(e) }));
    
    if (result && result.error) {
      if (String(result.error).includes('already running')) {
        alert('Task is already running.');
        return;
      }
      alert(result.error);
      return;
    }
    setTimeout(refreshCurrentTaskMeta, 1000);
  } finally {
    setButtonLoading(btn, false);
  }
}

// Force Run: start coordinator ignoring lock (use only when task is stuck)
async function doForceRun(e) {
  if (!currentTaskId) return;
  const btn = e ? e.currentTarget : null;
  if (!confirm('Force Run ignores the running lock. Use only if the task is stuck. Continue?')) return;
  setButtonLoading(btn, true);
  try {
    const runData = await api(`/task/${encodeURIComponent(currentTaskId)}`).catch(() => ({}));
    const picked = await pickLaunchModeForStart(runData.task || {}, `Force Run Task: ${currentTaskId}`);
    if (picked.cancelled) return;
    
    await api(`/run/create?force=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        task_id: currentTaskId,
        task_snapshot: runData.task,
        runtime_overrides: { launch_mode: picked.launch_mode },
        save_and_lock: picked.save_and_lock
      })
    });
    setTimeout(refreshCurrentTaskMeta, 1000);
  } finally {
    setButtonLoading(btn, false);
  }
}

async function saveInstruction(n) {
  if (!currentTaskId) return;
  const text = document.getElementById('instruction-edit').value;
  await doControl('EDIT_INSTRUCTION', { attempt: n, instruction_text: text });
}

// E5/E5-2: GUI "Insert user input" window — writes to user_input.jsonl (fixed schema); coordinator consumes and writes last_user_input_ts_consumed
function openUserInputModal() {
  if (!currentTaskId) return;
  const old = document.getElementById('user-input-modal');
  if (old) old.remove();
  const requestId = 'gui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  const modalHtml = `
    <div id="user-input-modal" class="modal-overlay" onclick="if(event.target===this)closeUserInputModal()">
      <div class="modal-box" style="max-width:520px">
        <h3 style="margin-top:0">Insert user input</h3>
        <p style="font-size:12px;color:#8b949e;margin-bottom:12px">Text will be appended to <code>user_input.jsonl</code>. Coordinator consumes it on the next run and writes <code>last_user_input_ts_consumed</code>.</p>
        <label class="form-label">Your input (text)</label>
        <textarea id="user-input-text" class="form-input" rows="4" placeholder="Answer or instruction for the task..."></textarea>
        <div id="user-input-msg" style="font-size:12px;margin-top:8px;color:#f85149"></div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-primary write-action" onclick="submitUserInput()">Submit</button>
          <button class="btn" onclick="closeUserInputModal()">Cancel</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();
  document.getElementById('user-input-text').focus();
}

function closeUserInputModal() {
  const modal = document.getElementById('user-input-modal');
  if (modal) modal.remove();
}

async function submitUserInput() {
  if (!currentTaskId) return;
  const textEl = document.getElementById('user-input-text');
  const msgEl = document.getElementById('user-input-msg');
  const text = (textEl && textEl.value || '').trim();
  if (!text) {
    if (msgEl) msgEl.textContent = 'Please enter some text.';
    return;
  }
  if (msgEl) msgEl.textContent = '';
  const requestId = 'gui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(currentTaskId)}/user_input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, request_id: requestId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (msgEl) msgEl.textContent = data.error || 'Request failed';
      return;
    }
    closeUserInputModal();
    refreshCurrentTaskMeta();
  } catch (e) {
    if (msgEl) msgEl.textContent = e.message || 'Request failed';
  }
}

// Adjust params & Run: for PAUSED task — edit goal, repo_path, max_attempts then save and run
async function openAdjustParamsModal() {
  if (!currentTaskId) return;
  const old = document.getElementById('adjust-params-modal');
  if (old) old.remove();
  let task = {};
  let overrides = {};
  try {
    const data = await api(`/task/${currentTaskId}`);
    task = data.task || {};
    const ov = await api(`/task/${currentTaskId}/runtime_overrides`);
    overrides = ov.overrides || {};
  } catch (e) {
    alert('Failed to load task: ' + (e?.message || String(e)));
    return;
  }
  const maxAttempts = overrides.max_attempts ?? task.max_attempts ?? 3;
  const modalHtml = `
    <div id="adjust-params-modal" class="modal-overlay" onclick="if(event.target===this)closeAdjustParamsModal()">
      <div class="modal-box" style="max-width:560px">
        <h3 style="margin-top:0">Adjust params &amp; Run</h3>
        <p style="font-size:12px;color:#8b949e;margin-bottom:12px">Edit instance params for this run, then run. Only available when task is PAUSED.</p>
        <label class="form-label" style="font-size:11px">goal</label>
        <textarea id="adjust-goal" class="form-input" rows="3" placeholder="Task goal">${escapeHtml((task.goal || ''))}</textarea>
        <label class="form-label" style="font-size:11px;margin-top:8px">repo_path</label>
        <input type="text" id="adjust-repo-path" class="form-input" value="${escapeHtml(task.repo_path || '')}" placeholder="/path/to/repo">
        <label class="form-label" style="font-size:11px;margin-top:8px">max_attempts (1–50)</label>
        <input type="number" id="adjust-max-attempts" class="form-input" min="1" max="50" value="${escapeHtml(String(maxAttempts))}">
        <div id="adjust-params-msg" style="font-size:12px;margin-top:8px;color:#f85149"></div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-primary write-action" onclick="submitAdjustParamsAndRun()">Save &amp; Run Next</button>
          <button class="btn" onclick="closeAdjustParamsModal()">Cancel</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();
}

function closeAdjustParamsModal() {
  const modal = document.getElementById('adjust-params-modal');
  if (modal) modal.remove();
}

async function submitAdjustParamsAndRun() {
  if (!currentTaskId) return;
  const msgEl = document.getElementById('adjust-params-msg');
  if (msgEl) msgEl.textContent = '';
  const goal = (document.getElementById('adjust-goal')?.value ?? '').trim();
  const repoPath = (document.getElementById('adjust-repo-path')?.value ?? '').trim();
  const maxAttemptsRaw = document.getElementById('adjust-max-attempts')?.value;
  const maxAttempts = maxAttemptsRaw ? Math.max(1, Math.min(50, parseInt(maxAttemptsRaw, 10))) : undefined;
  if (maxAttempts !== undefined && (isNaN(maxAttempts) || maxAttempts < 1 || maxAttempts > 50)) {
    if (msgEl) msgEl.textContent = 'max_attempts must be 1–50';
    return;
  }
  try {
    const patch = {};
    if (goal !== undefined) patch.goal = goal;
    if (repoPath !== undefined) patch.repo_path = repoPath || undefined;
    if (maxAttempts !== undefined) patch.max_attempts = maxAttempts;
    if (Object.keys(patch).length) {
      const res = await fetch(`/api/task/${encodeURIComponent(currentTaskId)}/task_json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msgEl) msgEl.textContent = data.error || 'Failed to update task';
        return;
      }
    }
    if (maxAttempts !== undefined) {
      const requestId = 'gui-adjust-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      await fetch(`/api/tasks/${encodeURIComponent(currentTaskId)}/runtime_overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: { max_attempts: maxAttempts }, request_id: requestId })
      });
    }
    closeAdjustParamsModal();
    await doRunNext();
  } catch (e) {
    if (msgEl) msgEl.textContent = e?.message || 'Request failed';
  }
}

// ================================================================
// A2: Task Spec CRUD — list, new, edit, copy, delete
// A4: task_type + rubric_thresholds
// A5: adapter selector
// ================================================================

let cachedAdapters = null;
let cachedCliapiProviders = {};
// C1-1: when false, PARTIAL adapters must not be selectable as default or for Run
let cachedAllowPartialRun = false;
let cachedRubric = {};

// A1-2: Selected spec for detail view (task_id or null)
let selectedSpecTaskId = null;

// Load task specs list (A1-2: task_id, task_type, scoring_mode, updated_at; click → detail)
async function loadTaskSpecs() {
  const list = document.getElementById('template-list');
  if (!list) return;

  let specs = [];
  try {
    const data = await api('/task_specs');
    specs = data.specs || [];
  } catch (e) {}

  let html = '';

  // Render hardcoded templates first
  html += Object.entries(TEMPLATES).map(([id, tpl]) => `
    <div class="task-item" style="cursor:default">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div onclick="openNewSpecModalWithTemplate('${id}')" style="cursor:pointer;flex:1;min-width:0">
          <div class="task-id" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(id)} <span style="font-size:10px;color:#8b949e">(tpl)</span></div>
          <div class="task-meta">
            <span class="task-state-tag">${escapeHtml(tpl.task_type || 'solo')}</span>
            <span style="font-size:11px;color:#8b949e">Built-in</span>
          </div>
        </div>
        <button class="btn btn-primary write-action" style="padding:2px 6px;font-size:10px;margin-left:4px"
          onclick="generateTaskFromTemplate('${id}')">Generate</button>
      </div>
    </div>
  `).join('');

  // Render loaded specs
  html += specs.map(s => `
    <div class="task-item ${s.task_id === selectedSpecTaskId ? 'active' : ''}" style="padding:10px 12px;cursor:default">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div onclick="showSpecDetail('${escapeHtml(s.task_id)}')" style="cursor:pointer;flex:1;min-width:0">
          <div class="task-id" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.task_id)}</div>
          <div style="font-size:11px;color:#8b949e">
            ${escapeHtml(s.task_type || 'no type')} · ${escapeHtml(s.updated_at ? s.updated_at.slice(5, 16).replace('T', ' ') : '')}
          </div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;align-items:center">
          <button class="btn btn-primary write-action" style="padding:2px 6px;font-size:10px"
            onclick="generateTaskFromTemplate('${escapeHtml(s.task_id)}')">Generate</button>
          <button class="btn" style="padding:2px 6px;font-size:10px"
            onclick="openEditSpecModal('${escapeHtml(s.task_id)}')">Edit</button>
          <button class="btn btn-danger write-action" style="padding:2px 6px;font-size:10px"
            onclick="deleteSpec('${escapeHtml(s.task_id)}')">×</button>
        </div>
      </div>
    </div>
  `).join('');

  list.innerHTML = html;
  updateReadOnlyBanner();
}

// A1-3: Show task spec detail in main content (full JSON + key fields + Run task)
async function showSpecDetail(taskId) {
  selectedSpecTaskId = taskId;
  loadTaskSpecs();
  const content = document.getElementById('content');
  content.innerHTML = '<div style="padding:16px;color:#8b949e">Loading...</div>';
  try {
    const data = await api(`/task_specs/${encodeURIComponent(taskId)}`);
    const spec = data.spec || {};
    const keys = ['task_id', 'goal', 'task_type', 'scoring_mode', 'rubric_thresholds', 'coder', 'judge', 'coder_model', 'judge_model'];
    const keyFields = keys.map(k => {
      const v = spec[k];
      const str = v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      return `<div style="margin-bottom:6px"><strong>${escapeHtml(k)}</strong>: ${escapeHtml(str)}</div>`;
    }).join('');
    content.innerHTML = `
      <h2>${escapeHtml(taskId)} <span style="font-size:14px;color:#8b949e">Task Spec</span></h2>
      <div style="margin-bottom:16px">
        <strong>Key fields</strong>
        <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;margin-top:8px;font-size:12px">
          ${keyFields}
        </div>
      </div>
      <div style="margin-bottom:16px">
        <button class="btn btn-primary" onclick="runTaskFromSpec('${escapeHtml(taskId)}')">Run task</button>
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#8b949e;margin-left:10px">
          <input type="checkbox" class="run-surface-default-toggle" ${useDefaultRunSurface ? 'checked' : ''} onchange="setUseDefaultRunSurface(this.checked)">
          Use default run surface (no popup)
        </label>
        <span id="spec-run-msg" style="margin-left:8px;font-size:12px;color:#8b949e"></span>
      </div>
      <div style="margin-bottom:8px"><strong>Full JSON</strong></div>
      <pre class="code-editor" style="background:#0d1117;padding:12px;border-radius:8px;overflow:auto;max-height:400px;font-size:12px">${escapeHtml(JSON.stringify(spec, null, 2))}</pre>
    `;
  } catch (e) {
    content.innerHTML = `<div style="padding:16px;color:#f85149">Failed to load spec: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

async function runTaskFromSpec(taskId) {
  const msgEl = document.getElementById('spec-run-msg');
  if (msgEl) msgEl.textContent = 'Starting...';
  try {
    const detail = await api(`/task_specs/${encodeURIComponent(taskId)}`);
    const spec = detail?.spec || {};
    const picked = await pickRunSurfaceForStart(spec, `Run Spec: ${taskId}`);
    if (picked.cancelled) {
      if (msgEl) msgEl.textContent = 'Cancelled.';
      return;
    }
    const result = await fetch(`/api/task_specs/${encodeURIComponent(taskId)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(picked.runSurface ? { run_surface: picked.runSurface } : {})
    });
    const data = await result.json();
    if (!result.ok) {
      if (msgEl) msgEl.textContent = data.error || 'Failed';
      return;
    }
    if (msgEl) msgEl.textContent = 'Started (pid: ' + (data.pid || '') + '). Select task in sidebar to watch.';
    loadTasks();
  } catch (e) {
    if (msgEl) msgEl.textContent = 'Error: ' + (e.message || String(e));
  }
}

// A5: Load adapters and cliapi providers; A6: apply saved defaults when present
async function loadAdapters() {
  try {
    const data = await api('/adapters');
    cachedAdapters = data.adapters || [];
    cachedAllowPartialRun = data.allow_partial_run === true;
  } catch {
    cachedAdapters = [];
    cachedAllowPartialRun = false;
  }
  try {
    const cliapi = await api('/cliapi-providers');
    cachedCliapiProviders = cliapi.providers || {};
  } catch {
    cachedCliapiProviders = {};
  }
}

/**
 * Prompt for a template name and save current form state as a new spec (template).
 */
async function makeCurrentAsTemplate() {
  let tplName = prompt('Enter a name for this template (alphanumeric, underscore, hyphen):');
  if (!tplName) return;
  if (!/^[A-Za-z0-9_-]+$/.test(tplName)) {
    alert('Invalid template name.');
    return;
  }
  
  if (!tplName.startsWith('template_')) {
    tplName = 'template_' + tplName;
  }
  
  // Use existing saveNewSpec logic but with the new template name as taskId
  const originalTaskIdEl = document.getElementById('modal-task-id');
  const originalVal = originalTaskIdEl.value;
  originalTaskIdEl.value = tplName;
  try {
    await saveNewSpec();
    alert('Template saved successfully: ' + tplName);
  } finally {
    originalTaskIdEl.value = originalVal;
  }
}

/**
 * Generate a new task instance from a template (built-in or saved spec).
 */
async function generateTaskFromTemplate(templateId) {
  let baseSpec = {};
  if (TEMPLATES[templateId]) {
    baseSpec = TEMPLATES[templateId];
  } else {
    try {
      const data = await api(`/task_specs/${encodeURIComponent(templateId)}`);
      baseSpec = data.spec || {};
    } catch (e) {
      alert('Failed to load base spec: ' + e.message);
      return;
    }
  }

  let newTaskId = prompt('Enter new Task ID for the instance:', 'task_' + new Date().getTime().toString().slice(-6));
  if (!newTaskId) return;
  if (!/^[A-Za-z0-9_-]+$/.test(newTaskId)) {
    alert('Invalid Task ID.');
    return;
  }

  // Ensure instances don't accidentally get saved as templates
  if (newTaskId.startsWith('template_')) {
    newTaskId = newTaskId.replace(/^template_/, '');
  }

  const spec = { ...baseSpec, task_id: newTaskId, created_at: new Date().toISOString() };
  
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: newTaskId, spec })
    });
    const result = await res.json();
    if (!res.ok) {
      alert('Generation failed: ' + (result.error || 'Validation failed'));
      return;
    }
    alert('Task instance generated: ' + newTaskId);
    loadTasks(); // Refresh tasks list
    loadTaskSpecs(); // Refresh templates list (just in case)
  } catch (e) {
    alert('Save failed: ' + (e.message || String(e)));
  }
}

// A4: Load rubric for a task_type and cache
async function loadRubric(taskType) {
  if (!taskType || cachedRubric[taskType]) return cachedRubric[taskType] || null;
  try {
    const data = await api(`/rubric/${encodeURIComponent(taskType)}`);
    if (data.dimensions) {
      cachedRubric[taskType] = data;
    }
    return cachedRubric[taskType] || null;
  } catch {
    return null;
  }
}

// A5: Build adapter selector — show all detected adapters except mock* and unavailable.
// v3.3 P14: Two-layer — channel type (coding-agent-cli | cliapi-proxy | ccb) then adapter/config.
const CHANNEL_TYPES = [
  { value: 'coding-agent-cli', label: 'Coding Agent CLI', tag: '工具调用 | 文件操作 | 多轮调度' },
  { value: 'cliapi-proxy', label: 'CLIProxyAPI', tag: '文本补全' },
  { value: 'ccb', label: 'CCB', tag: '需启动 CCB session' }
];
const AGENT_CLI_OPTIONS = ['codex', 'gemini', 'claude', 'opencode', 'droid'];
const CCB_PROVIDER_OPTIONS = ['codex', 'gemini'];

function inferChannelFromAdapter(adapterName) {
  if (!adapterName) return 'coding-agent-cli';
  if (adapterName === 'ccb') return 'ccb';
  if (AGENT_CLI_OPTIONS.includes(adapterName) || ['codex-cli', 'claude-cli', 'cursor-cli', 'antigravity-cli'].includes(String(adapterName || '').toLowerCase())) return 'coding-agent-cli';
  return 'cliapi-proxy';
}

function buildAdapterSelectorOnly(role, selectedName) {
  const isMock = (name) => ['mock', 'mock-timeout', 'mock_need_input'].includes(name);
  const alwaysInclude = (name) => name === 'codex-cli' || name === 'claude-cli';
  const adapterType = (role === 'settings-coder' ? 'coder' : role === 'settings-judge' ? 'judge' : role);
  let adapters = (cachedAdapters || []).filter(a => {
    if (a.type !== adapterType) return false;
    if (isMock(a.name)) return false;
    if (a.status !== 'OK' && !alwaysInclude(a.name)) return false;
    if (!cachedAllowPartialRun && a.support_level === 'PARTIAL' && !alwaysInclude(a.name)) return false;
    return true;
  });
  if (adapters.length === 0) {
    return `<select id="adapter-${role}" class="form-select" onchange="refreshModelSelector('${role}'); if (typeof syncFormToJson === 'function') syncFormToJson()"><option value="">Loading...</option></select>`;
  }
  const options = adapters.map(a => {
    const disabled = a.status !== 'OK' ? 'disabled' : '';
    const label = `${a.name} [${a.status}]${a.reason ? ' — ' + a.reason : ''}`;
    const sel = a.name === selectedName ? 'selected' : '';
    return `<option value="${escapeHtml(a.name)}" ${disabled} ${sel}>${escapeHtml(label)}</option>`;
  }).join('');
  return `<select id="adapter-${role}" class="form-select" onchange="refreshModelSelector('${role}'); if (typeof syncFormToJson === 'function') syncFormToJson()">${options}</select>`;
}

// Cliapi: provider + optional model (second-level) selector. selectedModel = model id or ''
// v3.3 P14: When channelType is coding-agent-cli, only show CLI options (no model). When ccb, show provider dropdown (codex/gemini); store coder=ccb, coder_model=provider.
function buildAdapterSelector(role, selectedProvider, selectedModel, channelTypeOptional) {
  const channel = channelTypeOptional != null ? channelTypeOptional : (document.getElementById('adapter-channel-type')?.value || 'coding-agent-cli');
  if (channel === 'ccb') {
    const selCodex = (selectedProvider === 'ccb' && selectedModel === 'codex') || selectedProvider === 'codex' ? 'selected' : '';
    const selGemini = (selectedProvider === 'ccb' && selectedModel === 'gemini') || selectedProvider === 'gemini' ? 'selected' : '';
    return `
    <div class="adapter-row-${role}" style="display:flex;flex-direction:column;gap:6px">
      <select id="adapter-${role}" class="form-select" data-ccb-provider="true">
        <option value="codex" ${selCodex}>codex</option>
        <option value="gemini" ${selGemini}>gemini</option>
      </select>
      <div id="${role}-model-wrap" class="model-wrap" style="display:none"><select id="adapter-${role}-model" class="form-select"></select></div>
      <div style="font-size:11px;color:#8b949e">Start CCB session in Settings if not running.</div>
    </div>`;
  }
  if (channel === 'coding-agent-cli') {
    const selectedNorm = normalizeProviderFromAny(selectedProvider || '');
    const options = AGENT_CLI_OPTIONS.map(name => {
      const sel = name === selectedNorm ? 'selected' : '';
      return `<option value="${escapeHtml(name)}" ${sel}>${escapeHtml(providerDisplayName(name))}</option>`;
    }).join('');
    return `
    <div class="adapter-row-${role}" style="display:flex;flex-direction:column;gap:6px">
      <select id="adapter-${role}" class="form-select" onchange="refreshModelSelector('${role}'); if (typeof syncFormToJson === 'function') syncFormToJson()">${options}</select>
      <div id="${role}-model-wrap" class="model-wrap" style="display:none"><select id="adapter-${role}-model" class="form-select"></select></div>
    </div>`;
  }
  // cliapi-proxy: current behavior
  const providerHtml = buildAdapterSelectorOnly(role, selectedProvider || '');
  const models = (cachedCliapiProviders[selectedProvider] && cachedCliapiProviders[selectedProvider].models) || [];
  const showModel = models.length > 0;
  let modelOptions = '<option value="">— default —</option>';
  if (showModel) {
    modelOptions = models.map(m => {
      const sel = (selectedModel && m.id === selectedModel) ? 'selected' : '';
      return `<option value="${escapeHtml(m.id)}" ${sel}>${escapeHtml(m.alias || m.id)}</option>`;
    }).join('');
  }
  const modelWrapStyle = showModel ? '' : 'display:none';
  return `
    <div class="adapter-row-${role}" style="display:flex;flex-direction:column;gap:6px">
      ${providerHtml}
      <div id="${role}-model-wrap" class="model-wrap" style="${modelWrapStyle};margin-top:4px">
        <label class="form-label" style="font-size:11px;color:#8b949e">Model (cliapi)</label>
        <select id="adapter-${role}-model" class="form-select" style="font-size:12px">${modelOptions}</select>
      </div>
    </div>`;
}

// When provider changes: show/hide model dropdown and repopulate options. Fetches live models from gateway when provider has base_url.
// v3.3 P14: For coding-agent-cli and ccb channels, model wrap stays hidden.
async function refreshModelSelector(role) {
  const channel = document.getElementById('adapter-channel-type')?.value || 'coding-agent-cli';
  const provEl = document.getElementById(`adapter-${role}`);
  const wrapEl = document.getElementById(`${role}-model-wrap`);
  const modelEl = document.getElementById(`adapter-${role}-model`);
  if (!provEl || !wrapEl || !modelEl) return;
  if (channel === 'coding-agent-cli' || channel === 'ccb') {
    wrapEl.style.display = 'none';
    return;
  }
  const provider = provEl.value || '';
  const staticProvider = cachedCliapiProviders[provider];
  const hasBaseUrl = staticProvider && staticProvider.base_url;
  let models = (staticProvider && staticProvider.models) || [];
  if (hasBaseUrl && provider) {
    try {
      const result = await api(`/cliapi-providers/${encodeURIComponent(provider)}/models`);
      if (Array.isArray(result.models) && result.models.length > 0) {
        models = result.models;
      }
    } catch (_) {
      // keep static list on fetch error
    }
  }
  if (models.length === 0) {
    wrapEl.style.display = 'none';
    modelEl.innerHTML = '<option value="">— default —</option>';
    return;
  }
  wrapEl.style.display = 'block';
  const currentVal = modelEl.value;
  modelEl.innerHTML = models.map(m => {
    const sel = m.id === currentVal ? 'selected' : (!currentVal && models[0] ? (m === models[0] ? 'selected' : '') : '');
    return `<option value="${escapeHtml(m.id)}" ${sel}>${escapeHtml(m.alias || m.id)}</option>`;
  }).join('');
  if (!currentVal && models[0]) modelEl.value = models[0].id;
}

function onChannelTypeChange() {
  const channel = document.getElementById('adapter-channel-type')?.value || 'coding-agent-cli';
  const tagEl = document.getElementById('adapter-channel-tag');
  if (tagEl) {
    const t = CHANNEL_TYPES.find(c => c.value === channel);
    tagEl.textContent = t ? t.tag : '';
  }
  const coderSel = document.getElementById('coder-adapter-selector');
  const judgeSel = document.getElementById('judge-adapter-selector');
  const coderVal = document.getElementById('adapter-coder')?.value;
  const judgeVal = document.getElementById('adapter-judge')?.value;
  const coderModelVal = document.getElementById('adapter-coder-model')?.value;
  const judgeModelVal = document.getElementById('adapter-judge-model')?.value;
  if (coderSel) {
    coderSel.innerHTML = buildAdapterSelector('coder', coderVal, coderModelVal, channel);
  }
  if (judgeSel) {
    judgeSel.innerHTML = buildAdapterSelector('judge', judgeVal, judgeModelVal, channel);
  }
  refreshModelSelector('coder').catch(() => {});
  refreshModelSelector('judge').catch(() => {});
  if (typeof syncFormToJson === 'function') syncFormToJson();
}

function onRunSurfaceChange() {
  const wrap = document.getElementById('collab-config-wrap');
  if (wrap) wrap.style.display = (_currentExecutorType === 'multi_agent') ? 'block' : 'none';
}

async function validateRepoPath() {
  const input = document.getElementById('modal-repo-path');
  const status = document.getElementById('modal-repo-path-status');
  if (!input || !status) return;
  const raw = (input.value || '').trim();
  if (!raw) {
    status.textContent = '';
    status.style.color = '';
    return;
  }
  status.textContent = '…';
  status.style.color = '#8b949e';
  try {
    const r = await api('/validate-path?path=' + encodeURIComponent(raw));
    if (r.valid) {
      status.textContent = 'Valid';
      status.style.color = '#3fb950';
    } else {
      if (r.error === 'Path does not exist') {
        status.textContent = 'Will create on run';
        status.style.color = '#d29922';
      } else {
        status.textContent = r.error || 'Invalid';
        status.style.color = '#f85149';
      }
    }
  } catch (_) {
    status.textContent = 'Error';
    status.style.color = '#f85149';
  }
}

function setChoiceOptions(inputEl, values, preferredValue, datalistId) {
  if (!inputEl) return;
  const prev = (preferredValue !== undefined && preferredValue !== null)
    ? String(preferredValue)
    : String(inputEl.value || '');
  const opts = [];
  const seen = new Set();
  for (const v of values || []) {
    const s = (v || '').toString().trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    opts.push(s);
  }
  if (inputEl.tagName === 'SELECT') {
    if (prev && !seen.has(prev)) opts.unshift(prev);
    inputEl.innerHTML = opts.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (prev) inputEl.value = prev;
    return;
  }
  if (datalistId) {
    let dl = document.getElementById(datalistId);
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = datalistId;
      document.body.appendChild(dl);
    }
    dl.innerHTML = opts.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
    inputEl.setAttribute('list', datalistId);
  }
  if (prev) inputEl.value = prev;
}

async function refreshRepoOptions(preferredRepoPath) {
  const repoInput = document.getElementById('modal-repo-path');
  if (!repoInput) return;
  const hint = (preferredRepoPath ?? repoInput.value ?? '').trim();
  try {
    const data = await api('/folder-options?hint=' + encodeURIComponent(hint));
    const folders = Array.isArray(data.folders) ? data.folders : [];
    setChoiceOptions(repoInput, folders, hint, 'modal-repo-path-options');
  } catch {
    setChoiceOptions(repoInput, hint ? [hint] : [], hint, 'modal-repo-path-options');
  }
}

async function refreshBaseRefOptions(preferredRef) {
  const repoInput = document.getElementById('modal-repo-path');
  const refInput = document.getElementById('modal-base-ref');
  if (!repoInput || !refInput) return;
  const repoPath = (repoInput.value || '').trim();
  let refs = [];
  let head = '';
  if (repoPath) {
    try {
      const data = await api('/git-refs?repo_path=' + encodeURIComponent(repoPath));
      refs = Array.isArray(data.refs) ? data.refs : [];
      head = (data.head || '').trim();
    } catch {}
  }
  const fallback = preferredRef || refInput.value || head || 'main';
  const merged = [head, ...refs, fallback, 'main'].filter(Boolean);
  setChoiceOptions(refInput, merged, fallback, 'modal-base-ref-options');
}

async function onRepoSelectionChanged() {
  await validateRepoPath();
  applyDefaultKnowledgePath();
  await refreshKnowledgeShardSelector();
  await refreshBaseRefOptions();
  if (typeof syncFormToJson === 'function') syncFormToJson();
}

function normalizeKnowledgePath(repoPath) {
  const raw = (repoPath || '').trim();
  if (!raw) return '';
  return raw.endsWith('/') ? (raw + '.knowledge') : (raw + '/.knowledge');
}

function getSelectedKnowledgeShards() {
  return [...document.querySelectorAll('#modal-knowledge-shards-list input[type="checkbox"]:checked')]
    .map((el) => (el.value || '').trim())
    .filter(Boolean);
}

function setKnowledgeShardSelection(checked) {
  const listEl = document.getElementById('modal-knowledge-shards-list');
  if (!listEl) return;
  listEl.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.checked = !!checked;
  });
  if (typeof syncFormToJson === 'function') syncFormToJson();
}

function selectAllKnowledgeShards() {
  setKnowledgeShardSelection(true);
}

function clearKnowledgeShards() {
  setKnowledgeShardSelection(false);
}

async function refreshKnowledgeShardSelector(selectedNames) {
  const listEl = document.getElementById('modal-knowledge-shards-list');
  if (!listEl) return;
  const selected = Array.isArray(selectedNames) ? selectedNames : getSelectedKnowledgeShards();
  const kp = (document.getElementById('modal-knowledge-project')?.value || '').trim();
  if (!kp) {
    listEl.innerHTML = '<div style="font-size:11px;color:#8b949e">Set knowledge base path to load shards.</div>';
    return;
  }
  listEl.innerHTML = '<div style="font-size:11px;color:#8b949e">Loading shards...</div>';
  try {
    const data = await api('/knowledge/shard-names?path=' + encodeURIComponent(kp));
    const names = Array.isArray(data.names) ? data.names : [];
    if (!names.length) {
      listEl.innerHTML = '<div style="font-size:11px;color:#8b949e">No shard files found (*.json).</div>';
      return;
    }
    listEl.innerHTML = names.map((name) => {
      const checked = selected.includes(name) ? 'checked' : '';
      return `<label style="display:inline-flex;align-items:center;gap:6px;margin-right:12px;margin-bottom:6px;cursor:pointer;font-size:12px"><input type="checkbox" value="${escapeHtml(name)}" ${checked} onchange="syncFormToJson()">${escapeHtml(name)}</label>`;
    }).join('');
  } catch (_) {
    listEl.innerHTML = '<div style="font-size:11px;color:#f85149">Failed to load shards.</div>';
  }
}

function applyDefaultKnowledgePath() {
  const pathEl = document.getElementById('modal-knowledge-project');
  const repoEl = document.getElementById('modal-repo-path');
  if (!pathEl || !repoEl) return;
  if (pathEl.dataset.userEdited === 'true') return;
  pathEl.value = normalizeKnowledgePath(repoEl.value || '');
  refreshKnowledgeShardSelector().catch(() => {});
}

async function createSelectedFolder() {
  const repoInput = document.getElementById('modal-repo-path');
  if (!repoInput) return;
  const raw = (repoInput.value || '').trim();
  if (!raw) {
    alert('repo_path is empty');
    return;
  }
  try {
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: raw })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      alert(data.error || 'Failed to create folder');
      return;
    }
    repoInput.value = data.path || raw;
    await refreshRepoOptions(repoInput.value);
    await onRepoSelectionChanged();
  } catch (e) {
    alert(e?.message || 'Failed to create folder');
  }
}

function closeFolderPickerModal() {
  const el = document.getElementById('folder-picker-modal');
  if (el) el.remove();
}

let _folderPickerState = { requested: '', current: '', parent: null, children: [] };

function folderPickerEscapeForOnclick(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function renderFolderPickerList() {
  const listEl = document.getElementById('folder-picker-list');
  const pathEl = document.getElementById('folder-picker-path');
  const curEl = document.getElementById('folder-picker-current');
  const msgEl = document.getElementById('folder-picker-msg');
  if (!listEl || !pathEl) return;
  pathEl.value = _folderPickerState.requested || _folderPickerState.current || '';
  if (curEl) curEl.textContent = _folderPickerState.current || '';
  if (msgEl) msgEl.textContent = '';

  const rows = [];
  if (_folderPickerState.parent) {
    rows.push(
      `<button type="button" class="btn" style="text-align:left" onclick="folderPickerNavigateTo('${folderPickerEscapeForOnclick(_folderPickerState.parent)}')">.. (Up)</button>`
    );
  }
  for (const child of (_folderPickerState.children || [])) {
    rows.push(
      `<button type="button" class="btn" style="text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" onclick="folderPickerNavigateTo('${folderPickerEscapeForOnclick(child)}')">${escapeHtml(child)}</button>`
    );
  }
  listEl.innerHTML = rows.length ? rows.join('') : '<div style="color:#8b949e;font-size:12px">No subfolders</div>';
}

async function folderPickerLoad(pathValue) {
  const msgEl = document.getElementById('folder-picker-msg');
  try {
    const requestedRaw = (pathValue || '').trim();
    const data = await api('/folder-children?path=' + encodeURIComponent(pathValue || ''));
    _folderPickerState = {
      requested: data.requested || requestedRaw || '',
      current: data.current || '',
      parent: data.parent || null,
      children: Array.isArray(data.children) ? data.children : []
    };
    renderFolderPickerList();
    if (msgEl && _folderPickerState.requested && _folderPickerState.current && _folderPickerState.requested !== _folderPickerState.current) {
      msgEl.textContent = `Path not found; opened nearest existing: ${_folderPickerState.current}`;
      msgEl.style.color = '#d29922';
    }
  } catch (e) {
    if (msgEl) {
      msgEl.textContent = e?.message || 'Failed to load folders';
      msgEl.style.color = '#f85149';
    }
  }
}

async function folderPickerNavigateTo(pathValue) {
  await folderPickerLoad(pathValue || '');
}

async function folderPickerOpenFromInput() {
  const pathEl = document.getElementById('folder-picker-path');
  if (!pathEl) return;
  await folderPickerLoad(pathEl.value || '');
}

let _folderPickerTypeTimer = null;
function folderPickerOnPathInput() {
  const pathEl = document.getElementById('folder-picker-path');
  if (!pathEl) return;
  const val = pathEl.value || '';
  if (_folderPickerTypeTimer) clearTimeout(_folderPickerTypeTimer);
  _folderPickerTypeTimer = setTimeout(() => {
    _folderPickerTypeTimer = null;
    folderPickerLoad(val).catch(() => {});
  }, 120);
}

async function folderPickerUseCurrent() {
  const repoInput = document.getElementById('modal-repo-path');
  if (!repoInput) return;
  const val = (_folderPickerState.current || _folderPickerState.requested || '').trim();
  if (!val) return;
  repoInput.value = val;
  closeFolderPickerModal();
  await refreshRepoOptions(val);
  await onRepoSelectionChanged();
}

async function folderPickerCreateCurrent() {
  const msg = document.getElementById('folder-picker-msg');
  const pathEl = document.getElementById('folder-picker-path');
  const raw = (pathEl?.value || '').trim();
  if (!raw) {
    if (msg) msg.textContent = 'Path is empty';
    return;
  }
  if (msg) msg.textContent = '';
  try {
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: raw })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      if (msg) msg.textContent = data.error || 'Failed to create folder';
      return;
    }
    await folderPickerLoad(data.path || raw);
    await folderPickerUseCurrent();
  } catch (e) {
    if (msg) msg.textContent = e?.message || 'Failed to create folder';
  }
}

async function openFolderPickerModal() {
  const old = document.getElementById('folder-picker-modal');
  if (old) old.remove();
  const repoInput = document.getElementById('modal-repo-path');
  const current = (repoInput?.value || '').trim();
  const modalHtml = `
    <div id="folder-picker-modal" class="modal-overlay" onclick="if(event.target===this)closeFolderPickerModal()">
      <div class="modal-box" style="max-width:760px;max-height:85vh;overflow-y:auto">
        <h3 style="margin-top:0">Folder Browser</h3>
        <div style="margin-bottom:8px">
          <label class="form-label" style="font-size:11px">Path</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="folder-picker-path" class="form-input" value="${escapeHtml(current)}" placeholder="/path/to/folder" style="flex:1" oninput="folderPickerOnPathInput()">
            <button type="button" id="folder-picker-open-btn" class="btn">Open</button>
            <button type="button" class="btn write-action" onclick="folderPickerCreateCurrent()">Create</button>
            <button type="button" class="btn btn-primary write-action" onclick="folderPickerUseCurrent()">Use</button>
          </div>
          <div style="font-size:11px;color:#8b949e;margin-top:6px">Opened folder: <code id="folder-picker-current"></code></div>
          <div id="folder-picker-msg" style="font-size:12px;color:#f85149;margin-top:6px"></div>
        </div>
        <div style="margin-top:10px">
          <label class="form-label" style="font-size:11px">Subfolders (click to enter)</label>
          <div id="folder-picker-list" style="display:grid;grid-template-columns:1fr;gap:6px;max-height:50vh;overflow:auto;margin-top:6px">
            <div style="color:#8b949e;font-size:12px">Loading…</div>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px">
          <button type="button" class="btn" onclick="closeFolderPickerModal()">Close</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();
  const pathInput = document.getElementById('folder-picker-path');
  const openBtn = document.getElementById('folder-picker-open-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      folderPickerOpenFromInput().catch(() => {});
    });
  }
  if (pathInput) {
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        folderPickerOpenFromInput().catch(() => {});
      }
    });
  }
  await folderPickerLoad(current || '');
}

async function initRepoGitSelectors(repoPath, baseRef) {
  await refreshRepoOptions(repoPath || '');
  await refreshBaseRefOptions(baseRef || 'main');
  await validateRepoPath();
  applyDefaultKnowledgePath();
}

let _formToJsonTimer = null;
function syncFormToJson() {
  if (_formToJsonTimer) clearTimeout(_formToJsonTimer);
  _formToJsonTimer = setTimeout(() => {
    _formToJsonTimer = null;
    const jsonEl = document.getElementById('modal-spec-json');
    if (!jsonEl) return;
    const taskId = (document.getElementById('modal-task-id')?.value || '').trim();
    const taskType = document.getElementById('modal-task-type')?.value || '';
    const instruction = (document.getElementById('modal-instruction')?.value || '').trim();
    const acceptance = (document.getElementById('modal-acceptance')?.value || '').trim().split(/\n/).map(s => s.trim()).filter(Boolean);
    const testCmd = (document.getElementById('modal-test-cmd')?.value || 'true').trim();
    const maxAttempts = parseInt(document.getElementById('modal-max-attempts')?.value || '3', 10);
    const coderTimeout = parseInt(document.getElementById('modal-coder-timeout')?.value || '600', 10);
    const judgeTimeout = parseInt(document.getElementById('modal-judge-timeout')?.value || '300', 10);
    const constraintsRaw = (document.getElementById('modal-constraints')?.value || '').trim();
    const constraints = constraintsRaw ? constraintsRaw.split(/\n/).map(s => s.trim()).filter(Boolean) : [];
    const repoPath = (document.getElementById('modal-repo-path')?.value || '').trim();
    const baseRef = (document.getElementById('modal-base-ref')?.value || 'main').trim();

    const spec = {
      task_id: taskId || 'my_task',
      task_type: taskType || 'solo',
      repo_path: repoPath || undefined,
      base_ref: baseRef || 'main',
      goal: instruction || '',
      acceptance,
      test_cmd: testCmd || 'true',
      max_attempts: Number.isFinite(maxAttempts) ? maxAttempts : 3,
      coder_timeout_seconds: Number.isFinite(coderTimeout) ? coderTimeout : 600,
      judge_timeout_seconds: Number.isFinite(judgeTimeout) ? judgeTimeout : 300,
      attempt_context_mode: document.getElementById('modal-attempt-context-mode')?.value || 'fresh_each',
      constraints
    };

    const soloProvider = (document.getElementById('modal-solo-provider')?.value || '').trim();
    const autoPass = parseFloat(document.getElementById('modal-auto-pass-threshold')?.value || '0.85');
    const inspTrigger = parseInt(document.getElementById('modal-inspiration-trigger')?.value || '3', 10);

    spec.agent_config = {
      max_attempts: parseInt(document.getElementById('modal-max-iterations')?.value || '5', 10),
      auto_pass_threshold: Number.isFinite(autoPass) ? autoPass : 0.85,
      inspiration_trigger_attempts: Number.isFinite(inspTrigger) ? inspTrigger : 3,
      provider: soloProvider || 'claude',
      knowledge_shards: getSelectedKnowledgeShards()
    };

    const roles = buildCollabRolesForTaskType(taskType, spec);
    if (roles) spec.collab_roles = roles;

    const knowledgeEnabled = document.getElementById('modal-knowledge-enabled')?.checked === true;
    if (knowledgeEnabled) {
      spec.knowledge_enabled = true;
      const kp = (document.getElementById('modal-knowledge-project')?.value || '').trim();
      spec.knowledge_project_path = kp || normalizeKnowledgePath(repoPath);
      spec.knowledge_provider = (document.getElementById('modal-knowledge-provider')?.value || 'codex').trim() || 'codex';
    }
    jsonEl.value = JSON.stringify(spec, null, 2);
  }, 400);
}

function syncJsonToForm() {
  const jsonEl = document.getElementById('modal-spec-json');
  if (!jsonEl) return;
  const raw = (jsonEl.value || '').trim();
  if (!raw) return;
  try {
    const spec = JSON.parse(raw);
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value != null ? value : ''; };
    set('modal-task-id', spec.task_id);
    if (spec.task_type) {
      const el = document.getElementById('modal-task-type');
      if (el) el.value = spec.task_type;
      onTaskTypeChange();
    }

    set('modal-instruction', spec.goal || spec.instruction);
    set('modal-solo-provider', spec.agent_config?.provider || spec.coder_model || '');
    set('modal-max-iterations', spec.agent_config?.max_attempts || spec.max_attempts || 5);
    set('modal-auto-pass-threshold', spec.agent_config?.auto_pass_threshold || 0.85);
    set('modal-inspiration-trigger', spec.agent_config?.inspiration_trigger_attempts || 3);

    // Sync collab roles back to UI selectors
    if (spec.collab_roles) {
      Object.entries(spec.collab_roles).forEach(([role, model]) => {
        const el = getCollabRoleSelect(role);
        if (el) el.value = model;
      });
    }

    if (document.getElementById('modal-knowledge-enabled')) document.getElementById('modal-knowledge-enabled').checked = spec.knowledge_enabled !== false;
    set('modal-knowledge-provider', spec.knowledge_provider || spec.agent_config?.provider || 'codex');
    set('modal-knowledge-project', spec.knowledge_project_path || normalizeKnowledgePath(spec.repo_path || ''));
    const knPathEl = document.getElementById('modal-knowledge-project');
    if (knPathEl) knPathEl.dataset.userEdited = spec.knowledge_project_path ? 'true' : 'false';
    refreshKnowledgeShardSelector(Array.isArray(spec.agent_config?.knowledge_shards) ? spec.agent_config.knowledge_shards : []).catch(() => {});
    document.getElementById('modal-acceptance') && (document.getElementById('modal-acceptance').value = Array.isArray(spec.acceptance) ? spec.acceptance.join('\n') : (spec.acceptance || ''));
    set('modal-test-cmd', spec.test_cmd);
    set('modal-max-attempts', spec.max_attempts !== undefined ? spec.max_attempts : 3);
    set('modal-coder-timeout', spec.coder_timeout_seconds !== undefined ? spec.coder_timeout_seconds : 600);
    set('modal-judge-timeout', spec.judge_timeout_seconds !== undefined ? spec.judge_timeout_seconds : 300);
    document.getElementById('modal-constraints') && (document.getElementById('modal-constraints').value = Array.isArray(spec.constraints) ? spec.constraints.join('\n') : '');
    set('modal-repo-path', spec.repo_path);
    set('modal-base-ref', spec.base_ref || 'main');
    
    // Legacy/Sync-only helpers
    if (spec.collab_roles) applyCollabRolesToForm(spec.collab_roles);
    initRepoGitSelectors(spec.repo_path || '', spec.base_ref || 'main').catch(() => {});
  } catch (_) { /* invalid JSON, ignore */ }
}

// A4: Build rubric thresholds UI
function buildThresholdsUI(taskType, existingThresholds) {
  const rubric = cachedRubric[taskType];
  if (!rubric || !rubric.dimensions) return '';

  const dims = rubric.dimensions;
  const thresh = existingThresholds || {};

  const rows = dims.map(dim => {
    const val = thresh[dim] !== undefined ? thresh[dim] : '';
    const isGate = rubric.hard_gates && rubric.hard_gates.includes(dim);
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <label style="width:200px;font-size:12px">${escapeHtml(dim)}${isGate ? ' <span style="color:#f85149">★</span>' : ''}</label>
        <input type="number" class="form-input" style="width:70px"
          id="thresh-${escapeHtml(dim)}"
          min="0" max="5" step="0.5"
          value="${escapeHtml(String(val))}"
          placeholder="min">
      </div>
    `;
  }).join('');

  const minScore = thresh.min_score !== undefined ? thresh.min_score : '';
  return `
    <div style="margin-top:8px">
      <div style="font-size:12px;color:#8b949e;margin-bottom:6px">
        ★ = hard gate dimension (score below threshold → GATED)
      </div>
      ${rows}
      <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
        <label style="width:200px;font-size:12px"><strong>Total min_score</strong></label>
        <input type="number" class="form-input" style="width:70px"
          id="thresh-min_score" min="0" max="100" step="1"
          value="${escapeHtml(String(minScore))}" placeholder="0-100">
      </div>
    </div>
  `;
}

// Read thresholds from UI inputs
function readThresholdsFromUI(taskType) {
  const rubric = cachedRubric[taskType];
  if (!rubric || !rubric.dimensions) return undefined;
  const result = {};
  let hasAny = false;
  for (const dim of rubric.dimensions) {
    const el = document.getElementById(`thresh-${dim}`);
    if (el && el.value !== '') {
      result[dim] = parseFloat(el.value);
      hasAny = true;
    }
  }
  const minEl = document.getElementById('thresh-min_score');
  if (minEl && minEl.value !== '') {
    result.min_score = parseFloat(minEl.value);
    hasAny = true;
  }
  return hasAny ? result : undefined;
}

// ================================================================
// A2: Modal helpers
// ================================================================

function closeModal() {
  const modal = document.getElementById('spec-modal');
  if (modal) modal.remove();
}

// A4: When task_type changes in modal, update rubric thresholds UI
async function onTaskTypeChange() {
  const sel = document.getElementById('modal-task-type');
  if (!sel) return;
  const taskType = sel.value;
  
  // Sync executor_type for UI logic
  if (taskType === 'solo') setExecutorType('solo_agent');
  else if (taskType === 'multi_agent') setExecutorType('multi_agent');
  else if (taskType === 'copywriting') setExecutorType('api_call');

  const journeyContainer = document.getElementById('modal-journey-prompts-container');
  if (journeyContainer) {
    const taskId = document.getElementById('modal-task-id')?.value || '';
    journeyContainer.innerHTML = buildTaskJourneyPromptsUI(taskType, taskId);
  }

  const container = document.getElementById('rubric-thresholds-container');
  if (!container) return;

  if (!taskType) {
    container.innerHTML = '';
    return;
  }
  if (_currentExecutorType !== 'api_call') {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = '<div style="color:#8b949e;font-size:12px">Loading rubric...</div>';
  await loadRubric(taskType);
  container.innerHTML = buildThresholdsUI(taskType, null);
}

// ── v5.0: Executor Type × Session Mode (replaces Three-Mode workflow toggle) ──
let _currentExecutorType = 'api_call';
let _currentSessionMode = 'fresh';

// Legacy compat: keep workflow_mode variable for any remaining references
let _currentWorkflowMode = 'single';

function setExecutorType(type) {
  _currentExecutorType = type;
  const el = document.getElementById('modal-executor-type');
  if (el && el.value !== type) el.value = type;
  updateSessionModeConstraints();
  // Map to legacy workflow_mode for backward compat
  if (type === 'api_call') _currentWorkflowMode = 'single';
  else if (type === 'solo_agent') _currentWorkflowMode = 'solo';
  else if (type === 'multi_agent') _currentWorkflowMode = 'collab';
  // Show/hide sections based on executor type
  const showIf = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  };
  showIf('section-role-models', true); // Always show, contains 'Make it Template'
  showIf('solo-provider-wrap', type === 'solo_agent');
  showIf('collab-roles-table', type !== 'solo_agent');
  showIf('collab-config-wrap', false); // legacy wrap
  showIf('section-repo-git', true);
  showIf('section-loop-config', type === 'solo_agent');
  showIf('section-knowledge', true);
  showIf('section-observation', type === 'solo_agent');
  showIf('section-acceptance', true); // Show for all, contains goal/instruction
  showIf('rubric-thresholds-container', type === 'api_call');
  showIf('section-channel-type', false);
  onRunSurfaceChange();
  
  // Update role row visibility (F1 redesign)
  document.querySelectorAll('.role-row').forEach(row => {
    const role = row.dataset.role;
    if (type === 'solo_agent') {
      row.style.display = (role === 'executor' || role === 'inspiration') ? '' : 'none';
    } else if (type === 'api_call') {
      row.style.display = (role === 'executor' || role === 'reviewer') ? '' : 'none';
    } else {
      row.style.display = '';
    }
  });
}

function updateSessionModeConstraints() {
  const smEl = document.getElementById('modal-session-mode');
  if (!smEl) return;
  const type = _currentExecutorType;
  const options = smEl.options;
  for (let i = 0; i < options.length; i++) {
    const val = options[i].value;
    if (type === 'api_call') {
      options[i].disabled = (val === 'continuous');
    } else {
      // solo_agent / multi_agent: only continuous
      options[i].disabled = (val === 'fresh' || val === 'iterative');
    }
  }
  // Auto-select valid option if current is disabled
  if (smEl.options[smEl.selectedIndex]?.disabled) {
    if (type === 'api_call') smEl.value = 'fresh';
    else smEl.value = 'continuous';
  }
  _currentSessionMode = smEl.value;
}

function setWorkflowMode(mode) {
  // Legacy compat shim — map to v5 executor_type
  if (mode === 'single') setExecutorType('api_call');
  else if (mode === 'solo') setExecutorType('solo_agent');
  else if (mode === 'collab') setExecutorType('multi_agent');
}

function workflowModeToExecutorType(mode) {
  if (mode === 'solo') return 'solo_agent';
  if (mode === 'collab') return 'multi_agent';
  return 'api_call';
}

function taskTypeToExecutorType(taskType) {
  const t = normalizeTaskTypeAlias(taskType);
  if (t === 'solo') return 'solo_agent';
  if (t === 'multi_agent') return 'multi_agent';
  if (t === 'copywriting') return 'api_call';
  return 'solo_agent';
}

function defaultSessionModeForExecutor(executorType) {
  return executorType === 'api_call' ? 'fresh' : 'continuous';
}

const COLLAB_ROLE_KEYS = ['pm', 'executor', 'reviewer', 'designer', 'inspiration'];
const DEFAULT_COLLAB_ROLE_PROVIDERS = {
  pm: 'claude',
  executor: 'codex',
  reviewer: 'gemini',
  designer: 'codex',
  inspiration: 'codex'
};
const COLLAB_ROLE_LABELS = {
  pm: 'PM',
  executor: 'executor',
  reviewer: 'reviewer',
  designer: 'designer',
  inspiration: 'inspiration'
};

function normalizeCollabRoleKey(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (key === 'pm' || key === 'project_manager' || key === 'project manager') return 'pm';
  return COLLAB_ROLE_KEYS.includes(key) ? key : '';
}

function normalizeCollabRolesMap(collabRoles) {
  const out = {};
  if (!collabRoles || typeof collabRoles !== 'object' || Array.isArray(collabRoles)) return out;
  Object.entries(collabRoles).forEach(([role, provider]) => {
    const key = normalizeCollabRoleKey(role);
    const p = normalizeRoleProvider(provider);
    if (key && ALLOWED_ROLE_PROVIDERS.includes(p)) out[key] = p;
  });
  return out;
}

function collabRoleDefaultsFromApi(roleRows) {
  const out = {};
  if (!Array.isArray(roleRows)) return out;
  roleRows.forEach(row => {
    const key = normalizeCollabRoleKey(row?.role);
    const provider = normalizeRoleProvider(row?.provider);
    if (key && ALLOWED_ROLE_PROVIDERS.includes(provider)) out[key] = provider;
  });
  return out;
}

function isVisibleCollabRoleSelect(el) {
  if (!el) return false;
  if (el.disabled) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function getCollabRoleSelect(role) {
  const key = String(role || '').trim();
  if (!key) return null;
  const all = Array.from(document.querySelectorAll(`select[id="collab-role-${key}"]`));
  if (!all.length) return null;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (isVisibleCollabRoleSelect(all[i])) return all[i];
  }
  return all[all.length - 1];
}

function collectCollabRolesFromForm() {
  const out = {};
  for (const role of COLLAB_ROLE_KEYS) {
    const el = getCollabRoleSelect(role);
    if (el && el.value) out[role] = el.value;
  }
  return Object.keys(out).length ? out : null;
}

function applyCollabRolesToForm(collabRoles) {
  const normalized = normalizeCollabRolesMap(collabRoles);
  COLLAB_ROLE_KEYS.forEach(role => {
    const el = getCollabRoleSelect(role);
    if (el && normalized[role]) el.value = normalized[role];
  });
}

function renderValidationErrors(errEl, errors) {
  if (!errEl) {
    errEl = document.getElementById('modal-form-error') || document.getElementById('modal-json-error');
  }
  if (!errEl) return;
  const list = (errors || []).filter(Boolean);
  if (list.length === 0) {
    errEl.textContent = '';
    return;
  }
  errEl.innerHTML = `Please fix the following:<br>${list.map(e => `• ${escapeHtml(e)}`).join('<br>')}`;
  try {
    errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch {}
}

function buildCollabRolesForTaskType(taskType, fallbackSpec) {
  const t = normalizeTaskTypeAlias(taskType);
  const fromSpec = normalizeCollabRolesMap((fallbackSpec && fallbackSpec.collab_roles) || {});
  if (t === 'copywriting') {
    const execRoleUi = normalizeProviderFromAny(getCollabRoleSelect('executor')?.value || '');
    const revRoleUi = normalizeProviderFromAny(getCollabRoleSelect('reviewer')?.value || '');
    const inspRoleUi = normalizeProviderFromAny(getCollabRoleSelect('inspiration')?.value || '');
    const execUi = normalizeProviderFromAny(document.getElementById('adapter-coder')?.value || execRoleUi || fromSpec.executor || '');
    const revUi = normalizeProviderFromAny(document.getElementById('adapter-judge')?.value || revRoleUi || fromSpec.reviewer || '');
    const inspUi = normalizeProviderFromAny(inspRoleUi || fromSpec.inspiration || '');
    return {
      executor: execUi || 'codex',
      reviewer: revUi || 'gemini',
      inspiration: inspUi || execUi || 'codex'
    };
  }
  if (t === 'solo') {
    const soloUi = normalizeProviderFromAny(document.getElementById('modal-solo-provider')?.value || '');
    const execRoleUi = normalizeProviderFromAny(getCollabRoleSelect('executor')?.value || '');
    const p = normalizeProviderFromAny(soloUi || execRoleUi || fromSpec.pm || fromSpec.executor || 'codex') || 'codex';
    return { pm: p, designer: p, executor: p, reviewer: p, inspiration: p };
  }
  if (t === 'multi_agent') {
    const ui = collectCollabRolesFromForm() || {};
    const merged = { ...fromSpec, ...ui };
    return {
      pm: normalizeProviderFromAny(merged.pm || ''),
      designer: normalizeProviderFromAny(merged.designer || ''),
      executor: normalizeProviderFromAny(merged.executor || ''),
      reviewer: normalizeProviderFromAny(merged.reviewer || ''),
      inspiration: normalizeProviderFromAny(merged.inspiration || '')
    };
  }
  return fromSpec;
}

function normalizeToV51SavePayload(rawSpec, taskId) {
  const { spec: normalized } = normalizeSpecToV51(rawSpec || {});
  const out = stripLegacyFields({ ...normalized });
  out.task_id = taskId;

  const uiTaskType = normalizeTaskTypeAlias(document.getElementById('modal-task-type')?.value || out.task_type);
  if (uiTaskType) out.task_type = uiTaskType;
  
  const uiLaunchMode = document.getElementById('modal-launch-mode')?.value || out.launch_mode;
  if (uiLaunchMode) out.launch_mode = uiLaunchMode;
  
  const uiLaunchModeLocked = document.getElementById('modal-launch-mode-locked');
  if (uiLaunchModeLocked) {
    out.launch_mode_locked = uiLaunchModeLocked.checked;
  } else if (out.launch_mode_locked === undefined) {
    out.launch_mode_locked = false;
  }

  // Keep provider terminology consistent in v5.1 payload.
  if (out.coder !== undefined) delete out.coder;
  if (out.judge !== undefined) delete out.judge;
  if (out.coder_model !== undefined) delete out.coder_model;
  if (out.judge_model !== undefined) delete out.judge_model;
  if (out.channel_type !== undefined) delete out.channel_type;

  // Normalize common fields from the visible form inputs.
  const rp = (document.getElementById('modal-repo-path')?.value || out.repo_path || '').trim();
  if (rp) out.repo_path = rp;
  const br = (document.getElementById('modal-base-ref')?.value || out.base_ref || 'main').trim();
  if (br) out.base_ref = br;
  const goal = (document.getElementById('modal-instruction')?.value || out.goal || '').trim();
  const soloGoal = (document.getElementById('modal-solo-executor-instruction')?.value || out.executor_instruction || '').trim();
  out.goal = goal || soloGoal || '';
  if (soloGoal) out.executor_instruction = soloGoal;

  const testCmd = (document.getElementById('modal-test-cmd')?.value || out.test_cmd || 'true').trim();
  out.test_cmd = testCmd || 'true';
  const ma = parseInt(document.getElementById('modal-max-attempts')?.value || out.max_attempts || '3', 10);
  out.max_attempts = Number.isFinite(ma) ? Math.min(50, Math.max(1, ma)) : 3;

  const acceptanceVal = (document.getElementById('modal-acceptance')?.value || '').trim();
  if (acceptanceVal) out.acceptance = acceptanceVal.split(/\n/).map(s => s.trim()).filter(Boolean);

  const coderTimeoutVal = parseInt(document.getElementById('modal-coder-timeout')?.value || out.coder_timeout_seconds || '600', 10);
  const judgeTimeoutVal = parseInt(document.getElementById('modal-judge-timeout')?.value || out.judge_timeout_seconds || '300', 10);
  if (Number.isFinite(coderTimeoutVal)) out.coder_timeout_seconds = Math.min(3600, Math.max(60, coderTimeoutVal));
  if (Number.isFinite(judgeTimeoutVal)) out.judge_timeout_seconds = Math.min(3600, Math.max(60, judgeTimeoutVal));

  const roles = buildCollabRolesForTaskType(out.task_type, out);
  if (roles && Object.keys(roles).length > 0) out.collab_roles = roles;

  const soloProvider = normalizeProviderFromAny(document.getElementById('modal-solo-provider')?.value || out.agent_config?.provider || '');
  const uiMaxAttempts = parseInt(document.getElementById('modal-max-iterations')?.value || '', 10);
  const uiAutoPass = parseFloat(document.getElementById('modal-auto-pass-threshold')?.value || '');
  const uiInspTrigger = parseInt(document.getElementById('modal-inspiration-trigger')?.value || '', 10);

  out.agent_config = {
    ...(out.agent_config || {}),
    provider: soloProvider || normalizeProviderFromAny(out.collab_roles?.executor || '') || 'codex',
    max_attempts: Number.isFinite(uiMaxAttempts) ? uiMaxAttempts : (out.agent_config?.max_attempts || out.max_attempts || 5),
    auto_pass_threshold: Number.isFinite(uiAutoPass) ? uiAutoPass : (out.agent_config?.auto_pass_threshold || 0.85),
    inspiration_trigger_attempts: Number.isFinite(uiInspTrigger) ? uiInspTrigger : (out.agent_config?.inspiration_trigger_attempts || 3),
    knowledge_shards: Array.isArray(out.agent_config?.knowledge_shards) ? out.agent_config.knowledge_shards : getSelectedKnowledgeShards()
  };
  return out;
}

function validateV51SpecForSave(spec) {
  const errors = [];
  const s = spec || {};
  const { task_types, launch_modes } = getV51Schema();
  if (!s.task_id || !/^[A-Za-z0-9_-]+$/.test(String(s.task_id))) errors.push('Task ID is required and must use letters/numbers/_/-.');
  if (!s.task_type || !task_types.includes(s.task_type)) errors.push(`Task Type is required (${task_types.join(', ')}).`);
  if (!s.launch_mode || !launch_modes.includes(s.launch_mode)) errors.push(`Launch Mode is required (${launch_modes.join(', ')}).`);
  if (typeof s.launch_mode_locked !== 'boolean') errors.push('Launch Mode Locked must be true/false.');
  if (!String(s.goal || '').trim()) errors.push('Instruction / Goal is required.');
  if (!String(s.test_cmd || '').trim()) errors.push('test_cmd is required.');
  if (!Number.isInteger(Number(s.max_attempts)) || Number(s.max_attempts) < 1 || Number(s.max_attempts) > 50) errors.push('max_attempts must be an integer between 1 and 50.');

  const roles = s.collab_roles || {};
  if (s.task_type === 'copywriting') {
    if (!roles.executor || !roles.reviewer) errors.push('Copywriting requires Executor and Reviewer providers.');
  }
  if (s.task_type === 'solo') {
    const required = ['pm', 'designer', 'executor', 'reviewer', 'inspiration'];
    const vals = required.map(k => normalizeProviderFromAny(roles[k] || '')).filter(Boolean);
    if (vals.length !== required.length) errors.push('Solo requires PM/Designer/Executor/Reviewer/Inspiration providers.');
    if (new Set(vals).size > 1) errors.push('Solo requires one same provider for all roles.');
  }
  if (s.task_type === 'multi_agent') {
    const required = ['pm', 'designer', 'executor', 'reviewer', 'inspiration'];
    required.forEach((k) => {
      if (!normalizeProviderFromAny(roles[k] || '')) errors.push(`Multi-agent requires collab_roles.${k}.`);
    });
  }
  return errors;
}

// A2-1: Open "New Task" modal (A6: apply saved default adapters when no template selected)
async function openNewSpecModal() {
  await loadAdapters();
  let defaultCoder = null;
  let defaultJudge = null;
  let defaultCoderModel = null;
  let defaultJudgeModel = null;
  let collabRoleDefaults = {};
  try {
    const cfg = await api('/config');
    defaultCoder = cfg.default_coder || null;
    defaultJudge = cfg.default_judge || null;
    defaultCoderModel = cfg.default_coder_model || null;
    defaultJudgeModel = cfg.default_judge_model || null;
  } catch {}
  try {
    const roles = await api('/agent/roles');
    collabRoleDefaults = roles.defaults || {};
  } catch {}

  const defaultChannel = inferChannelFromAdapter(defaultCoder);
  const COLLAB_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode', 'droid'];
  const COLLAB_ROLES = COLLAB_ROLE_KEYS.map(key => ({
    key,
    label: COLLAB_ROLE_LABELS[key],
    provider: collabRoleDefaults[key] || DEFAULT_COLLAB_ROLE_PROVIDERS[key]
  }));

  window._specTemplates = TEMPLATES;

  const modalHtml = `
    <div id="spec-modal" class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:800px;max-height:90vh;overflow-y:auto">
        <h3 style="margin-top:0">New Task Spec (v5.1.4)</h3>

        <div id="legacy-warning" class="questions-banner" style="display:none; margin-bottom:12px; border-color: var(--accent-red); background: rgba(218,54,51,0.1)">
          <strong>Legacy Task Detected</strong>
          <p style="font-size:12px; margin-top:4px">This task uses deprecated fields. Saving will normalize it to v5.1.4.</p>
          <div id="migration-preview" style="font-size:11px; margin-top:8px; opacity:0.8; font-family:monospace"></div>
        </div>

        <!-- Primary Fields -->
        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:12px; margin-bottom:12px">
          <div>
            <label class="form-label">Task Type</label>
            <select id="modal-task-type" class="form-select" onchange="syncFormToJson(); onTaskTypeChange()">
              <option value="copywriting">copywriting (single flow)</option>
              <option value="solo" selected>solo (autonomous agent)</option>
              <option value="multi_agent">multi_agent (collaborative)</option>
            </select>
          </div>
          <div>
            <label class="form-label">Template (optional)</label>
            <select id="modal-template" class="form-select" onchange="applyTemplate()">
              <option value="">— none —</option>
              ${Object.keys(window._specTemplates || {}).map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="form-label">Task ID</label>
            <input type="text" id="modal-task-id" class="form-input" placeholder="my_new_task"
              pattern="[A-Za-z0-9_-]+" title="Alphanumeric, underscore, hyphen only" oninput="syncFormToJson()">
          </div>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">instruction / goal <span style="color:#f85149">*</span></label>
          <textarea id="modal-instruction" class="form-input" rows="4" placeholder="Describe what to achieve" style="width:100%;resize:vertical" oninput="syncFormToJson()"></textarea>
        </div>

        <!-- Model Selection (Unified) -->
        <div id="section-role-models" style="margin-bottom:16px;padding:12px;background:#161b22;border:1px solid #30363d;border-radius:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong class="form-label" style="margin:0">Model Selection</strong>
            <button type="button" class="btn write-action" style="font-size:11px;padding:2px 8px" onclick="makeCurrentAsTemplate()">Make it Template</button>
          </div>
          
          <div id="solo-provider-wrap" style="margin-bottom:8px">
            <label class="form-label" style="font-size:11px">Provider</label>
            <select id="modal-solo-provider" class="form-select" onchange="syncFormToJson()">
              ${COLLAB_PROVIDERS.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(providerDisplayName(p))}</option>`).join('')}
            </select>
          </div>

          <div id="collab-roles-table" style="font-size:12px;display:none">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr><th style="text-align:left;padding-bottom:4px">Role</th><th style="text-align:left;padding-bottom:4px">Model / Provider</th></tr></thead>
              <tbody>
                ${COLLAB_ROLES.map(r => {
                  const opts = COLLAB_PROVIDERS.map(p => `<option value="${escapeHtml(p)}" ${p === r.provider ? 'selected' : ''}>${escapeHtml(providerDisplayName(p))}</option>`).join('');
                  return `<tr class="role-row" data-role="${escapeHtml(r.key)}"><td style="padding:4px 0">${escapeHtml(r.label)}</td><td style="padding:4px 0"><select id="collab-role-${escapeHtml(r.key)}" class="form-select" style="width:100%" onchange="syncFormToJson()">${opts}</select></td></tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Advanced Settings (Collapsed) -->
        <details style="margin-bottom:12px; border:1px solid #30363d; border-radius:8px; background: rgba(0,0,0,0.1)">
          <summary style="padding:10px; cursor:pointer; font-size:12px; color:var(--text-muted); font-weight:600">Advanced Settings (Repo, Context, Loop Config)</summary>
          <div style="padding:12px; border-top:1px solid #30363d">
            
            <div id="section-repo-git" style="margin-bottom:16px">
              <label class="form-label" style="font-size:11px">repo_path</label>
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                <input type="text" id="modal-repo-path" class="form-input" placeholder="/path/to/repo" style="flex:1;margin:0" onchange="onRepoSelectionChanged()" oninput="syncFormToJson()">
                <button type="button" class="btn write-action" style="padding:4px 8px;font-size:11px" onclick="openFolderPickerModal()">Choose</button>
              </div>
              <div style="display:flex; gap:12px">
                <div style="flex:1">
                  <label class="form-label" style="font-size:10px">base_ref</label>
                  <input type="text" id="modal-base-ref" class="form-input" placeholder="main" style="font-size:11px" oninput="syncFormToJson()">
                </div>
                <div style="flex:1">
                  <label class="form-label" style="font-size:10px">context_mode</label>
                  <select id="modal-attempt-context-mode" class="form-select" style="font-size:11px" onchange="syncFormToJson()">
                    <option value="fresh_each">fresh_each</option>
                    <option value="iterative">iterative</option>
                  </select>
                </div>
              </div>
            </div>

            <div id="section-loop-config" style="margin-bottom:16px; display:none; padding:10px; border:1px solid #30363d; border-radius:6px; background:#0d1117">
              <strong class="form-label" style="font-size:11px">Loop Parameters</strong>
              <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-top:8px">
                <div>
                  <label class="form-label" style="font-size:10px">max_attempts</label>
                  <input type="number" id="modal-max-iterations" class="form-input" style="font-size:11px" value="5" min="1" max="50" onchange="syncFormToJson()">
                </div>
                <div>
                  <label class="form-label" style="font-size:10px">auto_pass</label>
                  <input type="number" id="modal-auto-pass-threshold" class="form-input" style="font-size:11px" value="0.85" min="0" max="1" step="0.05" onchange="syncFormToJson()">
                </div>
                <div>
                  <label class="form-label" style="font-size:10px">insp_trigger</label>
                  <input type="number" id="modal-inspiration-trigger" class="form-input" style="font-size:11px" value="3" min="1" max="10" onchange="syncFormToJson()">
                </div>
              </div>
            </div>

            <div id="section-knowledge" style="margin-bottom:16px; padding:10px; border:1px solid #30363d; border-radius:6px; background:#0d1117">
              <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px">
                <input type="checkbox" id="modal-knowledge-enabled" checked oninput="syncFormToJson()">
                <span class="form-label" style="margin:0; font-size:11px">Enable Knowledge agent</span>
              </label>
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px">
                <div>
                  <label class="form-label" style="font-size:10px">Provider</label>
                  <select id="modal-knowledge-provider" class="form-select" style="font-size:11px" onchange="syncFormToJson()">
                    ${['codex','gemini','claude','opencode','droid'].map(p => '<option value="'+p+'">'+providerDisplayName(p)+'</option>').join('')}
                  </select>
                </div>
                <div>
                  <label class="form-label" style="font-size:10px">Knowledge Path</label>
                  <input type="text" id="modal-knowledge-project" class="form-input" style="font-size:11px" oninput="syncFormToJson()">
                </div>
              </div>
              <div id="modal-knowledge-shards-list" style="margin-top:8px; display:flex; flex-wrap:wrap; gap:4px"></div>
            </div>

            <div id="section-repo-filters" style="margin-bottom:16px; padding:10px; border:1px solid #30363d; border-radius:6px; background:#0d1117">
              <div style="display:flex; gap:12px">
                <div style="flex:1">
                  <label class="form-label" style="font-size:10px">allowed_paths (one per line)</label>
                  <textarea id="modal-allowed-paths" class="form-input" rows="2" style="font-size:11px; font-family:monospace" oninput="syncFormToJson()"></textarea>
                </div>
                <div style="flex:1">
                  <label class="form-label" style="font-size:10px">forbidden_globs (one per line)</label>
                  <textarea id="modal-forbidden-globs" class="form-input" rows="2" style="font-size:11px; font-family:monospace" oninput="syncFormToJson()"></textarea>
                </div>
              </div>
            </div>

            <div id="section-timeouts" style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-bottom:8px">
              <div>
                <label class="form-label" style="font-size:10px">coder_timeout</label>
                <input type="number" id="modal-coder-timeout" class="form-input" style="font-size:11px" value="600" onchange="syncFormToJson()">
              </div>
              <div>
                <label class="form-label" style="font-size:10px">judge_timeout</label>
                <input type="number" id="modal-judge-timeout" class="form-input" style="font-size:11px" value="300" onchange="syncFormToJson()">
              </div>
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px">
              <div id="section-observation" style="display:none">
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
                  <input type="checkbox" id="modal-open-terminal" checked>
                  <span style="font-size:11px; color:var(--text-muted)">Open terminal</span>
                </label>
              </div>
              <div id="section-deprecated-fields">
                <details>
                  <summary style="font-size:10px; color:var(--text-muted); cursor:pointer">Legacy Mapping</summary>
                  <div style="display:flex; gap:8px; margin-top:4px">
                    <select id="modal-executor-type" class="form-select" style="font-size:10px; padding:2px" onchange="setExecutorType(this.value); syncFormToJson()">
                      <option value="api_call">api_call</option>
                      <option value="solo_agent">solo_agent</option>
                      <option value="multi_agent">multi_agent</option>
                    </select>
                    <select id="modal-session-mode" class="form-select" style="font-size:10px; padding:2px" onchange="_currentSessionMode=this.value; syncFormToJson()">
                      <option value="fresh">fresh</option>
                      <option value="iterative">iterative</option>
                    </select>
                  </div>
                </details>
              </div>
            </div>

          </div>
        </details>

        <div id="section-acceptance" class="form-section" style="margin-bottom:12px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
          <strong class="form-label" style="font-size:11px">Acceptance &amp; Constraints</strong>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:10px">criteria (one per line)</label>
            <textarea id="modal-acceptance" class="form-input" rows="2" placeholder="Line 1&#10;Line 2" style="font-size:11px;width:100%;resize:vertical;margin-bottom:6px" oninput="syncFormToJson()"></textarea>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px">
            <div>
              <label class="form-label" style="font-size:10px">test_cmd</label>
              <input type="text" id="modal-test-cmd" class="form-input" placeholder="bash run_tests.sh" style="font-size:11px" oninput="syncFormToJson()">
            </div>
            <div>
              <label class="form-label" style="font-size:10px">max_attempts</label>
              <input type="number" id="modal-max-attempts" class="form-input" style="font-size:11px" value="3" onchange="syncFormToJson()">
            </div>
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:10px">constraints / paths</label>
            <textarea id="modal-constraints" class="form-input" rows="1" placeholder="allowed_paths, forbidden_globs..." style="font-size:11px;width:100%;resize:vertical" oninput="syncFormToJson()"></textarea>
          </div>
        </div>

        <div id="rubric-thresholds-container" style="margin-bottom:12px"></div>
        <div id="modal-journey-prompts-container"></div>

        <details style="margin-bottom:12px">
          <summary class="form-label" style="cursor:pointer; font-size:11px">Advanced (JSON)</summary>
          <textarea id="modal-spec-json" class="code-editor" style="height:150px;font-family:monospace;font-size:11px" onblur="syncJsonToForm()"></textarea>
          <div id="modal-json-error" style="color:#f85149;font-size:11px;margin-top:4px"></div>
        </details>

        <div id="modal-form-error" style="color:#f85149;font-size:12px;margin:8px 0;min-height:16px"></div>

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary write-action" onclick="saveNewSpec(event)">Save</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();
  
  // Initialize UI state
  onTaskTypeChange().then(() => {
    // Sync JSON once UI is ready
    syncFormToJson();
  });

  const knProviderEl = document.getElementById('modal-knowledge-provider');
  if (knProviderEl && !knProviderEl.value) knProviderEl.value = 'codex';
  const knPathEl = document.getElementById('modal-knowledge-project');
  if (knPathEl) knPathEl.dataset.userEdited = 'false';
  applyDefaultKnowledgePath();
  const soloProviderEl = document.getElementById('modal-solo-provider');
  if (soloProviderEl) {
    const desired = (defaultCoderModel || defaultCoder || 'claude').trim();
    if ([...soloProviderEl.options].some(o => o.value === desired)) {
      soloProviderEl.value = desired;
    }
  }

  initRepoGitSelectors('', 'main').catch(() => {});

  // Store templates for use in applyTemplate
  window._specTemplates = TEMPLATES;
}

function applyTemplate() {
  const sel = document.getElementById('modal-template');
  const tpl = window._specTemplates && sel ? window._specTemplates[sel.value] : null;
  if (!tpl) {
    document.getElementById('modal-spec-json').value = '';
    return;
  }
  // Update task-id field from template
  const taskIdEl = document.getElementById('modal-task-id');
  if (taskIdEl && !taskIdEl.value) taskIdEl.value = tpl.task_id || '';
  // Update task-type selector
  const typeEl = document.getElementById('modal-task-type');
  if (typeEl && tpl.task_type) typeEl.value = tpl.task_type;
  const attemptModeEl = document.getElementById('modal-attempt-context-mode');
  if (attemptModeEl && (tpl.attempt_context_mode === 'iterative' || tpl.attempt_context_mode === 'fresh_each')) attemptModeEl.value = tpl.attempt_context_mode;
  // Update adapter and model selectors
  const coderEl = document.getElementById('adapter-coder');
  if (coderEl && tpl.coder) coderEl.value = tpl.coder;
  const judgeEl = document.getElementById('adapter-judge');
  if (judgeEl && tpl.judge) judgeEl.value = tpl.judge;
  refreshModelSelector('coder').catch(() => {});
  refreshModelSelector('judge').catch(() => {});
  const coderModelEl = document.getElementById('adapter-coder-model');
  if (coderModelEl && tpl.coder_model) coderModelEl.value = tpl.coder_model;
  const judgeModelEl = document.getElementById('adapter-judge-model');
  if (judgeModelEl && tpl.judge_model) judgeModelEl.value = tpl.judge_model;
  // Put JSON in editor
  document.getElementById('modal-spec-json').value = JSON.stringify(tpl, null, 2);
  // Repo & Git fields
  const rp = document.getElementById('modal-repo-path');
  if (rp) rp.value = tpl.repo_path || '';
  const br = document.getElementById('modal-base-ref');
  if (br) br.value = tpl.base_ref || 'main';
  const ap = document.getElementById('modal-allowed-paths');
  if (ap) ap.value = Array.isArray(tpl.allowed_paths) ? tpl.allowed_paths.join('\n') : (tpl.allowed_paths || '');
  const fg = document.getElementById('modal-forbidden-globs');
  if (fg) fg.value = Array.isArray(tpl.forbidden_globs) ? tpl.forbidden_globs.join('\n') : (tpl.forbidden_globs || '');
  const inst = document.getElementById('modal-instruction');
  if (inst) inst.value = tpl.goal || tpl.instruction || '';
  const soloProvider = document.getElementById('modal-solo-provider');
  if (soloProvider) soloProvider.value = tpl.agent_config?.provider || tpl.coder_model || 'claude';
  const knEnabled = document.getElementById('modal-knowledge-enabled');
  if (knEnabled) knEnabled.checked = tpl.knowledge_enabled !== false;
  const knProvider = document.getElementById('modal-knowledge-provider');
  if (knProvider) knProvider.value = tpl.knowledge_provider || tpl.agent_config?.provider || 'codex';
  const knPath = document.getElementById('modal-knowledge-project');
  if (knPath) {
    knPath.dataset.userEdited = tpl.knowledge_project_path ? 'true' : 'false';
  }
  refreshKnowledgeShardSelector(Array.isArray(tpl.agent_config?.knowledge_shards) ? tpl.agent_config.knowledge_shards : []).catch(() => {});
  const acc = document.getElementById('modal-acceptance');
  if (acc) acc.value = Array.isArray(tpl.acceptance) ? tpl.acceptance.join('\n') : (tpl.acceptance || '');
  const tc = document.getElementById('modal-test-cmd');
  if (tc) tc.value = tpl.test_cmd || '';
  const ma = document.getElementById('modal-max-attempts');
  if (ma) ma.value = tpl.max_attempts !== undefined ? String(tpl.max_attempts) : '3';
  // Load rubric
  if (tpl.task_type) onTaskTypeChange();
  initRepoGitSelectors(tpl.repo_path || '', tpl.base_ref || 'main').catch(() => {});
}

// A2-2: Save new spec
async function saveNewSpec(e) {
  const btn = e ? e.currentTarget : null;
  const taskId = (document.getElementById('modal-task-id')?.value || '').trim();
  const jsonStr = (document.getElementById('modal-spec-json')?.value || '').trim();
  const errEl = document.getElementById('modal-form-error') || document.getElementById('modal-json-error');
  if (errEl) errEl.textContent = '';
  if (!taskId || !/^[A-Za-z0-9_-]+$/.test(taskId)) {
    renderValidationErrors(errEl, ['Task ID is required and must use letters/numbers/_/-.']);
    return;
  }

  setButtonLoading(btn, true);
  try {
    let spec = {};
    if (jsonStr) {
      try {
        spec = JSON.parse(jsonStr);
      } catch (e) {
        renderValidationErrors(errEl, ['JSON syntax error: ' + e.message]);
        return;
      }
    }
    const payload = normalizeToV51SavePayload(spec, taskId);
    const formErrors = validateV51SpecForSave(payload);
    if (formErrors.length > 0) {
      renderValidationErrors(errEl, formErrors);
      return;
    }

    // Naming convention: template_* go to task_specs (blueprints)
    // others go to tasks (live instances)
    const isTemplate = taskId.startsWith('template_');
    const endpoint = isTemplate ? '/api/task_specs' : '/api/tasks';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, spec: payload })
    });
    const result = await res.json();
    if (!res.ok) {
      renderValidationErrors(errEl, (Array.isArray(result.errors) && result.errors.length) ? result.errors : [result.error || 'Validation failed']);
      return;
    }
    closeModal();
    loadTaskSpecs();
    loadTasks();
  } catch (e) {
    renderValidationErrors(errEl, ['Save failed: ' + (e.message || String(e))]);
  } finally {
    setButtonLoading(btn, false);
  }
}

// A2-5: Open edit modal for existing spec
async function openEditSpecModal(taskId) {
  await loadAdapters();

  const data = await api(`/task_specs/${encodeURIComponent(taskId)}`);
  if (data.error) {
    alert('Failed to load spec: ' + data.error);
    return;
  }
  const spec = data.spec || {};

  const editChannel = spec.channel_type || inferChannelFromAdapter(spec.coder);
  const coderAdapterForSelector = editChannel === 'ccb' ? (spec.coder_model || 'codex') : spec.coder;
  const judgeAdapterForSelector = editChannel === 'ccb' ? (spec.judge_model || 'codex') : spec.judge;
  const specTaskType = normalizeTaskTypeAlias(spec.task_type || '');
  let editExecutorType = spec.executor_type || '';
  if (!editExecutorType && spec.workflow_mode) {
    editExecutorType = workflowModeToExecutorType(spec.workflow_mode);
  }
  if (!editExecutorType) {
    editExecutorType = taskTypeToExecutorType(specTaskType || 'solo');
  }
  const editSessionMode = spec.session_mode || defaultSessionModeForExecutor(editExecutorType);
  _currentExecutorType = editExecutorType;
  _currentSessionMode = editSessionMode;
  _currentWorkflowMode = spec.workflow_mode || 'auto';
  let collabRoleDefaults = {};
  try {
    const roles = await api('/agent/roles');
    collabRoleDefaults = roles.defaults || {};
  } catch {}
  const editCollabRoles = normalizeCollabRolesMap(spec.collab_roles || {});
  const COLLAB_PROVIDERS_EDIT = ['claude', 'codex', 'gemini', 'opencode', 'droid'];
  const COLLAB_ROLES_EDIT = COLLAB_ROLE_KEYS.map(key => ({
    key,
    label: COLLAB_ROLE_LABELS[key],
    provider: editCollabRoles[key] || collabRoleDefaults[key] || DEFAULT_COLLAB_ROLE_PROVIDERS[key]
  }));

  // Pre-load rubric if task_type known
  if (spec.task_type) await loadRubric(spec.task_type);

  // v5.1.4: Normalize for preview (F2)
  const isLegacy = isLegacyTask(spec);
  const normalized = normalizeSpecToV51(spec);
  const nSpec = normalized.spec;

  const thresholdsHtml = nSpec.task_type
    ? buildThresholdsUI(nSpec.task_type, nSpec.rubric_thresholds)
    : '';

  const modalHtml = `
    <div id="spec-modal" class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:800px;max-height:90vh;overflow-y:auto">
        <h3 style="margin-top:0">Edit Task Spec: ${escapeHtml(taskId)} (v5.1.4)</h3>

        <div id="legacy-warning" class="questions-banner" style="display:${isLegacy ? 'block' : 'none'}; margin-bottom:12px; border-color: var(--accent-red); background: rgba(218,54,51,0.1)">
          <strong>Legacy Task Detected</strong>
          <p style="font-size:12px; margin-top:4px">This task uses deprecated fields. Saving will normalize it to v5.1.4.</p>
          <div id="migration-preview" style="font-size:11px; margin-top:8px; opacity:0.8; font-family:monospace">
            ${normalized.notes.map(n => `• ${escapeHtml(n)}`).join('<br>')}
          </div>
        </div>

        <!-- Primary Fields -->
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:12px">
          <div>
            <label class="form-label">Task Type</label>
            <select id="modal-task-type" class="form-select" onchange="syncFormToJson(); onTaskTypeChange()">
              <option value="copywriting" ${nSpec.task_type === 'copywriting' ? 'selected' : ''}>copywriting</option>
              <option value="solo" ${nSpec.task_type === 'solo' ? 'selected' : ''}>solo</option>
              <option value="multi_agent" ${nSpec.task_type === 'multi_agent' ? 'selected' : ''}>multi_agent</option>
            </select>
          </div>
          <div>
            <label class="form-label">Task ID</label>
            <input type="text" id="modal-task-id" class="form-input" value="${escapeHtml(taskId)}" readonly style="background:rgba(255,255,255,0.05); cursor:not-allowed">
          </div>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">instruction / goal <span style="color:#f85149">*</span></label>
          <textarea id="modal-instruction" class="form-input" rows="4" placeholder="Describe what to achieve" style="width:100%;resize:vertical" oninput="syncFormToJson()">${escapeHtml(spec.goal || spec.instruction || '')}</textarea>
        </div>

        <!-- Model Selection (Unified) -->
        <div id="section-role-models" style="margin-bottom:16px;padding:12px;background:#161b22;border:1px solid #30363d;border-radius:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong class="form-label" style="margin:0">Model Selection</strong>
            <button type="button" class="btn write-action" style="font-size:11px;padding:2px 8px" onclick="makeCurrentAsTemplate()">Make it Template</button>
          </div>
          
          <div id="solo-provider-wrap" style="margin-bottom:8px; display:${nSpec.task_type === 'solo' ? 'block' : 'none'}">
            <label class="form-label" style="font-size:11px">Provider</label>
            <select id="modal-solo-provider" class="form-select" onchange="syncFormToJson()">
              ${COLLAB_PROVIDERS_EDIT.map(p => `<option value="${escapeHtml(p)}" ${(nSpec.agent_config?.provider || nSpec.coder_model || 'claude') === p ? 'selected' : ''}>${escapeHtml(providerDisplayName(p))}</option>`).join('')}
            </select>
          </div>

          <div id="collab-roles-table" style="font-size:12px; display:${nSpec.task_type !== 'solo' ? 'block' : 'none'}">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr><th style="text-align:left;padding-bottom:4px">Role</th><th style="text-align:left;padding-bottom:4px">Model / Provider</th></tr></thead>
              <tbody>
                ${COLLAB_ROLES_EDIT.map(r => {
                  const opts = COLLAB_PROVIDERS_EDIT.map(p => `<option value="${escapeHtml(p)}" ${p === r.provider ? 'selected' : ''}>${escapeHtml(providerDisplayName(p))}</option>`).join('');
                  return `<tr class="role-row" data-role="${escapeHtml(r.key)}"><td style="padding:4px 0">${escapeHtml(r.label)}</td><td style="padding:4px 0"><select id="collab-role-${escapeHtml(r.key)}" class="form-select" style="width:100%" onchange="syncFormToJson()">${opts}</select></td></tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Advanced Settings (Collapsed) -->
        <details style="margin-bottom:12px; border:1px solid #30363d; border-radius:8px; background: rgba(0,0,0,0.1)">
          <summary style="padding:10px; cursor:pointer; font-size:12px; color:var(--text-muted); font-weight:600">Advanced Settings (Repo, Context, Loop Config)</summary>
          <div style="padding:12px; border-top:1px solid #30363d">
            
            <div id="section-repo-git" style="margin-bottom:16px">
              <label class="form-label" style="font-size:11px">repo_path</label>
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                <input type="text" id="modal-repo-path" class="form-input" value="${escapeHtml(spec.repo_path || '')}" placeholder="/path/to/repo" style="flex:1;margin:0" onchange="onRepoSelectionChanged()" oninput="syncFormToJson()">
                <button type="button" class="btn write-action" style="padding:4px 8px;font-size:11px" onclick="openFolderPickerModal()">Choose</button>
              </div>
              <div style="display:flex; gap:12px">
                <div style="flex:1">
                  <label class="form-label" style="font-size:10px">base_ref</label>
                  <input type="text" id="modal-base-ref" class="form-input" value="${escapeHtml(spec.base_ref || 'main')}" placeholder="main" style="font-size:11px" oninput="syncFormToJson()">
                </div>
                <div style="flex:1">
                  <label class="form-label" style="font-size:10px">context_mode</label>
                  <select id="modal-attempt-context-mode" class="form-select" style="font-size:11px" onchange="syncFormToJson()">
                    <option value="fresh_each" ${(spec.attempt_context_mode || 'fresh_each') === 'fresh_each' ? 'selected' : ''}>fresh_each</option>
                    <option value="iterative" ${(spec.attempt_context_mode || '') === 'iterative' ? 'selected' : ''}>iterative</option>
                  </select>
                </div>
              </div>
            </div>

            <div id="section-loop-config" style="margin-bottom:16px; display:none; padding:10px; border:1px solid #30363d; border-radius:6px; background:#0d1117">
              <strong class="form-label" style="font-size:11px">Loop Parameters</strong>
              <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-top:8px">
                <div>
                  <label class="form-label" style="font-size:10px">max_attempts</label>
                  <input type="number" id="modal-max-iterations" class="form-input" style="font-size:11px" value="${spec.agent_config?.max_attempts ?? spec.max_attempts ?? 5}" min="1" max="50" onchange="syncFormToJson()">
                </div>
                <div>
                  <label class="form-label" style="font-size:10px">auto_pass</label>
                  <input type="number" id="modal-auto-pass-threshold" class="form-input" style="font-size:11px" value="${spec.agent_config?.auto_pass_threshold ?? 0.85}" min="0" max="1" step="0.05" onchange="syncFormToJson()">
                </div>
                <div>
                  <label class="form-label" style="font-size:10px">insp_trigger</label>
                  <input type="number" id="modal-inspiration-trigger" class="form-input" style="font-size:11px" value="${spec.agent_config?.inspiration_trigger_attempts ?? 3}" min="1" max="10" onchange="syncFormToJson()">
                </div>
              </div>
            </div>

            <div id="section-knowledge" style="margin-bottom:16px; padding:10px; border:1px solid #30363d; border-radius:6px; background:#0d1117">
              <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px">
                <input type="checkbox" id="modal-knowledge-enabled" ${spec.knowledge_enabled ? 'checked' : ''} oninput="syncFormToJson()">
                <span class="form-label" style="margin:0; font-size:11px">Enable Knowledge agent</span>
              </label>
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px">
                <div>
                  <label class="form-label" style="font-size:10px">Provider</label>
                  <select id="modal-knowledge-provider" class="form-select" style="font-size:11px" onchange="syncFormToJson()">
                    ${['codex','gemini','claude','opencode','droid'].map(p => '<option value="'+p+'" '+(((spec.knowledge_provider || spec.agent_config?.provider || 'codex')===p)?'selected':'')+'>'+providerDisplayName(p)+'</option>').join('')}
                  </select>
                </div>
                <div>
                  <label class="form-label" style="font-size:10px">Knowledge Path</label>
                  <input type="text" id="modal-knowledge-project" class="form-input" style="font-size:11px" value="${escapeHtml(spec.knowledge_project_path || '')}" oninput="syncFormToJson()">
                </div>
              </div>
              <div id="modal-knowledge-shards-list" style="margin-top:8px; display:flex; flex-wrap:wrap; gap:4px"></div>
            </div>

            <div id="section-repo-filters" style="margin-bottom:16px; padding:10px; border:1px solid #30363d; border-radius:6px; background:#0d1117">
              <div style="display:flex; gap:12px">
                <div style="flex:1">
                  <label class="form-label" style="font-size:10px">allowed_paths (one per line)</label>
                  <textarea id="modal-allowed-paths" class="form-input" rows="2" style="font-size:11px; font-family:monospace" oninput="syncFormToJson()">${escapeHtml(Array.isArray(spec.allowed_paths) ? spec.allowed_paths.join('\n') : (spec.allowed_paths || ''))}</textarea>
                </div>
                <div style="flex:1">
                  <label class="form-label" style="font-size:10px">forbidden_globs (one per line)</label>
                  <textarea id="modal-forbidden-globs" class="form-input" rows="2" style="font-size:11px; font-family:monospace" oninput="syncFormToJson()">${escapeHtml(Array.isArray(spec.forbidden_globs) ? spec.forbidden_globs.join('\n') : (spec.forbidden_globs || ''))}</textarea>
                </div>
              </div>
            </div>

            <div id="section-timeouts" style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-bottom:8px">
              <div>
                <label class="form-label" style="font-size:10px">coder_timeout</label>
                <input type="number" id="modal-coder-timeout" class="form-input" style="font-size:11px" value="${spec.coder_timeout_seconds || 600}" onchange="syncFormToJson()">
              </div>
              <div>
                <label class="form-label" style="font-size:10px">judge_timeout</label>
                <input type="number" id="modal-judge-timeout" class="form-input" style="font-size:11px" value="${spec.judge_timeout_seconds || 300}" onchange="syncFormToJson()">
              </div>
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px">
              <div id="section-observation" style="display:none">
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
                  <input type="checkbox" id="modal-open-terminal" ${((spec.solo_config && spec.solo_config.open_terminal) !== false) ? 'checked' : ''}>
                  <span style="font-size:11px; color:var(--text-muted)">Open terminal</span>
                </label>
              </div>
              <div id="section-deprecated-fields">
                <details>
                  <summary style="font-size:10px; color:var(--text-muted); cursor:pointer">Legacy Mapping</summary>
                  <div style="display:flex; gap:8px; margin-top:4px">
                    <select id="modal-executor-type" class="form-select" style="font-size:10px; padding:2px" onchange="setExecutorType(this.value); syncFormToJson()">
                      <option value="api_call" ${editExecutorType === 'api_call' ? 'selected' : ''}>api_call</option>
                      <option value="solo_agent" ${editExecutorType === 'solo_agent' ? 'selected' : ''}>solo_agent</option>
                      <option value="multi_agent" ${editExecutorType === 'multi_agent' ? 'selected' : ''}>multi_agent</option>
                    </select>
                    <select id="modal-session-mode" class="form-select" style="font-size:10px; padding:2px" onchange="_currentSessionMode=this.value; syncFormToJson()">
                      <option value="fresh" ${editSessionMode === 'fresh' ? 'selected' : ''}>fresh</option>
                      <option value="iterative" ${editSessionMode === 'iterative' ? 'selected' : ''}>iterative</option>
                    </select>
                  </div>
                </details>
              </div>
            </div>

          </div>
        </details>

        <div id="section-acceptance" class="form-section" style="margin-bottom:12px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
          <strong class="form-label" style="font-size:11px">Acceptance &amp; Constraints</strong>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:10px">criteria (one per line)</label>
            <textarea id="modal-acceptance" class="form-input" rows="2" placeholder="Line 1&#10;Line 2" style="font-size:11px;width:100%;resize:vertical;margin-bottom:6px" oninput="syncFormToJson()">${escapeHtml(Array.isArray(spec.acceptance) ? spec.acceptance.join('\n') : (spec.acceptance || ''))}</textarea>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px">
            <div>
              <label class="form-label" style="font-size:10px">test_cmd</label>
              <input type="text" id="modal-test-cmd" class="form-input" placeholder="bash run_tests.sh" style="font-size:11px" oninput="syncFormToJson()" value="${escapeHtml(spec.test_cmd || '')}">
            </div>
            <div>
              <label class="form-label" style="font-size:10px">max_attempts</label>
              <input type="number" id="modal-max-attempts" class="form-input" style="font-size:11px" value="${spec.max_attempts !== undefined ? spec.max_attempts : 3}" onchange="syncFormToJson()">
            </div>
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:10px">constraints / paths</label>
            <textarea id="modal-constraints" class="form-input" rows="1" placeholder="allowed_paths, forbidden_globs..." style="font-size:11px;width:100%;resize:vertical" oninput="syncFormToJson()">${escapeHtml(Array.isArray(spec.constraints) ? spec.constraints.join('\n') : (spec.constraints || []).join('\n'))}</textarea>
          </div>
        </div>

        <div id="rubric-thresholds-container" style="margin-bottom:12px">
          ${thresholdsHtml}
        </div>
        <div id="modal-journey-prompts-container"></div>

        <details style="margin-bottom:12px">
          <summary class="form-label" style="cursor:pointer; font-size:11px">Advanced (JSON)</summary>
          <textarea id="modal-spec-json" class="code-editor" style="height:150px;font-family:monospace;font-size:11px" onblur="syncJsonToForm()">${escapeHtml(JSON.stringify(spec, null, 2))}</textarea>
          <div id="modal-json-error" style="color:#f85149;font-size:11px;margin-top:4px"></div>
        </details>

        <div id="modal-form-error" style="color:#f85149;font-size:12px;margin:8px 0;min-height:16px"></div>

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary write-action" onclick="saveEditSpec('${escapeHtml(taskId)}')">Save</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();

  onTaskTypeChange().then(() => {
    syncFormToJson();
  }).catch(e => console.error('onTaskTypeChange failed', e));

  try {
    const knPathEl = document.getElementById('modal-knowledge-project');
    if (knPathEl) knPathEl.dataset.userEdited = spec.knowledge_project_path ? 'true' : 'false';
    const ksListEl = document.getElementById('modal-knowledge-shards-list');
    const preselected = (ksListEl?.dataset?.selected || '').split(',').map(s => s.trim()).filter(Boolean);
    refreshKnowledgeShardSelector(preselected).catch(() => {});
    initRepoGitSelectors(spec.repo_path || '', spec.base_ref || 'main').catch(() => {});
  } catch (e) {
    console.error('Edit modal init failed', e);
  }
}

// A2-5: Save edited spec
async function saveEditSpec(taskId) {
  const btn = document.querySelector('#spec-modal .btn.btn-primary.write-action');
  const jsonStr = (document.getElementById('modal-spec-json')?.value || '').trim();
  const errEl = document.getElementById('modal-form-error') || document.getElementById('modal-json-error');
  if (errEl) errEl.textContent = '';

  let spec = {};
  if (jsonStr) {
    try {
      spec = JSON.parse(jsonStr);
    } catch (e) {
      renderValidationErrors(errEl, ['JSON syntax error: ' + e.message]);
      return;
    }
  }

  const payload = normalizeToV51SavePayload(spec, taskId);
  const attemptContextModeVal = document.getElementById('modal-attempt-context-mode')?.value;
  if (attemptContextModeVal) payload.attempt_context_mode = attemptContextModeVal;
  const instructionVal = (document.getElementById('modal-instruction')?.value || '').trim();
  if (instructionVal) payload.goal = instructionVal;
  const acceptanceVal = document.getElementById('modal-acceptance')?.value?.trim();
  if (acceptanceVal) payload.acceptance = acceptanceVal.split(/\n/).map(s => s.trim()).filter(Boolean);
  const testCmdVal = document.getElementById('modal-test-cmd')?.value?.trim();
  if (testCmdVal !== undefined && testCmdVal !== '') payload.test_cmd = testCmdVal;
  const maxAttemptsVal = document.getElementById('modal-max-attempts')?.value;
  if (maxAttemptsVal !== undefined && maxAttemptsVal !== '') payload.max_attempts = Math.min(50, Math.max(1, parseInt(maxAttemptsVal, 10) || 3));
  const coderTimeoutVal = document.getElementById('modal-coder-timeout')?.value;
  if (coderTimeoutVal !== undefined && coderTimeoutVal !== '') payload.coder_timeout_seconds = Math.min(3600, Math.max(60, parseInt(coderTimeoutVal, 10) || 600));
  const judgeTimeoutVal = document.getElementById('modal-judge-timeout')?.value;
  if (judgeTimeoutVal !== undefined && judgeTimeoutVal !== '') payload.judge_timeout_seconds = Math.min(3600, Math.max(60, parseInt(judgeTimeoutVal, 10) || 300));
  const constraintsVal = (document.getElementById('modal-constraints')?.value || '').trim();
  if (constraintsVal) payload.constraints = constraintsVal.split(/\n/).map(s => s.trim()).filter(Boolean);
  else if (payload.constraints !== undefined) delete payload.constraints;
  const apRaw = document.getElementById('modal-allowed-paths')?.value?.trim();
  if (apRaw) {
    if (apRaw.startsWith('[')) { try { payload.allowed_paths = JSON.parse(apRaw); } catch {} }
    else { payload.allowed_paths = apRaw.split(/\n/).map(s => s.trim()).filter(Boolean); }
  } else if (payload.allowed_paths !== undefined) {
    delete payload.allowed_paths;
  }
  const fgRaw = document.getElementById('modal-forbidden-globs')?.value?.trim();
  if (fgRaw) {
    if (fgRaw.startsWith('[')) { try { payload.forbidden_globs = JSON.parse(fgRaw); } catch {} }
    else { payload.forbidden_globs = fgRaw.split(/\n/).map(s => s.trim()).filter(Boolean); }
  } else if (payload.forbidden_globs !== undefined) {
    delete payload.forbidden_globs;
  }

  if (payload.task_type) {
    const thresholds = readThresholdsFromUI(payload.task_type);
    if (thresholds) payload.rubric_thresholds = thresholds;
  }
  const knEnabled = document.getElementById('modal-knowledge-enabled')?.checked;
  if (knEnabled) {
    payload.knowledge_enabled = true;
    const kp = (document.getElementById('modal-knowledge-project')?.value || '').trim();
    const rp2 = (document.getElementById('modal-repo-path')?.value || '').trim();
    payload.knowledge_project_path = kp || normalizeKnowledgePath(rp2);
    payload.knowledge_provider = (document.getElementById('modal-knowledge-provider')?.value || 'codex').trim() || 'codex';
    payload.agent_config = {
      ...(payload.agent_config || {}),
      knowledge_shards: getSelectedKnowledgeShards()
    };
  } else if (payload.knowledge_enabled !== undefined) {
    delete payload.knowledge_enabled;
    if (payload.knowledge_project_path !== undefined) delete payload.knowledge_project_path;
    if (payload.knowledge_provider !== undefined) delete payload.knowledge_provider;
  }
  if (payload.task_type === 'solo') {
    payload.agent_config = {
      ...(payload.agent_config || {}),
      max_attempts: parseInt(document.getElementById('modal-max-iterations')?.value || String(payload.max_attempts || 3), 10),
      auto_pass_threshold: parseFloat(document.getElementById('modal-auto-pass-threshold')?.value || '0.85'),
      provider: normalizeProviderFromAny(document.getElementById('modal-solo-provider')?.value || payload.agent_config?.provider || payload.collab_roles?.executor || 'codex') || 'codex',
      knowledge_shards: getSelectedKnowledgeShards()
    };
  }
  if (payload.rubric_thresholds !== undefined && payload.task_type !== 'copywriting') {
    delete payload.rubric_thresholds;
  }

  const formErrors = validateV51SpecForSave(payload);
  if (formErrors.length > 0) {
    renderValidationErrors(errEl, formErrors);
    return;
  }

  setButtonLoading(btn, true);
  try {
    const isTemplate = taskId.startsWith('template_');
    const url = isTemplate ? `/api/task_specs/${encodeURIComponent(taskId)}` : '/api/tasks';
    const method = isTemplate ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isTemplate ? { spec: payload } : { task_id: taskId, spec: payload })
    });
    const result = await res.json();
    if (!res.ok) {
      renderValidationErrors(errEl, (Array.isArray(result.errors) && result.errors.length) ? result.errors : [result.error || 'Validation failed']);
      return;
    }
    closeModal();
    loadTaskSpecs();
    loadTasks();
  } catch (e) {
    renderValidationErrors(errEl, ['Save failed: ' + (e.message || String(e))]);
  } finally {
    setButtonLoading(btn, false);
  }
}

// A2-3: Copy a task spec
async function copySpec(taskId) {
  try {
    const result = await api(`/task_specs/${encodeURIComponent(taskId)}/copy`, { method: 'POST' });
    if (result.error) {
      alert('Copy failed: ' + result.error);
      return;
    }
    loadTaskSpecs();
    // Show confirmation
    const el = document.getElementById('task-specs-notice');
    if (el) {
      el.textContent = `Copied as: ${result.task_id}`;
      setTimeout(() => { el.textContent = ''; }, 3000);
    }
  } catch (e) {
    alert('Copy failed: ' + e.message);
  }
}

// A2-4: Delete (soft-delete) a task spec
async function deleteSpec(taskId) {
  if (!confirm(`Delete task spec "${taskId}"? (Soft-delete to trash/)`)) return;
  try {
    const result = await api(`/task_specs/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    if (result.error) {
      alert('Delete failed: ' + result.error);
      return;
    }
    loadTaskSpecs();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

// ================================================================
// D1/D2: Prompt management
// ================================================================

// D1: Load and display prompts list in sidebar
async function loadPrompts() {
  const list = document.getElementById('prompts-list');
  if (!list) return;
  try {
    const res = await fetch('/api/prompts');
    const data = await res.json();
    if (data.error) { list.innerHTML = `<div style="padding:6px 12px;font-size:12px;color:#f85149">${escapeHtml(data.error)}</div>`; return; }
    const prompts = Array.isArray(data) ? data : (Array.isArray(data.prompts) ? data.prompts : []);
    if (prompts.length === 0) {
      list.innerHTML = '<div style="padding:6px 12px;font-size:12px;color:#8b949e">No prompts found</div>';
      return;
    }
    list.innerHTML = prompts.map(p => `
      <div class="sidebar-item" onclick="viewPrompt(${JSON.stringify(p.name)})" style="cursor:pointer">
        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <span style="font-size:10px;color:#8b949e;margin-left:4px">${escapeHtml(String(Math.round((p.size||0)/1024*10)/10))}KB</span>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = `<div style="padding:6px 12px;font-size:12px;color:#f85149">Load error: ${escapeHtml(e.message)}</div>`;
  }
}

// D2: View and edit a prompt in a modal
async function viewPrompt(name, taskId = null) {
  // Remove existing modal if any
  const old = document.getElementById('prompt-modal');
  if (old) old.remove();
  try {
    let url = `/api/prompts/${encodeURIComponent(name)}`;
    if (taskId) url += `?task_id=${encodeURIComponent(taskId)}`;
    
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) { alert('Failed to load prompt: ' + data.error); return; }
    
    const scopeInfo = taskId 
      ? `<span style="background:var(--accent-blue);color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;vertical-align:middle;margin-left:8px">TASK SCOPE: ${escapeHtml(taskId)}</span>`
      : `<span style="background:#8b949e;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;vertical-align:middle;margin-left:8px">GLOBAL DEFAULT</span>`;

    const modalHtml = `
      <div id="prompt-modal" class="modal-overlay" onclick="if(event.target===this)closePromptModal()">
        <div class="modal-box" style="max-width:800px;max-height:90vh;overflow-y:auto">
          <h3 style="margin-top:0;display:flex;align-items:center;justify-content:space-between">
            <span>Edit Prompt: ${escapeHtml(name)} ${scopeInfo}</span>
          </h3>
          <textarea id="prompt-editor" class="code-editor" style="height:480px;font-family:monospace;font-size:12px;width:100%;box-sizing:border-box">${escapeHtml(data.content || '')}</textarea>
          <div id="prompt-save-notice" style="font-size:12px;color:#3fb950;margin-top:4px;min-height:16px"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
            <button class="btn" onclick="closePromptModal()">Cancel</button>
            <button class="btn btn-primary write-action" onclick="savePrompt(${JSON.stringify(name)}, ${JSON.stringify(taskId)})">Save</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    updateReadOnlyBanner();
  } catch (e) {
    alert('Failed to load prompt: ' + e.message);
  }
}

function closePromptModal() {
  const el = document.getElementById('prompt-modal');
  if (el) el.remove();
}

// D2: Save prompt content via PUT. K7-2: overwrite requires second confirmation.
async function savePrompt(name, taskId = null) {
  const content = document.getElementById('prompt-editor')?.value;
  if (content === undefined) return;
  const msg = taskId 
    ? `Overwrite this prompt specifically for task ${taskId}? This will NOT affect other tasks.`
    : `Overwrite this GLOBAL prompt? This will affect all future tasks.`;
    
  if (!confirm(msg)) return;
  const notice = document.getElementById('prompt-save-notice');
  if (notice) notice.textContent = '';
  try {
    let url = `/api/prompts/${encodeURIComponent(name)}`;
    if (taskId) url += `?task_id=${encodeURIComponent(taskId)}`;
    
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    const result = await res.json();
    if (!res.ok) {
      if (notice) notice.style.color = '#f85149';
      if (notice) notice.textContent = 'Save failed: ' + (result.error || res.statusText);
      return;
    }
    if (notice) { notice.style.color = '#3fb950'; notice.textContent = 'Saved.'; }
    loadPrompts();
    setTimeout(() => { if (notice) notice.textContent = ''; }, 3000);
  } catch (e) {
    if (notice) { notice.style.color = '#f85149'; notice.textContent = 'Save error: ' + e.message; }
  }
}

// D2: Open prompt for the task_type of a spec (from edit modal)
async function openPromptForTaskType(taskType) {
  if (!taskType) { alert('No task_type selected'); return; }
  const normalized = normalizeTaskTypeAlias(taskType);
  const preferred = `judge.prompt.${normalized}.md`;
  const fallback = 'judge.prompt.md';
  try {
    const res = await fetch('/api/prompts');
    const data = await res.json();
    const prompts = Array.isArray(data) ? data : (Array.isArray(data.prompts) ? data.prompts : []);
    const names = new Set(prompts.map(p => p?.name).filter(Boolean));
    if (names.has(preferred)) {
      await viewPrompt(preferred);
      return;
    }
    if (names.has(fallback)) {
      await viewPrompt(fallback);
      return;
    }
  } catch (_) {
    // fallback below
  }
  await viewPrompt(preferred);
}

// §v5.1.4: Task Journey Prompts UI (Bottom of Modal)
function buildTaskJourneyPromptsUI(taskType, taskId) {
  const normType = taskType ? normalizeTaskTypeAlias(taskType) : '';
  const prompts = [
    { name: 'pm.prompt.md', label: 'PM' },
    { name: 'designer.prompt.md', label: 'Designer' },
    { name: 'coder.prompt.md', label: 'Executor (Coder)' },
    { name: 'judge.prompt.md', label: 'Reviewer (Judge) — Global' },
    { name: 'inspiration.prompt.md', label: 'Inspiration' }
  ];
  if (normType) {
    prompts.push({ name: `judge.prompt.${normType}.md`, label: `Reviewer (Judge) — for ${normType}` });
  }

  const buttons = prompts.map(p => `
    <button type="button" class="btn" style="padding:4px 10px;font-size:11px" onclick="viewPrompt('${escapeHtml(p.name)}', ${JSON.stringify(taskId)})">
      ${escapeHtml(p.label)}
    </button>
  `).join('');

  return `
    <div id="section-journey-prompts" style="margin-top:16px;padding:12px;background:rgba(255,255,255,0.03);border:1px solid #30363d;border-radius:8px">
      <strong class="form-label" style="margin-bottom:8px">Task Journey Prompts</strong>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${buttons}
      </div>
      <p style="font-size:11px;color:#8b949e;margin-top:8px">These prompts define role-specific instructions used by the coordinator during task execution.</p>
    </div>
  `;
}

function formatPromptCenterSize(size) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function renderPromptCenterEntryList(entries) {
  const list = document.getElementById('prompt-center-list');
  if (!list) return;
  if (!Array.isArray(entries) || entries.length === 0) {
    list.innerHTML = '<div style="padding:10px;color:#8b949e;font-size:12px">No prompt files found.</div>';
    return;
  }

  let lastCategory = '';
  const rows = [];
  for (const item of entries) {
    const category = String(item?.category || 'Other');
    if (category !== lastCategory) {
      rows.push(`<div style="padding:8px 10px 4px;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.4px">${escapeHtml(category)}</div>`);
      lastCategory = category;
    }
    const selected = promptCenterSelectedTarget === item.target;
    rows.push(`
      <button type="button" class="btn" onclick='openPromptCenterFile(${JSON.stringify(item.target)})'
        style="display:block;width:100%;text-align:left;border-radius:0;border-left:3px solid ${selected ? '#58a6ff' : 'transparent'};background:${selected ? '#1f2937' : 'transparent'};padding:8px 10px;border-top:1px solid #21262d">
        <div style="font-size:12px;color:#c9d1d9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.name || '')}</div>
        <div style="font-size:11px;color:#8b949e;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.brief || '')}</div>
      </button>`);
  }
  list.innerHTML = rows.join('');
}

async function openPromptCenterFile(target) {
  if (!target) return;
  const notice = document.getElementById('prompt-center-save-notice');
  if (notice) notice.textContent = '';
  promptCenterSelectedTarget = target;
  const contentEl = document.getElementById('prompt-center-editor');
  const metaEl = document.getElementById('prompt-center-meta');
  const titleEl = document.getElementById('prompt-center-title');
  if (contentEl) contentEl.value = '';
  if (metaEl) metaEl.textContent = 'Loading...';
  if (titleEl) titleEl.textContent = 'Loading...';
  renderPromptCenterEntryList(window._promptCenterEntries || []);

  try {
    const res = await fetch(`/api/prompt-center/file?target=${encodeURIComponent(target)}`);
    const data = await res.json();
    if (!res.ok) {
      if (metaEl) metaEl.textContent = data.error || 'Failed to load file.';
      return;
    }
    if (titleEl) titleEl.textContent = data.name || '(unnamed)';
    if (metaEl) metaEl.textContent = `${data.filepath || ''}${data.updated_at ? ` · updated ${data.updated_at}` : ''}`;
    if (contentEl) contentEl.value = data.content || '';
    const saveBtn = document.getElementById('prompt-center-save-btn');
    if (saveBtn) saveBtn.dataset.target = target;
  } catch (e) {
    if (metaEl) metaEl.textContent = `Load failed: ${e.message || String(e)}`;
  }
}

async function savePromptCenterFile() {
  const btn = document.getElementById('prompt-center-save-btn');
  const target = btn?.dataset?.target || '';
  const content = document.getElementById('prompt-center-editor')?.value;
  const notice = document.getElementById('prompt-center-save-notice');
  if (!target || content === undefined) return;
  if (!confirm('Overwrite this prompt file? This action will be recorded in the audit log.')) return;
  if (notice) {
    notice.textContent = '';
    notice.style.color = '#8b949e';
  }
  try {
    const res = await fetch('/api/prompt-center/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, content })
    });
    const data = await res.json();
    if (!res.ok) {
      if (notice) { notice.style.color = '#f85149'; notice.textContent = data.error || 'Save failed'; }
      return;
    }
    if (notice) {
      notice.style.color = '#3fb950';
      notice.textContent = data.backup ? `Saved. Backup: ${data.backup}` : 'Saved.';
    }
    await refreshPromptCenter();
    await openPromptCenterFile(target);
  } catch (e) {
    if (notice) { notice.style.color = '#f85149'; notice.textContent = 'Save error: ' + (e.message || String(e)); }
  }
}

async function refreshPromptCenter() {
  const taskId = currentTaskId ? String(currentTaskId) : '';
  const query = taskId ? `?task_id=${encodeURIComponent(taskId)}` : '';
  const list = document.getElementById('prompt-center-list');
  const intro = document.getElementById('prompt-center-intro');
  const scope = document.getElementById('prompt-center-scope');
  if (list) list.innerHTML = '<div style="padding:10px;color:#8b949e;font-size:12px">Loading prompts...</div>';

  try {
    const res = await fetch(`/api/prompt-center${query}`);
    const data = await res.json();
    if (!res.ok) {
      if (list) list.innerHTML = `<div style="padding:10px;color:#f85149;font-size:12px">${escapeHtml(data.error || 'Failed to load prompt center')}</div>`;
      return;
    }
    if (intro) intro.textContent = data.intro || '';
    if (scope) {
      scope.textContent = data.task_id
        ? `Runtime scope: task ${data.task_id}${taskId && data.task_id !== taskId ? ` (fallback from selected ${taskId})` : ''}`
        : 'Runtime scope: no task run artifacts detected yet.';
    }
    const entries = Array.isArray(data.entries) ? data.entries : [];
    window._promptCenterEntries = entries;
    if (!promptCenterSelectedTarget || !entries.some((e) => e.target === promptCenterSelectedTarget)) {
      promptCenterSelectedTarget = entries[0]?.target || '';
    }
    renderPromptCenterEntryList(entries);
    if (promptCenterSelectedTarget) {
      await openPromptCenterFile(promptCenterSelectedTarget);
    } else {
      const titleEl = document.getElementById('prompt-center-title');
      const metaEl = document.getElementById('prompt-center-meta');
      const contentEl = document.getElementById('prompt-center-editor');
      if (titleEl) titleEl.textContent = 'No file selected';
      if (metaEl) metaEl.textContent = '';
      if (contentEl) contentEl.value = '';
    }
  } catch (e) {
    if (list) list.innerHTML = `<div style="padding:10px;color:#f85149;font-size:12px">Load failed: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

function renderPromptCenterPanel() {
  const wrap = document.getElementById('prompts-panel');
  if (!wrap) return;
  wrap.innerHTML = `
    <div style="padding:16px">
      <h2 style="margin:0 0 8px">Prompt Center</h2>
      <div id="prompt-center-intro" style="font-size:13px;color:#8b949e;line-height:1.45;margin-bottom:8px"></div>
      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div id="prompt-center-scope" style="font-size:12px;color:#8b949e"></div>
        <div style="display:flex;gap:8px">
          <button type="button" class="btn" onclick="promptCenterSelectedTarget='';refreshPromptCenter()">Reload</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:minmax(300px,36%) 1fr;gap:12px;min-height:calc(100vh - 240px);align-items:start">
        <div style="border:1px solid #30363d;border-radius:8px;overflow:auto;background:#0d1117;max-height:calc(100vh - 240px)">
          <div id="prompt-center-list"></div>
        </div>
        <div style="border:1px solid #30363d;border-radius:8px;padding:12px;background:#0d1117;display:flex;flex-direction:column;min-height:0;position:sticky;top:12px;max-height:calc(100vh - 240px)">
          <div id="prompt-center-title" style="font-size:14px;font-weight:600;margin-bottom:4px">No file selected</div>
          <div id="prompt-center-meta" style="font-size:12px;color:#8b949e;margin-bottom:8px;word-break:break-all"></div>
          <textarea id="prompt-center-editor" class="code-editor" style="flex:1;min-height:260px;width:100%;box-sizing:border-box"></textarea>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:8px">
            <div id="prompt-center-save-notice" style="font-size:12px;min-height:16px;color:#8b949e"></div>
            <button type="button" id="prompt-center-save-btn" class="btn btn-primary write-action" onclick="savePromptCenterFile()">Save</button>
          </div>
        </div>
      </div>
    </div>`;
  refreshPromptCenter();
  updateReadOnlyBanner();
}

// ================================================================
// Auto-refresh and initialization
// ================================================================

// Auto-refresh sidebar task list every 2 seconds
setInterval(loadTasks, 2000);

// B1-2/B1-3/B1-4: Auto-refresh ONLY current tab's log every 3 seconds (NOT full selectTask)
setInterval(refreshLiveLog, 3000);

// Refresh task meta periodically (separate from log refresh)
setInterval(refreshCurrentTaskMeta, 5000);

// Task list click delegation (survives 2s refresh; works for RUNNING/PAUSED/completed)
(function () {
  const list = document.getElementById('task-list');
  if (!list) return;
      list.addEventListener('click', function (e) {
        if (e.target.closest('button.write-action')) return;
        const row = e.target.closest('.task-item');
        if (!row) return;
        const taskId = row.dataset.taskId;
        if (taskId) {
          switchView('tasks');
          selectTask(taskId);
        }
      });
  
})();

// ── Solo Progress Panel ──────────────────────────────────────────────────────
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
      const isGoalMet = step.self_eval === 'goal_met';
      const isPartial = step.self_eval === 'partial' || step.self_eval === 'progress';
      const isFailed = step.self_eval === 'dead_loop';
      const isInProgress = !step.has_response;
      let icon = '\u25CB'; let color = '#8b949e';
      if (isGoalMet) { icon = '\u2713'; color = '#3fb950'; }
      else if (isPartial) { icon = '\u25D0'; color = '#d29922'; }
      else if (isFailed) { icon = '\u2717'; color = '#f85149'; }
      else if (isInProgress) { icon = '\u25CF'; color = '#58a6ff'; }
      html += '<div style="margin-bottom:12px;padding:8px;border-left:3px solid ' + color + ';padding-left:12px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center">';
      html += '<strong style="color:' + color + '">' + icon + ' Step ' + (step.step + 1) + '/' + data.max_iterations + '</strong>';
      if (step.self_eval) html += '<span style="font-size:11px;color:#8b949e">' + escapeHtml(step.self_eval) + (step.confidence ? ' (' + Math.round(step.confidence * 100) + '%)' : '') + '</span>';
      html += '</div>';
      if (step.summary) html += '<div style="font-size:12px;margin-top:4px;color:#c9d1d9">' + escapeHtml(step.summary.slice(0, 300)) + '</div>';
      if (step.test_result) {
        const t = step.test_result;
        html += '<div style="font-size:11px;margin-top:4px;color:#8b949e">Tests: ' + (t.passed || 0) + '/' + (t.total || 0) + ' pass</div>';
      }
      if (step.files_modified && step.files_modified.length > 0) {
        html += '<div style="font-size:11px;margin-top:4px;color:#8b949e">Files: ' + step.files_modified.map(f => escapeHtml(f)).join(', ') + '</div>';
      }
      html += '</div>';
    }
    html += '<div style="display:flex;gap:8px;margin-top:12px">';
    html += '<button class="btn btn-danger write-action" style="font-size:12px" onclick="abortSoloAgent(\'' + escapeHtml(taskId) + '\',' + attemptNum + ')">Abort</button>';
    html += '<button class="btn write-action" style="font-size:12px" onclick="proceedSoloStep(\'' + escapeHtml(taskId) + '\',' + attemptNum + ')">Proceed</button>';
    html += '</div></div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div style="color:#f85149;font-size:12px">Failed to load solo progress: ' + escapeHtml(e?.message || 'unknown') + '</div>';
  }
}

async function abortSoloAgent(taskId, attemptNum) {
  if (!confirm('Abort the solo agent? This will terminate the current run.')) return;
  try {
    await fetch('/api/task/' + encodeURIComponent(taskId) + '/attempt/' + attemptNum + '/solo-abort', { method: 'POST' });
    showFlash && showFlash('Solo agent abort signal sent', 'info');
  } catch (e) {
    alert('Failed to abort: ' + (e?.message || ''));
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
    showFlash && showFlash('Proceed signal sent', 'info');
  } catch (e) {
    alert('Failed: ' + (e?.message || ''));
  }
}

// ── Knowledge Viewer Modal ───────────────────────────────────────────────────
let currentKnowledgeShard = null;
let currentKnowledgePath = '';

function knowledgePathQuery() {
  return currentKnowledgePath ? ('?path=' + encodeURIComponent(currentKnowledgePath)) : '';
}

function openKnowledgeViewerFromTaskModal() {
  const kp = (document.getElementById('modal-knowledge-project')?.value || '').trim();
  openKnowledgeViewer(kp).catch(() => {});
}

async function openKnowledgeViewer(pathOverride) {
  currentKnowledgePath = (pathOverride || '').trim();
  currentKnowledgeShard = null;
  const old = document.getElementById('knowledge-modal');
  if (old) old.remove();
  const modalHtml = `
    <div id="knowledge-modal" class="modal-overlay" onclick="if(event.target===this)closeKnowledgeViewer()">
      <div class="modal-box" style="max-width:900px;max-height:90vh;overflow:hidden;display:flex;flex-direction:column">
        <h3 style="margin-top:0;flex-shrink:0">Knowledge Viewer</h3>
        <div style="font-size:12px;color:#8b949e;margin-top:-6px;margin-bottom:8px">Path: <code>${escapeHtml(currentKnowledgePath || '(default project knowledge path)')}</code></div>
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
    const data = await api('/knowledge/shards' + knowledgePathQuery());
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
  await loadKnowledgeShardList();
  const panel = document.getElementById('knowledge-entry-panel');
  if (!panel) return;
  panel.innerHTML = '<div style="color:#8b949e;font-size:12px">Loading...</div>';
  try {
    const data = await api('/knowledge/shards/' + encodeURIComponent(name) + knowledgePathQuery());
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
    await fetch('/api/knowledge/shards' + knowledgePathQuery(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: desc, path: currentKnowledgePath }) });
    await loadKnowledgeShardList();
    selectKnowledgeShard(name);
  } catch (e) { alert(e?.message || 'Failed'); }
}

async function deleteKnowledgeShard(name) {
  if (!confirm('Delete shard "'+name+'" and all its entries?')) return;
  try {
    await fetch('/api/knowledge/shards/' + encodeURIComponent(name) + knowledgePathQuery(), { method: 'DELETE' });
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
    await fetch('/api/knowledge/shards/' + encodeURIComponent(shardName) + '/entries/' + encodeURIComponent(key) + knowledgePathQuery(), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, summary, written_by: 'manual', last_modified_at: new Date().toISOString(), path: currentKnowledgePath })
    });
    selectKnowledgeShard(shardName);
  } catch (e) { alert(e?.message || 'Failed'); }
}

async function editKnowledgeEntry(shardName, key) {
  const data = await api('/knowledge/shards/' + encodeURIComponent(shardName) + knowledgePathQuery());
  const entry = (data.entries || {})[key];
  if (!entry) { alert('Entry not found'); return; }
  const summary = prompt('Edit summary:', entry.summary || '');
  if (summary === null) return;
  entry.summary = summary;
  entry.last_modified_at = new Date().toISOString();
  try {
    await fetch('/api/knowledge/shards/' + encodeURIComponent(shardName) + '/entries/' + encodeURIComponent(key) + knowledgePathQuery(), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...entry, path: currentKnowledgePath })
    });
    selectKnowledgeShard(shardName);
  } catch (e) { alert(e?.message || 'Failed'); }
}

async function deleteKnowledgeEntry(shardName, key) {
  if (!confirm('Delete entry "'+key+'"?')) return;
  try {
    await fetch('/api/knowledge/shards/' + encodeURIComponent(shardName) + '/entries/' + encodeURIComponent(key) + knowledgePathQuery(), { method: 'DELETE' });
    selectKnowledgeShard(shardName);
  } catch (e) { alert(e?.message || 'Failed'); }
}

// ── v5.0 Panels: Git Status, Knowledge Debt, Loop Stats ───────────────────

async function renderGitStatusPanel(taskId) {
  const container = document.getElementById('git-status-panel');
  if (!container) return;
  try {
    const data = await api(`/task/${encodeURIComponent(taskId)}/git-status`);
    let html = `<h4 style="margin:0 0 8px">Git Status: ${escapeHtml(taskId)}</h4>`;
    if (data.branches && data.branches.length > 0) {
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left;padding:4px;border-bottom:1px solid #30363d">Branch</th><th style="text-align:left;padding:4px;border-bottom:1px solid #30363d">Status</th></tr></thead><tbody>';
      for (const w of (data.workers || [])) {
        const statusColor = w.status === 'merged' ? '#3fb950' : w.status === 'changes_requested' ? '#f85149' : '#d29922';
        html += `<tr><td style="padding:4px;border-bottom:1px solid #21262d;font-family:monospace">${escapeHtml(w.branch)}</td><td style="padding:4px;border-bottom:1px solid #21262d"><span style="color:${statusColor}">${escapeHtml(w.status)}</span></td></tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += '<div style="color:#8b949e;font-size:12px">No git branches found for this task.</div>';
    }
    if (data.contract_check) {
      html += `<div style="margin-top:8px"><strong>Contract Check:</strong> <span style="color:${data.contract_check.pass ? '#3fb950' : '#f85149'}">${data.contract_check.pass ? 'PASS' : 'FAIL'}</span></div>`;
    }
    if (data.judge_scores) {
      html += '<div style="margin-top:8px"><strong>Judge Scores:</strong><pre style="font-size:11px;background:#0d1117;padding:8px;border-radius:4px;overflow-x:auto">' + escapeHtml(JSON.stringify(data.judge_scores, null, 2)) + '</pre></div>';
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div style="color:#f85149;font-size:12px">Git status unavailable: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

async function renderKnowledgeDebtPanel() {
  const container = document.getElementById('knowledge-debt-panel');
  if (!container) return;
  try {
    const data = await api('/knowledge/shards/debt');
    let html = '<h4 style="margin:0 0 8px">Knowledge Debt</h4>';
    if (data.total === 0 || !data.entries || Object.keys(data.entries).length === 0) {
      html += '<div style="color:#8b949e;font-size:12px">No debt entries found.</div>';
    } else {
      html += `<div style="font-size:12px;color:#8b949e;margin-bottom:8px">${data.total} entries total</div>`;
      // Show by severity
      if (data.by_severity) {
        for (const [sev, entries] of Object.entries(data.by_severity)) {
          const sevColor = sev === 'high' ? '#f85149' : sev === 'medium' ? '#d29922' : '#8b949e';
          html += `<div style="margin-bottom:8px"><strong style="color:${sevColor}">${escapeHtml(sev)}</strong> (${entries.length})`;
          html += '<ul style="margin:4px 0;padding-left:16px;font-size:12px">';
          for (const e of entries) {
            html += `<li><code>${escapeHtml(e.key)}</code>: ${escapeHtml(e.summary || e.description || '(no summary)')}</li>`;
          }
          html += '</ul></div>';
        }
      }
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div style="color:#8b949e;font-size:12px">No debt data available.</div>`;
  }
}

async function renderLoopStatsPanel() {
  const container = document.getElementById('loop-stats-panel');
  if (!container) return;
  try {
    const data = await api('/loop-stats');
    let html = '<h4 style="margin:0 0 8px">Loop Stats</h4>';
    if (!data.stats || data.stats.length === 0) {
      html += '<div style="color:#8b949e;font-size:12px">No loop stats recorded yet.</div>';
    } else {
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left;padding:4px;border-bottom:1px solid #30363d">Loop ID</th><th style="text-align:left;padding:4px;border-bottom:1px solid #30363d">Tasks</th><th style="text-align:left;padding:4px;border-bottom:1px solid #30363d">Attempts</th><th style="text-align:left;padding:4px;border-bottom:1px solid #30363d">Completed</th></tr></thead><tbody>';
      for (const s of data.stats) {
        const tasks = s.task_attempts || [];
        for (const t of tasks) {
          html += `<tr><td style="padding:4px;border-bottom:1px solid #21262d;font-family:monospace">${escapeHtml(s.loop_id || '')}</td><td style="padding:4px;border-bottom:1px solid #21262d">${escapeHtml(t.task_id || '')}</td><td style="padding:4px;border-bottom:1px solid #21262d">${t.actual_attempts || 0} / ${t.max_attempts || '?'}</td><td style="padding:4px;border-bottom:1px solid #21262d">${escapeHtml(s.completed_at || '')}</td></tr>`;
        }
        if (tasks.length === 0) {
          html += `<tr><td style="padding:4px;border-bottom:1px solid #21262d;font-family:monospace">${escapeHtml(s.loop_id || '')}</td><td colspan="3" style="padding:4px;border-bottom:1px solid #21262d;color:#8b949e">No task data</td></tr>`;
        }
      }
      html += '</tbody></table>';
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div style="color:#8b949e;font-size:12px">Loop stats unavailable.</div>`;
  }
}

let simulatorSelectedRunId = null;
let simulatorSelectedFilePath = '';
let simulatorRunCache = [];
let simulatorDetailOpenStateByRun = {};

function captureSimulatorDetailOpenState() {
  const root = document.getElementById('sim-run-detail');
  if (!root || !simulatorSelectedRunId) return;
  const state = {};
  root.querySelectorAll('details[data-sim-key]').forEach(el => {
    const key = el.dataset.simKey;
    if (!key) return;
    state[key] = !!el.open;
  });
  simulatorDetailOpenStateByRun[simulatorSelectedRunId] = state;
}

function simulatorDetailOpenAttr(state, key, defaultOpen) {
  const has = Object.prototype.hasOwnProperty.call(state || {}, key);
  const isOpen = has ? !!state[key] : !!defaultOpen;
  return isOpen ? 'open' : '';
}

function bindSimulatorDetailInteractions() {
  const root = document.getElementById('sim-run-detail');
  if (!root || root.dataset.simBound === '1') return;
  root.dataset.simBound = '1';
  root.addEventListener('mouseenter', () => {
    simulatorDetailHovering = true;
  });
  root.addEventListener('mouseleave', () => {
    simulatorDetailHovering = false;
    if (simulatorDetailPendingRefresh) {
      simulatorDetailPendingRefresh = false;
      refreshSimulatorPanelContent(true);
    }
  });
  root.addEventListener('toggle', () => {
    captureSimulatorDetailOpenState();
  }, true);
}

function getSimulatorFormData() {
  return {
    instruction: (document.getElementById('sim-instruction')?.value || '').trim(),
    communication: (document.getElementById('sim-communication')?.value || 'bridge').trim(),
    coder_provider: (document.getElementById('sim-coder-provider')?.value || 'codex').trim(),
    judge_provider: (document.getElementById('sim-judge-provider')?.value || 'codex').trim(),
    session_mode: (document.getElementById('sim-session-mode')?.value || 'continuous').trim(),
    max_attempts: parseInt(document.getElementById('sim-max-attempts')?.value || '1', 10) || 1,
    coder_timeout_seconds: parseInt(document.getElementById('sim-coder-timeout')?.value || '180', 10) || 180,
    judge_timeout_seconds: parseInt(document.getElementById('sim-judge-timeout')?.value || '120', 10) || 120,
    test_timeout_seconds: parseInt(document.getElementById('sim-test-timeout')?.value || '60', 10) || 60,
    test_cmd: (document.getElementById('sim-test-cmd')?.value || 'true').trim() || 'true'
  };
}

function simulatorSetMessage(msg, color) {
  const notice = document.getElementById('sim-run-notice');
  if (!notice) return;
  notice.textContent = msg || '';
  notice.style.color = color || '#8b949e';
}

async function renderSimulatorPanel() {
  const wrap = document.getElementById('simulator-panel');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="sim-panel-header">
      <h2 style="margin:0">Coordinator Simulator</h2>
      <span class="sim-panel-note">Runs in isolated folder: <code>Rdloop/Coordinator Simulator/</code></span>
    </div>

    <div id="sim-run-notice" style="font-size:12px;color:#8b949e;margin-bottom:8px"></div>

    <div class="sim-form">
      <div class="sim-form-row sim-span-2">
        <label class="form-label">Instruction</label>
        <textarea id="sim-instruction" class="code-editor" style="min-height:90px" placeholder="Describe the instruction to send into the real coordinator..."></textarea>
      </div>
      <div class="sim-form-row">
        <label class="form-label">Communication</label>
        <select id="sim-communication" class="form-select">
          <option value="bridge" selected>Bridge</option>
          <option value="ccb">CCB</option>
        </select>
      </div>
      <div class="sim-form-row">
        <label class="form-label">Session Mode</label>
        <select id="sim-session-mode" class="form-select">
          <option value="continuous" selected>continuous</option>
          <option value="iterative">iterative</option>
          <option value="fresh">fresh</option>
        </select>
      </div>
      <div class="sim-form-row">
        <label class="form-label">Coder Adapter</label>
        <select id="sim-coder-provider" class="form-select">
          <option value="codex" selected>codex</option>
          <option value="claude">claude</option>
          <option value="gemini">gemini</option>
          <option value="opencode">opencode</option>
          <option value="droid">droid</option>
          <option value="cursor">cursor</option>
        </select>
      </div>
      <div class="sim-form-row">
        <label class="form-label">Judge Adapter</label>
        <select id="sim-judge-provider" class="form-select">
          <option value="codex" selected>codex</option>
          <option value="claude">claude</option>
          <option value="gemini">gemini</option>
          <option value="opencode">opencode</option>
          <option value="droid">droid</option>
          <option value="cursor">cursor</option>
        </select>
      </div>
      <div class="sim-form-row">
        <label class="form-label">Max Attempts</label>
        <input id="sim-max-attempts" class="form-input" type="number" min="1" max="6" value="1">
      </div>
      <div class="sim-form-row">
        <label class="form-label">Coder Timeout (s)</label>
        <input id="sim-coder-timeout" class="form-input" type="number" min="15" max="3600" value="180">
      </div>
      <div class="sim-form-row">
        <label class="form-label">Judge Timeout (s)</label>
        <input id="sim-judge-timeout" class="form-input" type="number" min="15" max="3600" value="120">
      </div>
      <div class="sim-form-row">
        <label class="form-label">Test Timeout (s)</label>
        <input id="sim-test-timeout" class="form-input" type="number" min="5" max="1200" value="60">
      </div>
      <div class="sim-form-row sim-span-2">
        <label class="form-label">test_cmd</label>
        <input id="sim-test-cmd" class="form-input" type="text" value="true">
      </div>
      <div class="sim-form-row sim-span-2" style="display:flex;gap:8px">
        <button type="button" class="btn btn-primary write-action" onclick="startCoordinatorSimulation(event)">Run Simulator</button>
        <button type="button" class="btn write-action" onclick="refreshSimulatorPanelContent(true)">Refresh</button>
      </div>
    </div>

    <div class="sim-body">
      <div id="sim-runs-list" class="sim-card"><div style="color:#8b949e;font-size:12px">Loading runs...</div></div>
      <div id="sim-run-detail" class="sim-card"><div style="color:#8b949e;font-size:12px">Select a run.</div></div>
    </div>
  `;
  updateReadOnlyBanner();
  bindSimulatorDetailInteractions();
  await refreshSimulatorPanelContent(true);
}

async function startCoordinatorSimulation(event) {
  const btn = event?.currentTarget;
  setButtonLoading(btn, true);
  const payload = getSimulatorFormData();
  if (!payload.instruction) {
    simulatorSetMessage('Instruction is required.', '#f85149');
    setButtonLoading(btn, false);
    return;
  }
  simulatorSetMessage('Launching coordinator simulator run...', '#8b949e');
  try {
    const res = await fetch('/api/coordinator-simulator/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      simulatorSetMessage(data.error || 'Failed to start simulator run.', '#f85149');
      return;
    }
    simulatorSelectedRunId = data.run_id;
    simulatorSelectedFilePath = '';
    simulatorSetMessage(`Started ${data.run_id} (task_id=${data.task_id}, pid=${data.pid}).`, '#3fb950');
    await refreshSimulatorPanelContent(true);
  } catch (e) {
    simulatorSetMessage('Request failed: ' + (e?.message || String(e)), '#f85149');
  } finally {
    setButtonLoading(btn, false);
  }
}

function renderSimulatorRunsList(runs) {
  const listWrap = document.getElementById('sim-runs-list');
  if (!listWrap) return;
  if (!Array.isArray(runs) || runs.length === 0) {
    listWrap.innerHTML = '<h3 style="margin-top:0">Runs</h3><div style="color:#8b949e;font-size:12px">No simulator runs yet.</div>';
    return;
  }
  const html = runs.map(r => {
    const active = r.run_id === simulatorSelectedRunId;
    const state = r.state || 'UNKNOWN';
    const badgeCls = state === 'RUNNING' ? 'badge-running' : (state === 'PAUSED' ? 'badge-paused' : (state === 'READY_FOR_REVIEW' ? 'badge-ready' : 'badge-failed'));
    const runIdArg = JSON.stringify(String(r.run_id || ''));
    return `
      <div class="sim-run-item ${active ? 'active' : ''}" onclick="selectSimulatorRun('${escapeHtml(r.run_id)}')">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <strong style="font-size:12px">${escapeHtml(r.run_id)}</strong>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="badge ${badgeCls}">${escapeHtml(state)}</span>
            <button type="button" class="btn btn-danger sim-run-delete write-action" title="Delete run"
              onclick='deleteSimulatorRun(${runIdArg}, event)'>Delete</button>
          </div>
        </div>
        <div style="font-size:11px;color:#8b949e;margin-top:4px">${escapeHtml(r.communication || '')} · coder=${escapeHtml(r.coder_provider || '')} · judge=${escapeHtml(r.judge_provider || '')}</div>
        <div style="font-size:11px;color:#8b949e;margin-top:2px">${escapeHtml((r.created_at || '').replace('T', ' ').replace('Z', ''))}</div>
      </div>`;
  }).join('');
  listWrap.innerHTML = `<h3 style="margin-top:0">Runs</h3>${html}`;
}

function renderSimulatorFileTree(fileTree) {
  const rows = (Array.isArray(fileTree) ? fileTree : []).slice(0, 400).map(f => {
    const isDir = f.type === 'dir';
    const clickable = !isDir;
    const selected = !isDir && simulatorSelectedFilePath === String(f.path) ? ' sim-file-selected' : '';
    const size = isDir ? '' : ` (${escapeHtml(String(f.size || 0))} bytes)`;
    const open = clickable
      ? `<button type="button" class="btn" style="padding:2px 8px;font-size:11px" onclick='openSimulatorFile(${JSON.stringify(String(f.path))})'>Open</button>`
      : '';
    return `<tr class="${selected}">
      <td style="padding:4px;border-bottom:1px solid #21262d;font-family:monospace;font-size:11px">${escapeHtml(String(f.path))}${size}</td>
      <td style="padding:4px;border-bottom:1px solid #21262d;width:70px">${open}</td>
    </tr>`;
  }).join('');
  const viewerDefault = simulatorSelectedFilePath
    ? 'Loading selected file...'
    : 'Select a file from the list to view contents.';
  return `
    <div class="sim-file-split">
      <pre id="sim-file-viewer" class="sim-file-viewer">${escapeHtml(viewerDefault)}</pre>
      <div class="sim-file-list">
        ${rows
          ? `<table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>${rows}</tbody></table>`
          : '<div style="color:#8b949e;font-size:12px">No files yet.</div>'}
      </div>
    </div>`;
}

function renderSimulatorAttempts(attempts, detailOpenState) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return '<div style="color:#8b949e;font-size:12px">No attempts yet.</div>';
  }
  return attempts.map(a => {
    const dispatch = (a.coder_dispatch_lines || []).map(line => `<div>${escapeHtml(line)}</div>`).join('');
    const attemptKey = `attempt-${a.attempt || 0}`;
    const attemptOpen = simulatorDetailOpenAttr(detailOpenState, attemptKey, false);
    return `
      <details class="sim-attempt" data-sim-key="${escapeHtml(attemptKey)}" ${attemptOpen}>
        <summary>Attempt ${escapeHtml(String(a.attempt || 0))}</summary>
        <div style="font-size:12px;color:#8b949e;margin-top:6px">worktree: <code>${escapeHtml(a.worktree_path || '(not created yet)')}</code></div>
        ${a.files?.prompt ? `<div style="margin-top:6px"><button type="button" class="btn" style="padding:2px 8px;font-size:11px" onclick="openSimulatorFile('${escapeHtml(a.files.prompt)}')">Open prompt.txt</button></div>` : ''}
        ${a.files?.evidence ? `<div style="margin-top:6px"><button type="button" class="btn" style="padding:2px 8px;font-size:11px" onclick="openSimulatorFile('${escapeHtml(a.files.evidence)}')">Open evidence.json</button></div>` : ''}
        ${dispatch ? `<div style="margin-top:8px"><strong>Adapter dispatch</strong><div style="font-size:11px;margin-top:4px">${dispatch}</div></div>` : ''}
        ${a.coder_prompt ? `<div style="margin-top:8px"><strong>Prompt Handoff</strong><pre>${escapeHtml(a.coder_prompt)}</pre></div>` : ''}
        ${a.solo_request ? `<div style="margin-top:8px"><strong>Bridge Request</strong><pre>${escapeHtml(a.solo_request)}</pre></div>` : ''}
        ${a.coder_run_log_tail ? `<div style="margin-top:8px"><strong>Coder Log (tail)</strong><pre>${escapeHtml(a.coder_run_log_tail)}</pre></div>` : ''}
        ${a.judge_run_log_tail ? `<div style="margin-top:8px"><strong>Judge Log (tail)</strong><pre>${escapeHtml(a.judge_run_log_tail)}</pre></div>` : ''}
      </details>`;
  }).join('');
}

async function openSimulatorFile(relPath) {
  if (!simulatorSelectedRunId || !relPath) return;
  simulatorSelectedFilePath = relPath;
  const panel = document.getElementById('sim-file-viewer');
  if (panel) panel.textContent = 'Loading...';
  try {
    const data = await api(`/coordinator-simulator/runs/${encodeURIComponent(simulatorSelectedRunId)}/file?path=${encodeURIComponent(relPath)}`);
    const content = data.content || '';
    const meta = `${relPath} (${data.size || 0} bytes${data.truncated ? ', truncated tail' : ''})`;
    if (panel) panel.textContent = `${meta}\n\n${content}`;
  } catch (e) {
    if (panel) panel.textContent = 'Failed to load file: ' + (e?.message || String(e));
  }
}

async function stopSimulatorRun(event) {
  const btn = event?.currentTarget;
  if (!simulatorSelectedRunId) return;
  setButtonLoading(btn, true);
  try {
    const res = await fetch(`/api/coordinator-simulator/runs/${encodeURIComponent(simulatorSelectedRunId)}/stop`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      simulatorSetMessage(data.error || 'Stop failed.', '#f85149');
      return;
    }
    simulatorSetMessage(data.stopped ? `Sent SIGTERM to pid ${data.pid}.` : (data.message || 'Not running.'), '#d29922');
    await refreshSimulatorPanelContent(true);
  } catch (e) {
    simulatorSetMessage('Stop failed: ' + (e?.message || String(e)), '#f85149');
  } finally {
    setButtonLoading(btn, false);
  }
}

async function deleteSimulatorRun(runId, event) {
  if (event) event.stopPropagation();
  const targetRunId = (runId || simulatorSelectedRunId || '').trim();
  if (!targetRunId) return;
  if (!confirm(`Delete simulator run ${targetRunId}? This removes its sandbox files.`)) return;
  try {
    const res = await fetch(`/api/coordinator-simulator/runs/${encodeURIComponent(targetRunId)}`, {
      method: 'DELETE'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      simulatorSetMessage(data.error || 'Delete failed.', '#f85149');
      return;
    }
    if (simulatorSelectedRunId === targetRunId) {
      simulatorSelectedRunId = null;
      simulatorSelectedFilePath = '';
      delete simulatorDetailOpenStateByRun[targetRunId];
    }
    simulatorSetMessage(`Deleted ${targetRunId}.`, '#d29922');
    await refreshSimulatorPanelContent(true);
  } catch (e) {
    simulatorSetMessage('Delete failed: ' + (e?.message || String(e)), '#f85149');
  }
}

function selectSimulatorRun(runId) {
  simulatorSelectedRunId = runId;
  simulatorSelectedFilePath = '';
  refreshSimulatorPanelContent(true);
}

async function refreshSimulatorPanelContent(force = false) {
  const wrap = document.getElementById('simulator-panel');
  if (!wrap || wrap.style.display !== 'block') return;
  try {
    captureSimulatorDetailOpenState();
    const runsRes = await api('/coordinator-simulator/runs');
    simulatorRunCache = Array.isArray(runsRes.runs) ? runsRes.runs : [];
    if (!simulatorSelectedRunId && simulatorRunCache.length > 0) {
      simulatorSelectedRunId = simulatorRunCache[0].run_id;
    } else if (simulatorSelectedRunId && !simulatorRunCache.some(r => r.run_id === simulatorSelectedRunId)) {
      simulatorSelectedRunId = simulatorRunCache[0]?.run_id || null;
    }
    renderSimulatorRunsList(simulatorRunCache);
    const detailWrap = document.getElementById('sim-run-detail');
    if (!simulatorSelectedRunId) {
      if (detailWrap) detailWrap.innerHTML = '<h3 style="margin-top:0">Run Detail</h3><div style="color:#8b949e;font-size:12px">No run selected.</div>';
      return;
    }
    if (!force && simulatorDetailHovering) {
      simulatorDetailPendingRefresh = true;
      return;
    }
    const detail = await api(`/coordinator-simulator/runs/${encodeURIComponent(simulatorSelectedRunId)}`);
    const status = detail.status || {};
    const run = detail.run || {};
    const detailOpenState = simulatorDetailOpenStateByRun[simulatorSelectedRunId] || {};
    const behaviorRows = (detail.behavior_summary || []).slice(-100).map(b => `<li><code>${escapeHtml(b.type || '')}</code> ${escapeHtml(b.detail || '')}</li>`).join('');
    const eventsTail = (detail.events || []).slice(-80).map(ev => `<tr>
      <td style="padding:4px;border-bottom:1px solid #21262d;font-family:monospace;font-size:11px">${escapeHtml(ev.ts || '')}</td>
      <td style="padding:4px;border-bottom:1px solid #21262d">${escapeHtml(ev.type || '')}</td>
      <td style="padding:4px;border-bottom:1px solid #21262d">${escapeHtml(ev.summary || '')}</td>
    </tr>`).join('');
    detailWrap.innerHTML = `
      <h3 style="margin-top:0;display:flex;justify-content:space-between;align-items:center">
        <span>Run Detail: ${escapeHtml(simulatorSelectedRunId)}</span>
        <div style="display:flex;gap:8px">
          <button type="button" class="btn btn-danger write-action" onclick="stopSimulatorRun(event)">Stop</button>
          <button type="button" class="btn btn-danger write-action" onclick='deleteSimulatorRun(${JSON.stringify(String(simulatorSelectedRunId))}, event)'>Delete</button>
        </div>
      </h3>
      <div style="font-size:12px;margin-bottom:8px">
        <div>state: <strong>${escapeHtml(status.state || 'UNKNOWN')}</strong> · attempt ${escapeHtml(String(status.current_attempt || 0))}/${escapeHtml(String(status.max_attempts || '-'))}</div>
        <div>task_id: <code>${escapeHtml(run.task_id || '')}</code> · communication: <code>${escapeHtml(run.communication || '')}</code></div>
        <div>sandbox: <code>${escapeHtml(run.sandbox_root || '')}</code></div>
      </div>

      <details class="sim-section" data-sim-key="section-behaviors" ${simulatorDetailOpenAttr(detailOpenState, 'section-behaviors', true)}>
        <summary>Coordinator Behaviors (Derived + Raw)</summary>
        <ul style="font-size:12px;padding-left:18px;margin-top:8px">${behaviorRows || '<li>(none yet)</li>'}</ul>
        <div style="margin-top:8px">
          <strong>events.jsonl tail</strong>
          <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px"><tbody>${eventsTail || '<tr><td style="padding:4px;color:#8b949e">No events yet.</td></tr>'}</tbody></table>
        </div>
      </details>

      <details class="sim-section" data-sim-key="section-attempts" ${simulatorDetailOpenAttr(detailOpenState, 'section-attempts', true)}>
        <summary>Attempts, Handoff, Adapter Dispatch</summary>
        ${renderSimulatorAttempts(detail.attempts || [], detailOpenState)}
      </details>

      <details class="sim-section" data-sim-key="section-runtime-log" ${simulatorDetailOpenAttr(detailOpenState, 'section-runtime-log', false)}>
        <summary>Coordinator Runtime Log</summary>
        <pre>${escapeHtml(detail.coordinator_log_tail || '(empty)')}</pre>
      </details>

      <details class="sim-section" data-sim-key="section-files" ${simulatorDetailOpenAttr(detailOpenState, 'section-files', false)}>
        <summary>Generated Files</summary>
        ${renderSimulatorFileTree(detail.file_tree || [])}
      </details>
    `;
    bindSimulatorDetailInteractions();
    if (simulatorSelectedFilePath) {
      openSimulatorFile(simulatorSelectedFilePath);
    }
  } catch (e) {
    const detailWrap = document.getElementById('sim-run-detail');
    if (detailWrap) detailWrap.innerHTML = `<div style="color:#f85149;font-size:12px">Failed to refresh simulator data: ${escapeHtml(e?.message || String(e))}</div>`;
  }
}

// Initial load (K7-1: load health for read_only first so banner and button state are correct)
loadHealth().then(() => {
  loadTasks();
  loadTaskSpecs();
  updateReadOnlyBanner();
  document.getElementById('btn-settings')?.addEventListener('click', openSettingsPanel);
  document.getElementById('nav-tasks')?.addEventListener('click', () => switchView('tasks'));
  document.getElementById('nav-prompts')?.addEventListener('click', () => switchView('prompts'));
  document.getElementById('nav-ccb')?.addEventListener('click', () => switchView('ccb'));
  document.getElementById('nav-simulator')?.addEventListener('click', () => switchView('simulator'));
});
