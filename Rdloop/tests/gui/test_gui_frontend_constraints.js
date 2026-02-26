#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const appJs = path.join(root, 'gui', 'public', 'app.js');
const taskEditor = path.join(root, 'gui', 'src', 'TaskEditor.jsx');

function mustContain(file, pattern, label) {
  const text = fs.readFileSync(file, 'utf8');
  if (!new RegExp(pattern, 'm').test(text)) {
    throw new Error(`Missing ${label} in ${file}`);
  }
}

mustContain(taskEditor, 'modal-executor-type', 'executor_type control');
mustContain(taskEditor, 'modal-session-mode', 'session_mode control');
mustContain(taskEditor, 'updateSessionModeConstraints', 'constraints updater');
mustContain(appJs, 'updateSessionModeConstraints', 'app constraint sync');
mustContain(appJs, 'spec\\.executor_type', 'executor_type save');
mustContain(appJs, 'spec\\.session_mode', 'session_mode save');

console.log('[gui_frontend_constraints] PASS');
