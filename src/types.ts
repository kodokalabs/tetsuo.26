// ============================================================
// Core Types — Shared across all modules
// ============================================================

/** Unique identifier for conversations, messages, sessions */
export type Id = string;

/** Supported chat platforms */
export type ChannelType = 'telegram' | 'discord' | 'webchat' | 'cli';

/** How much the agent can do on its own */
export type AutonomyLevel = 'low' | 'medium' | 'high';

/** LLM provider backends */
export type LLMProvider = 'anthropic' | 'openai' | 'ollama';

// ---- Messages ------------------------------------------------

export interface InboundMessage {
  id: Id;
  channel: ChannelType;
  channelMessageId: string;
  userId: string;
  userName: string;
  text: string;
  attachments?: Attachment[];
  timestamp: Date;
  replyToMessageId?: string;
}

export interface OutboundMessage {
  channel: ChannelType;
  userId: string;
  text: string;
  attachments?: Attachment[];
  replyToMessageId?: string;
}

export interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video';
  url?: string;
  path?: string;
  mimeType?: string;
  name?: string;
}

// ---- LLM -----------------------------------------------------

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LLMContentBlock[];
  tool_call_id?: string;
  name?: string;
}

export interface LLMContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  tool_use_id?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  stopReason?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ---- Tools ---------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

// ---- Skills --------------------------------------------------

export interface SkillManifest {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tools?: string[];           // tool names this skill provides
  triggers?: string[];        // keywords or patterns that activate it
  instructions: string;       // the natural-language prompt/instructions
  filePath: string;           // path to the SKILL.md
}

// ---- Memory --------------------------------------------------

export interface MemoryEntry {
  id: Id;
  type: 'conversation' | 'fact' | 'preference' | 'task' | 'note';
  content: string;
  tags: string[];
  source: { channel: ChannelType; userId: string };
  createdAt: Date;
  updatedAt: Date;
  importance: number;         // 0-10
}

export interface ConversationThread {
  id: Id;
  channel: ChannelType;
  userId: string;
  messages: LLMMessage[];
  createdAt: Date;
  updatedAt: Date;
  summary?: string;
}

// ---- Heartbeat -----------------------------------------------

export interface HeartbeatTask {
  id: Id;
  description: string;
  schedule?: string;          // cron expression
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  channel?: ChannelType;
  userId?: string;
}

// ---- Gateway -------------------------------------------------

export interface Session {
  id: Id;
  channel: ChannelType;
  userId: string;
  thread: ConversationThread;
  activeTools: string[];
  createdAt: Date;
  lastActivity: Date;
}

export interface AgentConfig {
  name: string;
  provider: LLMProvider;
  model: string;
  autonomyLevel: AutonomyLevel;
  maxToolCalls: number;
  workspace: string;
  systemPrompt: string;
  allowedUserIds: string[];
  sandboxEnabled: boolean;
}

// ---- Task Queue ----------------------------------------------

export type TaskStatus = 'pending' | 'running' | 'waiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export interface Task {
  id: Id;
  parentId?: Id;                // if this is a subtask
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;             // 0-100
  steps: TaskStep[];
  currentStepIndex: number;
  result?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  /** Who requested this task */
  source: { channel: ChannelType; userId: string };
  /** Which model to use (can differ from default) */
  model?: string;
  provider?: LLMProvider;
  /** Token/cost tracking */
  usage: { inputTokens: number; outputTokens: number; estimatedCost: number };
  /** Scratchpad: agent's working notes, plans, intermediate results */
  scratchpad: string;
  /** Tags for filtering */
  tags: string[];
}

export interface TaskStep {
  id: Id;
  description: string;
  status: TaskStatus;
  toolCalls?: string[];         // names of tools used
  result?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

// ---- Approval Workflow ---------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRequest {
  id: Id;
  taskId: Id;
  stepDescription: string;
  /** What the agent wants to do */
  proposedAction: {
    tool: string;
    input: Record<string, unknown>;
    reasoning: string;          // why the agent wants to do this
  };
  /** Risk assessment */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskExplanation: string;
  status: ApprovalStatus;
  /** Who needs to approve */
  channel: ChannelType;
  userId: string;
  createdAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  expiresAt: Date;
}

// ---- Multi-Agent Orchestrator --------------------------------

export type WorkerStatus = 'idle' | 'busy' | 'error' | 'stopped';

export interface SubAgent {
  id: Id;
  name: string;
  role: string;                 // e.g. "researcher", "coder", "reviewer"
  provider: LLMProvider;
  model: string;
  status: WorkerStatus;
  currentTaskId?: Id;
  /** Model selection reasoning */
  routingReason: string;
  /** Accumulated usage */
  usage: { inputTokens: number; outputTokens: number; estimatedCost: number };
}

export interface OrchestratorPlan {
  id: Id;
  parentTaskId: Id;
  objective: string;
  subtasks: PlannedSubtask[];
  /** Dependency graph: subtask ID → IDs it depends on */
  dependencies: Record<Id, Id[]>;
  status: 'planning' | 'executing' | 'completed' | 'failed';
  createdAt: Date;
}

export interface PlannedSubtask {
  id: Id;
  title: string;
  description: string;
  /** Suggested agent role */
  role: string;
  /** Suggested model tier */
  modelTier: 'fast' | 'balanced' | 'reasoning' | 'local';
  /** Can run in parallel with which other subtask IDs? */
  parallelGroup?: string;
  /** Estimated complexity 1-10 */
  complexity: number;
  /** Does this touch private data? Route to local model. */
  requiresPrivacy: boolean;
  status: TaskStatus;
  result?: string;
  assignedAgentId?: Id;
}

/** Model routing configuration */
export interface ModelRoute {
  tier: 'fast' | 'balanced' | 'reasoning' | 'local';
  provider: LLMProvider;
  model: string;
  maxTokens: number;
  costPer1kInput: number;
  costPer1kOutput: number;
}

// ---- Event Triggers ------------------------------------------

export type TriggerType = 'file_watch' | 'webhook' | 'calendar' | 'cron' | 'email_watch';

export interface TriggerDefinition {
  id: Id;
  type: TriggerType;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /** What to do when triggered */
  action: {
    type: 'message' | 'task' | 'skill';
    content: string;            // message text, task description, or skill name
    channel?: ChannelType;
    userId?: string;
  };
  lastTriggered?: Date;
  triggerCount: number;
}

// ---- Events --------------------------------------------------

export type AgentEvent =
  | { type: 'message_received'; message: InboundMessage }
  | { type: 'message_sent'; message: OutboundMessage }
  | { type: 'tool_called'; tool: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: string; isError: boolean }
  | { type: 'heartbeat_tick'; tasks: HeartbeatTask[] }
  | { type: 'skill_loaded'; skill: SkillManifest }
  | { type: 'error'; error: string; context?: string }
  | { type: 'task_created'; task: Task }
  | { type: 'task_updated'; task: Task }
  | { type: 'task_completed'; task: Task }
  | { type: 'approval_requested'; approval: ApprovalRequest }
  | { type: 'approval_resolved'; approval: ApprovalRequest }
  | { type: 'subtask_spawned'; parentId: Id; subtask: PlannedSubtask; agentId: Id }
  | { type: 'trigger_fired'; trigger: TriggerDefinition; payload?: unknown };
