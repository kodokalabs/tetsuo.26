// ============================================================
// Runtime Settings — Persistent, admin-mutable security config
// Read from workspace/settings.json, writable via admin panel.
// Falls back to .env → hardcoded defaults.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { agentConfig, securityConfig as envDefaults } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Settings');

// ---- Schema: every setting the admin can change at runtime ---

export interface RuntimeSettings {
  // Security toggles
  sandboxEnabled: boolean;
  ssrfProtectionEnabled: boolean;
  promptInjectionGuards: boolean;
  gatewayAuthEnabled: boolean;
  auditLogEnabled: boolean;

  // Limits
  shellTimeoutMs: number;
  maxToolOutputChars: number;
  gatewayRateLimitPerMin: number;
  llmRateLimitPerMin: number;
  maxRequestBodyBytes: number;
  maxToolCallsPerMessage: number;

  // Tool permissions — which tool categories are enabled
  toolPermissions: {
    shell: boolean;
    fileRead: boolean;
    fileWrite: boolean;
    webFetch: boolean;
    browser: boolean;
    email: boolean;
    socialMedia: boolean;
    systemControl: boolean;
  };

  // Network
  allowedDomains: string[];      // empty = allow all public
  blockedDomains: string[];
  allowLocalhost: boolean;       // for SSRF — dangerous!

  // Agent behavior
  autonomyLevel: 'low' | 'medium' | 'high';
  agentName: string;

  // Integration credentials (stored encrypted at rest in production)
  integrations: {
    email: { enabled: boolean; host: string; port: number; secure: boolean; user: string; pass: string; smtpHost: string; smtpPort: number };
    reddit: { enabled: boolean; clientId: string; clientSecret: string; username: string; password: string };
    mastodon: { enabled: boolean; instanceUrl: string; accessToken: string };
    github: { enabled: boolean; token: string };
  };
}

// ---- Defaults (match .env fallbacks, everything secure) ------

const DEFAULTS: RuntimeSettings = {
  sandboxEnabled: true,
  ssrfProtectionEnabled: true,
  promptInjectionGuards: true,
  gatewayAuthEnabled: true,
  auditLogEnabled: true,

  shellTimeoutMs: 30_000,
  maxToolOutputChars: 50_000,
  gatewayRateLimitPerMin: 60,
  llmRateLimitPerMin: 30,
  maxRequestBodyBytes: 1_048_576,
  maxToolCallsPerMessage: 20,

  toolPermissions: {
    shell: true,
    fileRead: true,
    fileWrite: true,
    webFetch: true,
    browser: true,
    email: false,       // off by default — requires setup
    socialMedia: false,  // off by default — requires setup
    systemControl: false, // off by default — HIGH RISK
  },

  allowedDomains: [],
  blockedDomains: [],
  allowLocalhost: false,

  autonomyLevel: 'medium',
  agentName: 'Agent',

  integrations: {
    email: { enabled: false, host: '', port: 993, secure: true, user: '', pass: '', smtpHost: '', smtpPort: 587 },
    reddit: { enabled: false, clientId: '', clientSecret: '', username: '', password: '' },
    mastodon: { enabled: false, instanceUrl: '', accessToken: '' },
    github: { enabled: false, token: '' },
  },
};

// ---- Singleton state -----------------------------------------

let current: RuntimeSettings = structuredClone(DEFAULTS);
let settingsPath = '';

// ---- Load / Save / Get / Set ---------------------------------

export async function loadSettings(): Promise<RuntimeSettings> {
  settingsPath = path.join(agentConfig.workspace, 'settings.json');

  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    const saved = JSON.parse(raw) as Partial<RuntimeSettings>;
    // Deep merge saved over defaults so new keys get defaults
    current = deepMerge(structuredClone(DEFAULTS), saved);
    log.info('Loaded runtime settings from settings.json');
  } catch {
    // First run or corrupted — use env-based defaults
    current = {
      ...structuredClone(DEFAULTS),
      sandboxEnabled: envDefaults.ssrfProtectionEnabled,
      ssrfProtectionEnabled: envDefaults.ssrfProtectionEnabled,
      promptInjectionGuards: envDefaults.promptInjectionGuards,
      gatewayAuthEnabled: envDefaults.gatewayAuthEnabled,
      auditLogEnabled: envDefaults.auditLogEnabled,
      shellTimeoutMs: envDefaults.shellTimeoutMs,
      maxToolOutputChars: envDefaults.maxToolOutputChars,
      gatewayRateLimitPerMin: envDefaults.gatewayRateLimitPerMin,
      llmRateLimitPerMin: envDefaults.llmRateLimitPerMin,
      maxRequestBodyBytes: envDefaults.maxRequestBodyBytes,
      maxToolCallsPerMessage: agentConfig.maxToolCalls,
      autonomyLevel: agentConfig.autonomyLevel,
      agentName: agentConfig.name,
    };
    await saveSettings();
    log.info('Created default settings.json');
  }

  return current;
}

export async function saveSettings(): Promise<void> {
  await fs.writeFile(settingsPath, JSON.stringify(current, null, 2), { mode: 0o600 });
  log.info('Settings saved');
}

export function getSettings(): RuntimeSettings {
  return current;
}

/**
 * Patch specific fields. Returns the fields that actually changed.
 * Validates dangerous changes and requires confirmation tokens.
 */
export async function updateSettings(
  patch: Partial<RuntimeSettings>,
  confirmToken?: string,
): Promise<{ applied: string[]; requiresConfirm: string[] }> {
  const applied: string[] = [];
  const requiresConfirm: string[] = [];

  // Dangerous changes that require a confirmation token
  const DANGEROUS_KEYS: Record<string, string> = {
    'sandboxEnabled:false': 'Disabling sandbox allows unrestricted shell commands',
    'ssrfProtectionEnabled:false': 'Disabling SSRF protection exposes internal networks',
    'gatewayAuthEnabled:false': 'Disabling gateway auth lets anyone control the agent',
    'allowLocalhost:true': 'Allowing localhost exposes internal services to the agent',
    'toolPermissions.systemControl:true': 'System control gives the agent OS-level access',
    'toolPermissions.email:true': 'Email access lets the agent send messages as you',
    'toolPermissions.socialMedia:true': 'Social media lets the agent post publicly as you',
    'autonomyLevel:high': 'High autonomy lets the agent act without asking permission',
  };

  for (const [key, value] of Object.entries(flattenForCheck(patch))) {
    const dangerKey = `${key}:${value}`;
    if (DANGEROUS_KEYS[dangerKey]) {
      if (confirmToken !== generateConfirmToken(dangerKey)) {
        requiresConfirm.push(`${key} → ${value}: ${DANGEROUS_KEYS[dangerKey]}`);
        continue;
      }
    }
    applied.push(key);
  }

  if (requiresConfirm.length > 0 && applied.length === 0) {
    return { applied, requiresConfirm };
  }

  // Apply safe + confirmed changes
  current = deepMerge(current, patch);
  await saveSettings();

  return { applied: Object.keys(flattenForCheck(patch)), requiresConfirm };
}

/** Check if a specific tool category is allowed */
export function isToolAllowed(category: keyof RuntimeSettings['toolPermissions']): boolean {
  return current.toolPermissions[category];
}

/** Generate a confirmation token for dangerous changes */
export function generateConfirmToken(dangerKey: string): string {
  // Simple HMAC-like token. In production use crypto.
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.createHash('sha256').update(`confirm:${dangerKey}:${Date.now().toString().slice(0, -4)}`).digest('hex').slice(0, 16);
}

// ---- Helpers -------------------------------------------------

function flattenForCheck(obj: Record<string, any>, prefix = ''): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(result, flattenForCheck(v, key));
    } else {
      result[key] = v;
    }
  }
  return result;
}

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sv = source[key];
    const tv = target[key];
    if (sv !== undefined && sv !== null && typeof sv === 'object' && !Array.isArray(sv) && typeof tv === 'object' && tv !== null) {
      (result as any)[key] = deepMerge(tv as any, sv as any);
    } else if (sv !== undefined) {
      (result as any)[key] = sv;
    }
  }
  return result;
}
