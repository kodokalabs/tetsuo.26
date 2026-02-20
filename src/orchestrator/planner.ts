// ============================================================
// Orchestrator — Decomposes complex tasks into subtasks, assigns
// each to the optimal model, runs parallel where possible, and
// synthesizes results. The "brain" of multi-agent execution.
// ============================================================

import { v4 as uuid } from 'uuid';
import { callLLM } from '../llm/provider.js';
import { getToolDefinitions, executeTool } from '../tools/registry.js';
import { routeSubtask, getRouteCost } from './router.js';
import {
  createTask, updateTaskStatus, addTaskStep,
  updateTaskStep, addUsage, appendScratchpad,
  getTask, getSubtasks,
} from '../tasks/queue.js';
import { requestApproval } from '../tasks/approvals.js';
import { getSettings } from '../security/settings.js';
import { getSkillsContext } from '../skills/loader.js';
import { searchMemory, getAllMemories } from '../memory/store.js';
import { agentConfig } from '../config.js';
import { eventBus } from '../events.js';
import { createLogger } from '../utils/logger.js';
import type {
  Task, OrchestratorPlan, PlannedSubtask, SubAgent,
  LLMMessage, ToolCall, Id, ModelRoute,
} from '../types.js';

const log = createLogger('Orchestrator');

// Active sub-agents
const agents = new Map<Id, SubAgent>();

// ---- Plan: ask LLM to decompose a complex task --------------

export async function planTask(task: Task): Promise<OrchestratorPlan> {
  await updateTaskStatus(task.id, 'running');
  await appendScratchpad(task.id, 'Starting task planning...');

  const planPrompt = buildPlanningPrompt(task);

  const response = await callLLM([
    { role: 'system', content: planPrompt },
    { role: 'user', content: `Decompose this task into subtasks:\n\nTitle: ${task.title}\nDescription: ${task.description}\n\nRespond with ONLY a JSON object matching this schema:\n{\n  "subtasks": [\n    {\n      "title": "string",\n      "description": "string",\n      "role": "researcher|coder|writer|reviewer|executor",\n      "modelTier": "fast|balanced|reasoning|local",\n      "parallelGroup": "A|B|C...",\n      "complexity": 1-10,\n      "requiresPrivacy": boolean,\n      "dependsOn": [] // titles of subtasks this depends on\n    }\n  ]\n}\n\nRules:\n- Subtasks in the same parallelGroup run concurrently\n- Use "fast" for simple lookups/transforms, "balanced" for standard work, "reasoning" for complex analysis, "local" for private data\n- Be thorough but don't over-decompose simple tasks (1-3 subtasks for simple, 3-8 for complex)` },
  ], getToolDefinitions());

  let subtasks: PlannedSubtask[];
  try {
    // Parse the JSON from the LLM response
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    const parsed = JSON.parse(jsonMatch[0]);

    subtasks = (parsed.subtasks || []).map((s: any) => ({
      id: uuid(),
      title: s.title,
      description: s.description,
      role: s.role || 'executor',
      modelTier: s.modelTier || 'balanced',
      parallelGroup: s.parallelGroup,
      complexity: s.complexity || 5,
      requiresPrivacy: s.requiresPrivacy || false,
      status: 'pending' as const,
    }));
  } catch (err) {
    // If planning fails, treat the whole thing as a single task
    log.warn(`Planning failed, treating as single task: ${err}`);
    subtasks = [{
      id: uuid(),
      title: task.title,
      description: task.description,
      role: 'executor',
      modelTier: 'balanced',
      complexity: 5,
      requiresPrivacy: false,
      status: 'pending',
    }];
  }

  // Build dependency graph
  const dependencies: Record<Id, Id[]> = {};
  for (const st of subtasks) {
    dependencies[st.id] = []; // populated if dependsOn was specified
  }

  const plan: OrchestratorPlan = {
    id: uuid(),
    parentTaskId: task.id,
    objective: task.description,
    subtasks,
    dependencies,
    status: 'executing',
    createdAt: new Date(),
  };

  await appendScratchpad(task.id, `Plan created: ${subtasks.length} subtasks across ${new Set(subtasks.map(s => s.parallelGroup).filter(Boolean)).size || 1} parallel groups`);
  log.info(`Plan for "${task.title}": ${subtasks.length} subtasks`);
  subtasks.forEach(s => log.info(`  → [${s.modelTier}] ${s.title} (complexity:${s.complexity}, group:${s.parallelGroup || 'seq'})`));

  return plan;
}

// ---- Execute plan: run subtasks, respecting dependencies -----

export async function executePlan(plan: OrchestratorPlan, parentTask: Task): Promise<string> {
  const { subtasks, dependencies } = plan;
  const results = new Map<Id, string>();
  const completed = new Set<Id>();

  // Group subtasks by parallel group
  const groups = new Map<string, PlannedSubtask[]>();
  const sequential: PlannedSubtask[] = [];

  for (const st of subtasks) {
    if (st.parallelGroup) {
      const group = groups.get(st.parallelGroup) || [];
      group.push(st);
      groups.set(st.parallelGroup, group);
    } else {
      sequential.push(st);
    }
  }

  // Execute parallel groups first, then sequential
  const allGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [groupName, groupTasks] of allGroups) {
    await appendScratchpad(parentTask.id, `Executing parallel group ${groupName}: ${groupTasks.map(t => t.title).join(', ')}`);

    // Check dependencies
    for (const st of groupTasks) {
      const deps = dependencies[st.id] || [];
      const unmet = deps.filter(d => !completed.has(d));
      if (unmet.length > 0) {
        log.warn(`Subtask "${st.title}" has unmet deps, running sequentially`);
      }
    }

    // Run all tasks in this group concurrently
    const promises = groupTasks.map(st => executeSubtask(st, parentTask, results));
    const groupResults = await Promise.allSettled(promises);

    for (let i = 0; i < groupTasks.length; i++) {
      const st = groupTasks[i];
      const result = groupResults[i];
      if (result.status === 'fulfilled') {
        results.set(st.id, result.value);
        completed.add(st.id);
        st.status = 'completed';
        st.result = result.value;
      } else {
        st.status = 'failed';
        results.set(st.id, `ERROR: ${result.reason}`);
        completed.add(st.id);
        log.error(`Subtask "${st.title}" failed: ${result.reason}`);
      }
    }

    await updateTaskStatus(parentTask.id, 'running', {
      progress: Math.round((completed.size / subtasks.length) * 90),
    });
  }

  // Sequential subtasks
  for (const st of sequential) {
    await appendScratchpad(parentTask.id, `Executing: ${st.title}`);
    try {
      const result = await executeSubtask(st, parentTask, results);
      results.set(st.id, result);
      completed.add(st.id);
      st.status = 'completed';
      st.result = result;
    } catch (err: any) {
      st.status = 'failed';
      results.set(st.id, `ERROR: ${err.message}`);
      completed.add(st.id);
    }

    await updateTaskStatus(parentTask.id, 'running', {
      progress: Math.round((completed.size / subtasks.length) * 90),
    });
  }

  // Synthesize results
  const synthesis = await synthesizeResults(parentTask, subtasks, results);
  plan.status = 'completed';
  return synthesis;
}

// ---- Execute a single subtask with its assigned model --------

async function executeSubtask(
  subtask: PlannedSubtask,
  parentTask: Task,
  previousResults: Map<Id, string>,
): Promise<string> {
  const route = routeSubtask(subtask);
  const settings = getSettings();

  // Create a child task for tracking
  const childTask = await createTask({
    title: subtask.title,
    description: subtask.description,
    source: parentTask.source,
    parentId: parentTask.id,
    model: route.model,
    provider: route.provider,
    tags: [subtask.role, subtask.modelTier],
  });

  // Create / register sub-agent
  const agent: SubAgent = {
    id: uuid(),
    name: `${subtask.role}-${childTask.id.slice(0, 6)}`,
    role: subtask.role,
    provider: route.provider,
    model: route.model,
    status: 'busy',
    currentTaskId: childTask.id,
    routingReason: `Complexity:${subtask.complexity}, Tier:${subtask.modelTier}, Privacy:${subtask.requiresPrivacy}`,
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  };
  agents.set(agent.id, agent);
  subtask.assignedAgentId = agent.id;

  eventBus.emit({ type: 'subtask_spawned', parentId: parentTask.id, subtask, agentId: agent.id });

  log.info(`Sub-agent ${agent.name} executing "${subtask.title}" on ${route.provider}/${route.model}`);

  await updateTaskStatus(childTask.id, 'running');

  // Build context with previous results
  const prevContext = Array.from(previousResults.entries())
    .map(([id, result]) => `[Previous result]: ${result.slice(0, 2000)}`)
    .join('\n\n');

  // Agent loop for this subtask
  const systemPrompt = buildSubtaskPrompt(subtask, parentTask, prevContext);
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Execute this task:\n\n${subtask.description}\n\nParent objective: ${parentTask.description}` },
  ];

  const maxIterations = Math.min(settings.maxToolCallsPerMessage, 15);
  let iteration = 0;
  let finalResult = '';

  while (iteration < maxIterations) {
    iteration++;

    const response = await callLLM(messages, getToolDefinitions(), {
      provider: route.provider,
      model: route.model,
    });

    // Track usage
    if (response.usage) {
      const cost = getRouteCost(route, response.usage.inputTokens, response.usage.outputTokens);
      agent.usage.inputTokens += response.usage.inputTokens;
      agent.usage.outputTokens += response.usage.outputTokens;
      agent.usage.estimatedCost += cost;
      await addUsage(childTask.id, response.usage.inputTokens, response.usage.outputTokens, route.costPer1kInput, route.costPer1kOutput);
      await addUsage(parentTask.id, response.usage.inputTokens, response.usage.outputTokens, route.costPer1kInput, route.costPer1kOutput);
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalResult = response.content;
      break;
    }

    // Execute tool calls
    messages.push({
      role: 'assistant',
      content: response.toolCalls.map(tc => ({
        type: 'tool_use' as const,
        tool_use_id: tc.id,
        tool_name: tc.name,
        input: tc.input,
      })),
    });

    for (const tc of response.toolCalls) {
      // Check if approval needed
      const needsApproval = shouldRequestApproval(tc, settings.autonomyLevel);
      if (needsApproval) {
        const approved = await requestApproval({
          taskId: childTask.id,
          stepDescription: `Sub-agent "${agent.name}" wants to use ${tc.name}`,
          tool: tc.name,
          input: tc.input,
          reasoning: `Part of subtask: ${subtask.title}`,
          riskLevel: categorizeToolRisk(tc.name),
          riskExplanation: `Tool ${tc.name} called during autonomous subtask execution`,
          channel: parentTask.source.channel,
          userId: parentTask.source.userId,
        });

        if (!approved) {
          messages.push({
            role: 'tool',
            content: 'Action was rejected by user. Find an alternative approach or report what you have.',
            tool_call_id: tc.id,
          });
          continue;
        }
      }

      const result = await executeTool(tc);
      messages.push({
        role: 'tool',
        content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        tool_call_id: tc.id,
      });
    }
  }

  // Finalize
  agent.status = 'idle';
  agent.currentTaskId = undefined;
  await updateTaskStatus(childTask.id, 'completed', { result: finalResult });

  log.info(`Sub-agent ${agent.name} completed "${subtask.title}" (${agent.usage.inputTokens + agent.usage.outputTokens} tokens, $${agent.usage.estimatedCost.toFixed(4)})`);

  return finalResult;
}

// ---- Synthesize all subtask results into final answer --------

async function synthesizeResults(
  parentTask: Task,
  subtasks: PlannedSubtask[],
  results: Map<Id, string>,
): Promise<string> {
  await appendScratchpad(parentTask.id, 'Synthesizing results from all sub-agents...');

  const context = subtasks.map(st => {
    const result = results.get(st.id) || '(no result)';
    return `## Subtask: ${st.title}\nRole: ${st.role} | Model: ${st.modelTier}\nResult:\n${result.slice(0, 5000)}`;
  }).join('\n\n---\n\n');

  const response = await callLLM([
    { role: 'system', content: 'You are a coordinator synthesizing results from multiple specialist agents. Combine their outputs into a cohesive, well-structured final response. Resolve any conflicts between results. Be thorough but concise.' },
    { role: 'user', content: `Original request: ${parentTask.description}\n\nResults from ${subtasks.length} sub-agents:\n\n${context}\n\nSynthesize these into a single comprehensive response.` },
  ], []);

  if (response.usage) {
    await addUsage(parentTask.id, response.usage.inputTokens, response.usage.outputTokens);
  }

  return response.content;
}

// ---- Run entire orchestration for a task ---------------------

export async function orchestrate(task: Task): Promise<string> {
  try {
    const plan = await planTask(task);
    const result = await executePlan(plan, task);

    await updateTaskStatus(task.id, 'completed', { result, progress: 100 });
    return result;
  } catch (err: any) {
    await updateTaskStatus(task.id, 'failed', { error: err.message });
    throw err;
  }
}

// ---- Should this task use orchestration? ---------------------

export function shouldOrchestrate(description: string): boolean {
  const complexIndicators = [
    /\band\b.*\band\b/i,           // multiple "and"s suggest multi-part
    /\bstep[s]?\b/i,               // explicit steps
    /\bfirst\b.*\bthen\b/i,        // sequential instructions
    /\bcompare\b.*\bwith\b/i,      // comparison tasks
    /\bresearch\b.*\bwrite\b/i,    // research + produce
    /\banalyze\b.*\breport\b/i,    // analyze + report
    /\bcreate\b.*\band\b.*\bdeploy\b/i,
    /\bplan\b/i,
    /\bcomprehensive\b/i,
    /\bmultiple\b/i,
  ];

  const matches = complexIndicators.filter(p => p.test(description)).length;
  // More than 100 words or 2+ complexity indicators = orchestrate
  const wordCount = description.split(/\s+/).length;
  return wordCount > 100 || matches >= 2;
}

// ---- Helpers -------------------------------------------------

function buildPlanningPrompt(task: Task): string {
  return `You are a task planning coordinator. Your job is to decompose complex tasks into smaller, independently executable subtasks.

Guidelines:
- Each subtask should be completable by a single LLM agent with tools
- Identify which subtasks can run in parallel (same parallelGroup letter)
- Assign complexity 1-10 based on reasoning required
- Use "local" modelTier for anything touching private user data
- Use "fast" for simple lookups, formatting, basic transforms
- Use "balanced" for standard coding, writing, analysis
- Use "reasoning" for complex logic, math, architecture decisions
- Don't over-decompose: 1-3 subtasks for simple, 3-8 for complex tasks
- Available tools: ${getToolDefinitions().map(t => t.name).join(', ')}`;
}

function buildSubtaskPrompt(subtask: PlannedSubtask, parent: Task, prevContext: string): string {
  const skills = getSkillsContext();
  const ts = new Date().toISOString();

  return `You are a specialist sub-agent (role: ${subtask.role}) working on a subtask within a larger objective.

Current time: ${ts}
Workspace: ${agentConfig.workspace}
Your role: ${subtask.role}

Parent objective: ${parent.title}
Your subtask: ${subtask.title}

${prevContext ? `Context from previous subtasks:\n${prevContext}\n` : ''}
${skills ? `Relevant skills:\n${skills}\n` : ''}

Instructions:
- Focus ONLY on your specific subtask
- Use tools as needed to accomplish it
- Be thorough but efficient
- Return a clear, structured result that can be combined with other subtask results`;
}

function shouldRequestApproval(tc: ToolCall, autonomy: string): boolean {
  if (autonomy === 'high') return false;
  if (autonomy === 'low') return true;

  // Medium: approve writes, sends, and system actions
  const dangerousTools = new Set([
    'run_shell', 'write_file', 'email_send', 'mastodon_post',
    'reddit_post', 'open_application', 'clipboard_write',
  ]);
  return dangerousTools.has(tc.name);
}

function categorizeToolRisk(tool: string): 'low' | 'medium' | 'high' | 'critical' {
  const riskMap: Record<string, 'low' | 'medium' | 'high' | 'critical'> = {
    read_file: 'low', list_directory: 'low', recall: 'low', system_info: 'low',
    web_fetch: 'low', browser_action: 'medium', email_read: 'medium',
    write_file: 'medium', remember: 'low', schedule_cron: 'medium',
    run_shell: 'high', email_send: 'high', mastodon_post: 'high',
    reddit_post: 'high', open_application: 'high', clipboard_write: 'medium',
  };
  return riskMap[tool] || 'medium';
}

// ---- Query active agents ------------------------------------

export function getActiveAgents(): SubAgent[] {
  return Array.from(agents.values());
}

export function getAgentById(id: Id): SubAgent | undefined {
  return agents.get(id);
}
