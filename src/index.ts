// ============================================================
// Index — Main entry point: wires everything together
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import readline from 'readline';

import { agentConfig, heartbeatConfig, securityConfig, gatewayConfig } from './config.js';
import { eventBus } from './events.js';
import { createLogger } from './utils/logger.js';
import { initAuditLog, closeAuditLog } from './security/guard.js';
import { loadSettings } from './security/settings.js';

// Import tools first (registers built-in tools)
import './tools/registry.js';
import './memory/store.js'; // registers memory tools
import './tools/system.js'; // system control (guarded by permissions)
import './tools/email.js';  // email IMAP/SMTP (guarded by permissions)
import './tools/social.js'; // GitHub, Mastodon, Reddit (guarded by permissions)

import { loadSkills } from './skills/loader.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat/scheduler.js';
import {
  createTelegramAdapter,
  createDiscordAdapter,
  createCLIAdapter,
  registerChannel,
  sendMessage,
} from './channels/adapters.js';
import { startGateway } from './gateway/server.js';
import { processMessage, processHeartbeat } from './gateway/agent.js';

import type { InboundMessage, OutboundMessage } from './types.js';

const log = createLogger('Main');

// ---- Banner --------------------------------------------------

function printBanner(): void {
  console.log(chalk.cyan(`
  ╔══════════════════════════════════════════╗
  ║                                          ║
  ║   🤖  ${chalk.bold(agentConfig.name)}                       ║
  ║   Autonomous Agent v0.1.0                ║
  ║                                          ║
  ║   Provider:  ${agentConfig.provider.padEnd(26)}║
  ║   Model:     ${agentConfig.model.slice(0, 26).padEnd(26)}║
  ║   Autonomy:  ${agentConfig.autonomyLevel.padEnd(26)}║
  ║   Workspace: ${agentConfig.workspace.slice(-26).padEnd(26)}║
  ║                                          ║
  ╚══════════════════════════════════════════╝
  `));
}

// ---- Message Router ------------------------------------------

async function handleInboundMessage(message: InboundMessage): Promise<void> {
  try {
    const reply = await processMessage(message);
    await sendMessage({
      channel: message.channel,
      userId: message.userId,
      text: reply,
      replyToMessageId: message.channelMessageId,
    });
  } catch (err: any) {
    log.error(`Failed to process message: ${err.message}`);
    await sendMessage({
      channel: message.channel,
      userId: message.userId,
      text: `Sorry, I ran into an error: ${err.message}`,
    });
  }
}

// ---- Heartbeat Handler ---------------------------------------

async function handleHeartbeat(tasks: { description: string }[]): Promise<void> {
  const channel = heartbeatConfig.channel;
  const userId = agentConfig.allowedUserIds[0] || 'owner';

  try {
    const reply = await processHeartbeat(tasks, channel, userId);
    if (reply) {
      await sendMessage({
        channel: channel as any,
        userId,
        text: `💓 *Heartbeat*\n\n${reply}`,
      });
    }
  } catch (err: any) {
    log.error(`Heartbeat processing failed: ${err.message}`);
  }
}

// ---- CLI Interactive Mode ------------------------------------

function startCLI(): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green(`\n${agentConfig.name} > `),
  });

  const cliAdapter = createCLIAdapter((text) => {
    console.log(chalk.cyan(`\n${agentConfig.name}: `) + text);
    rl.prompt();
  });
  registerChannel(cliAdapter);
  cliAdapter.start();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }

    if (text === '/quit' || text === '/exit') {
      console.log(chalk.yellow('Shutting down...'));
      rl.close();
      await shutdown();
      return;
    }

    if (text === '/status') {
      console.log(chalk.dim(JSON.stringify({
        agent: agentConfig.name,
        provider: agentConfig.provider,
        model: agentConfig.model,
        uptime: Math.round(process.uptime()) + 's',
      }, null, 2)));
      rl.prompt();
      return;
    }

    const message: InboundMessage = {
      id: crypto.randomUUID(),
      channel: 'cli',
      channelMessageId: crypto.randomUUID(),
      userId: 'cli-user',
      userName: 'You',
      text,
      timestamp: new Date(),
    };

    await handleInboundMessage(message);
  });

  rl.prompt();
}

// ---- Startup -------------------------------------------------

async function main(): Promise<void> {
  printBanner();

  // Ensure workspace exists
  await fs.mkdir(agentConfig.workspace, { recursive: true });
  await fs.mkdir(path.join(agentConfig.workspace, 'skills'), { recursive: true });
  await fs.mkdir(path.join(agentConfig.workspace, 'memory'), { recursive: true });

  // Initialize security audit log
  if (securityConfig.auditLogEnabled) {
    await initAuditLog();
    log.info('Audit logging enabled');
  }

  // Load runtime settings (admin-configurable)
  const settings = await loadSettings();
  log.info(`Runtime settings loaded (autonomy: ${settings.autonomyLevel}, system control: ${settings.toolPermissions.systemControl ? 'ON' : 'off'})`);

  // Load skills
  log.info('Loading skills...');
  const skills = await loadSkills();
  log.info(`${skills.length} skills loaded`);

  // Wire up event handlers
  eventBus.on('message_received', (event) => {
    if (event.type === 'message_received') {
      handleInboundMessage(event.message);
    }
  });

  eventBus.on('heartbeat_tick', (event) => {
    if (event.type === 'heartbeat_tick') {
      handleHeartbeat(event.tasks);
    }
  });

  // Start channels
  log.info('Starting channels...');
  const telegram = createTelegramAdapter();
  if (telegram) {
    registerChannel(telegram);
    await telegram.start();
  }

  const discord = createDiscordAdapter();
  if (discord) {
    registerChannel(discord);
    await discord.start();
  }

  // Start heartbeat
  startHeartbeat();

  // Start gateway
  await startGateway();

  // Start CLI (interactive mode)
  startCLI();

  log.info(`${agentConfig.name} is ready! 🚀`);
  log.info(`Admin dashboard: http://${gatewayConfig.host}:${gatewayConfig.port}/admin`);
  log.info(`Gateway token in: ${agentConfig.workspace}/.gateway-token`);
}

// ---- Shutdown ------------------------------------------------

async function shutdown(): Promise<void> {
  log.info('Shutting down...');
  stopHeartbeat();
  await closeAuditLog();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---- Go! -----------------------------------------------------

main().catch((err) => {
  log.error(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
