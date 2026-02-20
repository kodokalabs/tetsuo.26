// ============================================================
// Admin Dashboard — Web UI for full agent management
// Security, tasks, costs, triggers, agents, audit — all in one.
// ============================================================

import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  getSettings, updateSettings, generateConfirmToken,
  type RuntimeSettings,
} from '../security/settings.js';
import { getAllTasks, getTasksByStatus, getTask, getSubtasks, updateTaskStatus, deleteTask } from '../tasks/queue.js';
import { getPendingApprovals, getAllApprovals, resolveApproval } from '../tasks/approvals.js';
import { getTodayUsage, getHistoricalUsage, getCostConfig, setCostConfig } from '../tasks/costs.js';
import { getAllTriggers, deleteTrigger, toggleTrigger } from '../triggers/engine.js';
import { getActiveAgents } from '../orchestrator/planner.js';
import { getRoutes } from '../orchestrator/router.js';
import { agentConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Admin');

export function createAdminRouter(): Router {
  const router = Router();

  // ---- Settings APIs -----------------------------------------
  router.get('/api/settings', (_req, res) => {
    res.json(maskCredentials(structuredClone(getSettings())));
  });

  router.post('/api/settings', async (req, res) => {
    try {
      const { patch, confirmToken } = req.body;
      if (!patch) { res.status(400).json({ error: 'Missing patch' }); return; }
      res.json(await updateSettings(patch, confirmToken));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/api/settings/confirm', (req, res) => {
    const { dangerKey } = req.body;
    if (!dangerKey) { res.status(400).json({ error: 'Missing dangerKey' }); return; }
    res.json({ token: generateConfirmToken(dangerKey) });
  });

  // ---- Task APIs ---------------------------------------------
  router.get('/api/tasks', (req, res) => {
    const status = req.query.status as string | undefined;
    const tasks = status ? getTasksByStatus(status as any) : getAllTasks();
    res.json(tasks.slice(0, 100));
  });

  router.get('/api/tasks/:id', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) { res.status(404).json({ error: 'Not found' }); return; }
    const subtasks = getSubtasks(task.id);
    res.json({ ...task, subtasks });
  });

  router.post('/api/tasks/:id/action', async (req, res) => {
    try {
      const { action } = req.body;
      const task = getTask(req.params.id);
      if (!task) { res.status(404).json({ error: 'Not found' }); return; }
      if (action === 'cancel') await updateTaskStatus(task.id, 'cancelled');
      else if (action === 'pause') await updateTaskStatus(task.id, 'paused');
      else if (action === 'resume') await updateTaskStatus(task.id, 'pending');
      else if (action === 'delete') await deleteTask(task.id);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ---- Approval APIs -----------------------------------------
  router.get('/api/approvals', (_req, res) => {
    res.json(getAllApprovals().slice(0, 50));
  });

  router.post('/api/approvals/:id', async (req, res) => {
    try {
      const { decision } = req.body;
      const result = await resolveApproval(req.params.id, decision, 'admin');
      res.json(result || { error: 'Not found or already resolved' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ---- Cost APIs ---------------------------------------------
  router.get('/api/costs/today', (_req, res) => { res.json(getTodayUsage()); });

  router.get('/api/costs/history', async (req, res) => {
    const days = parseInt(req.query.days as string) || 30;
    res.json(await getHistoricalUsage(days));
  });

  router.get('/api/costs/config', (_req, res) => { res.json(getCostConfig()); });

  router.post('/api/costs/config', async (req, res) => {
    try {
      await setCostConfig(req.body);
      res.json(getCostConfig());
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ---- Trigger APIs ------------------------------------------
  router.get('/api/triggers', (_req, res) => { res.json(getAllTriggers()); });

  router.post('/api/triggers/:id/toggle', async (req, res) => {
    try {
      const { enabled } = req.body;
      const result = await toggleTrigger(req.params.id, enabled);
      res.json(result || { error: 'Not found' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/api/triggers/:id', async (req, res) => {
    const ok = await deleteTrigger(req.params.id);
    res.json({ ok });
  });

  // ---- Agent APIs --------------------------------------------
  router.get('/api/agents', (_req, res) => {
    res.json({ agents: getActiveAgents(), routes: getRoutes() });
  });

  // ---- Audit APIs --------------------------------------------
  router.get('/api/audit', async (req, res) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
      const logFile = path.join(agentConfig.workspace, 'logs', `audit-${date}.jsonl`);
      const raw = await fs.readFile(logFile, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      res.json(lines.reverse().slice(0, 200));
    } catch { res.json([]); }
  });

  router.get('/api/audit/dates', async (_req, res) => {
    try {
      const logDir = path.join(agentConfig.workspace, 'logs');
      const files = await fs.readdir(logDir);
      const dates = files.filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
        .map(f => f.replace('audit-', '').replace('.jsonl', '')).sort().reverse();
      res.json(dates);
    } catch { res.json([]); }
  });

  // ---- Dashboard HTML ----------------------------------------
  router.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(getDashboardHTML());
  });

  return router;
}

function maskCredentials(s: RuntimeSettings): RuntimeSettings {
  const m = (v: string) => v ? '••••' + v.slice(-4) : '';
  if (s.integrations.email.pass) s.integrations.email.pass = m(s.integrations.email.pass);
  if (s.integrations.reddit.clientSecret) s.integrations.reddit.clientSecret = m(s.integrations.reddit.clientSecret);
  if (s.integrations.reddit.password) s.integrations.reddit.password = m(s.integrations.reddit.password);
  if (s.integrations.mastodon.accessToken) s.integrations.mastodon.accessToken = m(s.integrations.mastodon.accessToken);
  if (s.integrations.github.token) s.integrations.github.token = m(s.integrations.github.token);
  return s;
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;line-height:1.6}
.container{max-width:1060px;margin:0 auto;padding:20px}
h1{color:#58a6ff;margin-bottom:4px;font-size:1.5em}
h2{color:#8b949e;font-size:1em;margin:20px 0 10px;border-bottom:1px solid #21262d;padding-bottom:5px}
.sub{color:#8b949e;font-size:.8em;margin-bottom:20px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:14px}
.row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #21262d}
.row:last-child{border-bottom:none}
.row label{flex:1;font-size:.85em}
.desc{color:#8b949e;font-size:.72em;display:block}
.danger-desc{color:#f8514080}
.toggle{position:relative;width:40px;height:22px;cursor:pointer}
.toggle input{opacity:0;width:0;height:0}
.toggle .sl{position:absolute;inset:0;background:#30363d;border-radius:11px;transition:.3s}
.toggle .sl:before{content:"";position:absolute;height:16px;width:16px;left:3px;bottom:3px;background:#c9d1d9;border-radius:50%;transition:.3s}
.toggle input:checked+.sl{background:#238636}
.toggle input:checked+.sl:before{transform:translateX(18px)}
input[type=text],input[type=number],input[type=password],select{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:4px;padding:5px 8px;font-size:.8em;width:160px}
input:focus,select:focus{outline:none;border-color:#58a6ff}
button{background:#238636;color:#fff;border:none;border-radius:5px;padding:6px 14px;cursor:pointer;font-size:.8em;margin:2px}
button:hover{background:#2ea043}
button.danger{background:#da3633}
button.danger:hover{background:#f85149}
button.sm{padding:3px 8px;font-size:.72em}
.tabs{display:flex;gap:3px;margin-bottom:14px;flex-wrap:wrap}
.tab{padding:7px 14px;background:#161b22;border:1px solid #30363d;border-radius:5px 5px 0 0;cursor:pointer;font-size:.8em;color:#8b949e}
.tab.active{background:#0d1117;color:#58a6ff;border-bottom-color:#0d1117}
.panel{display:none}.panel.active{display:block}
.badge{font-size:.7em;padding:2px 6px;border-radius:8px;font-weight:600}
.b-green{background:#23863620;color:#3fb950}
.b-red{background:#f8514915;color:#f85149}
.b-yellow{background:#d2992220;color:#d29922}
.b-blue{background:#58a6ff20;color:#58a6ff}
.b-gray{background:#30363d;color:#8b949e}
table{width:100%;border-collapse:collapse;font-size:.8em}
th{text-align:left;color:#8b949e;padding:6px 8px;border-bottom:1px solid #30363d}
td{padding:5px 8px;border-bottom:1px solid #21262d}
.bar{display:flex;height:8px;background:#21262d;border-radius:4px;overflow:hidden;min-width:80px}
.bar-fill{background:#238636;border-radius:4px;transition:width .3s}
.mono{font-family:'Cascadia Code',monospace;font-size:.72em}
.cost-big{font-size:1.8em;font-weight:700;color:#58a6ff}
.cost-label{font-size:.75em;color:#8b949e}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.warn-box{background:#f8514915;border:1px solid #f85149;border-radius:6px;padding:10px;margin:10px 0;color:#f85149;font-size:.8em}
.confirm-modal{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;z-index:100;display:none}
.confirm-modal.show{display:flex}
.confirm-box{background:#161b22;border:2px solid #f85149;border-radius:12px;padding:24px;max-width:480px;width:90%}
.confirm-box h3{color:#f85149;margin-bottom:12px}
.confirm-box .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.save-banner{position:fixed;bottom:20px;right:20px;background:#238636;color:#fff;padding:10px 18px;border-radius:8px;font-size:.85em;opacity:0;transition:opacity .3s;pointer-events:none}
.save-banner.show{opacity:1}
</style></head><body>
<div class="container">
<h1>🤖 Agent Admin Dashboard</h1>
<p class="sub">Runtime management — security, tasks, costs, triggers, agents, audit</p>

<div class="tabs">
  <div class="tab active" data-p="security">🔒 Security</div>
  <div class="tab" data-p="tools">🛠 Tools</div>
  <div class="tab" data-p="integrations">🔌 Integrations</div>
  <div class="tab" data-p="tasks">📋 Tasks</div>
  <div class="tab" data-p="agents">🧠 Agents</div>
  <div class="tab" data-p="costs">💰 Costs</div>
  <div class="tab" data-p="triggers">⚡ Triggers</div>
  <div class="tab" data-p="audit">📜 Audit</div>
</div>

<!-- SECURITY -->
<div class="panel active" id="security">
<div class="card">
<h2>Core Security</h2>
<div class="row"><label>Sandbox Mode <span class="desc danger-desc">⚠ Disabling removes shell command filtering</span></label><label class="toggle"><input type="checkbox" data-key="sandboxEnabled" checked><span class="sl"></span></label></div>
<div class="row"><label>SSRF Protection <span class="desc danger-desc">⚠ Disabling exposes internal networks</span></label><label class="toggle"><input type="checkbox" data-key="ssrfProtectionEnabled" checked><span class="sl"></span></label></div>
<div class="row"><label>Prompt Injection Guards</label><label class="toggle"><input type="checkbox" data-key="promptInjectionGuards" checked><span class="sl"></span></label></div>
<div class="row"><label>Gateway Auth <span class="desc danger-desc">⚠ Disabling exposes the agent to network</span></label><label class="toggle"><input type="checkbox" data-key="gatewayAuthEnabled" checked><span class="sl"></span></label></div>
<div class="row"><label>Audit Logging</label><label class="toggle"><input type="checkbox" data-key="auditLogEnabled" checked><span class="sl"></span></label></div>
<div class="row"><label>Allow Localhost <span class="desc danger-desc">⚠ Exposes local services</span></label><label class="toggle"><input type="checkbox" data-key="allowLocalhost"><span class="sl"></span></label></div>
</div>
<div class="card">
<h2>Limits</h2>
<div class="row"><label>Shell Timeout (ms)</label><input type="number" data-key="shellTimeoutMs" value="30000"></div>
<div class="row"><label>Max Tool Output (chars)</label><input type="number" data-key="maxToolOutputChars" value="50000"></div>
<div class="row"><label>Gateway Rate (req/min)</label><input type="number" data-key="gatewayRateLimitPerMin" value="60"></div>
<div class="row"><label>LLM Rate (calls/min)</label><input type="number" data-key="llmRateLimitPerMin" value="30"></div>
<div class="row"><label>Max Tool Calls/Message</label><input type="number" data-key="maxToolCallsPerMessage" value="20"></div>
</div>
<div class="card">
<h2>Agent</h2>
<div class="row"><label>Autonomy <span class="desc">low=ask always, medium=safe auto, high=full auto</span></label><select data-key="autonomyLevel"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select></div>
<div class="row"><label>Agent Name</label><input type="text" data-key="agentName"></div>
</div></div>

<!-- TOOLS -->
<div class="panel" id="tools">
<div class="card">
<h2>Tool Categories</h2>
<div class="row"><label>🖥 Shell</label><label class="toggle"><input type="checkbox" data-key="toolPermissions.shell" checked><span class="sl"></span></label></div>
<div class="row"><label>📖 File Read</label><label class="toggle"><input type="checkbox" data-key="toolPermissions.fileRead" checked><span class="sl"></span></label></div>
<div class="row"><label>✏️ File Write</label><label class="toggle"><input type="checkbox" data-key="toolPermissions.fileWrite" checked><span class="sl"></span></label></div>
<div class="row"><label>🌐 Web Fetch</label><label class="toggle"><input type="checkbox" data-key="toolPermissions.webFetch" checked><span class="sl"></span></label></div>
<div class="row"><label>🌍 Browser</label><label class="toggle"><input type="checkbox" data-key="toolPermissions.browser" checked><span class="sl"></span></label></div>
<div class="row"><label>📧 Email <span class="desc danger-desc">⚠ reads/sends as you</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.email"><span class="sl"></span></label></div>
<div class="row"><label>📱 Social Media <span class="desc danger-desc">⚠ posts publicly as you</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.socialMedia"><span class="sl"></span></label></div>
<div class="row"><label>⚡ System Control <span class="desc danger-desc">⚠ HIGHEST RISK: OS access</span></label><label class="toggle"><input type="checkbox" data-key="toolPermissions.systemControl"><span class="sl"></span></label></div>
</div>
<div class="card">
<h2>Domain Filtering</h2>
<div class="row"><label>Allowed Domains</label><input type="text" data-key="allowedDomains" style="width:300px" placeholder="empty = all public"></div>
<div class="row"><label>Blocked Domains</label><input type="text" data-key="blockedDomains" style="width:300px"></div>
</div></div>

<!-- INTEGRATIONS -->
<div class="panel" id="integrations">
<div class="card"><h2>📧 Email (IMAP/SMTP)</h2>
<div class="row"><label>IMAP Host</label><input type="text" data-key="integrations.email.host" placeholder="imap.gmail.com"></div>
<div class="row"><label>Port</label><input type="number" data-key="integrations.email.port" value="993"></div>
<div class="row"><label>Email</label><input type="text" data-key="integrations.email.user"></div>
<div class="row"><label>Password</label><input type="password" data-key="integrations.email.pass"></div>
<div class="row"><label>SMTP Host</label><input type="text" data-key="integrations.email.smtpHost" placeholder="smtp.gmail.com"></div>
<div class="row"><label>SMTP Port</label><input type="number" data-key="integrations.email.smtpPort" value="587"></div>
</div>
<div class="card"><h2>🐙 GitHub</h2><div class="row"><label>Token</label><input type="password" data-key="integrations.github.token" placeholder="ghp_..."></div></div>
<div class="card"><h2>🐘 Mastodon</h2>
<div class="row"><label>Instance</label><input type="text" data-key="integrations.mastodon.instanceUrl" placeholder="https://mastodon.social"></div>
<div class="row"><label>Token</label><input type="password" data-key="integrations.mastodon.accessToken"></div>
</div>
<div class="card"><h2>🤖 Reddit</h2>
<div class="row"><label>Client ID</label><input type="text" data-key="integrations.reddit.clientId"></div>
<div class="row"><label>Client Secret</label><input type="password" data-key="integrations.reddit.clientSecret"></div>
<div class="row"><label>Username</label><input type="text" data-key="integrations.reddit.username"></div>
<div class="row"><label>Password</label><input type="password" data-key="integrations.reddit.password"></div>
</div></div>

<!-- TASKS -->
<div class="panel" id="tasks">
<div class="card">
<h2>Task Queue</h2>
<div style="display:flex;gap:6px;margin-bottom:10px">
<button onclick="loadTasks()">Refresh</button>
<select id="task-filter"><option value="">All</option><option value="running">Running</option><option value="pending">Pending</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="waiting_approval">Awaiting Approval</option></select>
</div>
<table><thead><tr><th>Status</th><th>Task</th><th>Progress</th><th>Cost</th><th>Actions</th></tr></thead><tbody id="task-table"></tbody></table>
</div>
<div class="card">
<h2>Pending Approvals</h2>
<div id="approvals-list"></div>
</div></div>

<!-- AGENTS -->
<div class="panel" id="agents">
<div class="card">
<h2>Active Sub-Agents</h2>
<table><thead><tr><th>Name</th><th>Role</th><th>Model</th><th>Status</th><th>Tokens</th><th>Cost</th></tr></thead><tbody id="agents-table"></tbody></table>
</div>
<div class="card">
<h2>Model Routes</h2>
<table><thead><tr><th>Tier</th><th>Provider</th><th>Model</th><th>$/1K In</th><th>$/1K Out</th></tr></thead><tbody id="routes-table"></tbody></table>
</div></div>

<!-- COSTS -->
<div class="panel" id="costs">
<div class="card">
<div class="grid">
<div><span class="cost-big" id="cost-today">$0.00</span><br><span class="cost-label">Today</span></div>
<div><span class="cost-big" id="cost-calls">0</span><br><span class="cost-label">Calls today</span></div>
<div><span class="cost-big" id="cost-tokens">0</span><br><span class="cost-label">Tokens today</span></div>
<div><span class="cost-big" id="cost-budget">∞</span><br><span class="cost-label">Daily budget</span></div>
</div></div>
<div class="card">
<h2>Budget Settings</h2>
<div class="row"><label>Daily Budget ($)</label><input type="number" id="budget-daily" step="0.5" value="0" min="0"></div>
<div class="row"><label>Weekly Budget ($)</label><input type="number" id="budget-weekly" step="1" value="0" min="0"></div>
<div class="row"><label>Hard Stop (block calls at limit)</label><label class="toggle"><input type="checkbox" id="budget-hardstop"><span class="sl"></span></label></div>
<button onclick="saveBudget()">Save Budget</button>
</div>
<div class="card">
<h2>Usage History</h2>
<div id="cost-history" style="max-height:300px;overflow-y:auto"></div>
</div></div>

<!-- TRIGGERS -->
<div class="panel" id="triggers">
<div class="card">
<h2>Event Triggers</h2>
<table><thead><tr><th>Enabled</th><th>Name</th><th>Type</th><th>Fired</th><th>Last</th><th>Actions</th></tr></thead><tbody id="trigger-table"></tbody></table>
<div id="no-triggers" style="color:#8b949e;padding:12px;font-size:.85em">No triggers configured. Create them via the agent CLI.</div>
</div></div>

<!-- AUDIT -->
<div class="panel" id="audit">
<div class="card">
<h2>Audit Log</h2>
<div style="display:flex;gap:6px;margin-bottom:10px;align-items:center">
<select id="audit-date" style="width:180px"></select>
<button onclick="loadAudit()">Load</button>
<label style="font-size:.75em;margin-left:auto"><input type="checkbox" id="audit-blocked"> Blocked only</label>
</div>
<div id="audit-log" style="max-height:500px;overflow-y:auto"></div>
</div></div>

<!-- CONFIRM MODAL -->
<div class="confirm-modal" id="cModal"><div class="confirm-box">
<h3>⚠️ Security Warning</h3><p id="cMsg"></p>
<div class="warn-box"><strong>Are you sure?</strong> This reduces agent security.</div>
<p style="font-size:.85em;margin:10px 0">Type <strong>CONFIRM</strong>:</p>
<input type="text" id="cInput" style="width:100%;margin-bottom:10px">
<div class="actions"><button onclick="cancelC()">Cancel</button><button class="danger" onclick="execC()">Apply</button></div>
</div></div>
<div class="save-banner" id="saveBanner">✓ Saved</div>
</div>

<script>
const A='/admin/api';
let settings={}, pendingC=null;
function authH(){const t=localStorage.getItem('at')||prompt('Gateway token (from workspace/.gateway-token):');if(t)localStorage.setItem('at',t);return{'Authorization':'Bearer '+t,'Content-Type':'application/json'}}
function showSaved(){const b=document.getElementById('saveBanner');b.classList.add('show');setTimeout(()=>b.classList.remove('show'),1500)}

// Tabs
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');document.getElementById(t.dataset.p).classList.add('active');
  if(t.dataset.p==='tasks'){loadTasks();loadApprovals();}
  if(t.dataset.p==='agents')loadAgents();
  if(t.dataset.p==='costs')loadCosts();
  if(t.dataset.p==='triggers')loadTriggers();
  if(t.dataset.p==='audit')loadAuditDates();
});

// Settings
async function loadS(){const r=await fetch(A+'/settings',{headers:authH()});settings=await r.json();popS(settings);}
function popS(s){document.querySelectorAll('[data-key]').forEach(el=>{const ks=el.dataset.key.split('.');let v=s;for(const k of ks)v=v?.[k];if(v===undefined)return;if(el.type==='checkbox')el.checked=v;else if(Array.isArray(v))el.value=v.join(', ');else el.value=v;});}
document.querySelectorAll('[data-key]').forEach(el=>{el.addEventListener(el.type==='checkbox'?'change':'blur',()=>saveS(el));});
async function saveS(el){const ks=el.dataset.key.split('.');let v;if(el.type==='checkbox')v=el.checked;else if(el.type==='number')v=parseInt(el.value);else if(el.dataset.key.endsWith('Domains'))v=el.value.split(',').map(s=>s.trim()).filter(Boolean);else v=el.value;
const p={};let o=p;for(let i=0;i<ks.length-1;i++){o[ks[i]]={};o=o[ks[i]];}o[ks[ks.length-1]]=v;
const r=await fetch(A+'/settings',{method:'POST',headers:authH(),body:JSON.stringify({patch:p})});const res=await r.json();
if(res.requiresConfirm?.length){if(el.type==='checkbox')el.checked=!el.checked;showC(res.requiresConfirm[0],el,p);return;}showSaved();}
function showC(m,el,p){pendingC={m,el,p};document.getElementById('cMsg').textContent=m;document.getElementById('cInput').value='';document.getElementById('cModal').classList.add('show');}
function cancelC(){pendingC=null;document.getElementById('cModal').classList.remove('show');}
async function execC(){if(document.getElementById('cInput').value!=='CONFIRM'){alert('Type CONFIRM');return;}
const dk=pendingC.m.split(':')[0].trim();const tr=await fetch(A+'/settings/confirm',{method:'POST',headers:authH(),body:JSON.stringify({dangerKey:dk})});const{token}=await tr.json();
await fetch(A+'/settings',{method:'POST',headers:authH(),body:JSON.stringify({patch:pendingC.patch,confirmToken:token})});
if(pendingC.el.type==='checkbox')pendingC.el.checked=!pendingC.el.checked;document.getElementById('cModal').classList.remove('show');pendingC=null;showSaved();}

// Tasks
async function loadTasks(){const f=document.getElementById('task-filter').value;const r=await fetch(A+'/tasks'+(f?'?status='+f:''),{headers:authH()});const tasks=await r.json();
const tb=document.getElementById('task-table');
tb.innerHTML=tasks.map(t=>{const bc=t.status==='completed'?'b-green':t.status==='failed'?'b-red':t.status==='running'?'b-blue':'b-gray';
return '<tr><td><span class="badge '+bc+'">'+t.status+'</span></td><td>'+t.title+'<br><span class="mono">'+t.id.slice(0,8)+'</span></td><td><div class="bar"><div class="bar-fill" style="width:'+t.progress+'%"></div></div> '+t.progress+'%</td><td>$'+(t.usage?.estimatedCost||0).toFixed(3)+'</td><td>'+(t.status==='running'?'<button class="sm danger" onclick="taskAct(\\''+t.id+'\\',\\'cancel\\')">Cancel</button>':'')+(t.status==='paused'?'<button class="sm" onclick="taskAct(\\''+t.id+'\\',\\'resume\\')">Resume</button>':'')+'</td></tr>';}).join('')||'<tr><td colspan="5" style="color:#8b949e">No tasks</td></tr>';}
async function taskAct(id,action){await fetch(A+'/tasks/'+id+'/action',{method:'POST',headers:authH(),body:JSON.stringify({action})});loadTasks();}
document.getElementById('task-filter').onchange=loadTasks;

// Approvals
async function loadApprovals(){const r=await fetch(A+'/approvals',{headers:authH()});const all=await r.json();const pending=all.filter(a=>a.status==='pending');
const d=document.getElementById('approvals-list');
if(!pending.length){d.innerHTML='<p style="color:#8b949e;font-size:.85em">No pending approvals</p>';return;}
d.innerHTML=pending.map(a=>'<div class="card" style="border-color:#d29922"><strong>'+a.proposedAction.tool+'</strong> <span class="badge b-yellow">'+a.riskLevel+'</span><br><span class="desc">'+a.proposedAction.reasoning+'</span><br><span class="desc">'+a.riskExplanation+'</span><div style="margin-top:6px"><button onclick="resolveA(\\''+a.id+'\\',\\'approved\\')">✅ Approve</button> <button class="danger" onclick="resolveA(\\''+a.id+'\\',\\'rejected\\')">❌ Reject</button></div></div>').join('');}
async function resolveA(id,d){await fetch(A+'/approvals/'+id,{method:'POST',headers:authH(),body:JSON.stringify({decision:d})});loadApprovals();loadTasks();}

// Agents
async function loadAgents(){const r=await fetch(A+'/agents',{headers:authH()});const{agents,routes}=await r.json();
document.getElementById('agents-table').innerHTML=agents.length?agents.map(a=>'<tr><td>'+a.name+'</td><td>'+a.role+'</td><td>'+a.provider+'/'+a.model+'</td><td><span class="badge '+(a.status==='busy'?'b-green':'b-gray')+'">'+a.status+'</span></td><td>'+(a.usage.inputTokens+a.usage.outputTokens)+'</td><td>$'+a.usage.estimatedCost.toFixed(4)+'</td></tr>').join(''):'<tr><td colspan="6" style="color:#8b949e">No active sub-agents</td></tr>';
document.getElementById('routes-table').innerHTML=routes.map(r=>'<tr><td><span class="badge b-blue">'+r.tier+'</span></td><td>'+r.provider+'</td><td>'+r.model+'</td><td>$'+r.costPer1kInput+'</td><td>$'+r.costPer1kOutput+'</td></tr>').join('');}

// Costs
async function loadCosts(){const[today,config,history]=await Promise.all([
  fetch(A+'/costs/today',{headers:authH()}).then(r=>r.json()),
  fetch(A+'/costs/config',{headers:authH()}).then(r=>r.json()),
  fetch(A+'/costs/history?days=14',{headers:authH()}).then(r=>r.json()),
]);
document.getElementById('cost-today').textContent='$'+today.estimatedCost.toFixed(2);
document.getElementById('cost-calls').textContent=today.callCount;
document.getElementById('cost-tokens').textContent=(today.inputTokens+today.outputTokens).toLocaleString();
document.getElementById('cost-budget').textContent=config.dailyBudget?'$'+config.dailyBudget:'∞';
document.getElementById('budget-daily').value=config.dailyBudget;
document.getElementById('budget-weekly').value=config.weeklyBudget;
document.getElementById('budget-hardstop').checked=config.hardStop;
const hd=document.getElementById('cost-history');
hd.innerHTML='<table><thead><tr><th>Date</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>'+
history.reverse().map(d=>'<tr><td>'+d.date+'</td><td>'+d.callCount+'</td><td>'+(d.inputTokens+d.outputTokens).toLocaleString()+'</td><td>$'+d.estimatedCost.toFixed(4)+'</td></tr>').join('')+'</tbody></table>';}
async function saveBudget(){await fetch(A+'/costs/config',{method:'POST',headers:authH(),body:JSON.stringify({
  dailyBudget:parseFloat(document.getElementById('budget-daily').value)||0,
  weeklyBudget:parseFloat(document.getElementById('budget-weekly').value)||0,
  hardStop:document.getElementById('budget-hardstop').checked
})});loadCosts();showSaved();}

// Triggers
async function loadTriggers(){const r=await fetch(A+'/triggers',{headers:authH()});const trigs=await r.json();
const tb=document.getElementById('trigger-table');const nt=document.getElementById('no-triggers');
if(!trigs.length){tb.innerHTML='';nt.style.display='block';return;}
nt.style.display='none';
tb.innerHTML=trigs.map(t=>'<tr><td><label class="toggle"><input type="checkbox" '+(t.enabled?'checked':'')+' onchange="togTrig(\\''+t.id+'\\',this.checked)"><span class="sl"></span></label></td><td>'+t.name+'</td><td><span class="badge b-blue">'+t.type+'</span></td><td>'+t.triggerCount+'</td><td>'+(t.lastTriggered?new Date(t.lastTriggered).toISOString().slice(0,16):'never')+'</td><td><button class="sm danger" onclick="delTrig(\\''+t.id+'\\')">Delete</button></td></tr>').join('');}
async function togTrig(id,en){await fetch(A+'/triggers/'+id+'/toggle',{method:'POST',headers:authH(),body:JSON.stringify({enabled:en})});}
async function delTrig(id){if(!confirm('Delete this trigger?'))return;await fetch(A+'/triggers/'+id,{method:'DELETE',headers:authH()});loadTriggers();}

// Audit
async function loadAuditDates(){const r=await fetch(A+'/audit/dates',{headers:authH()});const dates=await r.json();
document.getElementById('audit-date').innerHTML=dates.map(d=>'<option>'+d+'</option>').join('');if(dates.length)loadAudit();}
async function loadAudit(){const d=document.getElementById('audit-date').value;const r=await fetch(A+'/audit?date='+d,{headers:authH()});const entries=await r.json();
const bo=document.getElementById('audit-blocked').checked;const f=bo?entries.filter(e=>e.blocked):entries;
document.getElementById('audit-log').innerHTML=f.map(e=>'<div class="mono" style="padding:3px 0;border-bottom:1px solid #21262d"><span style="color:#8b949e">'+e.timestamp+'</span> <span style="color:'+(e.blocked?'#f85149':'#58a6ff')+'">'+(e.blocked?'🚫 ':'')+(e.tool||e.action)+'</span> '+(e.reason||'')+'</div>').join('')||'<p style="color:#8b949e;padding:16px">No entries</p>';}
document.getElementById('audit-blocked').onchange=loadAudit;

loadS();
</script></body></html>`;
}
