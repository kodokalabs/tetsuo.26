// ============================================================
// Event Triggers — Reactive system: file watch, webhooks,
// calendar polling, cron schedules. Fires tasks or messages
// when conditions are met.
// ============================================================

import fs from 'fs/promises';
import { watch, FSWatcher } from 'fs';
import path from 'path';
import http from 'http';
import { v4 as uuid } from 'uuid';
import cron from 'node-cron';
import { agentConfig } from '../config.js';
import { eventBus } from '../events.js';
import { createLogger } from '../utils/logger.js';
import { registerTool } from '../tools/registry.js';
import { audit } from '../security/guard.js';
import type { TriggerDefinition, TriggerType, Id } from '../types.js';

const log = createLogger('Triggers');

const triggersFile = () => path.join(agentConfig.workspace, 'triggers.json');
const triggers = new Map<Id, TriggerDefinition>();

// Active watchers/servers for cleanup
const fileWatchers = new Map<Id, FSWatcher>();
const cronJobs = new Map<Id, cron.ScheduledTask>();
let webhookServer: http.Server | null = null;

// ---- Init / Load / Save -------------------------------------

export async function initTriggers(): Promise<void> {
  try {
    const raw = await fs.readFile(triggersFile(), 'utf-8');
    const saved = JSON.parse(raw) as TriggerDefinition[];
    for (const t of saved) {
      triggers.set(t.id, t);
    }
  } catch { /* no triggers yet */ }

  // Start all enabled triggers
  for (const t of triggers.values()) {
    if (t.enabled) await startTrigger(t);
  }

  log.info(`Triggers loaded: ${triggers.size} total, ${Array.from(triggers.values()).filter(t => t.enabled).length} active`);
}

async function saveTriggers(): Promise<void> {
  await fs.writeFile(
    triggersFile(),
    JSON.stringify(Array.from(triggers.values()), null, 2),
  );
}

// ---- Create / Delete / Toggle --------------------------------

export async function createTrigger(params: {
  type: TriggerType;
  name: string;
  config: Record<string, unknown>;
  action: TriggerDefinition['action'];
}): Promise<TriggerDefinition> {
  const trigger: TriggerDefinition = {
    id: uuid(),
    type: params.type,
    name: params.name,
    enabled: true,
    config: params.config,
    action: params.action,
    triggerCount: 0,
  };

  triggers.set(trigger.id, trigger);
  await startTrigger(trigger);
  await saveTriggers();

  log.info(`Created trigger: ${trigger.name} (${trigger.type})`);
  return trigger;
}

export async function deleteTrigger(id: Id): Promise<boolean> {
  const trigger = triggers.get(id);
  if (!trigger) return false;

  await stopTrigger(trigger);
  triggers.delete(id);
  await saveTriggers();
  return true;
}

export async function toggleTrigger(id: Id, enabled: boolean): Promise<TriggerDefinition | null> {
  const trigger = triggers.get(id);
  if (!trigger) return null;

  if (enabled && !trigger.enabled) {
    trigger.enabled = true;
    await startTrigger(trigger);
  } else if (!enabled && trigger.enabled) {
    trigger.enabled = false;
    await stopTrigger(trigger);
  }

  await saveTriggers();
  return trigger;
}

export function getAllTriggers(): TriggerDefinition[] {
  return Array.from(triggers.values());
}

// ---- Fire a trigger ------------------------------------------

async function fireTrigger(trigger: TriggerDefinition, payload?: unknown): Promise<void> {
  trigger.lastTriggered = new Date();
  trigger.triggerCount++;
  await saveTriggers();

  await audit({ action: 'trigger_fired', input: { name: trigger.name, type: trigger.type } });
  eventBus.emit({ type: 'trigger_fired', trigger, payload });

  log.info(`Trigger fired: ${trigger.name} (${trigger.type}) — count: ${trigger.triggerCount}`);
}

// ---- Start individual trigger types --------------------------

async function startTrigger(trigger: TriggerDefinition): Promise<void> {
  switch (trigger.type) {
    case 'file_watch':
      startFileWatch(trigger);
      break;
    case 'webhook':
      await ensureWebhookServer();
      break;
    case 'cron':
      startCronTrigger(trigger);
      break;
    case 'calendar':
      startCalendarPoll(trigger);
      break;
    case 'email_watch':
      startEmailPoll(trigger);
      break;
  }
}

async function stopTrigger(trigger: TriggerDefinition): Promise<void> {
  switch (trigger.type) {
    case 'file_watch': {
      const watcher = fileWatchers.get(trigger.id);
      if (watcher) { watcher.close(); fileWatchers.delete(trigger.id); }
      break;
    }
    case 'cron': {
      const job = cronJobs.get(trigger.id);
      if (job) { job.stop(); cronJobs.delete(trigger.id); }
      break;
    }
  }
}

// ---- FILE WATCH ---------------------------------------------

function startFileWatch(trigger: TriggerDefinition): void {
  const watchPath = path.resolve(
    agentConfig.workspace,
    trigger.config.path as string || '.',
  );
  const pattern = trigger.config.pattern as string | undefined;

  try {
    const watcher = watch(watchPath, { recursive: true }, async (eventType, filename) => {
      if (!filename) return;
      if (pattern && !new RegExp(pattern).test(filename)) return;

      log.info(`File event: ${eventType} ${filename}`);
      await fireTrigger(trigger, { eventType, filename, path: path.join(watchPath, filename) });
    });

    fileWatchers.set(trigger.id, watcher);
    log.info(`File watcher started: ${watchPath} (pattern: ${pattern || '*'})`);
  } catch (err: any) {
    log.error(`Failed to watch ${watchPath}: ${err.message}`);
  }
}

// ---- WEBHOOK ------------------------------------------------

const WEBHOOK_PORT = 18790;
const webhookHandlers = new Map<string, TriggerDefinition>();

async function ensureWebhookServer(): Promise<void> {
  if (webhookServer) return;

  // Register all webhook triggers
  for (const t of triggers.values()) {
    if (t.type === 'webhook' && t.enabled) {
      const hookPath = (t.config.path as string) || `/${t.id.slice(0, 8)}`;
      webhookHandlers.set(hookPath, t);
    }
  }

  webhookServer = http.createServer(async (req, res) => {
    const trigger = webhookHandlers.get(req.url || '');
    if (!trigger) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Collect body
    let body = '';
    for await (const chunk of req) body += chunk;

    let payload: unknown;
    try { payload = JSON.parse(body); } catch { payload = body; }

    // Verify secret if configured
    const secret = trigger.config.secret as string | undefined;
    if (secret) {
      const sig = req.headers['x-webhook-secret'] || req.headers['x-hub-signature-256'];
      if (sig !== secret) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
    }

    await fireTrigger(trigger, {
      method: req.method,
      headers: req.headers,
      body: payload,
    });

    res.writeHead(200);
    res.end('OK');
  });

  webhookServer.listen(WEBHOOK_PORT, '127.0.0.1', () => {
    log.info(`Webhook server listening on http://127.0.0.1:${WEBHOOK_PORT}`);
  });
}

// ---- CRON ---------------------------------------------------

function startCronTrigger(trigger: TriggerDefinition): void {
  const expression = trigger.config.cron as string;
  if (!expression || !cron.validate(expression)) {
    log.error(`Invalid cron expression for trigger "${trigger.name}": ${expression}`);
    return;
  }

  const job = cron.schedule(expression, async () => {
    await fireTrigger(trigger, { scheduledTime: new Date().toISOString() });
  });

  cronJobs.set(trigger.id, job);
  log.info(`Cron trigger "${trigger.name}" scheduled: ${expression}`);
}

// ---- CALENDAR (Google Calendar polling via public URL) --------

function startCalendarPoll(trigger: TriggerDefinition): void {
  const calendarUrl = trigger.config.icalUrl as string;
  const pollIntervalMs = ((trigger.config.pollMinutes as number) || 15) * 60 * 1000;

  if (!calendarUrl) {
    log.error(`Calendar trigger "${trigger.name}" missing icalUrl`);
    return;
  }

  let lastCheck = new Date();

  const poll = async () => {
    try {
      const res = await fetch(calendarUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;

      const ical = await res.text();
      // Simple iCal parsing: find events starting within the next pollInterval
      const events = parseUpcomingEvents(ical, lastCheck, pollIntervalMs);
      lastCheck = new Date();

      for (const event of events) {
        await fireTrigger(trigger, event);
      }
    } catch (err: any) {
      log.error(`Calendar poll failed: ${err.message}`);
    }
  };

  // Poll immediately, then on interval
  poll();
  const interval = setInterval(poll, pollIntervalMs);

  // Store interval ID for cleanup (reuse cronJobs map)
  cronJobs.set(trigger.id, { stop: () => clearInterval(interval) } as any);
  log.info(`Calendar polling started: every ${pollIntervalMs / 60000}min`);
}

/** Minimal iCal parser — extract events starting in the next window */
function parseUpcomingEvents(ical: string, since: Date, windowMs: number): Array<{ summary: string; start: string; end: string; description?: string }> {
  const events: Array<{ summary: string; start: string; end: string; description?: string }> = [];
  const now = Date.now();
  const windowEnd = now + windowMs;

  // Split into VEVENT blocks
  const eventBlocks = ical.split('BEGIN:VEVENT').slice(1);

  for (const block of eventBlocks) {
    const get = (key: string): string => {
      const match = block.match(new RegExp(`${key}[^:]*:(.+)`, 'i'));
      return match?.[1]?.trim() || '';
    };

    const dtstart = get('DTSTART');
    const dtend = get('DTEND');
    const summary = get('SUMMARY');
    const description = get('DESCRIPTION');

    if (!dtstart || !summary) continue;

    // Parse iCal date (basic: 20250220T150000Z)
    const startDate = parseICalDate(dtstart);
    if (!startDate) continue;

    const startMs = startDate.getTime();

    // Event is upcoming if it starts between now and window end,
    // and is after our last check
    if (startMs > since.getTime() && startMs >= now && startMs <= windowEnd) {
      events.push({
        summary,
        start: startDate.toISOString(),
        end: dtend ? (parseICalDate(dtend)?.toISOString() || '') : '',
        description: description || undefined,
      });
    }
  }

  return events;
}

function parseICalDate(s: string): Date | null {
  // Handle formats: 20250220T150000Z, 20250220T150000, 20250220
  const clean = s.replace(/[^0-9TZ]/g, '');
  const match = clean.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/);
  if (!match) return null;
  const [, y, m, d, h, min, sec] = match;
  return new Date(Date.UTC(+y, +m - 1, +d, +(h || 0), +(min || 0), +(sec || 0)));
}

// ---- EMAIL WATCH (polls IMAP for new mail) -------------------

function startEmailPoll(trigger: TriggerDefinition): void {
  const pollIntervalMs = ((trigger.config.pollMinutes as number) || 5) * 60 * 1000;
  const fromFilter = trigger.config.fromFilter as string | undefined;
  const subjectFilter = trigger.config.subjectFilter as string | undefined;

  let lastCheckUid = 0;

  const poll = async () => {
    try {
      // Use the email tools' config
      const { getSettings } = await import('../security/settings.js');
      const config = getSettings().integrations.email;
      if (!config.host || !config.user) return;

      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({
        host: config.host, port: config.port, secure: config.secure,
        auth: { user: config.user, pass: config.pass },
        logger: false,
      });

      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch({ seen: false }, { envelope: true })) {
          if (msg.uid <= lastCheckUid) continue;

          const from = msg.envelope.from?.[0]?.address || '';
          const subject = msg.envelope.subject || '';

          if (fromFilter && !from.toLowerCase().includes(fromFilter.toLowerCase())) continue;
          if (subjectFilter && !subject.toLowerCase().includes(subjectFilter.toLowerCase())) continue;

          lastCheckUid = Math.max(lastCheckUid, msg.uid);
          await fireTrigger(trigger, {
            uid: msg.uid,
            from,
            subject,
            date: msg.envelope.date?.toISOString(),
          });
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (err: any) {
      log.error(`Email poll failed: ${err.message}`);
    }
  };

  poll();
  const interval = setInterval(poll, pollIntervalMs);
  cronJobs.set(trigger.id, { stop: () => clearInterval(interval) } as any);
  log.info(`Email watcher started: every ${pollIntervalMs / 60000}min`);
}

// ---- Cleanup -------------------------------------------------

export function stopAllTriggers(): void {
  for (const w of fileWatchers.values()) w.close();
  fileWatchers.clear();
  for (const j of cronJobs.values()) j.stop();
  cronJobs.clear();
  if (webhookServer) { webhookServer.close(); webhookServer = null; }
  webhookHandlers.clear();
  log.info('All triggers stopped');
}

// ============================================================
// TOOLS — Let the agent create & manage triggers
// ============================================================

registerTool(
  {
    name: 'create_trigger',
    description: `Create an event trigger that fires automatically. Types:
- file_watch: fires when files change. Config: { path, pattern }
- webhook: fires on HTTP POST. Config: { path, secret }
- cron: fires on schedule. Config: { cron: "* * * * *" }
- calendar: fires before events. Config: { icalUrl, pollMinutes }
- email_watch: fires on new email. Config: { pollMinutes, fromFilter, subjectFilter }
Action: { type: "message"|"task", content: "what to do", channel, userId }`,
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['file_watch', 'webhook', 'cron', 'calendar', 'email_watch'] },
        name: { type: 'string', description: 'Human-readable trigger name' },
        config: { type: 'object', description: 'Type-specific configuration' },
        actionType: { type: 'string', enum: ['message', 'task'], description: 'What to do when triggered' },
        actionContent: { type: 'string', description: 'Message text or task description' },
      },
      required: ['type', 'name', 'config', 'actionType', 'actionContent'],
    },
  },
  async (input) => {
    const trigger = await createTrigger({
      type: input.type as TriggerType,
      name: input.name as string,
      config: input.config as Record<string, unknown>,
      action: {
        type: input.actionType as 'message' | 'task',
        content: input.actionContent as string,
      },
    });
    return `Trigger created: "${trigger.name}" (${trigger.type}) [${trigger.id.slice(0, 8)}]`;
  },
);

registerTool(
  {
    name: 'list_triggers',
    description: 'List all event triggers with their status.',
    parameters: { type: 'object', properties: {} },
  },
  async () => {
    const all = getAllTriggers();
    if (all.length === 0) return 'No triggers configured.';
    return all.map(t =>
      `[${t.enabled ? '✓' : '✗'}] ${t.name} (${t.type}) — fired ${t.triggerCount} times${t.lastTriggered ? `, last: ${new Date(t.lastTriggered).toISOString().slice(0, 16)}` : ''} [${t.id.slice(0, 8)}]`
    ).join('\n');
  },
);

registerTool(
  {
    name: 'delete_trigger',
    description: 'Delete an event trigger by ID (first 8 chars).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Trigger ID (or first 8 chars)' } },
      required: ['id'],
    },
  },
  async (input) => {
    const prefix = (input.id as string).toLowerCase();
    const match = getAllTriggers().find(t => t.id.toLowerCase().startsWith(prefix));
    if (!match) return `No trigger found matching: ${prefix}`;
    await deleteTrigger(match.id);
    return `Deleted trigger: "${match.name}"`;
  },
);

log.info('Trigger system registered');
