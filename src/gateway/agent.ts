// ============================================================
// Agent Loop — The core brain: message → LLM → tools → reply
// ============================================================

import { callLLM } from '../llm/provider.js';
import { getToolDefinitions, executeTool } from '../tools/registry.js';
import { loadThread, saveThread, searchMemory, getAllMemories } from '../memory/store.js';
import { getSkillsContext } from '../skills/loader.js';
import { agentConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { InboundMessage, LLMMessage, ToolCall } from '../types.js';

const log = createLogger('Agent');

// ---- System Prompt Builder -----------------------------------

async function buildSystemPrompt(userId: string): Promise<string> {
  // Gather relevant memories for this user
  const memories = await getAllMemories();
  const memoryContext = memories.length > 0
    ? memories.slice(0, 20).map(m => `- [${m.type}] ${m.content}`).join('\n')
    : 'No memories stored yet.';

  const skillsContext = getSkillsContext();

  const now = new Date();
  const autonomyInstructions = {
    low: 'Always ask for confirmation before executing any tool or taking any action.',
    medium: 'You may execute safe, read-only actions automatically. Ask before destructive actions (deleting files, sending emails, etc.).',
    high: 'You have full autonomy to execute tasks. Only ask for confirmation for irreversible actions with major consequences.',
  };

  return `You are ${agentConfig.name}, a personal AI assistant running locally on the user's machine.
You are autonomous, proactive, and capable of executing real tasks — not just chatting.

## Current Context
- Date/Time: ${now.toISOString()}
- Workspace: ${agentConfig.workspace}
- Autonomy Level: ${agentConfig.autonomyLevel}
- ${autonomyInstructions[agentConfig.autonomyLevel]}

## Your Capabilities
You have access to tools that let you:
- Run shell commands on the local machine
- Read, write, and manage files
- Browse the web and fetch URLs
- Control a headless browser for complex web tasks
- Store and recall long-term memories about the user
- Schedule recurring cron jobs and manage heartbeat tasks
- Create new skills to extend your own capabilities

## Long-term Memory
${memoryContext}

${skillsContext}

## Guidelines
1. Be proactive — if you notice something useful, do it.
2. Use tools to accomplish tasks, don't just describe what you would do.
3. Remember important facts about the user using the 'remember' tool.
4. When given a complex task, break it down into steps and execute them.
5. If a tool call fails, try an alternative approach before giving up.
6. Keep responses concise but informative.
7. For heartbeat tasks, decide if any need action and respond accordingly.
`;
}

// ---- Agent Loop (agentic tool-use loop) ----------------------

export async function processMessage(message: InboundMessage): Promise<string> {
  const { channel, userId, text } = message;
  log.info(`Processing: [${channel}/${userId}] ${text.slice(0, 100)}`);

  // Load conversation thread
  const thread = await loadThread(channel, userId);

  // Build system prompt with full context
  const systemPrompt = await buildSystemPrompt(userId);

  // Add summary context if available
  if (thread.summary) {
    thread.messages.unshift({
      role: 'system',
      content: `[Previous conversation summary: ${thread.summary}]`,
    });
  }

  // Add user message
  thread.messages.push({ role: 'user', content: text });

  // Get available tools
  const tools = getToolDefinitions();

  // Agentic loop: call LLM, execute tools, repeat until done
  let iterations = 0;
  const maxIterations = agentConfig.maxToolCalls;

  while (iterations < maxIterations) {
    iterations++;

    const response = await callLLM(
      thread.messages.filter(m => m.role !== 'system'), // system goes separately
      tools,
      systemPrompt,
    );

    log.debug(`LLM response (iter ${iterations}): ${response.content.slice(0, 100)}`);
    if (response.usage) {
      log.debug(`Tokens: ${response.usage.inputTokens} in / ${response.usage.outputTokens} out`);
    }

    // If no tool calls, we're done
    if (!response.toolCalls || response.toolCalls.length === 0) {
      thread.messages.push({ role: 'assistant', content: response.content });
      await saveThread(thread);
      return response.content;
    }

    // Build assistant message with tool calls (Anthropic format)
    const assistantContent: any[] = [];
    if (response.content) {
      assistantContent.push({ type: 'text', text: response.content });
    }
    for (const tc of response.toolCalls) {
      assistantContent.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }
    thread.messages.push({ role: 'assistant', content: assistantContent });

    // Execute all tool calls
    const results = await Promise.all(
      response.toolCalls.map(tc => executeTool(tc)),
    );

    // Add tool results to conversation
    for (const result of results) {
      thread.messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.content,
      });
    }

    log.info(`Executed ${results.length} tool(s), iteration ${iterations}/${maxIterations}`);

    // Continue the loop — LLM will see the tool results and decide next step
  }

  // Hit max iterations
  log.warn(`Hit max tool iterations (${maxIterations})`);
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
  const taskList = tasks.map(t => `- ${t.description}`).join('\n');

  const systemPrompt = await buildSystemPrompt(userId);
  const heartbeatPrompt = `
This is a heartbeat check. Review the following tasks and decide if any require action right now:

${taskList}

If any tasks need action, perform them. If nothing needs attention, respond with exactly: HEARTBEAT_OK
`;

  const messages: LLMMessage[] = [{ role: 'user', content: heartbeatPrompt }];
  const tools = getToolDefinitions();

  const response = await callLLM(messages, tools, systemPrompt);

  if (response.content.trim() === 'HEARTBEAT_OK') {
    log.debug('Heartbeat: nothing to do');
    return null; // silently drop
  }

  // If the agent wants to do something, run it through the full loop
  return response.content;
}
