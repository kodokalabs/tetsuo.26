// ============================================================
// Approval Workflow — Pending action queue with approve/reject
// Agent proposes action → waits → user approves via chat/dash →
// agent resumes. Approvals expire after configurable timeout.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { agentConfig } from '../config.js';
import { eventBus } from '../events.js';
import { createLogger } from '../utils/logger.js';
import type { ApprovalRequest, ApprovalStatus, ChannelType, Id } from '../types.js';

const log = createLogger('Approval');

const approvalsDir = () => path.join(agentConfig.workspace, 'approvals');
const approvals = new Map<Id, ApprovalRequest>();
const waiters = new Map<Id, {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}>();

// Default expiry: 30 minutes
const EXPIRY_MS = 30 * 60 * 1000;

// ---- Init (load pending approvals from disk) -----------------

export async function initApprovalQueue(): Promise<void> {
  const dir = approvalsDir();
  await fs.mkdir(dir, { recursive: true });

  const files = await fs.readdir(dir);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf-8');
      const req = JSON.parse(raw) as ApprovalRequest;
      req.createdAt = new Date(req.createdAt);
      req.expiresAt = new Date(req.expiresAt);

      // Expire stale approvals
      if (req.status === 'pending' && new Date() > req.expiresAt) {
        req.status = 'expired';
        await persistApproval(req);
      }
      approvals.set(req.id, req);
    } catch { /* skip corrupted */ }
  }

  const pending = Array.from(approvals.values()).filter(a => a.status === 'pending');
  log.info(`Approval queue loaded: ${approvals.size} total, ${pending.length} pending`);
}

// ---- Request approval (called by agent loop) -----------------

/**
 * Request user approval for a proposed action.
 * Returns a promise that resolves to true (approved) or false (rejected/expired).
 * The agent loop should await this before proceeding.
 */
export async function requestApproval(params: {
  taskId: Id;
  stepDescription: string;
  tool: string;
  input: Record<string, unknown>;
  reasoning: string;
  riskLevel: ApprovalRequest['riskLevel'];
  riskExplanation: string;
  channel: ChannelType;
  userId: string;
}): Promise<boolean> {
  const req: ApprovalRequest = {
    id: uuid(),
    taskId: params.taskId,
    stepDescription: params.stepDescription,
    proposedAction: {
      tool: params.tool,
      input: params.input,
      reasoning: params.reasoning,
    },
    riskLevel: params.riskLevel,
    riskExplanation: params.riskExplanation,
    status: 'pending',
    channel: params.channel,
    userId: params.userId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + EXPIRY_MS),
  };

  approvals.set(req.id, req);
  await persistApproval(req);
  eventBus.emit({ type: 'approval_requested', approval: req });

  log.info(`Approval requested: [${req.riskLevel}] ${req.proposedAction.tool} — ${req.stepDescription}`);

  // Return a promise that waits for resolution
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(async () => {
      // Auto-expire
      if (req.status === 'pending') {
        req.status = 'expired';
        req.resolvedAt = new Date();
        await persistApproval(req);
        eventBus.emit({ type: 'approval_resolved', approval: req });
        log.warn(`Approval ${req.id.slice(0, 8)} expired`);
        resolve(false);
      }
      waiters.delete(req.id);
    }, EXPIRY_MS);

    waiters.set(req.id, { resolve, timer });
  });
}

// ---- Resolve (called by user via chat or dashboard) ----------

export async function resolveApproval(
  approvalId: Id,
  decision: 'approved' | 'rejected',
  resolvedBy?: string,
): Promise<ApprovalRequest | null> {
  const req = approvals.get(approvalId);
  if (!req || req.status !== 'pending') return null;

  req.status = decision;
  req.resolvedAt = new Date();
  req.resolvedBy = resolvedBy;
  await persistApproval(req);

  // Wake up the waiting agent
  const waiter = waiters.get(approvalId);
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve(decision === 'approved');
    waiters.delete(approvalId);
  }

  eventBus.emit({ type: 'approval_resolved', approval: req });
  log.info(`Approval ${approvalId.slice(0, 8)} ${decision} by ${resolvedBy || 'user'}`);
  return req;
}

// ---- Queries -------------------------------------------------

export function getPendingApprovals(userId?: string): ApprovalRequest[] {
  return Array.from(approvals.values())
    .filter(a => a.status === 'pending' && (!userId || a.userId === userId))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function getApproval(id: Id): ApprovalRequest | undefined {
  return approvals.get(id);
}

export function getAllApprovals(): ApprovalRequest[] {
  return Array.from(approvals.values())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// ---- Format approval for chat display ------------------------

export function formatApprovalForChat(req: ApprovalRequest): string {
  const riskEmoji: Record<string, string> = {
    low: '🟢', medium: '🟡', high: '🟠', critical: '🔴',
  };

  return [
    `${riskEmoji[req.riskLevel] || '⚪'} **Approval Required** [${req.id.slice(0, 8)}]`,
    ``,
    `**Action:** \`${req.proposedAction.tool}\``,
    `**Reason:** ${req.proposedAction.reasoning}`,
    `**Risk:** ${req.riskLevel.toUpperCase()} — ${req.riskExplanation}`,
    ``,
    `**Details:** ${req.stepDescription}`,
    ``,
    `Reply with:`,
    `  \`/approve ${req.id.slice(0, 8)}\` — proceed`,
    `  \`/reject ${req.id.slice(0, 8)}\` — cancel`,
    ``,
    `⏰ Expires: ${req.expiresAt.toISOString().slice(0, 16)}`,
  ].join('\n');
}

// ---- Persistence ---------------------------------------------

async function persistApproval(req: ApprovalRequest): Promise<void> {
  const dir = approvalsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${req.id}.json`),
    JSON.stringify(req, null, 2),
  );
}
