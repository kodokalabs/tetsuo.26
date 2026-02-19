// ============================================================
// Email Tools — IMAP read + SMTP send via nodemailer
// Free: works with Gmail, Outlook, Yahoo, any IMAP/SMTP server
// ============================================================

import { registerTool } from './registry.js';
import { getSettings, isToolAllowed } from '../security/settings.js';
import { audit, SecurityError, wrapUntrustedContent } from '../security/guard.js';
import { securityConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Email');

function guardEmail(): void {
  if (!isToolAllowed('email')) {
    throw new SecurityError(
      'Email tools are disabled. Enable in admin dashboard and configure IMAP/SMTP credentials.'
    );
  }
  const { integrations } = getSettings();
  if (!integrations.email.host || !integrations.email.user) {
    throw new SecurityError('Email not configured. Set IMAP/SMTP credentials in admin dashboard.');
  }
}

function getEmailConfig() {
  return getSettings().integrations.email;
}

// ---- Read emails via IMAP ------------------------------------

registerTool(
  {
    name: 'email_read',
    description: 'Read emails from the inbox via IMAP. Returns subject, from, date, and a preview of the body.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'IMAP folder (default: INBOX)' },
        count: { type: 'number', description: 'Number of recent emails to fetch (default: 10, max: 50)' },
        unread_only: { type: 'boolean', description: 'Only fetch unread emails (default: true)' },
        search: { type: 'string', description: 'Search query (subject or from)' },
      },
    },
  },
  async (input) => {
    guardEmail();
    const config = getEmailConfig();
    const count = Math.min((input.count as number) || 10, 50);
    const folder = (input.folder as string) || 'INBOX';
    const unreadOnly = input.unread_only !== false;

    // Use imapflow for IMAP access
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);

      try {
        const messages: string[] = [];
        const query = unreadOnly ? { seen: false } : {};

        let fetched = 0;
        for await (const msg of client.fetch(
          unreadOnly ? { seen: false } : '1:*',
          { envelope: true, bodyStructure: true, source: { maxLength: 2000 } },
          { changedSince: BigInt(0) }
        )) {
          if (fetched >= count) break;
          const env = msg.envelope;
          const from = env.from?.[0] ? `${env.from[0].name || ''} <${env.from[0].address}>` : 'unknown';
          const subject = env.subject || '(no subject)';
          const date = env.date?.toISOString().slice(0, 16) || '';

          // Get a text preview from the source
          let preview = '';
          if (msg.source) {
            const raw = msg.source.toString();
            // Extract a rough text preview from the raw message
            const textMatch = raw.match(/Content-Type: text\/plain[\s\S]*?\n\n([\s\S]{0,500})/i);
            preview = textMatch?.[1]?.replace(/\r?\n/g, ' ').trim().slice(0, 200) || '(no text preview)';
          }

          messages.push(`[${date}] From: ${from}\nSubject: ${subject}\nPreview: ${preview}\n`);
          fetched++;
        }

        await audit({ action: 'email_read', input: { folder, count: fetched } });

        if (messages.length === 0) return 'No emails found.';

        let result = messages.reverse().join('\n---\n');
        if (securityConfig.promptInjectionGuards) {
          result = wrapUntrustedContent(result, `email:${config.host}`);
        }
        return result;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  },
);

// ---- Send email via SMTP -------------------------------------

registerTool(
  {
    name: 'email_send',
    description: 'Send an email via SMTP. Requires confirmation in medium/low autonomy.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body (plain text)' },
        cc: { type: 'string', description: 'CC recipients (comma-separated)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  async (input) => {
    guardEmail();
    const config = getEmailConfig();
    const to = input.to as string;
    const subject = input.subject as string;
    const body = input.body as string;

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new SecurityError(`Invalid email address: ${to}`);
    }

    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: config.smtpHost || config.host.replace('imap', 'smtp'),
      port: config.smtpPort || 587,
      secure: config.smtpPort === 465,
      auth: { user: config.user, pass: config.pass },
    });

    const result = await transport.sendMail({
      from: config.user,
      to,
      cc: input.cc as string | undefined,
      subject,
      text: body,
    });

    await audit({ action: 'email_send', input: { to, subject } });
    log.info(`Email sent to ${to}: "${subject}"`);
    return `Email sent to ${to} (messageId: ${result.messageId})`;
  },
);

// ---- Search emails -------------------------------------------

registerTool(
  {
    name: 'email_search',
    description: 'Search emails by subject, sender, or date range.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender email/name filter' },
        subject: { type: 'string', description: 'Subject keyword filter' },
        since: { type: 'string', description: 'Emails since date (YYYY-MM-DD)' },
        count: { type: 'number', description: 'Max results (default: 20)' },
      },
    },
  },
  async (input) => {
    guardEmail();
    const config = getEmailConfig();
    const count = Math.min((input.count as number) || 20, 50);

    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const searchCriteria: any = {};
        if (input.from) searchCriteria.from = input.from as string;
        if (input.subject) searchCriteria.subject = input.subject as string;
        if (input.since) searchCriteria.since = new Date(input.since as string);

        const uids = await client.search(searchCriteria);
        const latestUids = uids.slice(-count);

        const results: string[] = [];
        for await (const msg of client.fetch(latestUids, { envelope: true })) {
          const env = msg.envelope;
          const from = env.from?.[0]?.address || 'unknown';
          results.push(`UID:${msg.uid} | ${env.date?.toISOString().slice(0, 10)} | ${from} | ${env.subject || '(no subject)'}`);
        }

        await audit({ action: 'email_search', input: { from: input.from, subject: input.subject } });
        return results.reverse().join('\n') || 'No matching emails.';
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  },
);

log.info('Email tools registered (IMAP/SMTP — free with any provider)');
