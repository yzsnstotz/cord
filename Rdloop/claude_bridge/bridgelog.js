/**
 * Bridge communication logger: appends Claude bridge IPC events to
 * BRIDGELOG_DIR/claude_bridge_comm.log (default: cwd/bridgelog).
 * Each line is JSON: ts_iso, event, from, to, id?, type?, payload preview, etc.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.BRIDGELOG_DIR
  ? path.resolve(process.env.BRIDGELOG_DIR)
  : path.resolve(process.cwd(), 'bridgelog');
const LOG_FILE = path.join(DIR, 'claude_bridge_comm.log');

function _ensureDir() {
  if (!fs.existsSync(DIR)) {
    fs.mkdirSync(DIR, { recursive: true });
  }
}

function _append(entry) {
  try {
    _ensureDir();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    // ignore
  }
}

function logEvent(event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...data
  };
  _append(entry);
}

module.exports = {
  logEvent,
  DIR,
  LOG_FILE
};
