// ============================================================
// Task Queue — Persistent, crash-recoverable task management
// Tasks survive restarts. State machine: pending → running →
// waiting_approval → completed/failed. Stored as JSON in workspace.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { agentConfig } from '../config.js';
import { eventBus } from '../events.js';
import { createLogger } from '../utils/logger.js';
import type { Task, TaskStep, TaskStatus, TaskPriority, ChannelType, Id } from '../types.js';

const log = createLogger('TaskQ');

const tasksDir = () => path.join(agentConfig.workspace, 'tasks');

// ---- In-memory index (loaded from disk on start) -------------

const tasks = new Map<Id, Task>();

export async function initTaskQueue(): Promise<void> {
  const dir = tasksDir();
  await fs.mkdir(dir, { recursive: true });

  const files = await fs.readdir(dir);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf-8');
      const task = JSON.parse(raw) as Task;
      task.createdAt = new Date(task.createdAt);
      task.updatedAt = new Date(task.updatedAt);
      tasks.set(task.id, task);
    } catch { /* skip corrupted */ }
  }

  // Resume any tasks that were running when we crashed
  const interrupted = Array.from(tasks.values()).filter(t => t.status === 'running');
  for (const t of interrupted) {
    log.warn(`Task "${t.title}" (${t.id.slice(0, 8)}) was interrupted — marking as paused`);
    t.status = 'paused';
    await persistTask(t);
  }

  log.info(`Task queue loaded: ${tasks.size} tasks (${interrupted.length} resumed from crash)`);
}

// ---- CRUD ----------------------------------------------------

export async function createTask(params: {
  title: string;
  description: string;
  source: { channel: ChannelType; userId: string };
  priority?: TaskPriority;
  parentId?: Id;
  model?: string;
  provider?: string;
  tags?: string[];
}): Promise<Task> {
  const task: Task = {
    id: uuid(),
    parentId: params.parentId,
    title: params.title,
    description: params.description,
    status: 'pending',
    priority: params.priority || 'normal',
    progress: 0,
    steps: [],
    currentStepIndex: 0,
    source: params.source,
    model: params.model,
    provider: params.provider as any,
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    scratchpad: '',
    tags: params.tags || [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  tasks.set(task.id, task);
  await persistTask(task);
  eventBus.emit({ type: 'task_created', task });
  log.info(`Created task: "${task.title}" (${task.id.slice(0, 8)}) [${task.priority}]`);
  return task;
}

export function getTask(id: Id): Task | undefined {
  return tasks.get(id);
}

export function getAllTasks(): Task[] {
  return Array.from(tasks.values()).sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getTasksByStatus(status: TaskStatus): Task[] {
  return getAllTasks().filter(t => t.status === status);
}

export function getSubtasks(parentId: Id): Task[] {
  return getAllTasks().filter(t => t.parentId === parentId);
}

// ---- State transitions ---------------------------------------

export async function updateTaskStatus(
  id: Id,
  status: TaskStatus,
  extra?: Partial<Pick<Task, 'result' | 'error' | 'progress' | 'scratchpad'>>,
): Promise<Task | null> {
  const task = tasks.get(id);
  if (!task) return null;

  const prevStatus = task.status;
  task.status = status;
  task.updatedAt = new Date();

  if (status === 'running' && !task.startedAt) task.startedAt = new Date();
  if (status === 'completed' || status === 'failed') task.completedAt = new Date();
  if (extra?.result !== undefined) task.result = extra.result;
  if (extra?.error !== undefined) task.error = extra.error;
  if (extra?.progress !== undefined) task.progress = extra.progress;
  if (extra?.scratchpad !== undefined) task.scratchpad = extra.scratchpad;

  await persistTask(task);
  eventBus.emit({ type: 'task_updated', task });

  if (status === 'completed') {
    eventBus.emit({ type: 'task_completed', task });
  }

  log.info(`Task ${id.slice(0, 8)} "${task.title}": ${prevStatus} → ${status} (${task.progress}%)`);
  return task;
}

export async function addTaskStep(
  taskId: Id,
  step: Omit<TaskStep, 'id' | 'status'>,
): Promise<TaskStep | null> {
  const task = tasks.get(taskId);
  if (!task) return null;

  const newStep: TaskStep = {
    ...step,
    id: uuid(),
    status: 'pending',
  };

  task.steps.push(newStep);
  task.updatedAt = new Date();
  await persistTask(task);
  return newStep;
}

export async function updateTaskStep(
  taskId: Id,
  stepId: Id,
  update: Partial<Pick<TaskStep, 'status' | 'result' | 'error' | 'toolCalls'>>,
): Promise<void> {
  const task = tasks.get(taskId);
  if (!task) return;

  const step = task.steps.find(s => s.id === stepId);
  if (!step) return;

  Object.assign(step, update);
  if (update.status === 'running') step.startedAt = new Date();
  if (update.status === 'completed' || update.status === 'failed') step.completedAt = new Date();

  // Recalculate progress
  const completed = task.steps.filter(s => s.status === 'completed').length;
  task.progress = task.steps.length > 0 ? Math.round((completed / task.steps.length) * 100) : 0;
  task.updatedAt = new Date();

  await persistTask(task);
  eventBus.emit({ type: 'task_updated', task });
}

export async function addUsage(
  taskId: Id,
  inputTokens: number,
  outputTokens: number,
  costPer1kIn = 0.003,
  costPer1kOut = 0.015,
): Promise<void> {
  const task = tasks.get(taskId);
  if (!task) return;

  task.usage.inputTokens += inputTokens;
  task.usage.outputTokens += outputTokens;
  task.usage.estimatedCost += (inputTokens / 1000) * costPer1kIn + (outputTokens / 1000) * costPer1kOut;
  await persistTask(task);
}

export async function appendScratchpad(taskId: Id, note: string): Promise<void> {
  const task = tasks.get(taskId);
  if (!task) return;

  const timestamp = new Date().toISOString().slice(11, 19);
  task.scratchpad += `\n[${timestamp}] ${note}`;
  task.updatedAt = new Date();
  await persistTask(task);
}

// ---- Persistence ---------------------------------------------

async function persistTask(task: Task): Promise<void> {
  const dir = tasksDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${task.id}.json`),
    JSON.stringify(task, null, 2),
  );
}

export async function deleteTask(id: Id): Promise<boolean> {
  const task = tasks.get(id);
  if (!task) return false;

  tasks.delete(id);
  try {
    await fs.unlink(path.join(tasksDir(), `${id}.json`));
  } catch { /* ok if already gone */ }
  return true;
}

// ---- Queue processing: get next ready task -------------------

export function getNextPendingTask(): Task | undefined {
  const pending = getTasksByStatus('pending');
  // Priority ordering: critical > high > normal > low
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
  pending.sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));
  return pending[0];
}

export function getRunningTaskCount(): number {
  return getTasksByStatus('running').length;
}
