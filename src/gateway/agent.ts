// ============================================================
// Agent Loop — The core brain: message → LLM → tools → reply
// Integrated with: approvals, cost tracking, orchestration,
// trigger handling, and chat commands.
// ============================================================

import { callLLM } from '../llm/provider.js';
import { getToolDefinitions, executeTool } from '../tools/registry.js';
import { loadThread, saveThread, searchMemory, getAllMemories } from '../memory/store.js';
import { getSkillsContext } from '../skills/loader.js';
import { agentConfig } from '../config.js';
import { getSettings } from '../security/settings.js';
import { trackUsage, canMakeCall, getTodayUsage } from '../tasks/costs.js';
import {
  resolveApproval, getPendingApprovals, formatApprovalForChat,
} from '../tasks/approvals.js';
import { shouldOrchestrate, orchestrate } from '../orchestrator/planner.js';
import { createTask, getAllTasks, getTask } from '../tasks/queue.js';
import { createLogger } from '../utils/logger.js';
import type { InboundMessage, LLMMessage, ToolCall, TriggerDefinition } from '../types.js';

const log = createLogger('Agent');

// ---- Chat command handler (before LLM) -----------------------

async function handleChatCommand(text: string, userId: string): Promise<string | null> {
  const trimmed = text.trim().toLowerCase();

  // /approve <id>
  const approveMatch = trimmed.match(/^\/approve\s+(\S+)/);
  if (approveMatch) {
    const prefix = approveMatch[1];
    const pending = getPendingApprovals(userId);
    const match = pending.find(a => a.id.toLowerCase().startsWith(prefix));
    if (!match) return `No pending approval matching "${prefix}". Use /pending to list.`;
    await resolveApproval(match.id, 'approved', userId);
    return `✅ Approved: ${match.proposedAction.tool} — the agent will proceed.`;
  }

  // /reject <id>
  const rejectMatch = trimmed.match(/^\/reject\s+(\S+)/);
  if (rejectMatch) {
    const prefix = rejectMatch[1];
    const pending = getPendingApprovals(userId);
    const match = pending.find(a => a.id.toLowerCase().startsWith(prefix));
    if (!match) return `No pending approval matching "${prefix}".`;
    await resolveApproval(match.id, 'rejected', userId);
    return `❌ Rejected: ${match.proposedAction.tool} — the agent will find an alternative.`;
  }

  // /pending — list pending approvals
  if (trimmed === '/pending') {
    const pending = getPendingApprovals(userId);
    if (pending.length === 0) return 'No pending approvals.';
    return pending.map(a => formatApprovalForChat(a)).join('\n\n---\n\n');
  }

  // /tasks — quick task list
  if (trimmed === '/tasks') {
    const tasks = getAllTasks().slice(0, 15);
    if (tasks.length === 0) return 'No tasks in queue.';
    return tasks.map(t =>
      `[${t.status}] ${t.title} — ${t.progress}% ($${t.usage.estimatedCost.toFixed(3)}) [${t.id.slice(0, 8)}]`
    ).join('\n');
  }

  // /cost — today's spending
  if (trimmed === '/cost' || trimmed === '/costs') {
    const usage = getTodayUsage();
    return `Today: ${usage.callCount} calls, ${usage.inputTokens + usage.outputTokens} tokens, $${usage.estimatedCost.toFixed(4)}`;
  }

  return null; // not a command
}

// ---- System Prompt Builder -----------------------------------

async function buildSystemPrompt(userId: string): Promise<string> {
  const memories = await getAllMemories();
  const memoryContext = memories.length > 0
    ? memories.slice(0, 20).map(m => `- [${m.type}] ${m.content}`).join('\n')
    : 'No memories stored yet.';

  const skillsContext = getSkillsContext();
  const settings = getSettings();
  const usage = getTodayUsage();

  const autonomyInstructions: Record<string, string> = {
    low: 'Always ask for confirmation before executing any tool or taking any action.',
    medium: 'You may execute safe, read-only actions automatically. Ask before destructive actions (deleting files, sending emails, etc.).',
    high: 'You have full autonomy to execute tasks. Only ask for confirmation for irreversible actions with major consequences.',
  };

  return `You are ${settings.agentName || agentConfig.name}, a personal AI assistant running locally on the user's machine.
You are autonomous, proactive, and capable of executing real tasks — not just chatting.

## Current Context
- Date/Time: ${new Date().toISOString()}
- Workspace: ${agentConfig.workspace}
- Autonomy: ${settings.autonomyLevel}
- ${autonomyInstructions[settings.autonomyLevel] || autonomyInstructions.medium}

## Your Capabilities
You have access to tools that let you:
- Run shell commands on the local machine
- Read, write, and manage files in the workspace
- Browse the web and fetch URLs
- Control a headless browser for complex web tasks
- Store and recall long-term memories
- Schedule cron jobs and manage heartbeat tasks
- Create new skills to extend your capabilities
${settings.toolPermissions.email ? '- Read and send emails via IMAP/SMTP' : ''}
${settings.toolPermissions.socialMedia ? '- Interact with GitHub, Mastodon, and Reddit' : ''}
${settings.toolPermissions.systemControl ? '- Control the OS: clipboard, notifications, apps, screenshots' : ''}
- **Create complex tasks** that get decomposed into subtasks and run in parallel across different AI models
- **Track costs** and manage budgets for LLM usage
- **Set up triggers** (file watch, webhooks, cron, calendar, email) for reactive automation

## Multi-Agent Orchestration
For complex tasks requiring multiple steps, research, or synthesis, use the \`create_task\` tool.
The orchestrator will automatically:
1. Decompose the task into subtasks
2. Route each subtask to the optimal model (fast/balanced/reasoning/local)
3. Run independent subtasks in parallel
4. Synthesize results into a cohesive response

## Approval System
When approval is needed, the user can reply with:
- \`/approve <id>\` — proceed with the action
- \`/reject <id>\` — cancel it
- \`/pending\` — list all pending approvals
- \`/tasks\` — list all tasks
- \`/cost\` — today's spending

## Cost Tracking
Today: ${usage.callCount} calls, $${usage.estimatedCost.toFixed(4)} spent

## Long-term Memory
${memoryContext}

${skillsContext}

## Guidelines
1. Be proactive — if you notice something useful, do it.
2. Use tools to accomplish tasks, don't just describe what you would do.
3. Remember important facts about the user using the 'remember' tool.
4. For complex multi-step work, use create_task to leverage multi-agent orchestration.
5. If a tool call fails, try an alternative approach before giving up.
6. Keep responses concise but informative.
7. Monitor costs — mention if budget is running low.
`;
}

// ---- Main Agent Loop -----------------------------------------

export async function processMessage(message: InboundMessage): Promise<string> {
  const { channel, userId, text } = message;
  log.info(`Processing: [${channel}/${userId}] ${text.slice(0, 100)}`);

  // Handle chat commands first
  const cmdResult = await handleChatCommand(text, userId);
  if (cmdResult !== null) return cmdResult;

  // Budget check
  if (!canMakeCall()) {
    return '⚠️ Daily LLM budget exceeded. Use `/cost` to check spending or ask the admin to adjust the budget.';
  }

  // Load conversation thread
  const thread = await loadThread(channel, userId);
  const systemPrompt = await buildSystemPrompt(userId);

  if (thread.summary) {
    thread.messages.unshift({
      role: 'system',
      content: `[Previous conversation summary: ${thread.summary}]`,
    });
  }

  thread.messages.push({ role: 'user', content: text });

  const tools = getToolDefinitions();
  const settings = getSettings();
  const maxIterations = settings.maxToolCallsPerMessage || agentConfig.maxToolCalls;
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    if (!canMakeCall()) {
      const budgetMsg = 'I\'ve hit the daily budget limit. Here\'s what I have so far.';
      thread.messages.push({ role: 'assistant', content: budgetMsg });
      await saveThread(thread);
      return budgetMsg;
    }

    const response = await callLLM(
      thread.messages.filter(m => m.role !== 'system'),
      tools,
      systemPrompt,
    );

    // Track cost
    if (response.usage) {
      await trackUsage(
        agentConfig.model,
        response.usage.inputTokens,
        response.usage.outputTokens,
      );
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      thread.messages.push({ role: 'assistant', content: response.content });
      await saveThread(thread);
      return response.content;
    }

    const assistantContent: any[] = [];
    if (response.content) {
      assistantContent.push({ type: 'text', text: response.content });
    }
    for (const tc of response.toolCalls) {
      assistantContent.push({
        type: 'tool_use', id: tc.id, name: tc.name, input: tc.input,
      });
    }
    thread.messages.push({ role: 'assistant', content: assistantContent });

    const results = await Promise.all(
      response.toolCalls.map(tc => executeTool(tc)),
    );

    for (const result of results) {
      thread.messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.content,
      });
    }

    log.info(`Executed ${results.length} tool(s), iteration ${iterations}/${maxIterations}`);
  }

  log.warn(`Hit max iterations (${maxIterations})`);
  const finalMsg = 'I reached the maximum number of tool calls for this request. Here\'s what I accomplished so far — let me know if you need me to continue.';
  thread.messages.push({ role: 'assistant', content: finalMsg });
  await saveThread(thread);
  return finalMsg;
}

// ---- Heartbeat Processing ------------------------------------

export async function processHeartbeat(
  tasks: { description: string }[],
  channel: string,
  userId: string,
): Promise<string | null> {
  if (!canMakeCall()) return null;

  const taskList = tasks.map(t => `- ${t.description}`).join('\n');
  const systemPrompt = await buildSystemPrompt(userId);

  const messages: LLMMessage[] = [{
    role: 'user',
    content: `Heartbeat check. Review these tasks and act if needed:\n\n${taskList}\n\nIf nothing needs attention, respond with exactly: HEARTBEAT_OK`,
  }];

  const response = await callLLM(messages, getToolDefinitions(), systemPrompt);

  if (response.usage) {
    await trackUsage(agentConfig.model, response.usage.inputTokens, response.usage.outputTokens);
  }

  if (response.content.trim() === 'HEARTBEAT_OK') return null;
  return response.content;
}

// ---- Trigger Processing --------------------------------------

export async function processTrigger(
  trigger: TriggerDefinition,
  payload: unknown,
): Promise<string | null> {
  if (!canMakeCall()) return null;

  const systemPrompt = await buildSystemPrompt('trigger');
  const triggerContext = `
Event trigger "${trigger.name}" (${trigger.type}) has fired.
Action configured: ${trigger.action.type} — ${trigger.action.content}

Trigger payload:
${JSON.stringify(payload, null, 2).slice(0, 3000)}

Execute the configured action based on the trigger payload.`;

  const messages: LLMMessage[] = [{ role: 'user', content: triggerContext }];
  const response = await callLLM(messages, getToolDefinitions(), systemPrompt);

  if (response.usage) {
    await trackUsage(agentConfig.model, response.usage.inputTokens, response.usage.outputTokens);
  }

  return response.content;
}
