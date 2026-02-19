# 🤖 Autonomous Agent

An OpenClaw-inspired autonomous AI agent built from scratch in TypeScript. Local-first, multi-channel, tool-using, self-extending, security-hardened — with a web admin dashboard for runtime control.

## Quick Start

### Windows (double-click)
```
setup.bat
```

### macOS / Linux
```bash
chmod +x setup.sh && ./setup.sh
```

Both setup wizards walk you through **10 detailed steps** with security explanations, risk warnings, and double confirmations for every dangerous option.

---

## Architecture

```
  Telegram / Discord / CLI
           │
  ┌────────┴─────────────────────┐
  │     Gateway (auth + rate limit)
  │     HTTP + WS :18789         │──── /admin (dashboard)
  └────────┬─────────────────────┘
           │
   ┌───────┼────────┐
   ▼       ▼        ▼
Channels  Agent    Heartbeat
   │      Loop     Scheduler
   │       │          │
   │    ┌──┴──┐       │
   │    ▼     ▼       │
   │  LLM   Tools ◄──┘
   │    │   ┌──┤
   │    │   │  ├── Shell (sandboxed)
   │    │   │  ├── Files (path-jailed)
   │    │   │  ├── Browser (SSRF-protected)
   │    │   │  ├── Email (IMAP/SMTP)
   │    │   │  ├── Social (GitHub/Mastodon/Reddit)
   │    │   │  └── System Control (OS-level)
   │    └──┬┘
   │       ▼
   │    Memory ── Security Guard ── Runtime Settings
   │    (local)   (auth,SSRF,      (admin dashboard,
   │              sandbox,audit)    settings.json)
   └───────┘
       Skills (SKILL.md)
```

### Modules (19 source files, ~4400 LOC)

| Module | Purpose |
|--------|---------|
| `security/guard.ts` | Auth, SSRF, path sandbox, shell filter, rate limit, audit |
| `security/settings.ts` | Runtime-mutable config persisted to settings.json |
| `admin/dashboard.ts` | Self-contained web UI for security management |
| `gateway/server.ts` | Authenticated HTTP + WebSocket control plane |
| `gateway/agent.ts` | Agentic tool-use loop |
| `tools/registry.ts` | Sandboxed core tools (shell, files, browser, web) |
| `tools/system.ts` | OS control (clipboard, notifications, apps, screenshots) |
| `tools/email.ts` | IMAP read + SMTP send (free, any provider) |
| `tools/social.ts` | GitHub, Mastodon, Reddit APIs (all free) |
| `channels/adapters.ts` | Telegram, Discord, CLI |
| `llm/provider.ts` | Anthropic, OpenAI, Ollama |
| `memory/store.ts` | Markdown-based persistent memory |
| `skills/loader.ts` | SKILL.md parser |
| `heartbeat/scheduler.ts` | Cron + proactive behavior |

---

## Admin Dashboard

Access at `http://127.0.0.1:18789/admin` (requires gateway token).

The dashboard provides runtime control over:

- **Security toggles** — sandbox, SSRF, auth, injection guards, audit
- **Tool permissions** — enable/disable entire categories (shell, email, social, system)
- **Rate limits** — gateway, LLM, and tool execution limits
- **Integration credentials** — email, GitHub, Mastodon, Reddit
- **Audit log viewer** — filterable, date-selectable action history
- **Domain filtering** — allowed/blocked domain lists

Dangerous changes (disabling sandbox, enabling system control) require **double confirmation**: type `CONFIRM` in a modal dialog.

---

## Integrations (all free)

| Service | API | Cost | What the agent can do |
|---------|-----|------|----------------------|
| **Email** | IMAP/SMTP | Free | Read inbox, search, send emails |
| **GitHub** | REST v3 | Free (5K req/hr) | Repos, issues, PRs |
| **Mastodon** | REST | Free (no limit) | Timeline, post, notifications |
| **Reddit** | OAuth2 | Free (60 req/min) | Read subs, post, inbox |

All integrations are **disabled by default**. Enable via admin dashboard or setup wizard. Each requires double confirmation due to security implications.

---

## Security

### Hardened by default

| Protection | What it does |
|---|---|
| **Path sandboxing** | All file ops jailed to workspace; blocks `../`, null bytes, symlink escapes |
| **SSRF protection** | DNS-resolving validator blocks private IPs, metadata endpoints, non-HTTP schemes |
| **Shell hardening** | 20+ regex patterns block destructive commands, exfiltration, reverse shells; API keys stripped from env |
| **Gateway auth** | Auto-generated 256-bit token, constant-time comparison, per-IP rate limiting |
| **Prompt injection** | External content wrapped with cryptographic boundary markers |
| **Audit logging** | Every tool call recorded in JSONL with timestamps |
| **WS filtering** | Tool results sanitized before broadcast |
| **Tool permissions** | Each tool category individually toggleable via admin |

### Double confirmation for dangerous changes

Both the setup wizard and admin dashboard require typing `CONFIRM` for:
- Disabling sandbox, SSRF protection, or gateway auth
- Enabling system control, email, or social media
- Setting high autonomy

### Runtime settings (settings.json)

All security parameters are persisted in `workspace/settings.json` and mutable at runtime via the admin dashboard API. Changes take effect immediately without restart.

---

## Project Structure

```
autonomous-agent/
├── setup.bat / setup.ps1 / setup.sh    # Platform setup wizards
├── src/
│   ├── index.ts                        # Entry point
│   ├── types.ts / config.ts / events.ts
│   ├── security/
│   │   ├── guard.ts                    # Auth, SSRF, sandbox, audit
│   │   └── settings.ts                 # Runtime settings manager
│   ├── admin/
│   │   └── dashboard.ts               # Web admin panel
│   ├── gateway/
│   │   ├── server.ts                   # HTTP + WS (authenticated)
│   │   └── agent.ts                    # Agent loop
│   ├── tools/
│   │   ├── registry.ts                 # Core tools (sandboxed)
│   │   ├── system.ts                   # OS control
│   │   ├── email.ts                    # IMAP/SMTP
│   │   └── social.ts                   # GitHub, Mastodon, Reddit
│   ├── channels/adapters.ts
│   ├── llm/provider.ts
│   ├── memory/store.ts
│   ├── skills/loader.ts
│   ├── heartbeat/scheduler.ts
│   └── utils/logger.ts
├── workspace/
│   ├── settings.json                   # Runtime security config
│   ├── .gateway-token                  # Auth token (auto-generated)
│   ├── skills/ / memory/ / logs/
│   └── HEARTBEAT.md
└── .env                                # API keys (chmod 600)
```

## License

MIT
