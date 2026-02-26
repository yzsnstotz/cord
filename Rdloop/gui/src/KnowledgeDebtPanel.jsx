/**
 * KnowledgeDebtPanel.jsx — v5 Knowledge Debt view: GET /api/knowledge/shards/debt
 * Shows debt shard entries grouped by severity and loop_id.
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

function KnowledgeDebtPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setError(null);
    api('/knowledge/shards/debt')
      .then(setData)
      .catch(() => setError(null)); // 404 or missing treated as empty
  }, []);

  if (error) return <div style={{ color: '#8b949e', fontSize: 12 }}>No debt data available.</div>;
  if (!data) return <div style={{ color: '#8b949e', fontSize: 12 }}>Loading…</div>;

  const total = data.total ?? (data.entries ? Object.keys(data.entries).length : 0);
  const bySeverity = data.by_severity || {};

  let content = (
    <>
      <h4 style={{ margin: '0 0 8px' }}>Knowledge Debt</h4>
      {total === 0 || !data.entries || Object.keys(data.entries).length === 0 ? (
        <div style={{ color: '#8b949e', fontSize: 12 }}>No debt entries found.</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 8 }}>{total} entries total</div>
          {Object.entries(bySeverity).map(([sev, entries]) => {
            const sevColor = sev === 'high' ? '#f85149' : sev === 'medium' ? '#d29922' : '#8b949e';
            return (
              <div key={sev} style={{ marginBottom: 8 }}>
                <strong style={{ color: sevColor }}>{escapeHtml(sev)}</strong> ({Array.isArray(entries) ? entries.length : 0})
                <ul style={{ margin: '4px 0', paddingLeft: 16, fontSize: 12 }}>
                  {(Array.isArray(entries) ? entries : []).map((e) => (
                    <li key={e.key || e.file}>
                      <code>{escapeHtml(e.key || e.file)}</code>: {escapeHtml(e.summary || e.description || '(no summary)')}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </>
      )}
    </>
  );

  return <div id="knowledge-debt-panel-react">{content}</div>;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KnowledgeDebtPanel };
} else {
  window.KnowledgeDebtPanel = KnowledgeDebtPanel;
}
