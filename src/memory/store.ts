// ============================================================
// Memory — Local-first persistent memory as Markdown files
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { agentConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { MemoryEntry, ConversationThread, LLMMessage, ChannelType, Id } from '../types.js';

const log = createLogger('Memory');

// ---- Paths ---------------------------------------------------

const memoryDir = () => path.join(agentConfig.workspace, 'memory');
const conversationsDir = () => path.join(memoryDir(), 'conversations');
const factsDir = () => path.join(memoryDir(), 'facts');
const tasksDir = () => path.join(memoryDir(), 'tasks');

async function ensureDirs(): Promise<void> {
  for (const dir of [conversationsDir(), factsDir(), tasksDir()]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// ---- Conversation Threads ------------------------------------

export async function loadThread(
  channel: ChannelType,
  userId: string,
): Promise<ConversationThread> {
  await ensureDirs();
  const threadFile = path.join(conversationsDir(), `${channel}-${userId}.json`);

  try {
    const raw = await fs.readFile(threadFile, 'utf-8');
    const thread = JSON.parse(raw) as ConversationThread;
    log.debug(`Loaded thread ${thread.id} with ${thread.messages.length} messages`);
    return thread;
  } catch {
    // New thread
    const thread: ConversationThread = {
      id: uuid(),
      channel,
      userId,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    log.info(`Created new thread for ${channel}/${userId}`);
    return thread;
  }
}

export async function saveThread(thread: ConversationThread): Promise<void> {
  await ensureDirs();
  const threadFile = path.join(
    conversationsDir(),
    `${thread.channel}-${thread.userId}.json`,
  );

  // Keep context window manageable: retain last 100 messages
  if (thread.messages.length > 100) {
    const trimmed = thread.messages.slice(-80);
    thread.summary = await summarizeMessages(thread.messages.slice(0, -80), thread.summary);
    thread.messages = trimmed;
  }

  thread.updatedAt = new Date();
  await fs.writeFile(threadFile, JSON.stringify(thread, null, 2));
  log.debug(`Saved thread ${thread.id} (${thread.messages.length} messages)`);
}

async function summarizeMessages(
  messages: LLMMessage[],
  existingSummary?: string,
): Promise<string> {
  // Simple extractive summary — in production, you'd call the LLM here
  const userMessages = messages
    .filter(m => m.role === 'user')
    .map(m => typeof m.content === 'string' ? m.content : '[complex content]')
    .slice(-10);

  const summary = [
    existingSummary ? `Previous context: ${existingSummary}` : '',
    `Recent topics: ${userMessages.join(' | ')}`,
  ].filter(Boolean).join('\n');

  return summary.slice(0, 2000);
}

// ---- Facts / Long-term Memory --------------------------------

export async function saveFact(fact: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry> {
  await ensureDirs();
  const entry: MemoryEntry = {
    ...fact,
    id: uuid(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Save as a markdown file with YAML frontmatter
  const md = [
    '---',
    `id: ${entry.id}`,
    `type: ${entry.type}`,
    `tags: [${entry.tags.join(', ')}]`,
    `importance: ${entry.importance}`,
    `source: ${entry.source.channel}/${entry.source.userId}`,
    `created: ${entry.createdAt.toISOString()}`,
    '---',
    '',
    entry.content,
  ].join('\n');

  const filename = `${entry.type}-${entry.id.slice(0, 8)}.md`;
  await fs.writeFile(path.join(factsDir(), filename), md);
  log.info(`Saved ${entry.type}: ${entry.content.slice(0, 80)}...`);
  return entry;
}

export async function searchMemory(query: string, limit = 10): Promise<MemoryEntry[]> {
  await ensureDirs();
  const entries: MemoryEntry[] = [];

  const files = await fs.readdir(factsDir());
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const raw = await fs.readFile(path.join(factsDir(), file), 'utf-8');
      const entry = parseMemoryFile(raw, file);
      if (entry) entries.push(entry);
    } catch {
      continue;
    }
  }

  // Simple keyword matching — in production, use embeddings or a vector store
  const queryTerms = query.toLowerCase().split(/\s+/);
  const scored = entries.map(e => {
    const text = `${e.content} ${e.tags.join(' ')}`.toLowerCase();
    const score = queryTerms.reduce((s, term) => s + (text.includes(term) ? 1 : 0), 0);
    return { entry: e, score: score + e.importance * 0.1 };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.entry);
}

export async function getAllMemories(): Promise<MemoryEntry[]> {
  await ensureDirs();
  const entries: MemoryEntry[] = [];
  const files = await fs.readdir(factsDir());
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const raw = await fs.readFile(path.join(factsDir(), file), 'utf-8');
      const entry = parseMemoryFile(raw, file);
      if (entry) entries.push(entry);
    } catch {
      continue;
    }
  }
  return entries.sort((a, b) => b.importance - a.importance);
}

function parseMemoryFile(raw: string, filename: string): MemoryEntry | null {
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) return null;

  const fm = frontmatterMatch[1];
  const content = frontmatterMatch[2].trim();

  const get = (key: string) => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m?.[1]?.trim() ?? '';
  };

  const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
  const tags = tagsMatch
    ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
    : [];

  const [sourceChannel, sourceUser] = get('source').split('/');

  return {
    id: get('id') || filename,
    type: get('type') as MemoryEntry['type'] || 'note',
    content,
    tags,
    importance: parseInt(get('importance')) || 5,
    source: { channel: (sourceChannel || 'cli') as ChannelType, userId: sourceUser || 'unknown' },
    createdAt: new Date(get('created') || Date.now()),
    updatedAt: new Date(get('created') || Date.now()),
  };
}

// ---- Memory Tool (registered for LLM use) --------------------

import { registerTool } from '../tools/registry.js';

registerTool(
  {
    name: 'remember',
    description: 'Store a fact, preference, or note in long-term memory. Use this to remember things the user tells you.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to remember' },
        type: { type: 'string', enum: ['fact', 'preference', 'task', 'note'], description: 'Type of memory' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for retrieval' },
        importance: { type: 'number', description: 'Importance 0-10 (default: 5)' },
      },
      required: ['content'],
    },
  },
  async (input) => {
    const entry = await saveFact({
      type: (input.type as MemoryEntry['type']) || 'note',
      content: input.content as string,
      tags: (input.tags as string[]) || [],
      importance: (input.importance as number) || 5,
      source: { channel: 'cli', userId: 'agent' },
    });
    return `Remembered: "${entry.content.slice(0, 100)}..." (id: ${entry.id.slice(0, 8)})`;
  },
);

registerTool(
  {
    name: 'recall',
    description: 'Search long-term memory for relevant facts, preferences, or notes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
      },
      required: ['query'],
    },
  },
  async (input) => {
    const results = await searchMemory(input.query as string, (input.limit as number) || 5);
    if (results.length === 0) return 'No relevant memories found.';
    return results.map(r =>
      `[${r.type}] (importance: ${r.importance}) ${r.content}`
    ).join('\n\n');
  },
);
