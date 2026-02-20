// ============================================================
// Cost Tracker — Token counting, spend tracking, budget limits
// Persisted daily, with configurable alerts and hard caps.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { agentConfig } from '../config.js';
import { eventBus } from '../events.js';
import { createLogger } from '../utils/logger.js';
import { registerTool } from '../tools/registry.js';

const log = createLogger('Costs');

interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  callCount: number;
  byModel: Record<string, { input: number; output: number; cost: number; calls: number }>;
}

interface CostConfig {
  dailyBudget: number;      // $ per day, 0 = no limit
  weeklyBudget: number;     // $ per week, 0 = no limit
  warnAtPercent: number;    // warn when this % of budget is used (default 80)
  hardStop: boolean;        // block LLM calls when budget exceeded
}

const costFile = () => path.join(agentConfig.workspace, 'costs.json');
const configFile = () => path.join(agentConfig.workspace, 'cost-config.json');

let todayUsage: DailyUsage = emptyDay();
let costConfig: CostConfig = {
  dailyBudget: 0,
  weeklyBudget: 0,
  warnAtPercent: 80,
  hardStop: false,
};

function emptyDay(): DailyUsage {
  return {
    date: new Date().toISOString().slice(0, 10),
    inputTokens: 0, outputTokens: 0, estimatedCost: 0, callCount: 0,
    byModel: {},
  };
}

// ---- Init ----------------------------------------------------

export async function initCostTracker(): Promise<void> {
  // Load config
  try {
    const raw = await fs.readFile(configFile(), 'utf-8');
    costConfig = { ...costConfig, ...JSON.parse(raw) };
  } catch { /* use defaults */ }

  // Load today's usage
  try {
    const raw = await fs.readFile(costFile(), 'utf-8');
    const all = JSON.parse(raw) as DailyUsage[];
    const today = new Date().toISOString().slice(0, 10);
    todayUsage = all.find(d => d.date === today) || emptyDay();
  } catch { /* fresh start */ }

  log.info(`Cost tracker initialized. Today: $${todayUsage.estimatedCost.toFixed(4)} (${todayUsage.callCount} calls). Budget: $${costConfig.dailyBudget || '∞'}/day`);
}

// ---- Track a call --------------------------------------------

export async function trackUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  costPer1kIn = 0.003,
  costPer1kOut = 0.015,
): Promise<{ allowed: boolean; warning?: string }> {
  const today = new Date().toISOString().slice(0, 10);
  if (todayUsage.date !== today) {
    await saveUsage();
    todayUsage = emptyDay();
  }

  const callCost = (inputTokens / 1000) * costPer1kIn + (outputTokens / 1000) * costPer1kOut;

  todayUsage.inputTokens += inputTokens;
  todayUsage.outputTokens += outputTokens;
  todayUsage.estimatedCost += callCost;
  todayUsage.callCount++;

  // Per-model tracking
  if (!todayUsage.byModel[model]) {
    todayUsage.byModel[model] = { input: 0, output: 0, cost: 0, calls: 0 };
  }
  todayUsage.byModel[model].input += inputTokens;
  todayUsage.byModel[model].output += outputTokens;
  todayUsage.byModel[model].cost += callCost;
  todayUsage.byModel[model].calls++;

  await saveUsage();

  // Budget checks
  let warning: string | undefined;
  let allowed = true;

  if (costConfig.dailyBudget > 0) {
    const pct = (todayUsage.estimatedCost / costConfig.dailyBudget) * 100;
    if (pct >= 100) {
      if (costConfig.hardStop) {
        allowed = false;
        warning = `BUDGET EXCEEDED: $${todayUsage.estimatedCost.toFixed(2)} / $${costConfig.dailyBudget} daily limit. LLM calls blocked.`;
        log.error(warning);
      } else {
        warning = `BUDGET WARNING: $${todayUsage.estimatedCost.toFixed(2)} exceeds $${costConfig.dailyBudget} daily limit.`;
        log.warn(warning);
      }
    } else if (pct >= costConfig.warnAtPercent) {
      warning = `Budget ${pct.toFixed(0)}% used: $${todayUsage.estimatedCost.toFixed(2)} / $${costConfig.dailyBudget}`;
      log.warn(warning);
    }
  }

  return { allowed, warning };
}

// ---- Check if budget allows a call ---------------------------

export function canMakeCall(): boolean {
  if (!costConfig.hardStop || costConfig.dailyBudget <= 0) return true;
  return todayUsage.estimatedCost < costConfig.dailyBudget;
}

// ---- Queries -------------------------------------------------

export function getTodayUsage(): DailyUsage {
  return { ...todayUsage };
}

export async function getHistoricalUsage(days = 30): Promise<DailyUsage[]> {
  try {
    const raw = await fs.readFile(costFile(), 'utf-8');
    const all = JSON.parse(raw) as DailyUsage[];
    return all.slice(-days);
  } catch {
    return [todayUsage];
  }
}

export function getCostConfig(): CostConfig {
  return { ...costConfig };
}

export async function setCostConfig(update: Partial<CostConfig>): Promise<void> {
  costConfig = { ...costConfig, ...update };
  await fs.writeFile(configFile(), JSON.stringify(costConfig, null, 2));
  log.info(`Cost config updated: daily=$${costConfig.dailyBudget}, weekly=$${costConfig.weeklyBudget}, hardStop=${costConfig.hardStop}`);
}

// ---- Persistence ---------------------------------------------

async function saveUsage(): Promise<void> {
  let all: DailyUsage[] = [];
  try {
    const raw = await fs.readFile(costFile(), 'utf-8');
    all = JSON.parse(raw);
  } catch { /* fresh */ }

  // Replace or append today
  const idx = all.findIndex(d => d.date === todayUsage.date);
  if (idx >= 0) all[idx] = todayUsage;
  else all.push(todayUsage);

  // Keep last 90 days
  all = all.slice(-90);

  await fs.writeFile(costFile(), JSON.stringify(all, null, 2));
}

// ---- Tools ---------------------------------------------------

registerTool(
  {
    name: 'cost_report',
    description: 'Show token usage and cost tracking for today and recent history.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to show (default: 7)' },
      },
    },
  },
  async (input) => {
    const days = (input.days as number) || 7;
    const history = await getHistoricalUsage(days);
    const config = getCostConfig();

    const lines = [
      `=== Cost Report (last ${days} days) ===`,
      `Daily budget: ${config.dailyBudget ? `$${config.dailyBudget}` : 'unlimited'} | Hard stop: ${config.hardStop ? 'YES' : 'no'}`,
      ``,
    ];

    let totalCost = 0;
    for (const day of history) {
      totalCost += day.estimatedCost;
      const models = Object.entries(day.byModel)
        .map(([m, u]) => `${m}: ${u.calls} calls, $${u.cost.toFixed(4)}`)
        .join(' | ');
      lines.push(
        `${day.date}: ${day.callCount} calls, ${day.inputTokens + day.outputTokens} tokens, $${day.estimatedCost.toFixed(4)}${models ? `\n  ${models}` : ''}`
      );
    }

    lines.push(``, `Total: $${totalCost.toFixed(4)} over ${history.length} days`);
    if (history.length > 1) {
      lines.push(`Average: $${(totalCost / history.length).toFixed(4)}/day`);
    }

    return lines.join('\n');
  },
);

registerTool(
  {
    name: 'set_budget',
    description: 'Set daily/weekly cost budget limits.',
    parameters: {
      type: 'object',
      properties: {
        dailyBudget: { type: 'number', description: 'Max $ per day (0 = unlimited)' },
        weeklyBudget: { type: 'number', description: 'Max $ per week (0 = unlimited)' },
        hardStop: { type: 'boolean', description: 'Block LLM calls when exceeded (default: false)' },
      },
    },
  },
  async (input) => {
    await setCostConfig({
      ...(input.dailyBudget !== undefined ? { dailyBudget: input.dailyBudget as number } : {}),
      ...(input.weeklyBudget !== undefined ? { weeklyBudget: input.weeklyBudget as number } : {}),
      ...(input.hardStop !== undefined ? { hardStop: input.hardStop as boolean } : {}),
    });
    const c = getCostConfig();
    return `Budget set: $${c.dailyBudget}/day, $${c.weeklyBudget}/week, hard stop: ${c.hardStop}`;
  },
);

log.info('Cost tracker tools registered');
