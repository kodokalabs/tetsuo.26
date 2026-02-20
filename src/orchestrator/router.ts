// ============================================================
// Model Router — Selects optimal LLM for each subtask based on
// complexity, privacy requirements, cost, and configured tiers.
// ============================================================

import { llmConfig } from '../config.js';
import { getSettings } from '../security/settings.js';
import { createLogger } from '../utils/logger.js';
import type { ModelRoute, LLMProvider, PlannedSubtask } from '../types.js';

const log = createLogger('Router');

// ---- Default model tiers ------------------------------------

const DEFAULT_ROUTES: ModelRoute[] = [
  {
    tier: 'fast',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 4096,
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
  },
  {
    tier: 'balanced',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 8192,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
  },
  {
    tier: 'reasoning',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    maxTokens: 16384,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
  },
  {
    tier: 'local',
    provider: 'ollama',
    model: 'llama3.1',
    maxTokens: 4096,
    costPer1kInput: 0,
    costPer1kOutput: 0,
  },
];

// ---- Loaded routes (populated at init) -----------------------

let routes: ModelRoute[] = [];

export function initModelRouter(): void {
  // Build routes from what's actually configured
  routes = [];

  // Always include configured provider as balanced
  const mainRoute: ModelRoute = {
    tier: 'balanced',
    provider: llmConfig.provider,
    model: llmConfig.provider === 'anthropic' ? llmConfig.anthropicModel
         : llmConfig.provider === 'openai' ? llmConfig.openaiModel
         : llmConfig.ollamaModel,
    maxTokens: 8192,
    costPer1kInput: llmConfig.provider === 'anthropic' ? 0.003
                  : llmConfig.provider === 'openai' ? 0.005
                  : 0,
    costPer1kOutput: llmConfig.provider === 'anthropic' ? 0.015
                   : llmConfig.provider === 'openai' ? 0.015
                   : 0,
  };
  routes.push(mainRoute);

  // If Anthropic, add Haiku as fast tier and Opus as reasoning tier
  if (llmConfig.anthropicApiKey) {
    if (!routes.find(r => r.tier === 'fast')) {
      routes.push(DEFAULT_ROUTES.find(r => r.tier === 'fast')!);
    }
    if (!routes.find(r => r.tier === 'reasoning')) {
      routes.push(DEFAULT_ROUTES.find(r => r.tier === 'reasoning')!);
    }
  }

  // If OpenAI key available, add as alternate fast tier
  if (llmConfig.openaiApiKey && llmConfig.provider !== 'openai') {
    routes.push({
      tier: 'fast',
      provider: 'openai',
      model: 'gpt-4o-mini',
      maxTokens: 4096,
      costPer1kInput: 0.00015,
      costPer1kOutput: 0.0006,
    });
  }

  // If Ollama configured, always available as local tier
  if (llmConfig.ollamaModel) {
    if (!routes.find(r => r.tier === 'local')) {
      routes.push({
        tier: 'local',
        provider: 'ollama',
        model: llmConfig.ollamaModel,
        maxTokens: 4096,
        costPer1kInput: 0,
        costPer1kOutput: 0,
      });
    }
  }

  log.info(`Model router initialized with ${routes.length} routes: ${routes.map(r => `${r.tier}→${r.provider}/${r.model}`).join(', ')}`);
}

// ---- Route selection ----------------------------------------

/**
 * Select the best model for a subtask based on its properties.
 * 
 * Routing logic:
 * - Privacy-sensitive data → local model (never leaves machine)
 * - Complexity 1-3 → fast tier (Haiku / GPT-4o-mini)
 * - Complexity 4-7 → balanced tier (Sonnet / GPT-4o)
 * - Complexity 8-10 → reasoning tier (Opus)
 * - Cost budget exceeded → downgrade to cheaper tier
 */
export function routeSubtask(subtask: PlannedSubtask, budgetRemaining?: number): ModelRoute {
  // Privacy-sensitive: always local
  if (subtask.requiresPrivacy) {
    const local = routes.find(r => r.tier === 'local');
    if (local) {
      log.info(`Routing "${subtask.title}" → local (privacy required)`);
      return local;
    }
    // No local model: warn and use balanced
    log.warn(`Privacy required for "${subtask.title}" but no local model configured — using balanced`);
  }

  // Use explicitly requested tier if available
  const requested = routes.find(r => r.tier === subtask.modelTier);

  // Budget check: if remaining budget is low, downgrade
  if (budgetRemaining !== undefined && budgetRemaining < 0.10) {
    const cheapest = routes
      .filter(r => r.costPer1kInput + r.costPer1kOutput > 0 || r.tier === 'local')
      .sort((a, b) => (a.costPer1kInput + a.costPer1kOutput) - (b.costPer1kInput + b.costPer1kOutput))[0];
    if (cheapest) {
      log.info(`Routing "${subtask.title}" → ${cheapest.tier} (budget low: $${budgetRemaining.toFixed(2)} remaining)`);
      return cheapest;
    }
  }

  // Complexity-based routing
  let tier: ModelRoute['tier'];
  if (subtask.complexity <= 3) tier = 'fast';
  else if (subtask.complexity <= 7) tier = 'balanced';
  else tier = 'reasoning';

  const route = requested || routes.find(r => r.tier === tier);
  if (route) {
    log.info(`Routing "${subtask.title}" (complexity:${subtask.complexity}) → ${route.tier}/${route.model}`);
    return route;
  }

  // Fallback: first available
  const fallback = routes[0] || DEFAULT_ROUTES[1]; // balanced default
  log.warn(`No route for tier ${tier} — falling back to ${fallback.tier}/${fallback.model}`);
  return fallback;
}

export function getRoutes(): ModelRoute[] {
  return [...routes];
}

export function getRouteCost(route: ModelRoute, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * route.costPer1kInput + (outputTokens / 1000) * route.costPer1kOutput;
}
