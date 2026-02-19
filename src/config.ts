// ============================================================
// Config — Loads and validates environment configuration
// ============================================================

import { config as loadEnv } from 'dotenv';
import path from 'path';
import type { AgentConfig, LLMProvider, AutonomyLevel } from './types.js';

loadEnv();

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function envBool(key: string, fallback = false): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return ['true', '1', 'yes'].includes(val.toLowerCase());
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

function envList(key: string): string[] {
  const val = process.env[key];
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

// ---- Exported config -----------------------------------------

export const llmConfig = {
  provider: env('LLM_PROVIDER', 'anthropic') as LLMProvider,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: env('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiModel: env('OPENAI_MODEL', 'gpt-4o'),
  ollamaBaseUrl: env('OLLAMA_BASE_URL', 'http://localhost:11434'),
  ollamaModel: env('OLLAMA_MODEL', 'llama3.1'),
};

export const channelConfig = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  },
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN ?? '',
    allowedChannelIds: envList('DISCORD_ALLOWED_CHANNEL_IDS'),
  },
};

export const gatewayConfig = {
  port: envInt('GATEWAY_PORT', 18789),
  host: env('GATEWAY_HOST', '127.0.0.1'),
};

export const heartbeatConfig = {
  enabled: envBool('HEARTBEAT_ENABLED', true),
  intervalMinutes: envInt('HEARTBEAT_INTERVAL_MINUTES', 30),
  channel: env('HEARTBEAT_CHANNEL', 'telegram'),
};

export const securityConfig = {
  /** Require bearer token for HTTP/WS gateway access */
  gatewayAuthEnabled: envBool('GATEWAY_AUTH_ENABLED', true),
  /** Max HTTP request body size in bytes */
  maxRequestBodyBytes: envInt('MAX_REQUEST_BODY_BYTES', 1_048_576),
  /** Rate limit: requests per minute per IP for gateway */
  gatewayRateLimitPerMin: envInt('GATEWAY_RATE_LIMIT_PER_MIN', 60),
  /** Rate limit: LLM calls per minute */
  llmRateLimitPerMin: envInt('LLM_RATE_LIMIT_PER_MIN', 30),
  /** Block web_fetch/browser from accessing internal networks */
  ssrfProtectionEnabled: envBool('SSRF_PROTECTION_ENABLED', true),
  /** Wrap fetched web content with anti-injection markers */
  promptInjectionGuards: envBool('PROMPT_INJECTION_GUARDS', true),
  /** Max shell command execution time (ms) */
  shellTimeoutMs: envInt('SHELL_TIMEOUT_MS', 30_000),
  /** Maximum output size from any single tool (chars) */
  maxToolOutputChars: envInt('MAX_TOOL_OUTPUT_CHARS', 50_000),
  /** Enable persistent audit logging of all tool calls */
  auditLogEnabled: envBool('AUDIT_LOG_ENABLED', true),
};

export const agentConfig: AgentConfig = {
  name: env('AGENT_NAME', 'Agent'),
  provider: llmConfig.provider,
  model: llmConfig.provider === 'anthropic'
    ? llmConfig.anthropicModel
    : llmConfig.provider === 'openai'
      ? llmConfig.openaiModel
      : llmConfig.ollamaModel,
  autonomyLevel: env('AGENT_AUTONOMY_LEVEL', 'medium') as AutonomyLevel,
  maxToolCalls: envInt('AGENT_MAX_TOOL_CALLS', 20),
  workspace: path.resolve(env('AGENT_WORKSPACE', './workspace')),
  systemPrompt: '',
  allowedUserIds: envList('ALLOWED_USER_IDS'),
  sandboxEnabled: envBool('SANDBOX_ENABLED', true),
};
