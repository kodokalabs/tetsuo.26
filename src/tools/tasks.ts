// ============================================================
// Task & Orchestration Tools — Expose task queue, multi-agent
// orchestration, and approval workflow to the agent via tools.
// ============================================================

import { registerTool } from './registry.js';
import {
  createTask, getTask, getAllTasks, getTasksByStatus,
  updateTaskStatus, getSubtasks, deleteTask,
  appendScratchpad, getNextPendingTask,
} from '../tasks/queue.js';
import {
  getPendingApprovals, resolveApproval,
  formatApprovalForChat, getAllApprovals,
} from '../tasks/approvals.js';
import { orchestrate, shouldOrchestrate, getActiveAgents } from '../orchestrator/planner.js';
import { getRoutes } from '../orchestrator/router.js';
import { createLogger } from '../utils/logger.js';
import type { ChannelType } from '../types.js';

const log = createLogger('TaskTools');

// ---- Create and run a complex task ---------------------------

registerTool(
  {
    name: 'create_task',
    description: `Create a tracked task. For complex multi-step work, the orchestrator will automatically decompose it into subtasks and run them in parallel across different models. Use this for anything that requires multiple steps, research+synthesis, or long-running work.`,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Detailed description of what to accomplish' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Priority (default: normal)' },
        channel: { type: 'string', description: 'Source channel' },
        userId: { type: 'string', description: 'Requesting user ID' },
        orchestrate: { type: 'boolean', description: 'Force multi-agent orchestration (auto-detected if not specified)' },
        tags: { type: 'string', description: 'Comma-separated tags' },
      },
      required: ['title', 'description'],
    },
  },
  async (input) => {
    const task = await createTask({
      title: input.title as string,
      description: input.description as string,
      priority: (input.priority as any) || 'normal',
      source: {
        channel: (input.channel as ChannelType) || 'cli',
        userId: (input.userId as string) || 'agent',
      },
      tags: (input.tags as string)?.split(',').map(s => s.trim()) || [],
    });

    // Determine if orchestration is needed
    const useOrchestration = input.orchestrate === true ||
      (input.orchestrate !== false && shouldOrchestrate(input.description as string));

    if (useOrchestration) {
      log.info(`Task "${task.title}" queued for multi-agent orchestration`);

      // Run orchestration in background (don't block the tool call)
      orchestrate(task).then(result => {
        log.info(`Task "${task.title}" completed: ${result.slice(0, 200)}...`);
      }).catch(err => {
        log.error(`Task "${task.title}" failed: ${err.message}`);
      });

      return `Task created and sent to orchestrator: "${task.title}" [${task.id.slice(0, 8)}]\nThe orchestrator will decompose this into subtasks and run them in parallel.\nUse \`task_status ${task.id.slice(0, 8)}\` to check progress.`;
    }

    return `Task created: "${task.title}" [${task.id.slice(0, 8)}] (status: pending)\nThis is a simple task — execute it directly with available tools.`;
  },
);

// ---- Task status query ---------------------------------------

registerTool(
  {
    name: 'task_status',
    description: 'Check the status of a task, including subtasks, progress, cost, and scratchpad.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID (or first 8 chars). Omit to list all tasks.' },
        status_filter: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'paused', 'waiting_approval'] },
      },
    },
  },
  async (input) => {
    if (!input.id && !input.status_filter) {
      // List all recent tasks
      const all = getAllTasks().slice(0, 20);
      if (all.length === 0) return 'No tasks in queue.';

      return all.map(t => {
        const bar = progressBar(t.progress);
        return `[${t.status.padEnd(16)}] ${bar} ${t.title} [${t.id.slice(0, 8)}] $${t.usage.estimatedCost.toFixed(3)}`;
      }).join('\n');
    }

    if (input.status_filter) {
      const filtered = getTasksByStatus(input.status_filter as any);
      if (filtered.length === 0) return `No ${input.status_filter} tasks.`;
      return filtered.map(t => `[${t.id.slice(0, 8)}] ${t.title} — ${t.progress}%`).join('\n');
    }

    // Find specific task
    const prefix = (input.id as string).toLowerCase();
    const all = getAllTasks();
    const task = all.find(t => t.id.toLowerCase().startsWith(prefix));
    if (!task) return `No task found matching: ${prefix}`;

    const subtasks = getSubtasks(task.id);
    const lines = [
      `=== Task: ${task.title} ===`,
      `ID: ${task.id}`,
      `Status: ${task.status} | Priority: ${task.priority}`,
      `Progress: ${progressBar(task.progress)} ${task.progress}%`,
      `Created: ${new Date(task.createdAt).toISOString().slice(0, 16)}`,
      task.startedAt ? `Started: ${new Date(task.startedAt).toISOString().slice(0, 16)}` : '',
      task.completedAt ? `Completed: ${new Date(task.completedAt).toISOString().slice(0, 16)}` : '',
      `Cost: $${task.usage.estimatedCost.toFixed(4)} (${task.usage.inputTokens + task.usage.outputTokens} tokens)`,
      ``,
    ];

    if (task.steps.length > 0) {
      lines.push(`Steps (${task.steps.length}):`);
      for (const step of task.steps) {
        const icon = step.status === 'completed' ? '✓' : step.status === 'running' ? '►' : step.status === 'failed' ? '✗' : '○';
        lines.push(`  ${icon} ${step.description}`);
      }
      lines.push('');
    }

    if (subtasks.length > 0) {
      lines.push(`Subtasks (${subtasks.length}):`);
      for (const st of subtasks) {
        const icon = st.status === 'completed' ? '✓' : st.status === 'running' ? '►' : st.status === 'failed' ? '✗' : '○';
        lines.push(`  ${icon} [${st.model || 'default'}] ${st.title} — ${st.progress}% $${st.usage.estimatedCost.toFixed(4)}`);
      }
      lines.push('');
    }

    if (task.scratchpad) {
      lines.push('Scratchpad (last 1000 chars):');
      lines.push(task.scratchpad.slice(-1000));
    }

    if (task.result) {
      lines.push(`\nResult:\n${task.result.slice(0, 3000)}`);
    }
    if (task.error) {
      lines.push(`\nError: ${task.error}`);
    }

    return lines.filter(Boolean).join('\n');
  },
);

// ---- Task management -----------------------------------------

registerTool(
  {
    name: 'task_action',
    description: 'Manage a task: pause, resume, cancel, or add a note to its scratchpad.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID (first 8 chars)' },
        action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'note'] },
        note: { type: 'string', description: 'Note to add to scratchpad (for action=note)' },
      },
      required: ['id', 'action'],
    },
  },
  async (input) => {
    const prefix = (input.id as string).toLowerCase();
    const task = getAllTasks().find(t => t.id.toLowerCase().startsWith(prefix));
    if (!task) return `No task found: ${prefix}`;

    switch (input.action) {
      case 'pause':
        await updateTaskStatus(task.id, 'paused');
        return `Task "${task.title}" paused.`;
      case 'resume':
        await updateTaskStatus(task.id, 'pending');
        return `Task "${task.title}" resumed (re-queued as pending).`;
      case 'cancel':
        await updateTaskStatus(task.id, 'cancelled');
        return `Task "${task.title}" cancelled.`;
      case 'note':
        await appendScratchpad(task.id, input.note as string || '');
        return `Note added to task "${task.title}".`;
      default:
        return `Unknown action: ${input.action}`;
    }
  },
);

// ---- Approval management -------------------------------------

registerTool(
  {
    name: 'check_approvals',
    description: 'List pending approval requests that need user decision.',
    parameters: { type: 'object', properties: {} },
  },
  async () => {
    const pending = getPendingApprovals();
    if (pending.length === 0) return 'No pending approvals.';
    return pending.map(a => formatApprovalForChat(a)).join('\n\n---\n\n');
  },
);

registerTool(
  {
    name: 'resolve_approval',
    description: 'Approve or reject a pending approval request.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Approval ID (first 8 chars)' },
        decision: { type: 'string', enum: ['approve', 'reject'] },
      },
      required: ['id', 'decision'],
    },
  },
  async (input) => {
    const prefix = (input.id as string).toLowerCase();
    const all = getAllApprovals();
    const match = all.find(a => a.id.toLowerCase().startsWith(prefix) && a.status === 'pending');
    if (!match) return `No pending approval found: ${prefix}`;

    const decision = (input.decision as string) === 'approve' ? 'approved' : 'rejected';
    await resolveApproval(match.id, decision as any, 'agent');
    return `Approval ${match.id.slice(0, 8)} ${decision}: ${match.proposedAction.tool}`;
  },
);

// ---- Sub-agent monitoring ------------------------------------

registerTool(
  {
    name: 'agent_status',
    description: 'Show all active sub-agents, their models, and what they are working on.',
    parameters: { type: 'object', properties: {} },
  },
  async () => {
    const active = getActiveAgents();
    if (active.length === 0) return 'No active sub-agents.';

    const lines = ['=== Active Sub-Agents ==='];
    for (const a of active) {
      lines.push(
        `${a.status === 'busy' ? '🟢' : '⚪'} ${a.name} (${a.role})`,
        `  Model: ${a.provider}/${a.model}`,
        `  Status: ${a.status}${a.currentTaskId ? ` — working on ${a.currentTaskId.slice(0, 8)}` : ''}`,
        `  Usage: ${a.usage.inputTokens + a.usage.outputTokens} tokens, $${a.usage.estimatedCost.toFixed(4)}`,
        `  Routing: ${a.routingReason}`,
      );
    }

    const routes = getRoutes();
    lines.push('', '=== Available Model Routes ===');
    for (const r of routes) {
      lines.push(`  ${r.tier}: ${r.provider}/${r.model} — $${r.costPer1kInput}/$${r.costPer1kOutput} per 1K tokens`);
    }

    return lines.join('\n');
  },
);

// ---- Helpers -------------------------------------------------

function progressBar(pct: number): string {
  const filled = Math.round(pct / 5);
  return `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}]`;
}

log.info('Task & orchestration tools registered');
