// ============================================================
// System Control — OS-level automation tools
// Windows: PowerShell | macOS: osascript | Linux: xdotool/xclip
// ============================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { registerTool } from './registry.js';
import { isToolAllowed } from '../security/settings.js';
import { audit, SecurityError } from '../security/guard.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SystemCtl');
const execAsync = promisify(exec);
const PLATFORM = os.platform(); // 'win32' | 'darwin' | 'linux'

function guardSystemControl(): void {
  if (!isToolAllowed('systemControl')) {
    throw new SecurityError(
      'System control tools are disabled. Enable them in the admin dashboard (⚠ high risk).'
    );
  }
}

// ---- Clipboard -----------------------------------------------

registerTool(
  {
    name: 'clipboard_read',
    description: 'Read the current system clipboard contents.',
    parameters: { type: 'object', properties: {} },
  },
  async () => {
    guardSystemControl();
    const cmd = PLATFORM === 'win32' ? 'powershell -command "Get-Clipboard"'
              : PLATFORM === 'darwin' ? 'pbpaste'
              : 'xclip -selection clipboard -o';
    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    await audit({ action: 'system_clipboard_read' });
    return stdout.slice(0, 10_000) || '(clipboard empty)';
  },
);

registerTool(
  {
    name: 'clipboard_write',
    description: 'Write text to the system clipboard.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to copy' } },
      required: ['text'],
    },
  },
  async (input) => {
    guardSystemControl();
    const text = (input.text as string).replace(/"/g, '\\"');
    const cmd = PLATFORM === 'win32' ? `powershell -command "Set-Clipboard -Value '${text.replace(/'/g, "''")}'"`
              : PLATFORM === 'darwin' ? `echo "${text}" | pbcopy`
              : `echo "${text}" | xclip -selection clipboard`;
    await execAsync(cmd, { timeout: 5000 });
    await audit({ action: 'system_clipboard_write' });
    return 'Copied to clipboard.';
  },
);

// ---- Notifications -------------------------------------------

registerTool(
  {
    name: 'send_notification',
    description: 'Show a desktop notification (toast/alert).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        message: { type: 'string', description: 'Notification body' },
      },
      required: ['title', 'message'],
    },
  },
  async (input) => {
    guardSystemControl();
    const title = (input.title as string).replace(/"/g, '\\"').slice(0, 200);
    const msg = (input.message as string).replace(/"/g, '\\"').slice(0, 500);

    let cmd: string;
    if (PLATFORM === 'win32') {
      cmd = `powershell -command "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle='${title.replace(/'/g, "''")}'; $n.BalloonTipText='${msg.replace(/'/g, "''")}'; $n.Visible=$true; $n.ShowBalloonTip(5000)"`;
    } else if (PLATFORM === 'darwin') {
      cmd = `osascript -e 'display notification "${msg}" with title "${title}"'`;
    } else {
      cmd = `notify-send "${title}" "${msg}" 2>/dev/null || echo "sent"`;
    }
    await execAsync(cmd, { timeout: 10_000 });
    await audit({ action: 'system_notification', input: { title } });
    return `Notification sent: "${title}"`;
  },
);

// ---- Application Management ----------------------------------

registerTool(
  {
    name: 'open_application',
    description: 'Launch a desktop application by name.',
    parameters: {
      type: 'object',
      properties: { app: { type: 'string', description: 'Application name or path (e.g., "notepad", "Firefox", "code")' } },
      required: ['app'],
    },
  },
  async (input) => {
    guardSystemControl();
    const app = input.app as string;
    // Block shell metacharacters
    if (/[;&|`$(){}]/.test(app)) throw new SecurityError('Invalid characters in app name');

    let cmd: string;
    if (PLATFORM === 'win32') {
      cmd = `start "" "${app}"`;
    } else if (PLATFORM === 'darwin') {
      cmd = `open -a "${app}"`;
    } else {
      cmd = `nohup ${app} &>/dev/null &`;
    }
    await execAsync(cmd, { timeout: 10_000 });
    await audit({ action: 'system_open_app', input: { app } });
    return `Launched: ${app}`;
  },
);

registerTool(
  {
    name: 'list_processes',
    description: 'List running processes with their PID and name.',
    parameters: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Optional name filter' } },
    },
  },
  async (input) => {
    guardSystemControl();
    const filter = input.filter as string | undefined;
    let cmd: string;
    if (PLATFORM === 'win32') {
      cmd = filter
        ? `tasklist /FI "IMAGENAME eq *${filter}*" /FO CSV /NH`
        : 'tasklist /FO CSV /NH';
    } else {
      cmd = filter
        ? `ps aux | grep -i "${filter}" | grep -v grep | head -30`
        : 'ps aux --sort=-pcpu | head -30';
    }
    const { stdout } = await execAsync(cmd, { timeout: 10_000 });
    await audit({ action: 'system_list_processes' });
    return stdout.slice(0, 10_000);
  },
);

// ---- System Info ---------------------------------------------

registerTool(
  {
    name: 'system_info',
    description: 'Get system information: OS, CPU, memory, disk, network.',
    parameters: { type: 'object', properties: {} },
  },
  async () => {
    guardSystemControl();
    const info = [
      `Platform: ${os.platform()} ${os.arch()}`,
      `OS: ${os.type()} ${os.release()}`,
      `Hostname: ${os.hostname()}`,
      `CPU: ${os.cpus()[0]?.model} (${os.cpus().length} cores)`,
      `Memory: ${(os.freemem() / 1e9).toFixed(1)}GB free / ${(os.totalmem() / 1e9).toFixed(1)}GB total`,
      `Uptime: ${(os.uptime() / 3600).toFixed(1)} hours`,
      `User: ${os.userInfo().username}`,
      `Home: ${os.homedir()}`,
    ].join('\n');
    await audit({ action: 'system_info' });
    return info;
  },
);

// ---- Open URL in default browser -----------------------------

registerTool(
  {
    name: 'open_url',
    description: 'Open a URL in the user\'s default web browser.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open' } },
      required: ['url'],
    },
  },
  async (input) => {
    guardSystemControl();
    const url = input.url as string;
    // Validate URL
    try { new URL(url); } catch { throw new SecurityError('Invalid URL'); }
    if (!/^https?:\/\//.test(url)) throw new SecurityError('Only http/https URLs allowed');

    const cmd = PLATFORM === 'win32' ? `start "" "${url}"`
              : PLATFORM === 'darwin' ? `open "${url}"`
              : `xdg-open "${url}" 2>/dev/null`;
    await execAsync(cmd, { timeout: 10_000 });
    await audit({ action: 'system_open_url', input: { url } });
    return `Opened in browser: ${url}`;
  },
);

// ---- Take screenshot -----------------------------------------

registerTool(
  {
    name: 'take_screenshot',
    description: 'Capture a screenshot of the current desktop.',
    parameters: {
      type: 'object',
      properties: { output: { type: 'string', description: 'Output filename (default: screenshot.png)' } },
    },
  },
  async (input) => {
    guardSystemControl();
    const filename = (input.output as string) || `screenshot-${Date.now()}.png`;
    // Path is handled within workspace by the caller

    let cmd: string;
    if (PLATFORM === 'win32') {
      cmd = `powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${filename}') }"`;
    } else if (PLATFORM === 'darwin') {
      cmd = `screencapture -x "${filename}"`;
    } else {
      cmd = `import -window root "${filename}" 2>/dev/null || scrot "${filename}" 2>/dev/null || echo "no screenshot tool"`;
    }
    await execAsync(cmd, { timeout: 10_000 });
    await audit({ action: 'system_screenshot' });
    return `Screenshot saved: ${filename}`;
  },
);

log.info(`System control tools registered (platform: ${PLATFORM})`);
