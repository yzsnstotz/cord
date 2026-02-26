/**
 * LoopStatsPanel.jsx — v5 Loop Stats view: GET /api/loop-stats
 * Displays loop_stats.jsonl: loop_id, task attempts, duration, completed_at.
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

function LoopStatsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setError(null);
    api('/loop-stats')
      .then(setData)
      .catch(() => setError(null));
  }, []);

  if (error) return <div style={{ color: '#8b949e', fontSize: 12 }}>Loop stats unavailable.</div>;
  if (!data) return <div style={{ color: '#8b949e', fontSize: 12 }}>Loading…</div>;

  const stats = data.stats || [];

  let content = (
    <>
      <h4 style={{ margin: '0 0 8px' }}>Loop Stats</h4>
      {stats.length === 0 ? (
        <div style={{ color: '#8b949e', fontSize: 12 }}>No loop stats recorded yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 4, borderBottom: '1px solid #30363d' }}>Loop ID</th>
              <th style={{ textAlign: 'left', padding: 4, borderBottom: '1px solid #30363d' }}>Tasks</th>
              <th style={{ textAlign: 'left', padding: 4, borderBottom: '1px solid #30363d' }}>Attempts</th>
              <th style={{ textAlign: 'left', padding: 4, borderBottom: '1px solid #30363d' }}>Completed</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s, idx) => {
              const tasks = s.task_attempts || [];
              return tasks.length > 0 ? (
                tasks.map((t, j) => (
                  <tr key={`${idx}-${j}`}>
                    <td style={{ padding: 4, borderBottom: '1px solid #21262d', fontFamily: 'monospace' }}>{escapeHtml(s.loop_id || '')}</td>
                    <td style={{ padding: 4, borderBottom: '1px solid #21262d' }}>{escapeHtml(t.task_id || '')}</td>
                    <td style={{ padding: 4, borderBottom: '1px solid #21262d' }}>{t.actual_attempts ?? 0} / {t.max_attempts ?? '?'}</td>
                    <td style={{ padding: 4, borderBottom: '1px solid #21262d' }}>{escapeHtml(s.completed_at || '')}</td>
                  </tr>
                ))
              ) : (
                <tr key={idx}>
                  <td style={{ padding: 4, borderBottom: '1px solid #21262d', fontFamily: 'monospace' }}>{escapeHtml(s.loop_id || '')}</td>
                  <td colSpan={3} style={{ padding: 4, borderBottom: '1px solid #21262d', color: '#8b949e' }}>No task data</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );

  return <div id="loop-stats-panel-react">{content}</div>;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LoopStatsPanel };
} else {
  window.LoopStatsPanel = LoopStatsPanel;
}
