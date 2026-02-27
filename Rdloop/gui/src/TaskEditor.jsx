/**
 * TaskEditor.jsx — v5.1 task form: Task Type + Launch Mode
 */
const React = window.React;
const { useState, useMemo } = React;

function mapLegacyWorkflowMode(workflowMode) {
  if (workflowMode === 'single') return 'copywriting';
  if (workflowMode === 'solo') return 'solo';
  if (workflowMode === 'collab') return 'multi_agent';
  return '';
}

function providersEqual(roles) {
  const vals = Object.values(roles || {}).filter(Boolean).map(v => String(v).toLowerCase());
  return vals.length <= 1 || new Set(vals).size === 1;
}

function TaskEditor({ initialSpec = {}, onSave, onCancel, readOnly = false }) {
  const initialTaskType = initialSpec.task_type || mapLegacyWorkflowMode(initialSpec.workflow_mode) || 'solo';
  const [taskType, setTaskType] = useState(initialTaskType);
  const [taskId, setTaskId] = useState(initialSpec.task_id || '');
  const [goal, setGoal] = useState(initialSpec.goal || initialSpec.instruction || '');
  const [acceptance, setAcceptance] = useState(Array.isArray(initialSpec.acceptance_criteria)
    ? initialSpec.acceptance_criteria.join('\n')
    : (Array.isArray(initialSpec.acceptance) ? initialSpec.acceptance.join('\n') : (initialSpec.acceptance || '')));
  const [testCmd, setTestCmd] = useState(initialSpec.test_cmd || 'true');
  const [launchMode, setLaunchMode] = useState(initialSpec.launch_mode || 'ccb');
  const [launchModeLocked, setLaunchModeLocked] = useState(initialSpec.launch_mode_locked === true);
  const [maxAttempts, setMaxAttempts] = useState(initialSpec.max_attempts ?? initialSpec.agent_config?.max_attempts ?? 3);
  const [autoPassThreshold, setAutoPassThreshold] = useState(initialSpec.agent_config?.auto_pass_threshold ?? 0.85);
  const [inspirationTrigger, setInspirationTrigger] = useState(initialSpec.agent_config?.inspiration_trigger_attempts ?? 3);

  const [roles, setRoles] = useState(() => ({
    pm: initialSpec.collab_roles?.pm || initialSpec.agent_config?.provider || 'claude',
    designer: initialSpec.collab_roles?.designer || initialSpec.agent_config?.provider || 'claude',
    executor: initialSpec.collab_roles?.executor || initialSpec.agent_config?.provider || 'claude',
    reviewer: initialSpec.collab_roles?.reviewer || initialSpec.agent_config?.provider || 'claude',
    inspiration: initialSpec.collab_roles?.inspiration || 'gemini'
  }));
  const [soloProvider, setSoloProvider] = useState(initialSpec.agent_config?.provider || roles.pm || 'claude');

  const roleWarning = useMemo(() => {
    if (taskType !== 'solo') return '';
    return providersEqual(roles) ? '' : 'Solo mode requires one provider for all roles.';
  }, [taskType, roles]);

  const legacyNotices = useMemo(() => {
    const notices = [];
    if (initialSpec.workflow_mode && !initialSpec.task_type) {
      notices.push(`Legacy workflow_mode detected: ${initialSpec.workflow_mode} -> mapped to ${initialTaskType}`);
    }
    if (initialSpec.executor_type !== undefined) {
      notices.push(`Deprecated field detected: executor_type=${initialSpec.executor_type} (ignored by v5.1 routing)`);
    }
    if (initialSpec.session_mode !== undefined) {
      notices.push(`Deprecated field detected: session_mode=${initialSpec.session_mode} (ignored by v5.1 routing)`);
    }
    return notices;
  }, [initialSpec, initialTaskType]);

  const setRole = (role, provider) => {
    const next = { ...roles, [role]: provider };
    setRoles(next);
  };

  const effectiveRoles = useMemo(() => {
    if (taskType === 'copywriting') {
      return { executor: roles.executor || 'claude', reviewer: roles.reviewer || 'claude' };
    }
    if (taskType === 'solo') {
      const p = soloProvider || 'claude';
      return { pm: p, designer: p, executor: p, reviewer: p };
    }
    return {
      pm: roles.pm || 'claude',
      designer: roles.designer || 'claude',
      executor: roles.executor || 'claude',
      reviewer: roles.reviewer || 'claude',
      inspiration: roles.inspiration || 'gemini'
    };
  }, [taskType, roles, soloProvider]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const spec = {
      task_id: taskId,
      schema_version: 'v51',
      task_type: taskType,
      launch_mode: launchMode,
      launch_mode_locked: launchModeLocked,
      goal,
      acceptance: acceptance.split('\n').map(s => s.trim()).filter(Boolean),
      test_cmd: testCmd,
      collab_roles: effectiveRoles,
      agent_config: {
        max_attempts: Number(maxAttempts) || 3,
        auto_pass_threshold: Number(autoPassThreshold),
        knowledge_shards: initialSpec.agent_config?.knowledge_shards || [],
        provider: taskType === 'solo' ? soloProvider : (initialSpec.agent_config?.provider || effectiveRoles.executor || 'claude'),
        inspiration_trigger_attempts: Number(inspirationTrigger)
      }
    };
    onSave(spec);
  };

  const providerOptions = ['claude', 'codex', 'gemini', 'opencode', 'droid'];
  const renderProviderSelect = (value, onChange) => (
    <select className="form-select" value={value} onChange={onChange} disabled={readOnly}>
      {providerOptions.map(p => <option key={p} value={p}>{p}</option>)}
    </select>
  );

  return (
    <div className="modal-box" style={{ maxWidth: '880px', maxHeight: '90vh', overflowY: 'auto' }}>
      <h3 style={{ marginTop: 0 }}>Task Spec (v5.1)</h3>
      {legacyNotices.length > 0 && (
        <div style={{ marginBottom: 10, fontSize: 12, color: '#8b949e' }}>
          {legacyNotices.map((msg, idx) => (
            <div key={`${msg}-${idx}`}>{msg}</div>
          ))}
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 12 }}>
          <label className="form-label">Task Type</label>
          <select id="modal-task-type" className="form-select" value={taskType} onChange={(e) => setTaskType(e.target.value)} disabled={readOnly}>
            <option value="copywriting">Copywriting</option>
            <option value="solo">Solo</option>
            <option value="multi_agent">Multi Agent</option>
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className="form-label">Launch Mode</label>
          <select id="modal-launch-mode" className="form-select" value={launchMode} onChange={(e) => setLaunchMode(e.target.value)} disabled={readOnly}>
            <option value="ccb">CCB (Visual)</option>
            <option value="bridge">Bridge (Non-Visual)</option>
          </select>
          <label style={{ display: 'inline-flex', gap: 8, marginTop: 8 }}>
            <input
              id="modal-launch-mode-locked"
              type="checkbox"
              checked={launchModeLocked}
              onChange={(e) => setLaunchModeLocked(e.target.checked)}
              disabled={readOnly}
            />
            <span>使用默认启动模式</span>
          </label>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className="form-label">Task ID</label>
          <input id="modal-task-id" type="text" className="form-input" value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={readOnly} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className="form-label">Goal</label>
          <textarea id="modal-goal" className="form-input" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} disabled={readOnly} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className="form-label">Acceptance (one per line)</label>
          <textarea id="modal-acceptance" className="form-input" rows={3} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} disabled={readOnly} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className="form-label">test_cmd</label>
          <input id="modal-test-cmd" type="text" className="form-input" value={testCmd} onChange={(e) => setTestCmd(e.target.value)} disabled={readOnly} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label className="form-label">max_attempts</label>
            <input id="modal-max-attempts" type="number" min={1} max={10} className="form-input" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} disabled={readOnly} />
          </div>
          <div>
            <label className="form-label">auto_pass (0-1)</label>
            <input id="modal-auto-pass" type="number" min={0} max={1} step={0.05} className="form-input" value={autoPassThreshold} onChange={(e) => setAutoPassThreshold(e.target.value)} disabled={readOnly} />
          </div>
          <div>
            <label className="form-label">inspiration trigger</label>
            <input id="modal-inspiration-trigger" type="number" min={1} max={10} className="form-input" value={inspirationTrigger} onChange={(e) => setInspirationTrigger(e.target.value)} disabled={readOnly} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className="form-label">collab_roles</label>
          {taskType === 'copywriting' && (
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8 }}>
              <div>executor</div>{renderProviderSelect(roles.executor, (e) => setRole('executor', e.target.value))}
              <div>reviewer</div>{renderProviderSelect(roles.reviewer, (e) => setRole('reviewer', e.target.value))}
            </div>
          )}
          {taskType === 'solo' && (
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8 }}>
              <div>provider</div>{renderProviderSelect(soloProvider, (e) => setSoloProvider(e.target.value))}
            </div>
          )}
          {taskType === 'multi_agent' && (
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8 }}>
              <div>pm</div>{renderProviderSelect(roles.pm, (e) => setRole('pm', e.target.value))}
              <div>designer</div>{renderProviderSelect(roles.designer, (e) => setRole('designer', e.target.value))}
              <div>executor</div>{renderProviderSelect(roles.executor, (e) => setRole('executor', e.target.value))}
              <div>reviewer</div>{renderProviderSelect(roles.reviewer, (e) => setRole('reviewer', e.target.value))}
              <div>inspiration</div>{renderProviderSelect(roles.inspiration, (e) => setRole('inspiration', e.target.value))}
            </div>
          )}
          {roleWarning && <div style={{ marginTop: 8, color: '#f85149', fontSize: 12 }}>{roleWarning}</div>}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="submit" className="btn write-action" disabled={readOnly}>Save</button>
          {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        </div>
      </form>
    </div>
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TaskEditor, mapLegacyWorkflowMode };
} else {
  window.TaskEditor = TaskEditor;
}
