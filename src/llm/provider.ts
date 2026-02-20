// ============================================================
// LLM — Unified interface for Anthropic, OpenAI, and Ollama
// Supports per-call provider/model overrides for multi-agent.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { llmConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { LLMMessage, LLMResponse, LLMProvider, ToolDefinition, ToolCall } from '../types.js';

const log = createLogger('LLM');

/** Optional overrides for sub-agent routing */
export interface LLMCallOptions {
  provider?: LLMProvider;
  model?: string;
}

// ---- Anthropic adapter ---------------------------------------

async function callAnthropic(
  messages: LLMMessage[],
  tools: ToolDefinition[],
  systemPrompt: string,
  model?: string,
): Promise<LLMResponse> {
  const client = new Anthropic({ apiKey: llmConfig.anthropicApiKey });

  const apiMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [{
            type: 'tool_result' as const,
            tool_use_id: m.tool_call_id!,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          }],
        };
      }
      return {
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : m.content as any,
      };
    });

  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as any,
  }));

  const response = await client.messages.create({
    model: model || llmConfig.anthropicModel,
    max_tokens: 8192,
    system: systemPrompt,
    messages: apiMessages,
    tools: anthropicTools.length > 0 ? anthropicTools : undefined,
  });

  let text = '';
  const toolCalls: ToolCall[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  return {
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    stopReason: response.stop_reason ?? undefined,
  };
}

// ---- OpenAI-compatible adapter (works for OpenAI + Ollama) ---

async function callOpenAICompatible(
  messages: LLMMessage[],
  tools: ToolDefinition[],
  systemPrompt: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<LLMResponse> {
  const openaiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    })),
  ];

  const openaiTools = tools.length > 0 ? tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  })) : undefined;

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data = await res.json() as any;
  const choice = data.choices?.[0];
  const msg = choice?.message;

  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc: any) => ({
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments || '{}'),
  }));

  return {
    content: msg?.content ?? '',
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: data.usage ? {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    } : undefined,
    stopReason: choice?.finish_reason,
  };
}

// ---- Unified interface with per-call overrides ---------------

/**
 * Call an LLM with optional provider/model override.
 * The third argument can be either a system prompt string (backward compat)
 * or a ToolDefinition[] (in which case system prompt is extracted from messages).
 * The fourth argument is optional overrides for sub-agent routing.
 */
export async function callLLM(
  messages: LLMMessage[],
  tools: ToolDefinition[],
  systemPromptOrOptions?: string | LLMCallOptions,
  options?: LLMCallOptions,
): Promise<LLMResponse> {
  // Handle flexible call signatures
  let systemPrompt: string;
  let opts: LLMCallOptions;

  if (typeof systemPromptOrOptions === 'string') {
    systemPrompt = systemPromptOrOptions;
    opts = options || {};
  } else {
    // Extract system prompt from messages array
    const sysMsg = messages.find(m => m.role === 'system');
    systemPrompt = sysMsg ? (typeof sysMsg.content === 'string' ? sysMsg.content : '') : '';
    opts = systemPromptOrOptions || {};
  }

  const provider = opts.provider || llmConfig.provider;
  const model = opts.model;

  log.info(`Calling ${provider}${model ? `/${model}` : ''} (${tools.length} tools)`);

  switch (provider) {
    case 'anthropic':
      return callAnthropic(messages, tools, systemPrompt, model);

    case 'openai':
      return callOpenAICompatible(
        messages, tools, systemPrompt,
        'https://api.openai.com',
        llmConfig.openaiApiKey,
        model || llmConfig.openaiModel,
      );

    case 'ollama':
      return callOpenAICompatible(
        messages, tools, systemPrompt,
        llmConfig.ollamaBaseUrl,
        '',
        model || llmConfig.ollamaModel,
      );

    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
