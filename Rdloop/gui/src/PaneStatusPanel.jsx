const React = window.React;
const { useEffect, useState } = React;

function truncateSessionId(id) {
  if (!id) return '';
  if (id.length <= 24) return id;
  return id.slice(0, 10) + '...' + id.slice(-10);
}

function PaneStatusPanel({ taskId, refreshMs = 5000 }) {
  const [panes, setPanes] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let timer = null;
    let stopped = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/task/${encodeURIComponent(taskId)}/panes`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load panes');
        if (!stopped) {
          setPanes(Array.isArray(data.panes) ? data.panes : []);
          setError('');
        }
      } catch (e) {
        if (!stopped) setError(e.message || 'Failed to load panes');
      }
      if (!stopped) timer = setTimeout(load, refreshMs);
    };

    load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, refreshMs]);

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h4 style={{ marginTop: 0 }}>Pane Status</h4>
      {error && <div style={{ color: '#f85149', marginBottom: 8 }}>{error}</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>pane</th>
            <th style={{ textAlign: 'left' }}>status</th>
            <th style={{ textAlign: 'left' }}>session_id</th>
            <th style={{ textAlign: 'left' }}>channel</th>
          </tr>
        </thead>
        <tbody>
          {panes.map((p) => (
            <tr key={p.pane || p.session_id}>
              <td>{p.pane}</td>
              <td>{p.status || 'waiting'}</td>
              <td title={p.session_id || ''}>{truncateSessionId(p.session_id || '')}</td>
              <td>{p.launch_mode === 'bridge' ? '⚙ Bridge' : '👁 CCB'}</td>
            </tr>
          ))}
          {panes.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: '#8b949e' }}>No panes</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PaneStatusPanel };
} else {
  window.PaneStatusPanel = PaneStatusPanel;
}
