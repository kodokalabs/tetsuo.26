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

// ---- Events --------------------------------------------------

export type AgentEvent =
  | { type: 'message_received'; message: InboundMessage }
  | { type: 'message_sent'; message: OutboundMessage }
  | { type: 'tool_called'; tool: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: string; isError: boolean }
  | { type: 'heartbeat_tick'; tasks: HeartbeatTask[] }
  | { type: 'skill_loaded'; skill: SkillManifest }
  | { type: 'error'; error: string; context?: string };
