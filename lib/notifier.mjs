import { spawn } from 'node:child_process';

let messageBoxShown = false;

function isEnabled() {
  const value = process.env.LOG_MESSAGE_BOX;
  if (value === undefined || value === null || value === '') {
    return true;
  }

  const normalized = String(value).toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

function quoteAppleScript(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')}"`;
}

export function showMessageBox({ title, message }) {
  if (messageBoxShown || !isEnabled()) {
    return;
  }

  messageBoxShown = true;

  if (process.platform !== 'darwin') {
    return;
  }

  const script = `display dialog ${quoteAppleScript(message)} with title ${quoteAppleScript(title)} buttons {"OK"} default button "OK" with icon caution`;

  try {
    const child = spawn('osascript', ['-e', script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // 无法弹窗时静默降级
  }
}
