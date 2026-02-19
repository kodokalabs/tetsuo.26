// ============================================================
// Channels — Multi-platform message adapters
// ============================================================

import { v4 as uuid } from 'uuid';
import { createLogger } from '../utils/logger.js';
import { channelConfig, agentConfig } from '../config.js';
import { eventBus } from '../events.js';
import type { ChannelType, InboundMessage, OutboundMessage } from '../types.js';

const log = createLogger('Channels');

// ---- Channel Interface ---------------------------------------

export interface ChannelAdapter {
  type: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
}

const adapters = new Map<ChannelType, ChannelAdapter>();

export function registerChannel(adapter: ChannelAdapter): void {
  adapters.set(adapter.type, adapter);
}

export function getChannel(type: ChannelType): ChannelAdapter | undefined {
  return adapters.get(type);
}

export function getAllChannels(): ChannelAdapter[] {
  return Array.from(adapters.values());
}

export async function sendMessage(message: OutboundMessage): Promise<void> {
  const adapter = adapters.get(message.channel);
  if (!adapter) {
    log.error(`No adapter for channel: ${message.channel}`);
    return;
  }
  await adapter.send(message);
  eventBus.emit({ type: 'message_sent', message });
}

// ---- Access control ------------------------------------------

function isUserAllowed(userId: string): boolean {
  if (agentConfig.allowedUserIds.length === 0) return true;
  return agentConfig.allowedUserIds.includes(userId);
}

// ---- Telegram Adapter ----------------------------------------

export function createTelegramAdapter(): ChannelAdapter | null {
  const token = channelConfig.telegram.botToken;
  if (!token) {
    log.warn('Telegram: No bot token configured, skipping');
    return null;
  }

  let bot: any = null;

  return {
    type: 'telegram',

    async start() {
      const { Telegraf } = await import('telegraf');
      bot = new Telegraf(token);

      bot.on('text', (ctx: any) => {
        const userId = String(ctx.from.id);
        if (!isUserAllowed(userId)) {
          log.warn(`Telegram: Blocked message from unauthorized user ${userId}`);
          return;
        }

        const message: InboundMessage = {
          id: uuid(),
          channel: 'telegram',
          channelMessageId: String(ctx.message.message_id),
          userId,
          userName: ctx.from.first_name || ctx.from.username || 'Unknown',
          text: ctx.message.text,
          timestamp: new Date(ctx.message.date * 1000),
        };

        log.info(`Telegram: ${message.userName}: ${message.text.slice(0, 80)}`);
        eventBus.emit({ type: 'message_received', message });
      });

      // Handle photos/documents
      bot.on('photo', (ctx: any) => {
        const userId = String(ctx.from.id);
        if (!isUserAllowed(userId)) return;

        const photo = ctx.message.photo.at(-1); // highest res
        const message: InboundMessage = {
          id: uuid(),
          channel: 'telegram',
          channelMessageId: String(ctx.message.message_id),
          userId,
          userName: ctx.from.first_name || 'Unknown',
          text: ctx.message.caption || '(image)',
          attachments: [{ type: 'image', url: photo.file_id }],
          timestamp: new Date(ctx.message.date * 1000),
        };

        eventBus.emit({ type: 'message_received', message });
      });

      await bot.launch();
      log.info('Telegram adapter started');
    },

    async stop() {
      bot?.stop('Agent shutdown');
    },

    async send(message: OutboundMessage) {
      if (!bot) return;
      try {
        // Split long messages (Telegram limit: 4096 chars)
        const chunks = splitText(message.text, 4000);
        for (const chunk of chunks) {
          await bot.telegram.sendMessage(message.userId, chunk, { parse_mode: 'Markdown' })
            .catch(() => bot.telegram.sendMessage(message.userId, chunk)); // fallback without markdown
        }
      } catch (err) {
        log.error(`Telegram send failed: ${err}`);
      }
    },
  };
}

// ---- Discord Adapter -----------------------------------------

export function createDiscordAdapter(): ChannelAdapter | null {
  const token = channelConfig.discord.botToken;
  if (!token) {
    log.warn('Discord: No bot token configured, skipping');
    return null;
  }

  let client: any = null;

  return {
    type: 'discord',

    async start() {
      const { Client, GatewayIntentBits } = await import('discord.js');
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });

      client.on('messageCreate', (msg: any) => {
        if (msg.author.bot) return;

        const userId = msg.author.id;
        if (!isUserAllowed(userId)) return;

        // Check if channel is allowed (if configured)
        const allowedChannels = channelConfig.discord.allowedChannelIds;
        if (allowedChannels.length > 0 && !allowedChannels.includes(msg.channel.id)) {
          return;
        }

        const message: InboundMessage = {
          id: uuid(),
          channel: 'discord',
          channelMessageId: msg.id,
          userId,
          userName: msg.author.displayName || msg.author.username,
          text: msg.content,
          timestamp: msg.createdAt,
        };

        log.info(`Discord: ${message.userName}: ${message.text.slice(0, 80)}`);
        eventBus.emit({ type: 'message_received', message });
      });

      await client.login(token);
      log.info('Discord adapter started');
    },

    async stop() {
      client?.destroy();
    },

    async send(message: OutboundMessage) {
      if (!client) return;
      try {
        const user = await client.users.fetch(message.userId);
        const dm = await user.createDM();
        const chunks = splitText(message.text, 1900);
        for (const chunk of chunks) {
          await dm.send(chunk);
        }
      } catch (err) {
        log.error(`Discord send failed: ${err}`);
      }
    },
  };
}

// ---- CLI / Local Adapter (for testing) -----------------------

export function createCLIAdapter(
  onMessage: (text: string) => void,
): ChannelAdapter {
  return {
    type: 'cli',
    async start() {
      log.info('CLI adapter ready');
    },
    async stop() {},
    async send(message: OutboundMessage) {
      onMessage(message.text);
    },
  };
}

// ---- Helpers -------------------------------------------------

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen; // fallback
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
