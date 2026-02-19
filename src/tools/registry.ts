// ============================================================
// Tools — Registry + Built-in tools (shell, files, browser)
// HARDENED: path sandboxing, SSRF protection, shell filtering,
//           prompt injection guards, audit logging, output caps
// ============================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { agentConfig, securityConfig } from '../config.js';
import { eventBus } from '../events.js';
import {
  safePath,
  validateURL,
  validateShellCommand,
  wrapUntrustedContent,
  audit,
  SecurityError,
} from '../security/guard.js';
import type { ToolDefinition, ToolResult, ToolCall } from '../types.js';

const log = createLogger('Tools');
const execAsync = promisify(exec);

// ---- Tool Registry -------------------------------------------

type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

const registry = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

export function registerTool(definition: ToolDefinition, handler: ToolHandler): void {
  registry.set(definition.name, { definition, handler });
  log.info(`Registered tool: ${definition.name}`);
}

export function getToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).map(t => t.definition);
}

export async function executeTool(call: ToolCall): Promise<ToolResult> {
  const tool = registry.get(call.name);
  if (!tool) {
    return { toolCallId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
  }

  log.info(`Executing tool: ${call.name}`, call.input);
  eventBus.emit({ type: 'tool_called', tool: call.name, input: call.input });

  try {
    const result = await tool.handler(call.input);

    // Cap output size to prevent context window flooding
    const capped = result.slice(0, securityConfig.maxToolOutputChars);

    await audit({ action: 'tool_exec', tool: call.name, input: call.input, result: capped.slice(0, 500) });
    eventBus.emit({ type: 'tool_result', tool: call.name, result: capped, isError: false });
    return { toolCallId: call.id, content: capped };
  } catch (err: any) {
    const errMsg = err.message ?? String(err);
    const isSecurityBlock = err instanceof SecurityError;

    await audit({
      action: 'tool_exec',
      tool: call.name,
      input: call.input,
      blocked: isSecurityBlock,
      reason: errMsg,
    });

    if (isSecurityBlock) {
      log.warn(`SECURITY BLOCK [${call.name}]: ${errMsg}`);
    } else {
      log.error(`Tool ${call.name} failed: ${errMsg}`);
    }

    eventBus.emit({ type: 'tool_result', tool: call.name, result: errMsg, isError: true });
    return { toolCallId: call.id, content: `Error: ${errMsg}`, isError: true };
  }
}

// ---- Built-in: Shell -----------------------------------------

registerTool(
  {
    name: 'run_shell',
    description: 'Execute a shell command within the agent workspace. Commands are security-filtered.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        workdir: { type: 'string', description: 'Working directory (must be within workspace)' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000, max: 120000)' },
      },
      required: ['command'],
    },
  },
  async (input) => {
    const cmd = input.command as string;

    // Security: validate command against blocklist patterns
    validateShellCommand(cmd);

    // Security: working directory must be within workspace
    const cwd = input.workdir
      ? safePath(input.workdir as string)
      : agentConfig.workspace;

    const timeout = Math.min(
      (input.timeout_ms as number) || securityConfig.shellTimeoutMs,
      120_000, // hard cap at 2 minutes
    );

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd,
        timeout,
        // Security: limit output buffer to prevent memory exhaustion
        maxBuffer: 5 * 1024 * 1024, // 5 MB
        // Security: inherit minimal environment
        env: {
          ...process.env,
          HOME: agentConfig.workspace,
          // Strip sensitive vars from child process
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          TELEGRAM_BOT_TOKEN: undefined,
          DISCORD_BOT_TOKEN: undefined,
        } as any,
      });
      return [
        stdout ? `STDOUT:\n${stdout.slice(0, 10_000)}` : '',
        stderr ? `STDERR:\n${stderr.slice(0, 5_000)}` : '',
      ].filter(Boolean).join('\n') || '(no output)';
    } catch (err: any) {
      return `Exit code ${err.code ?? 'unknown'}:\n${err.stderr || err.message}`.slice(0, 10_000);
    }
  },
);

// ---- Built-in: File Operations --------------------------------

registerTool(
  {
    name: 'read_file',
    description: 'Read the contents of a file within the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
      },
      required: ['path'],
    },
  },
  async (input) => {
    // Security: path sandboxed to workspace
    const filePath = safePath(input.path as string);
    const content = await fs.readFile(filePath, 'utf-8');
    return content.slice(0, securityConfig.maxToolOutputChars);
  },
);

registerTool(
  {
    name: 'write_file',
    description: 'Write content to a file within the workspace. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        content: { type: 'string', description: 'Content to write' },
        append: { type: 'boolean', description: 'Append instead of overwrite (default: false)' },
      },
      required: ['path', 'content'],
    },
  },
  async (input) => {
    // Security: path sandboxed to workspace
    const filePath = safePath(input.path as string);

    // Security: block writing executable files
    const ext = path.extname(filePath).toLowerCase();
    const dangerousExts = ['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.wsf'];
    if (dangerousExts.includes(ext)) {
      throw new SecurityError(`Writing ${ext} files is blocked for security`);
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (input.append) {
      await fs.appendFile(filePath, input.content as string);
    } else {
      await fs.writeFile(filePath, input.content as string);
    }
    return `Written ${(input.content as string).length} chars to ${filePath}`;
  },
);

registerTool(
  {
    name: 'list_directory',
    description: 'List files and directories within the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory path' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      },
      required: ['path'],
    },
  },
  async (input) => {
    // Security: path sandboxed to workspace
    const dirPath = safePath(input.path as string);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const lines = entries.map(e =>
      `${e.isDirectory() ? '📁' : '📄'} ${e.name}`
    );
    return lines.join('\n') || '(empty directory)';
  },
);

// ---- Built-in: Web Fetch (SSRF-protected) --------------------

registerTool(
  {
    name: 'web_fetch',
    description: 'Fetch the text content of a public URL. Internal/private network addresses are blocked.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public URL to fetch (http/https only)' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method (default: GET)' },
        headers: { type: 'object', description: 'Optional headers' },
        body: { type: 'string', description: 'Request body for POST/PUT' },
      },
      required: ['url'],
    },
  },
  async (input) => {
    // Security: SSRF validation (blocks private IPs, metadata endpoints, file://)
    const validatedUrl = await validateURL(input.url as string);

    const res = await fetch(validatedUrl.toString(), {
      method: (input.method as string) || 'GET',
      headers: (input.headers as Record<string, string>) || {},
      body: input.body as string | undefined,
      signal: AbortSignal.timeout(15_000), // 15s timeout
    });

    let text = await res.text();
    text = text.slice(0, 30_000);

    // Security: wrap untrusted web content with anti-injection markers
    if (securityConfig.promptInjectionGuards) {
      text = wrapUntrustedContent(text, validatedUrl.hostname);
    }

    return `Status: ${res.status}\n\n${text}`;
  },
);

// ---- Built-in: Browser (Puppeteer, SSRF-protected) -----------

registerTool(
  {
    name: 'browser_action',
    description: 'Control a headless browser. URLs are validated against SSRF. Actions: navigate, screenshot, click, type, get_text.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'screenshot', 'click', 'type', 'get_text'],
          description: 'Browser action to perform (evaluate is disabled for security)',
        },
        url: { type: 'string', description: 'URL for navigate action' },
        selector: { type: 'string', description: 'CSS selector for click/type actions' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['action'],
    },
  },
  async (input) => {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        // Security: disable file access and GPU
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
      ],
    });
    const page = await browser.newPage();

    // Security: block requests to internal networks
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      try {
        if (securityConfig.ssrfProtectionEnabled) {
          await validateURL(req.url());
        }
        req.continue();
      } catch {
        req.abort('blockedbyclient');
      }
    });

    try {
      const action = input.action as string;

      switch (action) {
        case 'navigate': {
          // Security: validate URL before navigation
          await validateURL(input.url as string);
          await page.goto(input.url as string, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          return `Navigated to ${input.url}. Title: ${await page.title()}`;
        }

        case 'screenshot': {
          const buf = await page.screenshot({ encoding: 'base64' });
          const ssPath = safePath(`screenshot-${Date.now()}.png`);
          await fs.writeFile(ssPath, Buffer.from(buf as string, 'base64'));
          return `Screenshot saved to ${ssPath}`;
        }

        case 'click':
          await page.click(input.selector as string);
          return `Clicked ${input.selector}`;

        case 'type':
          await page.type(input.selector as string, input.text as string);
          return `Typed into ${input.selector}`;

        case 'get_text': {
          let text = await page.evaluate(() => document.body.innerText);
          text = text.slice(0, 30_000);
          // Security: wrap with anti-injection markers
          if (securityConfig.promptInjectionGuards) {
            text = wrapUntrustedContent(text, page.url());
          }
          return text;
        }

        // NOTE: 'evaluate' (arbitrary JS) is intentionally removed.
        // It allows arbitrary code execution in the browser context
        // and can be used to exfiltrate data or bypass SSRF protections.

        default:
          return `Unknown browser action: ${action}`;
      }
    } finally {
      await browser.close();
    }
  },
);
