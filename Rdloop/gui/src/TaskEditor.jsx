/**
 * TaskEditor.jsx — v5 task form: Executor Type × Session Mode (replaces workflow_mode)
 * Constraint: API Call => Continuous disabled; Solo/Multi => Fresh and Iterative disabled.
 */
const React = window.React;
const { useState, useEffect, useCallback } = React;

function escapeHtml(str) {
  if (str == null) return '';
  const s = String(str);
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function TaskEditor({ initialSpec = {}, onSave, onCancel }) {
  const [executorType, setExecutorType] = useState(initialSpec.executor_type || 'solo_agent');
  const [sessionMode, setSessionMode] = useState(initialSpec.session_mode || 'continuous');
  const [taskId, setTaskId] = useState(initialSpec.task_id || '');
  const [goal, setGoal] = useState(initialSpec.goal || initialSpec.instruction || '');
  const [acceptance, setAcceptance] = useState(Array.isArray(initialSpec.acceptance_criteria)
    ? (initialSpec.acceptance_criteria || []).join('\n')
    : (initialSpec.acceptance || ''));
  const [testCmd, setTestCmd] = useState(initialSpec.test_cmd || '');
  const [maxAttempts, setMaxAttempts] = useState(initialSpec.max_attempts ?? initialSpec.agent_config?.max_attempts ?? 3);

  // Resolve initial from v4 workflow_mode for backward compat
  useEffect(() => {
    const wm = initialSpec.workflow_mode;
    if (wm && !initialSpec.executor_type) {
      if (wm === 'single') { setExecutorType('api_call'); setSessionMode('fresh'); }
      else if (wm === 'solo') { setExecutorType('solo_agent'); setSessionMode('continuous'); }
      else if (wm === 'collab') { setExecutorType('multi_agent'); setSessionMode('continuous'); }
    }
  }, [initialSpec.workflow_mode, initialSpec.executor_type]);

  const updateSessionModeConstraints = useCallback((execType) => {
    setExecutorType(execType);
    if (execType === 'api_call') {
      if (sessionMode === 'continuous') setSessionMode('iterative');
    } else if (execType === 'solo_agent' || execType === 'multi_agent') {
      if (sessionMode === 'fresh' || sessionMode === 'iterative') setSessionMode('continuous');
    }
  }, [sessionMode]);

  const isContinuousDisabled = executorType === 'api_call';
  const isFreshDisabled = executorType === 'solo_agent' || executorType === 'multi_agent';
  const isIterativeDisabled = executorType === 'solo_agent' || executorType === 'multi_agent';

  const handleSubmit = (e) => {
    e.preventDefault();
    const spec = {
      task_id: taskId,
      executor_type: executorType,
      session_mode: sessionMode,
      goal,
      acceptance: acceptance.split('\n').filter(Boolean),
      acceptance_criteria: acceptance.split('\n').filter(Boolean),
      test_cmd: testCmd,
      max_attempts: Number(maxAttempts) || 3,
      agent_config: {
        max_attempts: Number(maxAttempts) || 3,
        auto_pass_threshold: initialSpec.agent_config?.auto_pass_threshold ?? 0.85,
        knowledge_shards: initialSpec.agent_config?.knowledge_shards || [],
        provider: initialSpec.agent_config?.provider || '',
      },
    };
    if (executorType === 'multi_agent' && initialSpec.collab_roles) {
      spec.collab_roles = initialSpec.collab_roles;
    }
    onSave(spec);
  };

  return (
    <div className="modal-box" style={{ maxWidth: '800px', maxHeight: '90vh', overflowY: 'auto' }}>
      <h3 style={{ marginTop: 0 }}>New Task Spec (v5)</h3>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 12 }}>
          <label className="form-label">Executor Type (v5)</label>
          <select
            id="modal-executor-type"
            className="form-select"
            value={executorType}
            onChange={(e) => updateSessionModeConstraints(e.target.value)}
          >
            <option value="api_call">API Call — single-flow LLM via CLI proxy</option>
            <option value="solo_agent">Solo Agent — autonomous agent loop</option>
            <option value="multi_agent">Multi Agent — collaborative multi-worker</option>
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label className="form-label">Session Mode (v5)</label>
          <select
            id="modal-session-mode"
            className="form-select"
            value={sessionMode}
            onChange={(e) => setSessionMode(e.target.value)}
          >
            <option value="fresh" disabled={isFreshDisabled}>Fresh — each attempt from scratch</option>
            <option value="iterative" disabled={isIterativeDisabled}>Iterative — carry context across attempts</option>
            <option value="continuous" disabled={isContinuousDisabled}>Continuous — persistent agent session</option>
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label className="form-label">Task ID</label>
          <input
            type="text"
            id="modal-task-id"
            className="form-input"
            placeholder="my_new_task"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label className="form-label">Goal / instruction</label>
          <textarea
            id="modal-instruction"
            className="form-input"
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            style={{ width: '100%', resize: 'vertical' }}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label className="form-label">Acceptance (one per line)</label>
          <textarea
            id="modal-acceptance"
            className="form-input"
            rows={2}
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            style={{ width: '100%', resize: 'vertical' }}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label className="form-label">test_cmd</label>
          <input
            type="text"
            id="modal-test-cmd"
            className="form-input"
            value={testCmd}
            onChange={(e) => setTestCmd(e.target.value)}
            placeholder="bash run_tests.sh"
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label className="form-label">max_attempts</label>
          <input
            type="number"
            id="modal-max-attempts"
            className="form-input"
            min={1}
            max={10}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(e.target.value)}
            style={{ width: 80 }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="submit" className="btn write-action">Save</button>
          {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        </div>
      </form>
    </div>
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TaskEditor };
} else {
  window.TaskEditor = TaskEditor;
}
