const React = window.React;

function LaunchModeDialog({ open, defaultMode = 'ccb', onCancel, onConfirm }) {
  const [mode, setMode] = React.useState(defaultMode);
  const [remember, setRemember] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setMode(defaultMode || 'ccb');
      setRemember(false);
    }
  }, [open, defaultMode]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target.className === 'modal-overlay') onCancel && onCancel(); }}>
      <div className="modal-box" style={{ maxWidth: 460 }}>
        <h3 style={{ marginTop: 0 }}>选择启动模式</h3>
        <label style={{ display: 'block', marginBottom: 8 }}>
          <input type="radio" name="launch_mode" checked={mode === 'ccb'} onChange={() => setMode('ccb')} />
          <span style={{ marginLeft: 8 }}>CCB (Visual) - 可视化 agent 界面</span>
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <input type="radio" name="launch_mode" checked={mode === 'bridge'} onChange={() => setMode('bridge')} />
          <span style={{ marginLeft: 8 }}>Bridge (Non-Visual) - 后台执行，GUI 监控</span>
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span style={{ marginLeft: 8 }}>记住选择（使用 Settings 预设）</span>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={() => onCancel && onCancel()}>取消</button>
          <button className="btn btn-primary write-action" onClick={() => onConfirm && onConfirm({ launch_mode: mode, launch_mode_locked: remember })}>确认</button>
        </div>
      </div>
    </div>
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LaunchModeDialog };
} else {
  window.LaunchModeDialog = LaunchModeDialog;
}
