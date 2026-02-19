// ============================================================
// Heartbeat — Proactive agent behavior (cron + checklist)
// ============================================================

import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { agentConfig, heartbeatConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { eventBus } from '../events.js';
import { registerTool } from '../tools/registry.js';
import type { HeartbeatTask } from '../types.js';

const log = createLogger('Heartbeat');

let heartbeatJob: cron.ScheduledTask | null = null;
const cronJobs = new Map<string, cron.ScheduledTask>();

// ---- Heartbeat Checklist (HEARTBEAT.md) ----------------------

const heartbeatFile = () => path.join(agentConfig.workspace, 'HEARTBEAT.md');

async function loadHeartbeatTasks(): Promise<HeartbeatTask[]> {
  try {
    const raw = await fs.readFile(heartbeatFile(), 'utf-8');
    return parseHeartbeatMd(raw);
  } catch {
    // Create default HEARTBEAT.md
    const defaultContent = [
      '# Heartbeat Checklist',
      '',
      'These items are checked on every heartbeat tick. Edit this file to add/remove tasks.',
      '',
      '- [ ] Check for any pending reminders or calendar events',
      '- [ ] Review any queued tasks that need follow-up',
      '- [ ] Summarize any unread important messages',
    ].join('\n');

    await fs.mkdir(path.dirname(heartbeatFile()), { recursive: true });
    await fs.writeFile(heartbeatFile(), defaultContent);
    return parseHeartbeatMd(defaultContent);
  }
}

function parseHeartbeatMd(content: string): HeartbeatTask[] {
  const tasks: HeartbeatTask[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const match = line.match(/^- \[([ x])\]\s+(.+)$/);
    if (match) {
      tasks.push({
        id: uuid(),
        description: match[2].trim(),
        enabled: match[1] === ' ', // unchecked = enabled
      });
    }
  }

  return tasks;
}

// ---- Heartbeat Runner ----------------------------------------

async function onHeartbeat(): Promise<void> {
  log.info('💓 Heartbeat tick');
  const tasks = await loadHeartbeatTasks();
  const activeTasks = tasks.filter(t => t.enabled);

  if (activeTasks.length === 0) {
    log.debug('No active heartbeat tasks');
    return;
  }

  eventBus.emit({ type: 'heartbeat_tick', tasks: activeTasks });
}

// ---- Cron Jobs -----------------------------------------------

function scheduleCron(id: string, expression: string, handler: () => Promise<void>): void {
  if (!cron.validate(expression)) {
    log.error(`Invalid cron expression: ${expression}`);
    return;
  }

  if (cronJobs.has(id)) {
    cronJobs.get(id)!.stop();
  }

  const job = cron.schedule(expression, async () => {
    try {
      await handler();
    } catch (err) {
      log.error(`Cron job ${id} failed: ${err}`);
    }
  });

  cronJobs.set(id, job);
  log.info(`Scheduled cron job: ${id} (${expression})`);
}

// ---- Start / Stop --------------------------------------------

export function startHeartbeat(): void {
  if (!heartbeatConfig.enabled) {
    log.info('Heartbeat disabled');
    return;
  }

  const intervalMin = heartbeatConfig.intervalMinutes;
  const cronExpr = `*/${intervalMin} * * * *`;

  heartbeatJob = cron.schedule(cronExpr, onHeartbeat);
  log.info(`Heartbeat started (every ${intervalMin} minutes)`);
}

export function stopHeartbeat(): void {
  heartbeatJob?.stop();
  for (const [id, job] of cronJobs) {
    job.stop();
    log.debug(`Stopped cron job: ${id}`);
  }
  cronJobs.clear();
}

// ---- Tools for LLM ------------------------------------------

registerTool(
  {
    name: 'schedule_cron',
    description: 'Schedule a recurring task using a cron expression. The task description will be evaluated on each tick.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique job identifier' },
        cron_expression: { type: 'string', description: 'Cron expression (e.g., "0 9 * * *" for daily at 9am)' },
        description: { type: 'string', description: 'What this job should do on each tick' },
      },
      required: ['id', 'cron_expression', 'description'],
    },
  },
  async (input) => {
    const id = input.id as string;
    const expr = input.cron_expression as string;
    const desc = input.description as string;

    scheduleCron(id, expr, async () => {
      log.info(`Cron ${id} fired: ${desc}`);
      eventBus.emit({
        type: 'heartbeat_tick',
        tasks: [{
          id,
          description: desc,
          enabled: true,
          schedule: expr,
          lastRun: new Date(),
        }],
      });
    });

    return `Scheduled cron job "${id}" with expression "${expr}": ${desc}`;
  },
);

registerTool(
  {
    name: 'cancel_cron',
    description: 'Cancel a scheduled cron job by its ID.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job ID to cancel' },
      },
      required: ['id'],
    },
  },
  async (input) => {
    const id = input.id as string;
    const job = cronJobs.get(id);
    if (!job) return `No cron job found with id: ${id}`;
    job.stop();
    cronJobs.delete(id);
    return `Cancelled cron job: ${id}`;
  },
);

registerTool(
  {
    name: 'edit_heartbeat',
    description: 'Add or remove items from the heartbeat checklist (HEARTBEAT.md).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'list'], description: 'Action to perform' },
        task: { type: 'string', description: 'Task description (for add/remove)' },
      },
      required: ['action'],
    },
  },
  async (input) => {
    const action = input.action as string;

    if (action === 'list') {
      const tasks = await loadHeartbeatTasks();
      return tasks.map(t =>
        `- [${t.enabled ? ' ' : 'x'}] ${t.description}`
      ).join('\n') || 'No heartbeat tasks.';
    }

    let content: string;
    try {
      content = await fs.readFile(heartbeatFile(), 'utf-8');
    } catch {
      content = '# Heartbeat Checklist\n\n';
    }

    if (action === 'add') {
      content += `\n- [ ] ${input.task}`;
      await fs.writeFile(heartbeatFile(), content);
      return `Added heartbeat task: ${input.task}`;
    }

    if (action === 'remove') {
      const lines = content.split('\n');
      const filtered = lines.filter(l => !l.includes(input.task as string));
      await fs.writeFile(heartbeatFile(), filtered.join('\n'));
      return `Removed heartbeat task: ${input.task}`;
    }

    return `Unknown action: ${action}`;
  },
);
