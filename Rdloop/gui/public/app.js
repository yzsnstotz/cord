// rdloop GUI — Frontend Application
// B1: Live Panel with tab persistence, etag/304 no-flash refresh
// A2: TaskSpec CRUD (new/copy/delete/edit)
// A4: task_type selector + rubric_thresholds config
// A5: Adapter healthcheck selector
// B3: Attempt API fixed field set
// E2: XSS prevention — all dynamic DOM insertion uses escapeHtml

let currentTaskId = null;
let currentAttempt = null;

// B1-1: activeTab persisted in sessionStorage
let activeTab = sessionStorage.getItem('rdloop_activeTab') || 'coordinator';

// B1-4: AutoScroll persisted in localStorage
let autoScroll = localStorage.getItem('rdloop_autoScroll') !== 'false';

// B1-2: etag per logName for If-None-Match
let liveLogEtag = {};

// Tab → logName mapping
const TAB_LOG_MAP = {
  coordinator: 'coordinator.log',
  coder: 'coder.log',
  judge: 'judge.log'
};

// ================================================================
// E2: C0-1: XSS prevention — escapeHtml applied to ALL dynamic content
// ================================================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

// Decode JSON-style Unicode escapes (\uXXXX) so coder_output and evidence display correctly
function decodeUnicodeEscapes(str) {
  if (str == null || typeof str !== 'string') return '';
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
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
  return res.json();
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

// P10: Settings panel — agent_root, default_execution_mode, coder/judge defaults; save all at once
let settingsConfigSnapshot = null;

const ALLOWED_ROLE_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode', 'droid'];

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
  const execMode = cfg.default_execution_mode === 'semi-auto' ? 'semi-auto' : 'auto';
  const coderSel = buildAdapterSelector('settings-coder', cfg.default_coder || '', cfg.default_coder_model || '');
  const judgeSel = buildAdapterSelector('settings-judge', cfg.default_judge || '', cfg.default_judge_model || '');

  const rolesHtml = Array.isArray(roles) && roles.length
    ? roles.map(r => {
        const opts = ALLOWED_ROLE_PROVIDERS.map(p => `<option value="${escapeHtml(p)}" ${r.provider === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');
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
          <label class="form-label">Default execution mode</label>
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
            <label style="cursor:pointer;font-size:13px">
              <input type="radio" name="settings-exec-mode" value="auto" ${execMode === 'auto' ? 'checked' : ''} onchange="onSettingsExecModeChange()"> auto — 全自动无人介入
            </label>
            <label style="cursor:pointer;font-size:13px">
              <input type="radio" name="settings-exec-mode" value="semi-auto" ${execMode === 'semi-auto' ? 'checked' : ''} onchange="onSettingsExecModeChange()"> semi-auto — 人在回路可观察介入
            </label>
          </div>
          <div id="settings-ccb-hint" style="display:none;margin-top:8px;padding:8px;background:#3d2e00;border:1px solid #9e6a00;border-radius:6px;font-size:12px;color:#d4a012"></div>
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

        <div style="margin-bottom:12px" id="settings-roles-section">
          <label class="form-label">Role configuration (collab_context.md)</label>
          <div id="settings-roles-wrap" style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px;${execMode === 'auto' ? 'opacity:0.6;pointer-events:none' : ''}">${rolesHtml}</div>
          <div id="settings-roles-hint" style="font-size:11px;color:#8b949e;margin-top:4px;display:${execMode === 'auto' ? 'block' : 'none'}">角色配置仅在 semi-auto 模式下生效。</div>
          <button type="button" class="btn write-action" style="margin-top:8px;font-size:12px" onclick="submitAgentRoles()">Save roles</button>
          <span id="settings-roles-msg" style="margin-left:8px;font-size:12px;color:#3fb950"></span>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">Execution channel (v3.3)</label>
          <select id="adapter-settings-channel-type" class="form-select" style="width:auto;margin-bottom:6px" onchange="onSettingsChannelChange()">
            ${CHANNEL_TYPES.map(c => `<option value="${escapeHtml(c.value)}" ${c.value === (inferChannelFromAdapter(cfg.default_coder)) ? 'selected' : ''}>${escapeHtml(c.label)} — ${escapeHtml(c.tag)}</option>`).join('')}
          </select>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div>
            <label class="form-label">Default Coder</label>
            <div id="settings-coder-wrap">${buildAdapterSelector('settings-coder', cfg.default_coder || '', cfg.default_coder_model || '', inferChannelFromAdapter(cfg.default_coder))}</div>
          </div>
          <div>
            <label class="form-label">Default Judge</label>
            <div id="settings-judge-wrap">${buildAdapterSelector('settings-judge', cfg.default_judge || '', cfg.default_judge_model || '', inferChannelFromAdapter(cfg.default_judge))}</div>
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
  onSettingsExecModeChange();
  refreshModelSelector('settings-coder').catch(() => {});
  refreshModelSelector('settings-judge').catch(() => {});
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
    const execMode = s.default_execution_mode === 'semi-auto' ? 'semi-auto' : 'auto';
    document.querySelectorAll('input[name="settings-exec-mode"]').forEach(r => {
      r.checked = r.value === execMode;
    });
    const ch = inferChannelFromAdapter(s.default_coder);
    const channelEl = document.getElementById('adapter-settings-channel-type');
    if (channelEl) channelEl.value = ch;
    const coderWrap = document.getElementById('settings-coder-wrap');
    const judgeWrap = document.getElementById('settings-judge-wrap');
    if (coderWrap) coderWrap.innerHTML = buildAdapterSelector('settings-coder', s.default_coder || '', s.default_coder_model || '', ch);
    if (judgeWrap) judgeWrap.innerHTML = buildAdapterSelector('settings-judge', s.default_judge || '', s.default_judge_model || '', ch);
    const weztermCb = document.getElementById('settings-use-wezterm-for-all');
    if (weztermCb) weztermCb.checked = s.use_wezterm_for_all === true;
    refreshModelSelector('settings-coder').catch(() => {});
    refreshModelSelector('settings-judge').catch(() => {});
  }

  const agentRoot = (document.getElementById('settings-agent-root')?.value ?? '').trim();
  const ccbPath = (document.getElementById('settings-ccb-path')?.value ?? '').trim();
  const execRadios = document.querySelectorAll('input[name="settings-exec-mode"]');
  let default_execution_mode = 'auto';
  for (const r of execRadios) {
    if (r.checked) { default_execution_mode = r.value; break; }
  }
  const default_coder = document.getElementById('adapter-settings-coder')?.value ?? null;
  const default_judge = document.getElementById('adapter-settings-judge')?.value ?? null;
  const default_coder_model = document.getElementById('adapter-settings-coder-model')?.value?.trim() || null;
  const default_judge_model = document.getElementById('adapter-settings-judge-model')?.value?.trim() || null;
  const channelType = document.getElementById('adapter-settings-channel-type')?.value || 'coding-agent-cli';
  const use_wezterm_for_all = document.getElementById('settings-use-wezterm-for-all')?.checked === true;
  let payloadCoder = default_coder || null;
  let payloadJudge = default_judge || null;
  let payloadCoderModel = default_coder_model || null;
  let payloadJudgeModel = default_judge_model || null;
  if (channelType === 'ccb') {
    payloadCoder = 'ccb';
    payloadJudge = 'ccb';
    payloadCoderModel = default_coder || 'codex';
    payloadJudgeModel = default_judge || 'codex';
  }
  const payload = {
    agent_root: agentRoot || '',
    ccb_path: ccbPath || '',
    default_execution_mode,
    default_coder: payloadCoder,
    default_judge: payloadJudge,
    default_coder_model: payloadCoderModel,
    default_judge_model: payloadJudgeModel,
    use_wezterm_for_all,
    knowledge_enabled: document.getElementById('settings-knowledge-enabled')?.checked || false,
    knowledge_provider: document.getElementById('settings-knowledge-provider')?.value || 'codex',
    knowledge_project_path: (document.getElementById('settings-knowledge-project')?.value || '').trim()
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

function switchView(view) {
  const isCcb = view === 'ccb';
  document.getElementById('content').style.display = isCcb ? 'none' : 'block';
  document.getElementById('ccb-panel').style.display = isCcb ? 'block' : 'none';
  document.getElementById('nav-tasks').classList.toggle('active', !isCcb);
  document.getElementById('nav-ccb').classList.toggle('active', isCcb);
  if (isCcb) {
    renderCcbPanel();
    startCcbPanelPolling();
  } else {
    stopCcbPanelPolling();
  }
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
        if (isOff || (!isOn && !isRunning)) {
          primaryBtn = `<button type="button" class="btn btn-primary write-action ccb-card-btn" id="ccb-btn-start-${escapeHtml(p.provider)}" onclick="ccbStartProviders(['${escapeHtml(p.provider)}'])" ${!tmuxOk ? 'disabled' : ''}>Start</button>`;
        } else {
          primaryBtn = `<button type="button" class="btn btn-primary write-action ccb-card-btn" id="ccb-btn-open-${escapeHtml(p.provider)}" onclick="ccbAttachProvider('${escapeHtml(p.provider)}')">Open</button>`;
          secondaryBtn = `<button type="button" class="btn btn-danger write-action ccb-card-btn-sm" id="ccb-btn-stop-${escapeHtml(p.provider)}" onclick="ccbStopProviders(['${escapeHtml(p.provider)}'])" title="Stop ${escapeHtml(p.provider)}">Stop</button>`;
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
  const workDir = (config.ccb_work_dir || config.project_path || '').trim();
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
    if (isOff || (!isOn && !isRunning)) {
      primaryBtn = `<button type="button" class="btn btn-primary write-action ccb-card-btn" id="ccb-btn-start-${escapeHtml(p.provider)}" onclick="ccbStartProviders(['${escapeHtml(p.provider)}'])" ${!tmuxOk ? 'disabled' : ''}>Start</button>`;
    } else {
      primaryBtn = `<button type="button" class="btn btn-primary write-action ccb-card-btn" id="ccb-btn-open-${escapeHtml(p.provider)}" onclick="ccbAttachProvider('${escapeHtml(p.provider)}')">Open</button>`;
      secondaryBtn = `<button type="button" class="btn btn-danger write-action ccb-card-btn-sm" id="ccb-btn-stop-${escapeHtml(p.provider)}" onclick="ccbStopProviders(['${escapeHtml(p.provider)}'])" title="Stop ${escapeHtml(p.provider)}">Stop</button>`;
    }

    return `
      <div class="ccb-card" id="ccb-card-${escapeHtml(p.provider)}">
        <div class="ccb-card-header">
          <span class="ccb-card-status" id="ccb-status-${escapeHtml(p.provider)}">${statusDot}</span>
          <span class="ccb-card-name">${escapeHtml(p.provider)}</span>
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
      <button type="button" class="btn btn-primary write-action" onclick="ccbStartAll()" ${!tmuxOk ? 'disabled' : ''}>Start All</button>
      <button type="button" class="btn btn-danger write-action" onclick="ccbStopAll()">Stop All</button>
      ${ccbInstance.running ? `<button type="button" class="btn btn-danger write-action" onclick="ccbKillInstance()" title="Kill the currently active CCB process (PID ${escapeHtml(String(ccbInstance.pid))})">Kill CCB</button>` : ''}
      ${weztermAvailable ? `<button type="button" class="btn write-action" onclick="ccbOpenWezTermWithConfig()" title="Open all agents in WezTerm">WezTerm</button>` : ''}
      <button type="button" class="btn write-action" onclick="ccbAgentStatus()" title="Run ccb-agent-status.sh (askd, legacy daemons, provider ping)">Agent status</button>
      <span class="ccb-process-info">CCB: ${ccbProcessHtml}</span>
    </div>

    <details class="ccb-config-section">
      <summary>Settings</summary>
      <div class="ccb-config-body">
        <div class="ccb-config-row">
          <label class="form-label">Work Directory</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="ccb-work-dir" class="form-input" value="${escapeHtml(workDir)}" placeholder="${escapeHtml(config.project_path || '/path/to/project')}" style="flex:1">
            <button type="button" class="btn write-action" onclick="saveCcbWorkDir()">Save</button>
          </div>
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
            ${['codex', 'gemini', 'opencode', 'claude', 'droid'].map(p => `<label style="cursor:pointer;font-size:13px"><input type="checkbox" class="ccb-config-cb" data-provider="${escapeHtml(p)}" ${(ccbConfig.providers || []).includes(p) ? 'checked' : ''}> ${escapeHtml(p)}</label>`).join('')}
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

async function ccbStartProviders(providers) {
  const workDir = (document.getElementById('ccb-work-dir')?.value || '').trim();
  const cfg = await api('/config').catch(() => ({}));
  const dir = workDir || (cfg.project_path || '');
  const notice = document.getElementById('ccb-panel-notice');

  // If use_wezterm_for_all is enabled, route through WezTerm instead of tmux
  if (cfg.use_wezterm_for_all) {
    await ccbOpenWezTermAndRun(providers);
    return;
  }

  if (notice) { notice.textContent = 'Starting ' + providers.join(', ') + '... (waiting for session)'; notice.style.color = '#8b949e'; }
  try {
    const res = await fetch('/api/ccb/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers, work_dir: dir || undefined })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (notice) notice.textContent = '';
      alert(data.error || data.hint || 'Start failed');
      return;
    }
    const ids = (data.session_ids || []).join(', ') || providers.join(', ');
    if (notice) {
      notice.textContent = 'Started: ' + ids + (data.hint ? '. ' + data.hint : '');
      notice.style.color = '#3fb950';
      setTimeout(() => { if (notice) notice.textContent = ''; }, 5000);
    }
    // Auto-open terminal if configured
    const hasAttachableSession = Array.isArray(data.session_ids) && data.session_ids.length > 0;
    if (hasAttachableSession && cfg.ccb_auto_open_terminal !== false) {
      const sessionId = (data.session_ids && data.session_ids[0]) || null;
      setTimeout(() => {
        if (sessionId) ccbAttachSession(sessionId);
        else ccbAttachProvider(providers[0]);
      }, 1500);
    }
    // Poll status so cards update
    [2000, 4000, 6000, 8000, 12000, 16000].forEach(ms => setTimeout(refreshCcbPanelContent, ms));
  } catch (e) {
    if (notice) notice.textContent = '';
    alert(e?.message || 'Start failed');
  }
}

async function saveCcbWorkDir() {
  const input = document.getElementById('ccb-work-dir');
  const dir = (input?.value || '').trim();
  const notice = document.getElementById('ccb-panel-notice');
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ccb_work_dir: dir })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (notice) { notice.textContent = data.error || 'Save failed'; notice.style.color = '#f85149'; }
      return;
    }
    if (notice) {
      notice.textContent = 'Work directory saved.';
      notice.style.color = '#3fb950';
      setTimeout(() => { notice.textContent = ''; }, 3000);
    }
  } catch (e) {
    if (notice) { notice.textContent = e?.message || 'Save failed'; notice.style.color = '#f85149'; }
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
  const workDir = (document.getElementById('ccb-work-dir')?.value || '').trim();
  const dir = workDir || (cfg.project_path || '') || undefined;
  const notice = document.getElementById('ccb-panel-notice');
  if (notice) { notice.textContent = 'Opening terminal...'; notice.style.color = '#8b949e'; }
  try {
    const res = await fetch('/api/ccb/session/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ work_dir: dir || undefined, providers: providers || ['codex'] })
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
  const workDir = (document.getElementById('ccb-work-dir')?.value || '').trim();
  const cfg = await api('/config').catch(() => ({}));
  const dir = workDir || (cfg.project_path || '') || undefined;
  const notice = document.getElementById('ccb-panel-notice');
  if (notice) { notice.textContent = 'Opening WezTerm...'; notice.style.color = '#8b949e'; }
  try {
    const res = await fetch('/api/ccb/session/open-wezterm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ work_dir: dir || undefined, providers: providers || ['codex'] })
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
    const terminalMode = last.terminal_mode || 'unknown';
    const prov = (last.providers || []).find(p => p.provider === provider);
    const paneId = prov && prov.pane_id ? encodeURIComponent(prov.pane_id) : '';
    let url = '/api/ccb/session/attach?provider=' + encodeURIComponent(provider);
    if (terminalMode === 'wezterm') {
      url += '&terminal_mode=wezterm';
    } else if (paneId) {
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
      notice.textContent = 'Opening ' + provider + ' terminal...';
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

async function ccbStopProviders(providers, skipRunningCheck) {
  if (!skipRunningCheck) {
    const tasksRes = await api('/tasks?limit=100').catch(() => ({ items: [] }));
    const runningSemi = (tasksRes.items || []).filter(t => t.state === 'RUNNING' && t.execution_mode === 'semi-auto');
    if (runningSemi.length > 0 && !confirm(runningSemi.length + ' semi-auto task(s) running. Stopping will pause them. Continue?')) return;
  }
  try {
    await fetch('/api/ccb/session/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers })
    });
    setTimeout(refreshCcbPanelContent, 1000);
  } catch (e) {
    alert(e?.message || 'Stop failed');
  }
}

async function ccbStopAll() {
  const tasksRes = await api('/tasks?limit=100').catch(() => ({ items: [] }));
  const runningSemi = (tasksRes.items || []).filter(t => t.state === 'RUNNING' && t.execution_mode === 'semi-auto');
  const msg = runningSemi.length > 0
    ? runningSemi.length + ' semi-auto task(s) running. Stopping CCB will pause them. Continue?'
    : 'Stop all CCB sessions?';
  if (!confirm(msg)) return;
  await ccbStopProviders([], true);
}

/** Kill the currently active CCB process (lock-holder). */
async function ccbKillInstance() {
  if (!confirm('Kill the currently active CCB process? This will terminate the CCB daemon (tmux/WezTerm session may remain until closed).')) return;
  const notice = document.getElementById('ccb-panel-notice');
  if (notice) { notice.textContent = 'Killing CCB...'; notice.style.color = '#8b949e'; }
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
async function ccbStartAll() {
  const cfg = await api('/ccb/config').catch(() => ({ providers: [] }));
  const providers = (cfg.providers && cfg.providers.length) ? cfg.providers : ['codex', 'gemini', 'opencode', 'claude'];
  await ccbStartProviders(providers);
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
    return;
  }
  if (document.getElementById('ccb-warn-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'ccb-warn-banner';
  banner.style.cssText = 'padding:10px 16px;background:#d2992233;border-bottom:1px solid #d29922;color:#d29922;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:12px';
  banner.innerHTML = `
    <span>CCB not running — semi-auto tasks need active agent sessions.</span>
    <button type="button" class="btn btn-primary" style="padding:4px 12px" onclick="switchView('ccb'); document.getElementById('ccb-warn-banner')?.remove();">Go to Agents</button>
    <button type="button" class="btn" style="padding:2px 8px" onclick="document.getElementById('ccb-warn-banner')?.remove()">Dismiss</button>
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
          <div class="task-id">${escapeHtml(t.task_id)}${t.execution_mode === 'semi-auto' ? ' <span style="font-size:10px;color:#8b949e" title="semi-auto">⟳</span>' : ''}</div>
          <div class="task-meta">
            ${badge(t.state)}
            attempt ${escapeHtml(String(t.current_attempt || 0))} · ${escapeHtml(t.last_decision || '-')}
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

  const metaMsg = document.getElementById('meta-message');
  if (metaMsg) metaMsg.textContent = s.message || '-';
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

// P14: Guide card when PAUSED due to CCB unavailable
let ccbGuidePollTimer = null;
function startCcbGuidePolling() {
  if (ccbGuidePollTimer) return;
  function tick() {
    const card = document.getElementById('ccb-guide-card');
    if (!card || card.closest('#content')?.style.display === 'none') {
      if (ccbGuidePollTimer) { clearTimeout(ccbGuidePollTimer); ccbGuidePollTimer = null; }
      return;
    }
    api('/ccb/session-status').then(r => {
      const providers = r.providers || [];
      const anyOk = providers.some(p => p.status === 'ok');
      const btn = document.getElementById('ccb-guide-continue-btn');
      if (btn) btn.disabled = !anyOk;
    }).catch(() => {});
    ccbGuidePollTimer = setTimeout(tick, 5000);
  }
  tick();
}

// Full task render — called once per task switch
function renderTask(data) {
  const { task, status, final_summary, attempts, timeline } = data;
  const s = status || {};
  const content = document.getElementById('content');

  if (s.state === 'PAUSED' && s.pause_reason_code === 'PAUSED_CODER_CCB_UNAVAILABLE') {
    content.innerHTML = `
    <div id="ccb-guide-card" style="background:#161b22;border:1px solid #d29922;border-radius:12px;padding:24px;max-width:560px">
      <h2 style="margin-top:0;color:#d29922">Agents Not Running</h2>
      <p style="margin-bottom:16px">This task requires CCB (semi-auto mode). No agents are online, task is paused.</p>
      <p style="margin-bottom:16px;font-size:13px;color:#8b949e">Go to the Agents panel to start providers, then return here to continue.</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary" onclick="switchView('ccb')">Go to Agents</button>
        <button type="button" class="btn btn-primary" id="ccb-guide-continue-btn" disabled onclick="switchView('tasks'); doRunNext();">Resume Task</button>
      </div>
    </div>`;
    content.className = '';
    startCcbGuidePolling();
    return;
  }

  content.innerHTML = `
    <h2 id="task-heading">${escapeHtml(s.task_id || currentTaskId)} <span id="task-heading-badge">${badge(s.state)}</span></h2>

    <div class="info-grid">
      <div class="info-card">
        <div class="label">State</div>
        <div class="value" id="meta-state">${badge(s.state)}</div>
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
        <div class="label">Message</div>
        <div class="value" id="meta-message" style="font-size:13px">${escapeHtml(s.message || '-')}</div>
      </div>
    </div>

    ${Array.isArray(s.questions_for_user) && s.questions_for_user.length > 0 ? `
      <div style="background:#d2992233;border:1px solid #d29922;border-radius:8px;padding:12px;margin-bottom:16px">
        <strong>Questions for user:</strong>
        <ul style="margin-top:8px;padding-left:20px">
          ${s.questions_for_user.map(q => `<li>${escapeHtml(q)}</li>`).join('')}
        </ul>
      </div>
    ` : ''}

    <div class="controls">
      <button class="btn btn-danger write-action" ${(s.state !== 'RUNNING') ? 'disabled' : ''} onclick="doControl('PAUSE')" title="Takes effect at next checkpoint when coordinator is running">Pause</button>
      <button class="btn btn-primary write-action" ${(s.state === 'RUNNING') ? 'disabled' : ''} onclick="doResume()" title="Resume and start coordinator">Resume</button>
      <button class="btn btn-primary write-action" ${(s.state === 'RUNNING') ? 'disabled' : ''} onclick="doRunNext()" title="Set RUN_NEXT and start coordinator (when PAUSED)">Run Next</button>
      <button class="btn btn-warn write-action" onclick="doForceRun()" title="Start coordinator ignoring lock (only if task is stuck)">Force Run</button>
      ${(s.state === 'PAUSED') ? `<button class="btn btn-primary write-action" onclick="openAdjustParamsModal()" title="Edit instance params (goal, repo_path, max_attempts) then run">Adjust params &amp; Run</button>` : ''}
      <button class="btn write-action" onclick="openUserInputModal()" title="E5/E5-2: Insert user input (written to user_input.jsonl; coordinator consumes on next run)">Insert user input</button>
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

    <h3>Timeline (${escapeHtml(String((timeline || []).length))} events)</h3>
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
async function doControl(action, payload) {
  if (!currentTaskId) return;
  await api(`/task/${currentTaskId}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload: payload || {} })
  });
  // B1-1: only refresh meta, do NOT trigger full re-render / tab reset
  setTimeout(refreshCurrentTaskMeta, 500);
}

// Run Next: set RUN_NEXT (so --continue will advance from PAUSED) then start coordinator
async function doRunNext() {
  if (!currentTaskId) return;
  await doControl('RUN_NEXT');
  const result = await api(`/task/${currentTaskId}/run`, { method: 'POST' }).catch(e => ({ error: e?.message || String(e) }));
  if (result && result.error) {
    if (String(result.error).includes('already running') || String(result.hint || '').includes('lock')) {
      alert('Task is already running. Pause first if you want to stop it.');
      return;
    }
    alert(result.error);
    return;
  }
  setTimeout(refreshCurrentTaskMeta, 1000);
}

// Resume: set RESUME then start coordinator (one click = resume + run)
async function doResume() {
  if (!currentTaskId) return;
  await doControl('RESUME');
  const result = await api(`/task/${currentTaskId}/run`, { method: 'POST' }).catch(e => ({ error: e?.message || String(e) }));
  if (result && result.error) {
    if (String(result.error).includes('already running') || String(result.hint || '').includes('lock')) {
      alert('Task is already running.');
      return;
    }
    alert(result.error);
    return;
  }
  setTimeout(refreshCurrentTaskMeta, 1000);
}

// Force Run: start coordinator ignoring lock (use only when task is stuck)
async function doForceRun() {
  if (!currentTaskId) return;
  if (!confirm('Force Run ignores the running lock. Use only if the task is stuck. Continue?')) return;
  await api(`/task/${currentTaskId}/run?force=1`, { method: 'POST' });
  setTimeout(refreshCurrentTaskMeta, 1000);
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
  const data = await api('/task_specs');
  const specs = data.specs || [];
  const container = document.getElementById('task-specs-list');
  if (!container) return;

  if (specs.length === 0) {
    container.innerHTML = '<div style="padding:8px;color:#8b949e;font-size:12px">No task specs found.</div>';
    return;
  }

  container.innerHTML = specs.map(s => `
    <div class="task-item ${s.task_id === selectedSpecTaskId ? 'active' : ''}" style="padding:8px 12px;cursor:pointer"
         onclick="showSpecDetail('${escapeHtml(s.task_id)}')">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="task-id" style="font-size:12px">${escapeHtml(s.task_id)}</div>
          <div style="font-size:11px;color:#8b949e">
            ${escapeHtml(s.task_type || 'no type')} · ${escapeHtml(s.scoring_mode || '')} · ${escapeHtml(s.updated_at ? s.updated_at.slice(0, 19) + 'Z' : '')}
          </div>
        </div>
        <div style="display:flex;gap:4px" onclick="event.stopPropagation()">
          <button class="btn write-action" style="padding:3px 8px;font-size:11px"
            onclick="openEditSpecModal('${escapeHtml(s.task_id)}')">Edit</button>
          <button class="btn write-action" style="padding:3px 8px;font-size:11px"
            onclick="copySpec('${escapeHtml(s.task_id)}')">Copy</button>
          <button class="btn btn-danger write-action" style="padding:3px 8px;font-size:11px"
            onclick="deleteSpec('${escapeHtml(s.task_id)}')">Del</button>
        </div>
      </div>
    </div>
  `).join('');
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
    const result = await fetch(`/api/task_specs/${encodeURIComponent(taskId)}/run`, { method: 'POST' });
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

// A6-1: Save current adapter selection as default (rdloop.config.json)
async function saveAdaptersAsDefault() {
  const coderEl = document.getElementById('adapter-coder');
  const judgeEl = document.getElementById('adapter-judge');
  const coderModelEl = document.getElementById('adapter-coder-model');
  const judgeModelEl = document.getElementById('adapter-judge-model');
  const default_coder = coderEl ? coderEl.value : null;
  const default_judge = judgeEl ? judgeEl.value : null;
  const default_coder_model = coderModelEl && coderModelEl.value ? coderModelEl.value : null;
  const default_judge_model = judgeModelEl && judgeModelEl.value ? judgeModelEl.value : null;
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        default_coder: default_coder || null,
        default_judge: default_judge || null,
        default_coder_model: default_coder_model || null,
        default_judge_model: default_judge_model || null
      })
    });
    const data = await res.json();
    if (!res.ok) {
      alert('Failed to save default: ' + (data.error || ''));
      return;
    }
    const notice = document.getElementById('task-specs-notice');
    if (notice) notice.textContent = 'Default adapters saved.';
    setTimeout(() => { if (notice) notice.textContent = ''; }, 3000);
  } catch (e) {
    alert('Failed to save default: ' + (e.message || ''));
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
const AGENT_CLI_OPTIONS = ['claude-cli', 'codex-cli', 'cursor-cli'];
const CCB_PROVIDER_OPTIONS = ['codex', 'gemini'];

function inferChannelFromAdapter(adapterName) {
  if (!adapterName) return 'coding-agent-cli';
  if (adapterName === 'ccb') return 'ccb';
  if (AGENT_CLI_OPTIONS.includes(adapterName)) return 'coding-agent-cli';
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
  const channel = channelTypeOptional != null ? channelTypeOptional : (document.getElementById('adapter-channel-type') || document.getElementById('adapter-settings-channel-type'))?.value || 'coding-agent-cli';
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
    const options = AGENT_CLI_OPTIONS.map(name => {
      const sel = name === (selectedProvider || '') ? 'selected' : '';
      return `<option value="${escapeHtml(name)}" ${sel}>${escapeHtml(name)}</option>`;
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

function onExecutionModeChange() {
  const wrap = document.getElementById('collab-config-wrap');
  const mode = document.getElementById('modal-execution-mode')?.value || 'auto';
  if (wrap) wrap.style.display = mode === 'semi-auto' ? 'block' : 'none';
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
      status.textContent = r.error || 'Invalid';
      status.style.color = '#f85149';
    }
  } catch (_) {
    status.textContent = 'Error';
    status.style.color = '#f85149';
  }
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
    const maxAttempts = Math.min(10, Math.max(1, parseInt(document.getElementById('modal-max-attempts')?.value || '3', 10) || 3));
    const coderTimeout = Math.min(3600, Math.max(60, parseInt(document.getElementById('modal-coder-timeout')?.value || '600', 10) || 600));
    const judgeTimeout = Math.min(3600, Math.max(60, parseInt(document.getElementById('modal-judge-timeout')?.value || '300', 10) || 300));
    const constraintsRaw = (document.getElementById('modal-constraints')?.value || '').trim();
    const constraints = constraintsRaw ? constraintsRaw.split(/\n/).map(s => s.trim()).filter(Boolean) : [];
    const repoPath = (document.getElementById('modal-repo-path')?.value || '').trim();
    const baseRef = (document.getElementById('modal-base-ref')?.value || 'main').trim();
    const apRaw = (document.getElementById('modal-allowed-paths')?.value || '').trim();
    const allowedPaths = apRaw ? apRaw.split(/\n/).map(s => s.trim()).filter(Boolean) : [];
    const fgRaw = (document.getElementById('modal-forbidden-globs')?.value || '').trim();
    const forbiddenGlobs = fgRaw ? fgRaw.split(/\n/).map(s => s.trim()).filter(Boolean) : ['**/.env', '**/secrets*', '**/*.pem'];
    const channelType = document.getElementById('adapter-channel-type')?.value || 'coding-agent-cli';
    let coder = document.getElementById('adapter-coder')?.value || 'mock';
    let judge = document.getElementById('adapter-judge')?.value || 'mock';
    let coderModel = document.getElementById('adapter-coder-model')?.value?.trim();
    let judgeModel = document.getElementById('adapter-judge-model')?.value?.trim();
    if (channelType === 'ccb') {
      coder = 'ccb';
      judge = 'ccb';
      coderModel = document.getElementById('adapter-coder')?.value || 'codex';
      judgeModel = document.getElementById('adapter-judge')?.value || 'codex';
    }
    const executionMode = document.getElementById('modal-execution-mode')?.value || 'auto';
    const spec = {
      schema_version: 'v1',
      task_id: taskId || 'my_task',
      task_type: taskType || undefined,
      execution_mode: executionMode,
      channel_type: channelType,
      repo_path: repoPath || undefined,
      base_ref: baseRef || 'main',
      goal: instruction || '',
      acceptance,
      test_cmd: testCmd || 'true',
      max_attempts: maxAttempts,
      coder_timeout_seconds: coderTimeout,
      judge_timeout_seconds: judgeTimeout,
      attempt_context_mode: document.getElementById('modal-attempt-context-mode')?.value || 'fresh_each',
      constraints,
      allowed_paths: allowedPaths,
      forbidden_globs: forbiddenGlobs,
      coder,
      judge,
      ...(coderModel ? { coder_model: coderModel } : {}),
      ...(judgeModel ? { judge_model: judgeModel } : {})
    };
    if (executionMode === 'semi-auto') {
      const executorEl = document.getElementById('collab-role-executor');
      const reviewerEl = document.getElementById('collab-role-reviewer');
      const designerEl = document.getElementById('collab-role-designer');
      const inspirationEl = document.getElementById('collab-role-inspiration');
      spec.collab_roles = {};
      if (executorEl?.value) spec.collab_roles.executor = executorEl.value;
      if (reviewerEl?.value) spec.collab_roles.reviewer = reviewerEl.value;
      if (designerEl?.value) spec.collab_roles.designer = designerEl.value;
      if (inspirationEl?.value) spec.collab_roles.inspiration = inspirationEl.value;
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
    if (spec.task_type) document.getElementById('modal-task-type') && (document.getElementById('modal-task-type').value = spec.task_type);
    set('modal-instruction', spec.goal || spec.instruction);
    document.getElementById('modal-acceptance') && (document.getElementById('modal-acceptance').value = Array.isArray(spec.acceptance) ? spec.acceptance.join('\n') : (spec.acceptance || ''));
    set('modal-test-cmd', spec.test_cmd);
    set('modal-max-attempts', spec.max_attempts !== undefined ? spec.max_attempts : 3);
    set('modal-coder-timeout', spec.coder_timeout_seconds !== undefined ? spec.coder_timeout_seconds : 600);
    set('modal-judge-timeout', spec.judge_timeout_seconds !== undefined ? spec.judge_timeout_seconds : 300);
    document.getElementById('modal-constraints') && (document.getElementById('modal-constraints').value = Array.isArray(spec.constraints) ? spec.constraints.join('\n') : '');
    set('modal-repo-path', spec.repo_path);
    set('modal-base-ref', spec.base_ref || 'main');
    document.getElementById('modal-allowed-paths') && (document.getElementById('modal-allowed-paths').value = Array.isArray(spec.allowed_paths) ? spec.allowed_paths.join('\n') : '');
    document.getElementById('modal-forbidden-globs') && (document.getElementById('modal-forbidden-globs').value = Array.isArray(spec.forbidden_globs) ? spec.forbidden_globs.join('\n') : '');
    if (spec.execution_mode) document.getElementById('modal-execution-mode') && (document.getElementById('modal-execution-mode').value = spec.execution_mode);
    if (spec.channel_type) document.getElementById('adapter-channel-type') && (document.getElementById('adapter-channel-type').value = spec.channel_type);
    onExecutionModeChange();
    onChannelTypeChange();
    const coderVal = spec.coder;
    const judgeVal = spec.judge;
    const coderModelVal = spec.coder_model;
    const judgeModelVal = spec.judge_model;
    const ch = spec.channel_type || inferChannelFromAdapter(spec.coder);
    const coderSel = document.getElementById('coder-adapter-selector');
    const judgeSel = document.getElementById('judge-adapter-selector');
    if (coderSel) coderSel.innerHTML = buildAdapterSelector('coder', ch === 'ccb' ? (coderModelVal || 'codex') : coderVal, coderModelVal, ch);
    if (judgeSel) judgeSel.innerHTML = buildAdapterSelector('judge', ch === 'ccb' ? (judgeModelVal || 'codex') : judgeVal, judgeModelVal, ch);
    refreshModelSelector('coder').catch(() => {});
    refreshModelSelector('judge').catch(() => {});
    if (spec.collab_roles) {
      ['executor', 'reviewer', 'designer', 'inspiration'].forEach(role => {
        const el = document.getElementById('collab-role-' + role);
        if (el && spec.collab_roles[role]) el.value = spec.collab_roles[role];
      });
    }
  } catch (_) { /* invalid JSON, ignore */ }
}

async function onSettingsExecModeChange() {
  const mode = document.querySelector('input[name="settings-exec-mode"]:checked')?.value || 'auto';
  const rolesSection = document.getElementById('settings-roles-section');
  const rolesWrap = document.getElementById('settings-roles-wrap');
  const hintEl = document.getElementById('settings-roles-hint');
  if (rolesSection && rolesWrap && hintEl) {
    if (mode === 'auto') {
      rolesWrap.style.opacity = '0.6';
      rolesWrap.style.pointerEvents = 'none';
      hintEl.style.display = 'block';
    } else {
      rolesWrap.style.opacity = '';
      rolesWrap.style.pointerEvents = '';
      hintEl.style.display = 'none';
    }
  }
  const ccbHint = document.getElementById('settings-ccb-hint');
  if (mode === 'semi-auto' && ccbHint) {
    try {
      const st = await api('/ccb/session-status');
      const online = (st.providers || []).some(p => p.status === 'ok');
      ccbHint.style.display = 'block';
      if (!online) {
        ccbHint.textContent = 'CCB 未检测到在线 session。请在下方设置 CCB 目录后点击任务栏的「启动」启动 ccb codex / ccb gemini。';
      } else {
        ccbHint.textContent = 'CCB session 已就绪。';
        ccbHint.style.background = '#1a2f1a';
        ccbHint.style.borderColor = '#2ea043';
        ccbHint.style.color = '#3fb950';
      }
    } catch (_) {
      ccbHint.textContent = '无法获取 CCB 状态。请设置 ccb_path 后重试。';
      ccbHint.style.display = 'block';
    }
  } else if (ccbHint) {
    ccbHint.style.display = 'none';
  }
}

function onSettingsChannelChange() {
  const channel = document.getElementById('adapter-settings-channel-type')?.value || 'coding-agent-cli';
  const coderWrap = document.getElementById('settings-coder-wrap');
  const judgeWrap = document.getElementById('settings-judge-wrap');
  const cfg = settingsConfigSnapshot || {};
  if (coderWrap) coderWrap.innerHTML = buildAdapterSelector('settings-coder', cfg.default_coder || '', cfg.default_coder_model || '', channel);
  if (judgeWrap) judgeWrap.innerHTML = buildAdapterSelector('settings-judge', cfg.default_judge || '', cfg.default_judge_model || '', channel);
  refreshModelSelector('settings-coder').catch(() => {});
  refreshModelSelector('settings-judge').catch(() => {});
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
  const container = document.getElementById('rubric-thresholds-container');
  if (!container) return;

  if (!taskType) {
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
  showIf('section-adapter-grid', type !== 'solo_agent');
  showIf('collab-config-wrap', type === 'multi_agent');
  showIf('section-repo-git', type !== 'api_call' || true);
  showIf('section-loop-config', type === 'solo_agent');
  showIf('section-knowledge', type !== 'api_call');
  showIf('section-observation', type === 'solo_agent');
  showIf('section-acceptance', type !== 'solo_agent');
  showIf('section-channel-type', false);
  showIf('section-execution-mode', false);
  showIf('section-attempt-context', type === 'api_call');
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

// A2-1: Open "New Task" modal (A6: apply saved default adapters when no template selected)
async function openNewSpecModal() {
  await loadAdapters();
  let defaultCoder = null;
  let defaultJudge = null;
  let defaultCoderModel = null;
  let defaultJudgeModel = null;
  let defaultExecutionMode = 'auto';
  try {
    const cfg = await api('/config');
    defaultCoder = cfg.default_coder || null;
    defaultJudge = cfg.default_judge || null;
    defaultCoderModel = cfg.default_coder_model || null;
    defaultJudgeModel = cfg.default_judge_model || null;
    defaultExecutionMode = cfg.default_execution_mode || 'auto';
  } catch {}

  const defaultChannel = inferChannelFromAdapter(defaultCoder);
  const COLLAB_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode', 'droid'];
  const COLLAB_ROLES = [{ role: 'PM', provider: 'claude', readOnly: true }, { role: 'executor', provider: 'codex', readOnly: false }, { role: 'reviewer', provider: 'gemini', readOnly: false }, { role: 'designer', provider: 'codex', readOnly: false }, { role: 'inspiration', provider: 'codex', readOnly: false }];

  const TEMPLATES = {
    hello_world: {
      schema_version: 'v1',
      task_id: 'my_task',
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
      task_type: 'requirements_doc',
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
      task_type: 'engineering_impl',
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

  const modalHtml = `
    <div id="spec-modal" class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:800px;max-height:90vh;overflow-y:auto">
        <h3 style="margin-top:0">New Task Spec</h3>

        <div style="margin-bottom:12px">
          <label class="form-label">Executor Type (v5)</label>
          <select id="modal-executor-type" class="form-select" onchange="setExecutorType(this.value); syncFormToJson()">
            <option value="api_call">API Call — single-flow LLM via CLI proxy</option>
            <option value="solo_agent">Solo Agent — autonomous agent loop</option>
            <option value="multi_agent">Multi Agent — collaborative multi-worker</option>
          </select>
        </div>
        <div style="margin-bottom:12px">
          <label class="form-label">Session Mode (v5)</label>
          <select id="modal-session-mode" class="form-select" onchange="_currentSessionMode=this.value; syncFormToJson()">
            <option value="fresh">Fresh — each attempt from scratch</option>
            <option value="iterative">Iterative — carry context across attempts</option>
            <option value="continuous" disabled>Continuous — persistent agent session</option>
          </select>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">Task ID</label>
          <input type="text" id="modal-task-id" class="form-input" placeholder="my_new_task"
            pattern="[A-Za-z0-9_-]+" title="Alphanumeric, underscore, hyphen only" oninput="syncFormToJson()">
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">Type</label>
          <select id="modal-task-type" class="form-select" onchange="onTaskTypeChange(); syncFormToJson()">
            <option value="">— none —</option>
            <option value="requirements_doc">requirements_doc</option>
            <option value="engineering_impl">engineering_impl</option>
            <option value="douyin_script">douyin_script</option>
            <option value="storyboard">storyboard</option>
            <option value="paid_mini_drama">paid_mini_drama</option>
          </select>
        </div>

        <div id="section-attempt-context" style="margin-bottom:12px">
          <label class="form-label">Attempt context mode</label>
          <select id="modal-attempt-context-mode" class="form-select" title="fresh_each: each attempt from scratch (divergent). iterative: n+1 gets previous coder output as context (convergent)." onchange="syncFormToJson()">
            <option value="fresh_each">fresh_each — each attempt from scratch (divergent, e.g. scripts)</option>
            <option value="iterative">iterative — next attempt builds on previous coder output (convergent, e.g. requirements, code)</option>
          </select>
        </div>

        <div id="section-execution-mode" style="margin-bottom:12px;display:none">
          <label class="form-label">Execution mode (v3.3)</label>
          <select id="modal-execution-mode" class="form-select" style="width:auto" onchange="onExecutionModeChange()">
            <option value="auto" ${(defaultExecutionMode || 'auto') === 'auto' ? 'selected' : ''}>auto — 全自动无人介入</option>
            <option value="semi-auto" ${defaultExecutionMode === 'semi-auto' ? 'selected' : ''}>semi-auto — 人在回路可观察介入</option>
          </select>
        </div>

        <div id="collab-config-wrap" style="margin-bottom:12px;display:${defaultExecutionMode === 'semi-auto' ? 'block' : 'none'};padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
          <details open>
            <summary class="form-label" style="cursor:pointer">协作配置 (semi-auto)</summary>
            <div id="collab-roles-table" style="margin-top:8px;font-size:12px">
              <table style="width:100%;border-collapse:collapse">
                <thead><tr><th style="text-align:left">Role</th><th style="text-align:left">Provider</th></tr></thead>
                <tbody>
                  ${COLLAB_ROLES.map(r => {
                    const opts = r.readOnly ? `<option value="claude" selected>claude</option>` : COLLAB_PROVIDERS.map(p => `<option value="${escapeHtml(p)}" ${p === r.provider ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');
                    return `<tr><td>${escapeHtml(r.role)}</td><td><select id="collab-role-${escapeHtml(r.role)}" class="form-select" style="min-width:100px" ${r.readOnly ? 'disabled' : ''}>${opts}</select></td></tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </details>
        </div>

        <div id="section-channel-type" style="margin-bottom:12px;display:none">
          <label class="form-label">Execution channel (v3.3)</label>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <select id="adapter-channel-type" class="form-select" style="width:auto" onchange="onChannelTypeChange()">
              ${CHANNEL_TYPES.map(c => `<option value="${escapeHtml(c.value)}" ${c.value === defaultChannel ? 'selected' : ''}>${escapeHtml(c.label)} — ${escapeHtml(c.tag)}</option>`).join('')}
            </select>
            <span id="adapter-channel-tag" style="font-size:11px;color:#8b949e"></span>
          </div>
        </div>

        <div id="section-adapter-grid" style="margin-bottom:12px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div>
              <label class="form-label">Coder Adapter (A5)</label>
              <div id="coder-adapter-selector">${buildAdapterSelector('coder', defaultCoder, defaultCoderModel, defaultChannel)}</div>
            </div>
            <div>
              <label class="form-label">Judge Adapter (A5)</label>
              <div id="judge-adapter-selector">${buildAdapterSelector('judge', defaultJudge, defaultJudgeModel, defaultChannel)}</div>
            </div>
          </div>
          <div style="margin-bottom:12px">
            <button type="button" class="btn write-action" style="font-size:12px" onclick="saveAdaptersAsDefault()">Save as Default (A6)</button>
          </div>
        </div>

        <div id="section-loop-config" style="margin-bottom:12px;display:none">
          <div style="padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
            <strong class="form-label">Agent Loop Config</strong>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;margin-bottom:8px">
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

        <div id="section-observation" style="margin-bottom:12px;display:none">
          <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="modal-open-terminal" checked>
            <span class="form-label" style="display:inline;margin:0">Open agent terminal on start</span>
          </label>
        </div>

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

        <div id="section-acceptance" class="form-section" style="margin-bottom:12px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
          <strong class="form-label">需求与验收</strong>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">instruction / goal <span style="color:#f85149">*</span></label>
            <textarea id="modal-instruction" class="form-input" rows="3" placeholder="Describe what to achieve" style="width:100%;resize:vertical;margin-bottom:6px" oninput="syncFormToJson()"></textarea>
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">acceptance_criteria (one per line)</label>
            <textarea id="modal-acceptance" class="form-input" rows="2" placeholder="Line 1&#10;Line 2" style="width:100%;resize:vertical;margin-bottom:6px" oninput="syncFormToJson()"></textarea>
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">test_cmd</label>
            <input type="text" id="modal-test-cmd" class="form-input" placeholder="bash run_tests.sh" style="margin-bottom:6px" oninput="syncFormToJson()">
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">max_attempts (1–10)</label>
            <input type="number" id="modal-max-attempts" class="form-input" min="1" max="10" value="3" style="width:80px;margin-bottom:6px" onchange="syncFormToJson()">
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">coder_timeout_seconds</label>
            <input type="number" id="modal-coder-timeout" class="form-input" min="60" max="3600" value="600" style="width:80px;margin-bottom:6px" onchange="syncFormToJson()">
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">judge_timeout_seconds</label>
            <input type="number" id="modal-judge-timeout" class="form-input" min="60" max="3600" value="300" style="width:80px;margin-bottom:6px" onchange="syncFormToJson()">
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">constraints (one per line, optional)</label>
            <textarea id="modal-constraints" class="form-input" rows="2" placeholder="e.g. No network" style="width:100%;resize:vertical;margin-bottom:6px" oninput="syncFormToJson()"></textarea>
          </div>
        </div>

        <div id="section-repo-git" class="form-section" style="margin-bottom:12px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
          <strong class="form-label">Repo &amp; Git</strong>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">repo_path (absolute path to git repo)</label>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <input type="text" id="modal-repo-path" class="form-input" placeholder="/path/to/repo" style="flex:1;margin-bottom:6px" onblur="validateRepoPath()" oninput="syncFormToJson()">
              <span id="modal-repo-path-status" style="font-size:12px;min-width:80px" title="Validation result"></span>
            </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">base_ref (branch or ref)</label>
            <input type="text" id="modal-base-ref" class="form-input" placeholder="main" style="margin-bottom:6px" oninput="syncFormToJson()">
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">allowed_paths (one per line, optional)</label>
            <textarea id="modal-allowed-paths" class="form-input" rows="2" placeholder="src/" style="font-family:monospace;font-size:11px;width:100%;resize:vertical" oninput="syncFormToJson()"></textarea>
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">forbidden_globs (one per line, optional)</label>
            <textarea id="modal-forbidden-globs" class="form-input" rows="2" placeholder="**/.env" style="font-family:monospace;font-size:11px;width:100%;resize:vertical" oninput="syncFormToJson()"></textarea>
          </div>
        </div>

        <div id="rubric-thresholds-container" style="margin-bottom:12px"></div>

        <details style="margin-bottom:12px">
          <summary class="form-label" style="cursor:pointer">高级 (JSON)</summary>
          <div style="margin-top:8px">
            <label class="form-label">Task JSON (syntax validated on save)</label>
            <textarea id="modal-spec-json" class="code-editor" style="height:200px;font-family:monospace;font-size:12px" onblur="syncJsonToForm()"></textarea>
            <div id="modal-json-error" style="color:#f85149;font-size:12px;margin-top:4px"></div>
          </div>
        </details>

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary write-action" onclick="saveNewSpec()">Save</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();
  onChannelTypeChange();
  refreshModelSelector('coder').catch(() => {});
  refreshModelSelector('judge').catch(() => {});

  // Apply default executor type (v5)
  setExecutorType('api_call');

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
  const acc = document.getElementById('modal-acceptance');
  if (acc) acc.value = Array.isArray(tpl.acceptance) ? tpl.acceptance.join('\n') : (tpl.acceptance || '');
  const tc = document.getElementById('modal-test-cmd');
  if (tc) tc.value = tpl.test_cmd || '';
  const ma = document.getElementById('modal-max-attempts');
  if (ma) ma.value = tpl.max_attempts !== undefined ? String(tpl.max_attempts) : '3';
  // Load rubric
  if (tpl.task_type) onTaskTypeChange();
}

// A2-2: Save new spec
async function saveNewSpec() {
  const taskId = (document.getElementById('modal-task-id').value || '').trim();
  const jsonStr = (document.getElementById('modal-spec-json').value || '').trim();
  const errEl = document.getElementById('modal-json-error');
  errEl.textContent = '';

  if (!taskId || !/^[A-Za-z0-9_-]+$/.test(taskId)) {
    errEl.textContent = 'Invalid task_id: alphanumeric, underscore, hyphen only';
    return;
  }
  const buildFromForm = !jsonStr || jsonStr.trim() === '';
  if (buildFromForm) {
    const instruction = (document.getElementById('modal-instruction')?.value || '').trim();
    if (!instruction) {
      errEl.textContent = 'instruction / goal is required';
      return;
    }
  }

  // E3: JSON syntax validation
  let spec;
  if (jsonStr) {
    try {
      spec = JSON.parse(jsonStr);
    } catch (e) {
      errEl.textContent = 'JSON syntax error: ' + e.message;
      return;
    }
  } else {
    // Build from form fields
    const taskType = document.getElementById('modal-task-type')?.value || undefined;
    const channelType = document.getElementById('adapter-channel-type')?.value || 'coding-agent-cli';
    let coder = document.getElementById('adapter-coder')?.value || 'mock';
    let judge = document.getElementById('adapter-judge')?.value || 'mock';
    let coderModel = document.getElementById('adapter-coder-model')?.value?.trim();
    let judgeModel = document.getElementById('adapter-judge-model')?.value?.trim();
    if (channelType === 'ccb') {
      coder = 'ccb';
      judge = 'ccb';
      coderModel = document.getElementById('adapter-coder')?.value || 'codex';
      judgeModel = document.getElementById('adapter-judge')?.value || 'codex';
    }
    const instruction = (document.getElementById('modal-instruction')?.value || '').trim();
    const goal = instruction || '';
    const acceptanceLines = (document.getElementById('modal-acceptance')?.value || '').split(/\n/).map(s => s.trim()).filter(Boolean);
    const acceptance = acceptanceLines.length ? acceptanceLines : [];
    const testCmd = (document.getElementById('modal-test-cmd')?.value || 'true').trim();
    const maxAttempts = Math.min(10, Math.max(1, parseInt(document.getElementById('modal-max-attempts')?.value || '3', 10) || 3));
    const apRaw = (document.getElementById('modal-allowed-paths')?.value || '').trim();
    const allowedPaths = apRaw ? apRaw.split(/\n/).map(s => s.trim()).filter(Boolean) : [];
    const fgRaw = (document.getElementById('modal-forbidden-globs')?.value || '').trim();
    const forbiddenGlobs = fgRaw ? fgRaw.split(/\n/).map(s => s.trim()).filter(Boolean) : ['**/.env', '**/secrets*', '**/*.pem'];
    const coderTimeout = Math.min(3600, Math.max(60, parseInt(document.getElementById('modal-coder-timeout')?.value || '600', 10) || 600));
    const judgeTimeout = Math.min(3600, Math.max(60, parseInt(document.getElementById('modal-judge-timeout')?.value || '300', 10) || 300));
    const constraintsRaw = (document.getElementById('modal-constraints')?.value || '').trim();
    const constraints = constraintsRaw ? constraintsRaw.split(/\n/).map(s => s.trim()).filter(Boolean) : [];
    spec = {
      schema_version: 'v1',
      task_id: taskId,
      task_type: taskType || undefined,
      execution_mode: document.getElementById('modal-execution-mode')?.value || 'auto',
      channel_type: channelType,
      repo_path: document.getElementById('modal-repo-path')?.value?.trim() || undefined,
      base_ref: document.getElementById('modal-base-ref')?.value?.trim() || 'main',
      coder,
      judge,
      ...(coderModel ? { coder_model: coderModel } : {}),
      ...(judgeModel ? { judge_model: judgeModel } : {}),
      goal: goal || '',
      acceptance: acceptance,
      test_cmd: testCmd || 'true',
      max_attempts: maxAttempts,
      attempt_context_mode: document.getElementById('modal-attempt-context-mode')?.value || 'fresh_each',
      constraints: constraints,
      allowed_paths: allowedPaths,
      forbidden_globs: forbiddenGlobs,
      coder_timeout_seconds: coderTimeout,
      judge_timeout_seconds: judgeTimeout,
      created_at: new Date().toISOString()
    };
    // A4: read thresholds
    if (taskType) {
      const thresholds = readThresholdsFromUI(taskType);
      if (thresholds) spec.rubric_thresholds = thresholds;
    }
  }

  // Override task_id, adapter, and model from form controls if JSON was provided
  spec.task_id = taskId;
  const channelTypeVal = document.getElementById('adapter-channel-type')?.value;
  if (channelTypeVal) spec.channel_type = channelTypeVal;
  let coderVal = document.getElementById('adapter-coder')?.value;
  let judgeVal = document.getElementById('adapter-judge')?.value;
  let coderModelVal = document.getElementById('adapter-coder-model')?.value;
  let judgeModelVal = document.getElementById('adapter-judge-model')?.value;
  if (channelTypeVal === 'ccb') {
    spec.coder = 'ccb';
    spec.judge = 'ccb';
    spec.coder_model = coderVal || 'codex';
    spec.judge_model = judgeVal || 'codex';
  } else {
    if (coderVal) spec.coder = coderVal;
    if (judgeVal) spec.judge = judgeVal;
    if (coderModelVal) spec.coder_model = coderModelVal; else if (spec.coder_model !== undefined) delete spec.coder_model;
    if (judgeModelVal) spec.judge_model = judgeModelVal; else if (spec.judge_model !== undefined) delete spec.judge_model;
  }
  const taskTypeVal = document.getElementById('modal-task-type')?.value;
  if (taskTypeVal) spec.task_type = taskTypeVal;
  const attemptContextModeVal = document.getElementById('modal-attempt-context-mode')?.value;
  if (attemptContextModeVal) spec.attempt_context_mode = attemptContextModeVal;
  const executionModeVal = document.getElementById('modal-execution-mode')?.value;
  if (executionModeVal) spec.execution_mode = executionModeVal;
  if (executionModeVal === 'semi-auto') {
    const executorEl = document.getElementById('collab-role-executor');
    const reviewerEl = document.getElementById('collab-role-reviewer');
    const designerEl = document.getElementById('collab-role-designer');
    const inspirationEl = document.getElementById('collab-role-inspiration');
    spec.collab_roles = {};
    if (executorEl?.value) spec.collab_roles.executor = executorEl.value;
    if (reviewerEl?.value) spec.collab_roles.reviewer = reviewerEl.value;
    if (designerEl?.value) spec.collab_roles.designer = designerEl.value;
    if (inspirationEl?.value) spec.collab_roles.inspiration = inspirationEl.value;
  }
  // Repo & Git from form
  const rp = document.getElementById('modal-repo-path')?.value?.trim();
  if (rp !== undefined && rp !== '') spec.repo_path = rp;
  const br = document.getElementById('modal-base-ref')?.value?.trim();
  if (br !== undefined && br !== '') spec.base_ref = br;
  const instructionVal = (document.getElementById('modal-instruction')?.value || '').trim();
  if (instructionVal) spec.goal = instructionVal;
  const acceptanceVal = document.getElementById('modal-acceptance')?.value?.trim();
  if (acceptanceVal) spec.acceptance = acceptanceVal.split(/\n/).map(s => s.trim()).filter(Boolean);
  const testCmdVal = document.getElementById('modal-test-cmd')?.value?.trim();
  if (testCmdVal !== undefined && testCmdVal !== '') spec.test_cmd = testCmdVal;
  const maxAttemptsVal = document.getElementById('modal-max-attempts')?.value;
  if (maxAttemptsVal !== undefined && maxAttemptsVal !== '') spec.max_attempts = Math.min(10, Math.max(1, parseInt(maxAttemptsVal, 10) || 3));
  const coderTimeoutVal = document.getElementById('modal-coder-timeout')?.value;
  if (coderTimeoutVal !== undefined && coderTimeoutVal !== '') spec.coder_timeout_seconds = Math.min(3600, Math.max(60, parseInt(coderTimeoutVal, 10) || 600));
  const judgeTimeoutVal = document.getElementById('modal-judge-timeout')?.value;
  if (judgeTimeoutVal !== undefined && judgeTimeoutVal !== '') spec.judge_timeout_seconds = Math.min(3600, Math.max(60, parseInt(judgeTimeoutVal, 10) || 300));
  const constraintsVal = (document.getElementById('modal-constraints')?.value || '').trim();
  if (constraintsVal) spec.constraints = constraintsVal.split(/\n/).map(s => s.trim()).filter(Boolean);
  const apRaw = document.getElementById('modal-allowed-paths')?.value?.trim();
  if (apRaw) {
    if (apRaw.startsWith('[')) { try { spec.allowed_paths = JSON.parse(apRaw); } catch {} }
    else { spec.allowed_paths = apRaw.split(/\n/).map(s => s.trim()).filter(Boolean); }
  }
  const fgRaw = document.getElementById('modal-forbidden-globs')?.value?.trim();
  if (fgRaw) {
    if (fgRaw.startsWith('[')) { try { spec.forbidden_globs = JSON.parse(fgRaw); } catch {} }
    else { spec.forbidden_globs = fgRaw.split(/\n/).map(s => s.trim()).filter(Boolean); }
  }
  // A4: merge thresholds
  if (spec.task_type) {
    const thresholds = readThresholdsFromUI(spec.task_type);
    if (thresholds) spec.rubric_thresholds = thresholds;
  }

  // v5.0: executor_type + session_mode (replaces workflow_mode)
  spec.executor_type = _currentExecutorType;
  spec.session_mode = _currentSessionMode || document.getElementById('modal-session-mode')?.value || 'fresh';
  // Legacy compat: keep workflow_mode for backward compat
  spec.workflow_mode = _currentWorkflowMode;
  if (_currentExecutorType === 'api_call') {
    spec.execution_mode = 'auto';
  } else if (_currentExecutorType === 'solo_agent') {
    spec.execution_mode = 'auto';
    spec.agent_config = {
      max_attempts: parseInt(document.getElementById('modal-max-iterations')?.value || '10', 10),
      auto_pass_threshold: parseFloat(document.getElementById('modal-auto-pass-threshold')?.value || '0.85'),
      knowledge_shards: (document.getElementById('modal-knowledge-shards')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
      provider: document.getElementById('modal-solo-provider')?.value || 'claude'
    };
    const testCmdSolo = (document.getElementById('modal-test-cmd-solo')?.value || '').trim();
    if (testCmdSolo) spec.test_cmd = testCmdSolo;
  } else if (_currentExecutorType === 'multi_agent') {
    spec.execution_mode = 'semi-auto';
  }
  // Knowledge settings for solo + multi_agent
  if (_currentExecutorType !== 'api_call') {
    const knEnabled = document.getElementById('modal-knowledge-enabled')?.checked;
    if (knEnabled) {
      spec.knowledge_enabled = true;
      spec.knowledge_project_path = (document.getElementById('modal-knowledge-project')?.value || '').trim();
    }
  }

  try {
    const res = await fetch('/api/task_specs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, spec })
    });
    const result = await res.json();
    if (!res.ok) {
      errEl.textContent = result.error || 'Validation failed';
      if (Array.isArray(result.errors) && result.errors.length) {
        errEl.innerHTML = escapeHtml(result.error || 'Validation failed') + '<br>' + result.errors.map(e => '• ' + escapeHtml(e)).join('<br>');
      }
      return;
    }
    closeModal();
    loadTaskSpecs();
  } catch (e) {
    errEl.textContent = 'Save failed: ' + (e.message || String(e));
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
  const editExecutionMode = spec.execution_mode || 'auto';
  const editCollabRoles = spec.collab_roles || {};
  const COLLAB_PROVIDERS_EDIT = ['claude', 'codex', 'gemini', 'opencode', 'droid'];
  const COLLAB_ROLES_EDIT = [
    { role: 'PM', provider: 'claude', readOnly: true },
    { role: 'executor', provider: editCollabRoles.executor || 'codex', readOnly: false },
    { role: 'reviewer', provider: editCollabRoles.reviewer || 'gemini', readOnly: false },
    { role: 'designer', provider: editCollabRoles.designer || 'codex', readOnly: false },
    { role: 'inspiration', provider: editCollabRoles.inspiration || 'codex', readOnly: false }
  ];

  // Pre-load rubric if task_type known
  if (spec.task_type) await loadRubric(spec.task_type);

  const thresholdsHtml = spec.task_type
    ? buildThresholdsUI(spec.task_type, spec.rubric_thresholds)
    : '';

  const modalHtml = `
    <div id="spec-modal" class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:800px;max-height:90vh;overflow-y:auto">
        <h3 style="margin-top:0">Edit Task Spec: ${escapeHtml(taskId)}</h3>

        <div style="margin-bottom:12px">
          <label class="form-label">Task Type (A4)</label>
          <select id="modal-task-type" class="form-select" onchange="onTaskTypeChange()">
            <option value="">— none —</option>
            <option value="requirements_doc" ${spec.task_type === 'requirements_doc' ? 'selected' : ''}>requirements_doc</option>
            <option value="engineering_impl" ${(spec.task_type === 'engineering_impl' || spec.task_type === 'engineering_implementation') ? 'selected' : ''}>engineering_impl</option>
            <option value="douyin_script" ${spec.task_type === 'douyin_script' ? 'selected' : ''}>douyin_script</option>
            <option value="storyboard" ${spec.task_type === 'storyboard' ? 'selected' : ''}>storyboard</option>
            <option value="paid_mini_drama" ${spec.task_type === 'paid_mini_drama' ? 'selected' : ''}>paid_mini_drama</option>
          </select>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">Attempt context mode</label>
          <select id="modal-attempt-context-mode" class="form-select" title="fresh_each: each attempt from scratch. iterative: n+1 gets previous coder output as context.">
            <option value="fresh_each" ${(spec.attempt_context_mode || 'fresh_each') === 'fresh_each' ? 'selected' : ''}>fresh_each — each attempt from scratch (divergent, e.g. scripts)</option>
            <option value="iterative" ${(spec.attempt_context_mode || '') === 'iterative' ? 'selected' : ''}>iterative — next attempt builds on previous coder output (convergent, e.g. requirements, code)</option>
          </select>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">Execution mode (v3.3)</label>
          <select id="modal-execution-mode" class="form-select" style="width:auto" onchange="onExecutionModeChange()">
            <option value="auto" ${editExecutionMode === 'auto' ? 'selected' : ''}>auto — 全自动无人介入</option>
            <option value="semi-auto" ${editExecutionMode === 'semi-auto' ? 'selected' : ''}>semi-auto — 人在回路可观察介入</option>
          </select>
        </div>

        <div id="collab-config-wrap" style="margin-bottom:12px;display:${editExecutionMode === 'semi-auto' ? 'block' : 'none'};padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
          <details open>
            <summary class="form-label" style="cursor:pointer">协作配置 (semi-auto)</summary>
            <div id="collab-roles-table" style="margin-top:8px;font-size:12px">
              <table style="width:100%;border-collapse:collapse">
                <thead><tr><th style="text-align:left">Role</th><th style="text-align:left">Provider</th></tr></thead>
                <tbody>
                  ${COLLAB_ROLES_EDIT.map(r => {
                    const opts = r.readOnly ? `<option value="claude" selected>claude</option>` : COLLAB_PROVIDERS_EDIT.map(p => `<option value="${escapeHtml(p)}" ${p === r.provider ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');
                    return `<tr><td>${escapeHtml(r.role)}</td><td><select id="collab-role-${escapeHtml(r.role)}" class="form-select" style="min-width:100px" ${r.readOnly ? 'disabled' : ''}>${opts}</select></td></tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </details>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">Execution channel (v3.3)</label>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <select id="adapter-channel-type" class="form-select" style="width:auto" onchange="onChannelTypeChange()">
              ${CHANNEL_TYPES.map(c => `<option value="${escapeHtml(c.value)}" ${c.value === editChannel ? 'selected' : ''}>${escapeHtml(c.label)} — ${escapeHtml(c.tag)}</option>`).join('')}
            </select>
            <span id="adapter-channel-tag" style="font-size:11px;color:#8b949e"></span>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div>
            <label class="form-label">Coder Adapter (A5)</label>
            <div id="coder-adapter-selector">${buildAdapterSelector('coder', coderAdapterForSelector, spec.coder_model, editChannel)}</div>
          </div>
          <div>
            <label class="form-label">Judge Adapter (A5)</label>
            <div id="judge-adapter-selector">${buildAdapterSelector('judge', judgeAdapterForSelector, spec.judge_model, editChannel)}</div>
          </div>
        </div>
        <div style="margin-bottom:12px">
          <button type="button" class="btn write-action" style="font-size:12px" onclick="saveAdaptersAsDefault()">Save as Default (A6)</button>
        </div>

        <div class="form-section" style="margin-bottom:12px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
          <strong class="form-label">需求与验收</strong>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">instruction / goal</label>
            <textarea id="modal-instruction" class="form-input" rows="3" placeholder="Describe what to achieve" style="width:100%;resize:vertical;margin-bottom:6px">${escapeHtml(spec.goal || spec.instruction || '')}</textarea>
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">acceptance_criteria (one per line)</label>
            <textarea id="modal-acceptance" class="form-input" rows="2" style="width:100%;resize:vertical;margin-bottom:6px">${escapeHtml(Array.isArray(spec.acceptance) ? spec.acceptance.join('\n') : (spec.acceptance || ''))}</textarea>
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">test_cmd</label>
            <input type="text" id="modal-test-cmd" class="form-input" value="${escapeHtml(spec.test_cmd || '')}" placeholder="bash run_tests.sh" style="margin-bottom:6px">
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">max_attempts (1–10)</label>
            <input type="number" id="modal-max-attempts" class="form-input" min="1" max="10" value="${spec.max_attempts !== undefined ? spec.max_attempts : 3}" style="width:80px;margin-bottom:6px">
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">coder_timeout_seconds</label>
            <input type="number" id="modal-coder-timeout" class="form-input" min="60" max="3600" value="${spec.coder_timeout_seconds !== undefined ? spec.coder_timeout_seconds : 600}" style="width:80px;margin-bottom:6px">
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">judge_timeout_seconds</label>
            <input type="number" id="modal-judge-timeout" class="form-input" min="60" max="3600" value="${spec.judge_timeout_seconds !== undefined ? spec.judge_timeout_seconds : 300}" style="width:80px;margin-bottom:6px">
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">constraints (one per line)</label>
            <textarea id="modal-constraints" class="form-input" rows="2" style="width:100%;resize:vertical;margin-bottom:6px">${escapeHtml(Array.isArray(spec.constraints) ? spec.constraints.join('\n') : (spec.constraints || []).join('\n'))}</textarea>
          </div>
        </div>

        <div class="form-section" style="margin-bottom:12px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
          <strong class="form-label">Repo &amp; Git</strong>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">repo_path</label>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <input type="text" id="modal-repo-path" class="form-input" value="${escapeHtml(spec.repo_path || '')}" placeholder="/path/to/repo" style="flex:1;margin-bottom:6px" onblur="validateRepoPath()">
              <span id="modal-repo-path-status" style="font-size:12px;min-width:80px"></span>
            </div>
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">base_ref</label>
            <input type="text" id="modal-base-ref" class="form-input" value="${escapeHtml(spec.base_ref || 'main')}" placeholder="main" style="margin-bottom:6px">
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">allowed_paths (one per line)</label>
            <textarea id="modal-allowed-paths" class="form-input" rows="2" style="font-family:monospace;font-size:11px;width:100%;resize:vertical">${escapeHtml(Array.isArray(spec.allowed_paths) ? spec.allowed_paths.join('\n') : (spec.allowed_paths || []).join('\n'))}</textarea>
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">forbidden_globs (one per line)</label>
            <textarea id="modal-forbidden-globs" class="form-input" rows="2" style="font-family:monospace;font-size:11px;width:100%;resize:vertical">${escapeHtml(Array.isArray(spec.forbidden_globs) ? spec.forbidden_globs.join('\n') : (spec.forbidden_globs || []).join('\n'))}</textarea>
          </div>
        </div>

        <div id="rubric-thresholds-container" style="margin-bottom:12px">
          ${thresholdsHtml}
        </div>

        <details style="margin-bottom:12px">
          <summary class="form-label" style="cursor:pointer">高级 (JSON)</summary>
          <div style="margin-top:8px">
            <label class="form-label">Task JSON (syntax validated on save)</label>
            <textarea id="modal-spec-json" class="code-editor" style="height:200px;font-family:monospace;font-size:12px" onblur="syncJsonToForm()">${escapeHtml(JSON.stringify(spec, null, 2))}</textarea>
            <div id="modal-json-error" style="color:#f85149;font-size:12px;margin-top:4px"></div>
          </div>
        </details>

        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
          ${spec.task_type ? `<button class="btn write-action" style="margin-right:auto;font-size:12px" onclick="openPromptForTaskType('${escapeHtml(spec.task_type)}')">Edit judge.prompt.${escapeHtml(spec.task_type)}.md</button>` : ''}
          <button class="btn" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary write-action" onclick="saveEditSpec('${escapeHtml(taskId)}')">Save</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();
  onChannelTypeChange();
  refreshModelSelector('coder').catch(() => {});
  refreshModelSelector('judge').catch(() => {});
}

// A2-5: Save edited spec
async function saveEditSpec(taskId) {
  const jsonStr = (document.getElementById('modal-spec-json').value || '').trim();
  const errEl = document.getElementById('modal-json-error');
  errEl.textContent = '';

  // E3: JSON syntax validation
  let spec;
  try {
    spec = JSON.parse(jsonStr);
  } catch (e) {
    errEl.textContent = 'JSON syntax error: ' + e.message;
    return;
  }

  // Override fields from form controls (adapter + model same as saveNewSpec)
  const channelTypeVal = document.getElementById('adapter-channel-type')?.value;
  if (channelTypeVal) spec.channel_type = channelTypeVal;
  let coderVal = document.getElementById('adapter-coder')?.value;
  let judgeVal = document.getElementById('adapter-judge')?.value;
  let coderModelVal = document.getElementById('adapter-coder-model')?.value;
  let judgeModelVal = document.getElementById('adapter-judge-model')?.value;
  if (channelTypeVal === 'ccb') {
    spec.coder = 'ccb';
    spec.judge = 'ccb';
    spec.coder_model = coderVal || 'codex';
    spec.judge_model = judgeVal || 'codex';
  } else {
    if (coderVal) spec.coder = coderVal;
    if (judgeVal) spec.judge = judgeVal;
    if (coderModelVal) spec.coder_model = coderModelVal; else if (spec.coder_model !== undefined) delete spec.coder_model;
    if (judgeModelVal) spec.judge_model = judgeModelVal; else if (spec.judge_model !== undefined) delete spec.judge_model;
  }
  const taskTypeVal = document.getElementById('modal-task-type')?.value;
  if (taskTypeVal) spec.task_type = taskTypeVal;
  const attemptContextModeVal = document.getElementById('modal-attempt-context-mode')?.value;
  if (attemptContextModeVal) spec.attempt_context_mode = attemptContextModeVal;
  const executionModeVal = document.getElementById('modal-execution-mode')?.value;
  if (executionModeVal) spec.execution_mode = executionModeVal;
  if (executionModeVal === 'semi-auto') {
    const executorEl = document.getElementById('collab-role-executor');
    const reviewerEl = document.getElementById('collab-role-reviewer');
    const designerEl = document.getElementById('collab-role-designer');
    const inspirationEl = document.getElementById('collab-role-inspiration');
    spec.collab_roles = {};
    if (executorEl?.value) spec.collab_roles.executor = executorEl.value;
    if (reviewerEl?.value) spec.collab_roles.reviewer = reviewerEl.value;
    if (designerEl?.value) spec.collab_roles.designer = designerEl.value;
    if (inspirationEl?.value) spec.collab_roles.inspiration = inspirationEl.value;
  } else if (spec.collab_roles !== undefined) delete spec.collab_roles;
  spec.task_id = taskId;

  // Repo & Git and structured fields from form
  const rp = document.getElementById('modal-repo-path')?.value?.trim();
  if (rp !== undefined && rp !== '') spec.repo_path = rp;
  const br = document.getElementById('modal-base-ref')?.value?.trim();
  if (br !== undefined && br !== '') spec.base_ref = br;
  const instructionVal = (document.getElementById('modal-instruction')?.value || '').trim();
  if (instructionVal) spec.goal = instructionVal;
  const acceptanceVal = document.getElementById('modal-acceptance')?.value?.trim();
  if (acceptanceVal) spec.acceptance = acceptanceVal.split(/\n/).map(s => s.trim()).filter(Boolean);
  const testCmdVal = document.getElementById('modal-test-cmd')?.value?.trim();
  if (testCmdVal !== undefined && testCmdVal !== '') spec.test_cmd = testCmdVal;
  const maxAttemptsVal = document.getElementById('modal-max-attempts')?.value;
  if (maxAttemptsVal !== undefined && maxAttemptsVal !== '') spec.max_attempts = Math.min(10, Math.max(1, parseInt(maxAttemptsVal, 10) || 3));
  const coderTimeoutVal = document.getElementById('modal-coder-timeout')?.value;
  if (coderTimeoutVal !== undefined && coderTimeoutVal !== '') spec.coder_timeout_seconds = Math.min(3600, Math.max(60, parseInt(coderTimeoutVal, 10) || 600));
  const judgeTimeoutVal = document.getElementById('modal-judge-timeout')?.value;
  if (judgeTimeoutVal !== undefined && judgeTimeoutVal !== '') spec.judge_timeout_seconds = Math.min(3600, Math.max(60, parseInt(judgeTimeoutVal, 10) || 300));
  const constraintsVal = (document.getElementById('modal-constraints')?.value || '').trim();
  if (constraintsVal) spec.constraints = constraintsVal.split(/\n/).map(s => s.trim()).filter(Boolean);
  const apRaw = document.getElementById('modal-allowed-paths')?.value?.trim();
  if (apRaw) {
    if (apRaw.startsWith('[')) { try { spec.allowed_paths = JSON.parse(apRaw); } catch {} }
    else { spec.allowed_paths = apRaw.split(/\n/).map(s => s.trim()).filter(Boolean); }
  }
  const fgRaw = document.getElementById('modal-forbidden-globs')?.value?.trim();
  if (fgRaw) {
    if (fgRaw.startsWith('[')) { try { spec.forbidden_globs = JSON.parse(fgRaw); } catch {} }
    else { spec.forbidden_globs = fgRaw.split(/\n/).map(s => s.trim()).filter(Boolean); }
  }

  // A4: merge thresholds from UI
  if (spec.task_type) {
    const thresholds = readThresholdsFromUI(spec.task_type);
    if (thresholds) spec.rubric_thresholds = thresholds;
  }

  try {
    const res = await fetch(`/api/task_specs/${encodeURIComponent(taskId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec })
    });
    const result = await res.json();
    if (!res.ok) {
      errEl.textContent = result.error || 'Validation failed';
      if (Array.isArray(result.errors) && result.errors.length) {
        errEl.innerHTML = escapeHtml(result.error || 'Validation failed') + '<br>' + result.errors.map(e => '• ' + escapeHtml(e)).join('<br>');
      }
      return;
    }
    closeModal();
    loadTaskSpecs();
  } catch (e) {
    errEl.textContent = 'Save failed: ' + (e.message || String(e));
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
    if (!Array.isArray(data) || data.length === 0) {
      list.innerHTML = '<div style="padding:6px 12px;font-size:12px;color:#8b949e">No prompts found</div>';
      return;
    }
    list.innerHTML = data.map(p => `
      <div class="sidebar-item" onclick="viewPrompt(${JSON.stringify(p.name)})" style="cursor:pointer">
        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <span style="font-size:10px;color:#8b949e;margin-left:4px">${escapeHtml(String(Math.round((p.size||0)/1024*10)/10))}KB</span>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = `<div style="padding:6px 12px;font-size:12px;color:#f85149">Load error: ${escapeHtml(e.message)}</div>`;
  }
}

// D2: View and edit a prompt in a modal
async function viewPrompt(name) {
  // Remove existing modal if any
  const old = document.getElementById('prompt-modal');
  if (old) old.remove();
  try {
    const res = await fetch(`/api/prompts/${encodeURIComponent(name)}`);
    const data = await res.json();
    if (data.error) { alert('Failed to load prompt: ' + data.error); return; }
    const modalHtml = `
      <div id="prompt-modal" class="modal-overlay" onclick="if(event.target===this)closePromptModal()">
        <div class="modal-box" style="max-width:800px;max-height:90vh;overflow-y:auto">
          <h3 style="margin-top:0">Edit Prompt: ${escapeHtml(name)}</h3>
          <textarea id="prompt-editor" class="code-editor" style="height:480px;font-family:monospace;font-size:12px;width:100%;box-sizing:border-box">${escapeHtml(data.content || '')}</textarea>
          <div id="prompt-save-notice" style="font-size:12px;color:#3fb950;margin-top:4px;min-height:16px"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
            <button class="btn" onclick="closePromptModal()">Cancel</button>
            <button class="btn btn-primary write-action" onclick="savePrompt(${JSON.stringify(escapeHtml(name))})">Save</button>
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
async function savePrompt(name) {
  const content = document.getElementById('prompt-editor')?.value;
  if (content === undefined) return;
  if (!confirm('Overwrite this prompt file? This action will be recorded in the audit log.')) return;
  const notice = document.getElementById('prompt-save-notice');
  if (notice) notice.textContent = '';
  try {
    const res = await fetch(`/api/prompts/${encodeURIComponent(name)}`, {
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
  const name = `judge.prompt.${taskType}.md`;
  await viewPrompt(name);
}

// Sidebar: add Prompts section
function renderPromptsSection() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  if (document.getElementById('prompts-section')) return;

  const section = document.createElement('div');
  section.id = 'prompts-section';
  section.innerHTML = `
    <div style="padding:12px 12px 4px;display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px">Prompts</div>
      <button class="btn" style="padding:2px 8px;font-size:11px" onclick="loadPrompts()">↺</button>
    </div>
    <div id="prompts-list" style="max-height:180px;overflow-y:auto;border-bottom:1px solid #30363d"></div>
    <div style="padding:4px 12px 12px;font-size:11px;color:#8b949e;font-style:italic">
      From prompts/
    </div>
  `;
  sidebar.appendChild(section);
  loadPrompts();
}

// ================================================================
// Sidebar: add Task Specs section
// ================================================================
function renderSpecsSection() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // Check if already rendered
  if (document.getElementById('specs-section')) return;

  const section = document.createElement('div');
  section.id = 'specs-section';
  section.innerHTML = `
    <div style="padding:12px 12px 4px;display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px">Task Specs</div>
      <button class="btn write-action" style="padding:2px 8px;font-size:11px" onclick="openNewSpecModal()">+ New</button>
    </div>
    <div id="task-specs-notice" style="padding:0 12px;font-size:11px;color:#58a6ff;min-height:14px"></div>
    <div id="task-specs-list" style="max-height:220px;overflow-y:auto;border-bottom:1px solid #30363d"></div>
    <div style="padding:4px 12px 12px;font-size:11px;color:#8b949e;font-style:italic">
      Specs from tasks/ and examples/
    </div>
  `;

  sidebar.appendChild(section);
  loadTaskSpecs();
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
    if (taskId) selectTask(taskId);
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
  await loadKnowledgeShardList();
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

// Initial load (K7-1: load health for read_only first so banner and button state are correct)
loadHealth().then(() => {
  loadTasks();
  renderSpecsSection();
  renderPromptsSection();
  updateReadOnlyBanner();
  document.getElementById('btn-settings')?.addEventListener('click', openSettingsPanel);
  document.getElementById('nav-tasks')?.addEventListener('click', () => switchView('tasks'));
  document.getElementById('nav-ccb')?.addEventListener('click', () => switchView('ccb'));
});
