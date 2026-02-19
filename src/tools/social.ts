// ============================================================
// Social Media Tools — GitHub, Mastodon, Reddit (all free APIs)
// ============================================================

import { registerTool } from './registry.js';
import { getSettings, isToolAllowed } from '../security/settings.js';
import { audit, SecurityError, wrapUntrustedContent, validateURL } from '../security/guard.js';
import { securityConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Social');

function guardSocial(): void {
  if (!isToolAllowed('socialMedia')) {
    throw new SecurityError(
      'Social media tools are disabled. Enable in admin dashboard (⚠ can post publicly as you).'
    );
  }
}

// ============================================================
// GITHUB — Free API, 5000 req/hr with token
// ============================================================

async function githubFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const { integrations } = getSettings();
  if (!integrations.github.token) throw new SecurityError('GitHub token not configured.');

  const res = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${integrations.github.token}`,
      'User-Agent': 'AutonomousAgent/1.0',
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${res.status}: ${err.slice(0, 500)}`);
  }
  return res.json();
}

registerTool(
  {
    name: 'github_repos',
    description: 'List your GitHub repositories, or search for public repos.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (omit for your own repos)' },
        count: { type: 'number', description: 'Number of results (default: 10)' },
      },
    },
  },
  async (input) => {
    guardSocial();
    const count = Math.min((input.count as number) || 10, 30);
    let data: any[];

    if (input.query) {
      const res = await githubFetch(`/search/repositories?q=${encodeURIComponent(input.query as string)}&per_page=${count}`);
      data = res.items;
    } else {
      data = await githubFetch(`/user/repos?sort=updated&per_page=${count}`);
    }

    await audit({ action: 'github_repos', input: { query: input.query } });
    return data.map((r: any) =>
      `${r.full_name} ⭐${r.stargazers_count} — ${r.description || '(no description)'} [${r.html_url}]`
    ).join('\n') || 'No repos found.';
  },
);

registerTool(
  {
    name: 'github_issues',
    description: 'List or create issues on a GitHub repository.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create'], description: 'Action to perform' },
        repo: { type: 'string', description: 'Repository (owner/name)' },
        title: { type: 'string', description: 'Issue title (for create)' },
        body: { type: 'string', description: 'Issue body (for create)' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (for list)' },
      },
      required: ['action', 'repo'],
    },
  },
  async (input) => {
    guardSocial();
    const repo = input.repo as string;

    if (input.action === 'list') {
      const state = (input.state as string) || 'open';
      const issues = await githubFetch(`/repos/${repo}/issues?state=${state}&per_page=15`);
      await audit({ action: 'github_issues_list', input: { repo } });
      return (issues as any[]).map((i: any) =>
        `#${i.number} [${i.state}] ${i.title} — by ${i.user.login} (${i.comments} comments)`
      ).join('\n') || 'No issues found.';
    }

    if (input.action === 'create') {
      if (!input.title) throw new Error('Title required for creating issues');
      const issue = await githubFetch(`/repos/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: input.title, body: input.body || '' }),
      });
      await audit({ action: 'github_issue_create', input: { repo, title: input.title } });
      return `Created issue #${(issue as any).number}: ${(issue as any).html_url}`;
    }

    return 'Unknown action';
  },
);

registerTool(
  {
    name: 'github_pr',
    description: 'List pull requests on a repository.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository (owner/name)' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter' },
      },
      required: ['repo'],
    },
  },
  async (input) => {
    guardSocial();
    const repo = input.repo as string;
    const state = (input.state as string) || 'open';
    const prs = await githubFetch(`/repos/${repo}/pulls?state=${state}&per_page=15`);
    await audit({ action: 'github_prs', input: { repo } });
    return (prs as any[]).map((p: any) =>
      `#${p.number} [${p.state}] ${p.title} — by ${p.user.login} (${p.changed_files ?? '?'} files)`
    ).join('\n') || 'No PRs found.';
  },
);

// ============================================================
// MASTODON — Fully free, federated, no rate limit registration
// ============================================================

async function mastodonFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const { integrations } = getSettings();
  const { instanceUrl, accessToken } = integrations.mastodon;
  if (!instanceUrl || !accessToken) throw new SecurityError('Mastodon not configured.');

  const baseUrl = instanceUrl.replace(/\/$/, '');
  await validateURL(`${baseUrl}${endpoint}`);

  const res = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Mastodon API ${res.status}: ${err.slice(0, 500)}`);
  }
  return res.json();
}

registerTool(
  {
    name: 'mastodon_timeline',
    description: 'Read your Mastodon home timeline.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of posts (default: 20, max: 40)' },
      },
    },
  },
  async (input) => {
    guardSocial();
    const count = Math.min((input.count as number) || 20, 40);
    const posts = await mastodonFetch(`/api/v1/timelines/home?limit=${count}`);
    await audit({ action: 'mastodon_timeline' });

    let result = (posts as any[]).map((p: any) => {
      const text = p.content?.replace(/<[^>]*>/g, '').slice(0, 300) || '';
      return `@${p.account.acct} (${p.created_at.slice(0, 16)})\n${text}\n♥ ${p.favourites_count} 🔁 ${p.reblogs_count}`;
    }).join('\n---\n');

    if (securityConfig.promptInjectionGuards) {
      result = wrapUntrustedContent(result, 'mastodon');
    }
    return result || 'Timeline empty.';
  },
);

registerTool(
  {
    name: 'mastodon_post',
    description: 'Post a status (toot) to Mastodon.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Status text (max 500 chars)' },
        visibility: { type: 'string', enum: ['public', 'unlisted', 'private', 'direct'], description: 'Visibility (default: public)' },
      },
      required: ['status'],
    },
  },
  async (input) => {
    guardSocial();
    const status = (input.status as string).slice(0, 500);
    const visibility = (input.visibility as string) || 'public';

    const post = await mastodonFetch('/api/v1/statuses', {
      method: 'POST',
      body: JSON.stringify({ status, visibility }),
    });

    await audit({ action: 'mastodon_post', input: { visibility, preview: status.slice(0, 100) } });
    return `Posted: ${(post as any).url}`;
  },
);

registerTool(
  {
    name: 'mastodon_notifications',
    description: 'Check your Mastodon notifications.',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'Number (default: 15)' } },
    },
  },
  async (input) => {
    guardSocial();
    const count = Math.min((input.count as number) || 15, 30);
    const notifs = await mastodonFetch(`/api/v1/notifications?limit=${count}`);
    await audit({ action: 'mastodon_notifications' });

    let result = (notifs as any[]).map((n: any) =>
      `[${n.type}] @${n.account.acct} — ${n.status?.content?.replace(/<[^>]*>/g, '').slice(0, 100) || n.type}`
    ).join('\n');

    if (securityConfig.promptInjectionGuards) {
      result = wrapUntrustedContent(result, 'mastodon');
    }
    return result || 'No notifications.';
  },
);

// ============================================================
// REDDIT — Free API, 60 req/min with OAuth
// ============================================================

let redditToken: string | null = null;
let redditTokenExpiry = 0;

async function getRedditToken(): Promise<string> {
  if (redditToken && Date.now() < redditTokenExpiry) return redditToken;

  const { integrations } = getSettings();
  const { clientId, clientSecret, username, password } = integrations.reddit;
  if (!clientId || !clientSecret || !username || !password) {
    throw new SecurityError('Reddit not configured. Set credentials in admin dashboard.');
  }

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'AutonomousAgent/1.0',
    },
    body: `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Reddit auth failed: ${res.status}`);
  const data = await res.json() as any;
  redditToken = data.access_token;
  redditTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return redditToken!;
}

async function redditFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const token = await getRedditToken();
  const res = await fetch(`https://oauth.reddit.com${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'AutonomousAgent/1.0',
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Reddit API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

registerTool(
  {
    name: 'reddit_read',
    description: 'Read posts from a subreddit or your front page.',
    parameters: {
      type: 'object',
      properties: {
        subreddit: { type: 'string', description: 'Subreddit name (omit for front page)' },
        sort: { type: 'string', enum: ['hot', 'new', 'top', 'rising'], description: 'Sort order' },
        count: { type: 'number', description: 'Number of posts (default: 10)' },
      },
    },
  },
  async (input) => {
    guardSocial();
    const count = Math.min((input.count as number) || 10, 25);
    const sub = input.subreddit ? `/r/${input.subreddit}` : '';
    const sort = (input.sort as string) || 'hot';

    const data = await redditFetch(`${sub}/${sort}?limit=${count}`);
    await audit({ action: 'reddit_read', input: { subreddit: input.subreddit } });

    let result = (data.data.children as any[]).map((c: any) => {
      const p = c.data;
      return `r/${p.subreddit} | ⬆${p.score} | ${p.title}\n${p.selftext?.slice(0, 200) || p.url || ''}\nby u/${p.author} — ${p.num_comments} comments`;
    }).join('\n---\n');

    if (securityConfig.promptInjectionGuards) {
      result = wrapUntrustedContent(result, 'reddit');
    }
    return result || 'No posts found.';
  },
);

registerTool(
  {
    name: 'reddit_post',
    description: 'Submit a text post to a subreddit.',
    parameters: {
      type: 'object',
      properties: {
        subreddit: { type: 'string', description: 'Target subreddit' },
        title: { type: 'string', description: 'Post title' },
        body: { type: 'string', description: 'Post body text' },
      },
      required: ['subreddit', 'title'],
    },
  },
  async (input) => {
    guardSocial();
    const data = await redditFetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        sr: input.subreddit as string,
        kind: 'self',
        title: input.title as string,
        text: (input.body as string) || '',
      }).toString(),
    });

    await audit({ action: 'reddit_post', input: { subreddit: input.subreddit, title: input.title } });
    const url = (data as any)?.json?.data?.url || 'submitted';
    return `Posted to r/${input.subreddit}: ${url}`;
  },
);

registerTool(
  {
    name: 'reddit_inbox',
    description: 'Check your Reddit inbox / messages.',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'Number (default: 10)' } },
    },
  },
  async (input) => {
    guardSocial();
    const count = Math.min((input.count as number) || 10, 25);
    const data = await redditFetch(`/message/inbox?limit=${count}`);
    await audit({ action: 'reddit_inbox' });

    let result = (data.data.children as any[]).map((c: any) => {
      const m = c.data;
      return `From: u/${m.author} | ${m.subject || '(reply)'}\n${m.body?.slice(0, 200) || ''}`;
    }).join('\n---\n');

    if (securityConfig.promptInjectionGuards) {
      result = wrapUntrustedContent(result, 'reddit');
    }
    return result || 'Inbox empty.';
  },
);

log.info('Social media tools registered (GitHub, Mastodon, Reddit — all free APIs)');
