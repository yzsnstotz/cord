const React = window.React;
const { useState } = React;

function TaskDetail({ task, onRun }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const runNow = async () => {
    if (!task) return;
    const r = await fetch(`/api/tasks/${encodeURIComponent(task.task_id)}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Run failed');
    }
    onRun && onRun();
  };

  const handleRunClick = async () => {
    if (!task) return;
    if (task.launch_mode_locked === true) {
      await runNow();
      return;
    }
    setDialogOpen(true);
  };

  const handleDialogConfirm = async ({ launch_mode, launch_mode_locked }) => {
    if (!task) return;
    const r = await fetch(`/api/task/${encodeURIComponent(task.task_id)}/launch-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launch_mode, launch_mode_locked })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Failed to set launch mode');
    }
    setDialogOpen(false);
    await runNow();
  };

  if (!task) return null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{task.task_id}</h3>
        <button className="btn btn-primary write-action" onClick={handleRunClick}>Run</button>
      </div>
      <div style={{ marginTop: 8, fontSize: 12 }}>
        task_type: <code>{task.task_type || 'n/a'}</code> | launch_mode: <code>{task.launch_mode || 'ccb'}</code>
      </div>
      <PaneStatusPanel taskId={task.task_id} refreshMs={5000} />
      <LaunchModeDialog
        open={dialogOpen}
        defaultMode={task.launch_mode || 'ccb'}
        onCancel={() => setDialogOpen(false)}
        onConfirm={handleDialogConfirm}
      />
    </div>
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TaskDetail };
} else {
  window.TaskDetail = TaskDetail;
}
