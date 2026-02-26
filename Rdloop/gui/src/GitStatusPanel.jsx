/**
 * GitStatusPanel.jsx — v5 Git Status view: GET /api/task/:taskId/git-status
 * Shows worker branch states, contract_check, judge_scores.
 */
const React = window.React;
const { useState, useEffect } = React;

function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

async function api(path) {
  const r = await fetch('/api' + path);
  if (!r.ok) throw new Error(r.statusText || r.status);
  return r.json();
}

function GitStatusPanel({ taskId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!taskId) return;
    setError(null);
    api(`/task/${encodeURIComponent(taskId)}/git-status`)
      .then(setData)
      .catch((e) => setError(e.message || String(e)));
  }, [taskId]);

  if (!taskId) return <div style={{ color: '#8b949e', fontSize: 12 }}>Select a task to view Git Status.</div>;
  if (error) return <div style={{ color: '#f85149', fontSize: 12 }}>Git status unavailable: {escapeHtml(error)}</div>;
  if (!data) return <div style={{ color: '#8b949e', fontSize: 12 }}>Loading…</div>;

  let content = (
    <>
      <h4 style={{ margin: '0 0 8px' }}>Git Status: {escapeHtml(taskId)}</h4>
      {(data.workers && data.workers.length > 0) ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 4, borderBottom: '1px solid #30363d' }}>Branch</th>
              <th style={{ textAlign: 'left', padding: 4, borderBottom: '1px solid #30363d' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.workers.map((w) => {
              const statusColor = w.status === 'merged' ? '#3fb950' : w.status === 'changes_requested' ? '#f85149' : '#d29922';
              return (
                <tr key={w.branch}>
                  <td style={{ padding: 4, borderBottom: '1px solid #21262d', fontFamily: 'monospace' }}>{escapeHtml(w.branch)}</td>
                  <td style={{ padding: 4, borderBottom: '1px solid #21262d', color: statusColor }}>{escapeHtml(w.status)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div style={{ color: '#8b949e', fontSize: 12 }}>No git branches found for this task.</div>
      )}
      {data.contract_check && (
        <div style={{ marginTop: 8 }}>
          <strong>Contract Check:</strong>{' '}
          <span style={{ color: data.contract_check.pass ? '#3fb950' : '#f85149' }}>
            {data.contract_check.pass ? 'PASS' : 'FAIL'}
          </span>
        </div>
      )}
      {data.judge_scores && (
        <div style={{ marginTop: 8 }}>
          <strong>Judge Scores:</strong>
          <pre style={{ fontSize: 11, background: '#0d1117', padding: 8, borderRadius: 4, overflowX: 'auto' }}>
            {JSON.stringify(data.judge_scores, null, 2)}
          </pre>
        </div>
      )}
    </>
  );

  return <div id="git-status-panel-react">{content}</div>;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GitStatusPanel };
} else {
  window.GitStatusPanel = GitStatusPanel;
}
