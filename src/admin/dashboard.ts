// ============================================================
// Admin Dashboard — Web UI for runtime security management
// Mounted at /admin on the gateway. Fully self-contained HTML.
// ============================================================

import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  getSettings,
  updateSettings,
  generateConfirmToken,
  type RuntimeSettings,
} from '../security/settings.js';
import { agentConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Admin');

export function createAdminRouter(): Router {
  const router = Router();

  // ---- API: Get all settings ---------------------------------
  router.get('/api/settings', (_req: Request, res: Response) => {
    const settings = getSettings();
    // Mask sensitive credentials in response
    const masked = maskCredentials(structuredClone(settings));
    res.json(masked);
  });

  // ---- API: Update settings ----------------------------------
  router.post('/api/settings', async (req: Request, res: Response) => {
    try {
      const { patch, confirmToken } = req.body;
      if (!patch || typeof patch !== 'object') {
        res.status(400).json({ error: 'Missing "patch" object in body' });
        return;
      }
      const result = await updateSettings(patch, confirmToken);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- API: Get confirmation token for dangerous change ------
  router.post('/api/settings/confirm', (req: Request, res: Response) => {
    const { dangerKey } = req.body;
    if (!dangerKey) {
      res.status(400).json({ error: 'Missing "dangerKey"' });
      return;
    }
    res.json({ token: generateConfirmToken(dangerKey) });
  });

  // ---- API: Audit logs ---------------------------------------
  router.get('/api/audit', async (req: Request, res: Response) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
      const logFile = path.join(agentConfig.workspace, 'logs', `audit-${date}.jsonl`);
      const raw = await fs.readFile(logFile, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      // Return last 200 entries (newest first)
      res.json(lines.reverse().slice(0, 200));
    } catch {
      res.json([]);
    }
  });

  // ---- API: List available audit log dates -------------------
  router.get('/api/audit/dates', async (_req: Request, res: Response) => {
    try {
      const logDir = path.join(agentConfig.workspace, 'logs');
      const files = await fs.readdir(logDir);
      const dates = files
        .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
        .map(f => f.replace('audit-', '').replace('.jsonl', ''))
        .sort()
        .reverse();
      res.json(dates);
    } catch {
      res.json([]);
    }
  });

  // ---- API: Integration test ---------------------------------
  router.post('/api/test-integration', async (req: Request, res: Response) => {
    const { type } = req.body;
    // Returns a simple connectivity check result
    res.json({ type, status: 'test_not_implemented', message: 'Save credentials first, then test from the agent CLI.' });
  });

  // ---- Dashboard HTML ----------------------------------------
  router.get('/', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(getDashboardHTML());
  });

  return router;
}

function maskCredentials(settings: RuntimeSettings): RuntimeSettings {
  const mask = (s: string) => s ? '••••' + s.slice(-4) : '';
  if (settings.integrations.email.pass) settings.integrations.email.pass = mask(settings.integrations.email.pass);
  if (settings.integrations.reddit.clientSecret) settings.integrations.reddit.clientSecret = mask(settings.integrations.reddit.clientSecret);
  if (settings.integrations.reddit.password) settings.integrations.reddit.password = mask(settings.integrations.reddit.password);
  if (settings.integrations.mastodon.accessToken) settings.integrations.mastodon.accessToken = mask(settings.integrations.mastodon.accessToken);
  if (settings.integrations.github.token) settings.integrations.github.token = mask(settings.integrations.github.token);
  return settings;
}

// ---- Self-contained Dashboard HTML ---------------------------

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;line-height:1.6}
  .container{max-width:960px;margin:0 auto;padding:20px}
  h1{color:#58a6ff;margin-bottom:8px;font-size:1.6em}
  h2{color:#8b949e;font-size:1.1em;margin:24px 0 12px;border-bottom:1px solid #21262d;padding-bottom:6px}
  .subtitle{color:#8b949e;font-size:.85em;margin-bottom:24px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
  .row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #21262d}
  .row:last-child{border-bottom:none}
  .row label{flex:1;font-size:.9em}
  .row .desc{color:#8b949e;font-size:.75em;display:block}
  .danger-label{color:#f85149;font-weight:600}
  .danger-desc{color:#f8514980}
  .toggle{position:relative;width:44px;height:24px;cursor:pointer}
  .toggle input{opacity:0;width:0;height:0}
  .toggle .slider{position:absolute;inset:0;background:#30363d;border-radius:12px;transition:.3s}
  .toggle .slider:before{content:"";position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#c9d1d9;border-radius:50%;transition:.3s}
  .toggle input:checked+.slider{background:#238636}
  .toggle input:checked+.slider:before{transform:translateX(20px)}
  input[type=text],input[type=number],input[type=password],select{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:4px;padding:6px 10px;font-size:.85em;width:180px}
  input:focus,select:focus{outline:none;border-color:#58a6ff}
  button{background:#238636;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:.85em}
  button:hover{background:#2ea043}
  button.danger{background:#da3633}
  button.danger:hover{background:#f85149}
  .warn-box{background:#f8514915;border:1px solid #f85149;border-radius:6px;padding:12px;margin:12px 0;color:#f85149;font-size:.85em}
  .warn-box strong{display:block;margin-bottom:4px}
  .status{font-size:.75em;padding:2px 8px;border-radius:10px;margin-left:8px}
  .status.on{background:#23863620;color:#3fb950}
  .status.off{background:#f8514915;color:#f85149}
  .tabs{display:flex;gap:4px;margin-bottom:16px}
  .tab{padding:8px 16px;background:#161b22;border:1px solid #30363d;border-radius:6px 6px 0 0;cursor:pointer;font-size:.85em;color:#8b949e}
  .tab.active{background:#0d1117;color:#58a6ff;border-bottom-color:#0d1117}
  .panel{display:none}
  .panel.active{display:block}
  .log-entry{font-family:'Cascadia Code',monospace;font-size:.75em;padding:4px 8px;border-bottom:1px solid #21262d}
  .log-entry .ts{color:#8b949e}
  .log-entry .blocked{color:#f85149;font-weight:600}
  .log-entry .tool{color:#58a6ff}
  .confirm-modal{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;z-index:100;display:none}
  .confirm-modal.show{display:flex}
  .confirm-box{background:#161b22;border:2px solid #f85149;border-radius:12px;padding:24px;max-width:480px;width:90%}
  .confirm-box h3{color:#f85149;margin-bottom:12px}
  .confirm-box p{font-size:.9em;margin-bottom:16px}
  .confirm-box .actions{display:flex;gap:8px;justify-content:flex-end}
  .save-banner{position:fixed;bottom:20px;right:20px;background:#238636;color:#fff;padding:12px 20px;border-radius:8px;font-size:.9em;opacity:0;transition:opacity .3s;pointer-events:none}
  .save-banner.show{opacity:1}
</style>
</head>
<body>
<div class="container">
<h1>🤖 Agent Admin Dashboard</h1>
<p class="subtitle">Runtime security & integration management. Changes take effect immediately.</p>

<div class="tabs">
  <div class="tab active" data-panel="security">🔒 Security</div>
  <div class="tab" data-panel="tools">🛠 Tool Permissions</div>
  <div class="tab" data-panel="integrations">🔌 Integrations</div>
  <div class="tab" data-panel="audit">📋 Audit Log</div>
</div>

<!-- SECURITY PANEL -->
<div class="panel active" id="security">
  <div class="card">
    <h2>Core Security</h2>
    <div class="row"><label>Sandbox Mode <span class="desc danger-desc">⚠ Disabling removes ALL shell command restrictions</span></label><label class="toggle"><input type="checkbox" data-key="sandboxEnabled" checked><span class="slider"></span></label></div>
    <div class="row"><label>SSRF Protection <span class="desc danger-desc">⚠ Disabling lets the agent reach internal networks & cloud metadata</span></label><label class="toggle"><input type="checkbox" data-key="ssrfProtectionEnabled" checked><span class="slider"></span></label></div>
    <div class="row"><label>Prompt Injection Guards <span class="desc">Wraps external content with anti-injection boundaries</span></label><label class="toggle"><input type="checkbox" data-key="promptInjectionGuards" checked><span class="slider"></span></label></div>
    <div class="row"><label>Gateway Authentication <span class="desc danger-desc">⚠ Disabling lets anyone on the network control the agent</span></label><label class="toggle"><input type="checkbox" data-key="gatewayAuthEnabled" checked><span class="slider"></span></label></div>
    <div class="row"><label>Audit Logging <span class="desc">Persistent log of every tool call</span></label><label class="toggle"><input type="checkbox" data-key="auditLogEnabled" checked><span class="slider"></span></label></div>
    <div class="row"><label>Allow Localhost Access <span class="desc danger-desc">⚠ DANGEROUS: Lets agent access localhost services (DBs, APIs)</span></label><label class="toggle"><input type="checkbox" data-key="allowLocalhost"><span class="slider"></span></label></div>
  </div>
  <div class="card">
    <h2>Limits</h2>
    <div class="row"><label>Shell Timeout (ms)</label><input type="number" data-key="shellTimeoutMs" value="30000" min="1000" max="300000"></div>
    <div class="row"><label>Max Tool Output (chars)</label><input type="number" data-key="maxToolOutputChars" value="50000" min="1000" max="500000"></div>
    <div class="row"><label>Gateway Rate Limit (req/min)</label><input type="number" data-key="gatewayRateLimitPerMin" value="60" min="1" max="1000"></div>
    <div class="row"><label>LLM Rate Limit (calls/min)</label><input type="number" data-key="llmRateLimitPerMin" value="30" min="1" max="200"></div>
    <div class="row"><label>Max Tool Calls / Message</label><input type="number" data-key="maxToolCallsPerMessage" value="20" min="1" max="100"></div>
  </div>
  <div class="card">
    <h2>Agent Behavior</h2>
    <div class="row"><label>Autonomy Level <span class="desc">Low=always asks, Medium=safe actions auto, High=full autonomy</span></label><select data-key="autonomyLevel"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select></div>
    <div class="row"><label>Agent Name</label><input type="text" data-key="agentName" value="Jarvis"></div>
  </div>
</div>

<!-- TOOL PERMISSIONS PANEL -->
<div class="panel" id="tools">
  <div class="card">
    <h2>Tool Categories</h2>
    <p style="font-size:.8em;color:#8b949e;margin-bottom:12px">Enable or disable entire categories of agent tools. Disabled tools will not appear in the LLM's tool list.</p>
    <div class="row"><label>🖥 Shell Commands <span class="desc">Execute terminal commands</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.shell" checked><span class="slider"></span></label></div>
    <div class="row"><label>📖 File Read <span class="desc">Read files within workspace</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.fileRead" checked><span class="slider"></span></label></div>
    <div class="row"><label>✏️ File Write <span class="desc">Create & modify files within workspace</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.fileWrite" checked><span class="slider"></span></label></div>
    <div class="row"><label>🌐 Web Fetch <span class="desc">HTTP requests to public URLs</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.webFetch" checked><span class="slider"></span></label></div>
    <div class="row"><label>🌍 Browser Control <span class="desc">Headless Chrome automation</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.browser" checked><span class="slider"></span></label></div>
    <div class="row"><label>📧 Email <span class="desc danger-desc">⚠ Can read & send email as you — configure in Integrations first</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.email"><span class="slider"></span></label></div>
    <div class="row"><label>📱 Social Media <span class="desc danger-desc">⚠ Can post publicly as you — configure in Integrations first</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.socialMedia"><span class="slider"></span></label></div>
    <div class="row"><label>⚡ System Control <span class="desc danger-desc">⚠ HIGHEST RISK: OS-level access (apps, clipboard, windows, processes)</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.systemControl"><span class="slider"></span></label></div>
  </div>
  <div class="card">
    <h2>Domain Filtering</h2>
    <div class="row"><label>Allowed Domains <span class="desc">Comma-separated. Empty = all public domains allowed.</span></label><input type="text" data-key="allowedDomains" style="width:300px" placeholder="e.g. github.com, api.openai.com"></div>
    <div class="row"><label>Blocked Domains <span class="desc">Always blocked, even if in allowed list.</span></label><input type="text" data-key="blockedDomains" style="width:300px" placeholder="e.g. evil.com"></div>
  </div>
</div>

<!-- INTEGRATIONS PANEL -->
<div class="panel" id="integrations">
  <div class="card">
    <h2>📧 Email (IMAP/SMTP)</h2>
    <p style="font-size:.8em;color:#8b949e;margin-bottom:12px">Works with Gmail, Outlook, Yahoo, or any IMAP/SMTP provider. Free — no API key needed.</p>
    <div class="row"><label>IMAP Host</label><input type="text" data-key="integrations.email.host" placeholder="imap.gmail.com"></div>
    <div class="row"><label>IMAP Port</label><input type="number" data-key="integrations.email.port" value="993"></div>
    <div class="row"><label>Username (email)</label><input type="text" data-key="integrations.email.user" placeholder="you@gmail.com"></div>
    <div class="row"><label>Password / App Password</label><input type="password" data-key="integrations.email.pass" placeholder="App password recommended"></div>
    <div class="row"><label>SMTP Host</label><input type="text" data-key="integrations.email.smtpHost" placeholder="smtp.gmail.com"></div>
    <div class="row"><label>SMTP Port</label><input type="number" data-key="integrations.email.smtpPort" value="587"></div>
  </div>
  <div class="card">
    <h2>🐙 GitHub (free API)</h2>
    <p style="font-size:.8em;color:#8b949e;margin-bottom:12px">Personal access token from github.com/settings/tokens (free, classic token with repo scope)</p>
    <div class="row"><label>Access Token</label><input type="password" data-key="integrations.github.token" placeholder="ghp_..."></div>
  </div>
  <div class="card">
    <h2>🐘 Mastodon (free API)</h2>
    <p style="font-size:.8em;color:#8b949e;margin-bottom:12px">Get a token from your instance: Preferences → Development → New Application</p>
    <div class="row"><label>Instance URL</label><input type="text" data-key="integrations.mastodon.instanceUrl" placeholder="https://mastodon.social"></div>
    <div class="row"><label>Access Token</label><input type="password" data-key="integrations.mastodon.accessToken"></div>
  </div>
  <div class="card">
    <h2>🤖 Reddit (free API)</h2>
    <p style="font-size:.8em;color:#8b949e;margin-bottom:12px">Create a "script" app at reddit.com/prefs/apps (free, 60 req/min)</p>
    <div class="row"><label>Client ID</label><input type="text" data-key="integrations.reddit.clientId"></div>
    <div class="row"><label>Client Secret</label><input type="password" data-key="integrations.reddit.clientSecret"></div>
    <div class="row"><label>Username</label><input type="text" data-key="integrations.reddit.username"></div>
    <div class="row"><label>Password</label><input type="password" data-key="integrations.reddit.password"></div>
  </div>
</div>

<!-- AUDIT LOG PANEL -->
<div class="panel" id="audit">
  <div class="card">
    <h2>Audit Log</h2>
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
      <select id="audit-date" style="width:200px"></select>
      <button onclick="loadAudit()">Load</button>
      <label style="font-size:.8em;margin-left:auto"><input type="checkbox" id="audit-blocked-only"> Show blocked only</label>
    </div>
    <div id="audit-log" style="max-height:500px;overflow-y:auto;font-family:monospace;font-size:.75em"></div>
  </div>
</div>

<!-- CONFIRMATION MODAL -->
<div class="confirm-modal" id="confirmModal">
  <div class="confirm-box">
    <h3>⚠️ Security Warning</h3>
    <p id="confirmMessage"></p>
    <div class="warn-box">
      <strong>Are you absolutely sure?</strong>
      This change reduces the security of your agent and may expose your system to risks.
    </div>
    <p style="font-size:.85em;margin:12px 0">Type <strong>CONFIRM</strong> to proceed:</p>
    <input type="text" id="confirmInput" style="width:100%;margin-bottom:12px" placeholder="Type CONFIRM">
    <div class="actions">
      <button onclick="cancelConfirm()">Cancel</button>
      <button class="danger" onclick="executeConfirm()">Apply Dangerous Change</button>
    </div>
  </div>
</div>

<div class="save-banner" id="saveBanner">✓ Settings saved</div>
</div>

<script>
const API = '/admin/api';
let settings = {};
let pendingConfirm = null;

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.panel).classList.add('active');
    if (tab.dataset.panel === 'audit') loadAuditDates();
  };
});

// Load settings
async function load() {
  const res = await fetch(API + '/settings', { headers: authHeaders() });
  settings = await res.json();
  populateUI(settings);
}

function authHeaders() {
  const token = localStorage.getItem('adminToken') || prompt('Enter gateway token (from workspace/.gateway-token):');
  if (token) localStorage.setItem('adminToken', token);
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

function populateUI(s) {
  document.querySelectorAll('[data-key]').forEach(el => {
    const keys = el.dataset.key.split('.');
    let val = s;
    for (const k of keys) { val = val?.[k]; }
    if (val === undefined) return;
    if (el.type === 'checkbox') el.checked = val;
    else if (Array.isArray(val)) el.value = val.join(', ');
    else el.value = val;
  });
}

// Save on change
document.querySelectorAll('[data-key]').forEach(el => {
  const event = el.type === 'checkbox' ? 'change' : 'blur';
  el.addEventListener(event, () => saveSetting(el));
});

async function saveSetting(el) {
  const keys = el.dataset.key.split('.');
  let value;
  if (el.type === 'checkbox') value = el.checked;
  else if (el.type === 'number') value = parseInt(el.value);
  else if (el.dataset.key.endsWith('Domains')) value = el.value.split(',').map(s => s.trim()).filter(Boolean);
  else value = el.value;

  // Build nested patch
  const patch = {};
  let obj = patch;
  for (let i = 0; i < keys.length - 1; i++) { obj[keys[i]] = {}; obj = obj[keys[i]]; }
  obj[keys[keys.length - 1]] = value;

  const res = await fetch(API + '/settings', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ patch })
  });
  const result = await res.json();

  if (result.requiresConfirm && result.requiresConfirm.length > 0) {
    // Revert the toggle
    if (el.type === 'checkbox') el.checked = !el.checked;
    // Show confirmation
    showConfirm(result.requiresConfirm[0], el, patch);
    return;
  }

  showSaved();
}

function showConfirm(message, el, patch) {
  pendingConfirm = { message, el, patch };
  document.getElementById('confirmMessage').textContent = message;
  document.getElementById('confirmInput').value = '';
  document.getElementById('confirmModal').classList.add('show');
}

function cancelConfirm() {
  pendingConfirm = null;
  document.getElementById('confirmModal').classList.remove('show');
}

async function executeConfirm() {
  if (document.getElementById('confirmInput').value !== 'CONFIRM') {
    alert('You must type CONFIRM exactly.');
    return;
  }
  const dangerKey = pendingConfirm.message.split(':')[0].trim();
  // Get confirmation token
  const tokenRes = await fetch(API + '/settings/confirm', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ dangerKey })
  });
  const { token } = await tokenRes.json();

  // Retry with token
  const res = await fetch(API + '/settings', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ patch: pendingConfirm.patch, confirmToken: token })
  });
  await res.json();

  if (pendingConfirm.el.type === 'checkbox') pendingConfirm.el.checked = !pendingConfirm.el.checked;
  document.getElementById('confirmModal').classList.remove('show');
  pendingConfirm = null;
  showSaved();
}

function showSaved() {
  const banner = document.getElementById('saveBanner');
  banner.classList.add('show');
  setTimeout(() => banner.classList.remove('show'), 2000);
}

// Audit logs
async function loadAuditDates() {
  const res = await fetch(API + '/audit/dates', { headers: authHeaders() });
  const dates = await res.json();
  const sel = document.getElementById('audit-date');
  sel.innerHTML = dates.map(d => '<option value="'+d+'">'+d+'</option>').join('');
  if (dates.length) loadAudit();
}

async function loadAudit() {
  const date = document.getElementById('audit-date').value;
  const res = await fetch(API + '/audit?date=' + date, { headers: authHeaders() });
  const entries = await res.json();
  const blockedOnly = document.getElementById('audit-blocked-only').checked;
  const filtered = blockedOnly ? entries.filter(e => e.blocked) : entries;
  const html = filtered.map(e => {
    const cls = e.blocked ? 'blocked' : 'tool';
    return '<div class="log-entry"><span class="ts">' + e.timestamp + '</span> '
      + '<span class="' + cls + '">' + (e.blocked ? '🚫 BLOCKED ' : '') + (e.tool || e.action) + '</span> '
      + (e.reason || '') + '</div>';
  }).join('');
  document.getElementById('audit-log').innerHTML = html || '<p style="color:#8b949e;padding:20px">No entries</p>';
}

document.getElementById('audit-blocked-only').onchange = loadAudit;

// Init
load();
</script>
</body></html>`;
}
