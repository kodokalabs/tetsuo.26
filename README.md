# 🤖 Autonomous Agent v0.2.0

A local-first, multi-channel, tool-using AI agent with multi-agent orchestration, persistent task queue, approval workflows, event triggers, cost tracking, and a full admin dashboard. 25 source files, ~6900 lines of TypeScript.

## Quick Start

```bash
# Windows
setup.bat

# macOS / Linux
chmod +x setup.sh && ./setup.sh

# Then
npm run dev
```

Admin dashboard: `http://127.0.0.1:18789/admin`

---

## Architecture

```
  Telegram / Discord / CLI
           │
  ┌────────┴───────────────────────────┐
  │     Gateway (auth + rate limit)     │
  │     HTTP + WS :18789               │── /admin (8-panel dashboard)
  └────────┬───────────────────────────┘
           │
   ┌───────┼────────┐
   ▼       ▼        ▼
Channels  Agent    Heartbeat
   │      Loop     Scheduler
   │       │  ↕ Approvals
   │       │  ↕ Cost Tracking
   │    ┌──┴──────────────┐
   │    ▼                 ▼
   │  LLM Provider    Orchestrator
   │  (per-call model   ├── Planner (decompose → subtasks)
   │   override)        ├── Router (complexity → model tier)
   │    │               └── Workers (parallel sub-agents)
   │    │
   │  Tools (30+)
   │  ├── Shell (sandboxed)     ├── Email (IMAP/SMTP)
   │  ├── Files (path-jailed)   ├── Social (GitHub/Mastodon/Reddit)
   │  ├── Browser (SSRF-safe)   ├── System Control (OS-level)
   │  ├── Task Queue            ├── Cost Tracker
   │  ├── Trigger Manager       └── Approval Manager
   │  │
   │  Memory ── Security Guard ── Runtime Settings
   │  └── Triggers (file watch, webhook, calendar, cron, email)
   └───────┘
```

## Core Features

### Multi-Agent Orchestration
Complex tasks are automatically decomposed into subtasks and executed in parallel across different AI models.

- **Planner**: LLM-powered task decomposition into subtasks with dependency graphs
- **Model Router**: Routes each subtask to optimal model tier based on complexity, privacy, and budget
  - `fast` → Haiku / GPT-4o-mini (simple lookups, formatting)
  - `balanced` → Sonnet / GPT-4o (standard work)
  - `reasoning` → Opus (complex analysis, architecture)
  - `local` → Ollama (private data, zero cost)
- **Parallel execution**: Subtasks in the same group run concurrently
- **Result synthesis**: Coordinator combines all sub-agent outputs into a cohesive response
- **Cost tracking per sub-agent**: See which models are spending what

### Persistent Task Queue
Tasks survive restarts, have state machines, and track progress.

- States: `pending → running → waiting_approval → completed/failed/cancelled/paused`
- Priority ordering: critical > high > normal > low
- Per-task scratchpad for agent working notes
- Progress bars with step-level tracking
- Full token/cost accounting per task and subtask
- Crash recovery: interrupted tasks auto-pause on restart

### Approval Workflow
The agent proposes actions and waits for user decision before proceeding.

- Risk-classified proposals (low/medium/high/critical)
- Chat commands: `/approve <id>`, `/reject <id>`, `/pending`
- Dashboard: one-click approve/reject with risk explanations
- Auto-expiry after 30 minutes
- Non-blocking: agent continues other work while waiting

### Event Triggers
Reactive automation — the agent responds to events, not just messages.

| Trigger | What fires it |
|---------|---------------|
| `file_watch` | Files change in a watched directory |
| `webhook` | HTTP POST received (e.g., GitHub push) |
| `cron` | Schedule (cron expression) |
| `calendar` | Upcoming events (iCal URL polling) |
| `email_watch` | New email matching filters |

Triggers can send messages or create intelligent tasks.

### Cost Tracking & Budgets
- Per-call token counting with model-specific pricing
- Per-model, per-day usage breakdown
- Configurable daily/weekly budget limits
- Hard stop mode: blocks LLM calls when budget exceeded
- Dashboard: real-time spend display and history charts
- Chat command: `/cost`

### Tools (30+)

| Category | Tools | Status |
|----------|-------|--------|
| **Shell** | `run_shell` | sandboxed, filtered |
| **Files** | `read_file`, `write_file`, `list_directory` | path-jailed |
| **Web** | `web_fetch` | SSRF-protected |
| **Browser** | `browser_action` | headless Chrome |
| **Memory** | `remember`, `recall` | local markdown |
| **Scheduling** | `schedule_cron`, `cancel_cron`, `edit_heartbeat` | persistent |
| **Skills** | `list_skills`, `create_skill` | self-extending |
| **Email** | `email_read`, `email_search`, `email_send` | IMAP/SMTP (free) |
| **GitHub** | `github_repos`, `github_issues`, `github_pr` | free API |
| **Mastodon** | `mastodon_timeline`, `mastodon_post`, `mastodon_notifications` | free API |
| **Reddit** | `reddit_read`, `reddit_post`, `reddit_inbox` | free API |
| **System** | `clipboard_read/write`, `send_notification`, `open_application`, `open_url`, `list_processes`, `system_info`, `take_screenshot` | OS-level |
| **Tasks** | `create_task`, `task_status`, `task_action` | orchestrated |
| **Agents** | `agent_status`, `check_approvals`, `resolve_approval` | monitoring |
| **Costs** | `cost_report`, `set_budget` | tracking |
| **Triggers** | `create_trigger`, `list_triggers`, `delete_trigger` | reactive |

### Admin Dashboard (8 panels)

1. **🔒 Security** — sandbox, SSRF, auth, injection guards, rate limits
2. **🛠 Tools** — enable/disable tool categories, domain filtering
3. **🔌 Integrations** — email, GitHub, Mastodon, Reddit credentials
4. **📋 Tasks** — queue viewer with progress bars, pending approvals
5. **🧠 Agents** — active sub-agents, model routes, per-agent stats
6. **💰 Costs** — today's spend, budget settings, usage history
7. **⚡ Triggers** — list, enable/disable, delete triggers
8. **📜 Audit** — date-filterable action log with blocked-only filter

Dangerous changes require typing `CONFIRM` in a modal dialog.

### Chat Commands

| Command | Action |
|---------|--------|
| `/approve <id>` | Approve a pending action |
| `/reject <id>` | Reject a pending action |
| `/pending` | List pending approvals |
| `/tasks` | List all tasks with status |
| `/cost` | Today's token spend |
| `/status` | Agent info and uptime |
| `/quit` | Shut down |

---

## Security (all ON by default)

| Protection | Details |
|---|---|
| Path sandboxing | Jailed to workspace, blocks `../`, null bytes |
| SSRF protection | DNS-resolving, blocks private IPs + metadata |
| Shell hardening | 20+ regex patterns, env key stripping, 5MB output cap |
| Gateway auth | 256-bit token, constant-time comparison |
| Prompt injection | Cryptographic boundary markers on external content |
| Audit logging | JSONL per-day with timestamps |
| Rate limiting | Token bucket per IP + LLM call rate |
| Tool permissions | Individually toggleable per category |

---

## Project Structure

```
src/
├── index.ts                     Entry point
├── types.ts                     All type definitions
├── config.ts / events.ts        Configuration + event bus
├── security/
│   ├── guard.ts                 Auth, SSRF, sandbox, audit
│   └── settings.ts              Runtime-mutable config
├── admin/
│   └── dashboard.ts             8-panel web admin UI
├── orchestrator/
│   ├── planner.ts               Task decomposition + parallel execution
│   └── router.ts                Complexity → model routing
├── tasks/
│   ├── queue.ts                 Persistent task state machine
│   ├── approvals.ts             Pending action workflow
│   └── costs.ts                 Token/spend tracking + budgets
├── triggers/
│   └── engine.ts                File watch, webhook, cron, calendar, email
├── gateway/
│   ├── server.ts                HTTP + WS (authenticated)
│   └── agent.ts                 Agent loop with approvals + cost tracking
├── tools/
│   ├── registry.ts              Core tools (sandboxed)
│   ├── tasks.ts                 Task + orchestration tools
│   ├── system.ts                OS control
│   ├── email.ts                 IMAP/SMTP
│   └── social.ts                GitHub, Mastodon, Reddit
├── channels/adapters.ts         Telegram, Discord, CLI
├── llm/provider.ts              Anthropic, OpenAI, Ollama (per-call override)
├── memory/store.ts              Markdown-based persistent memory
├── skills/loader.ts             SKILL.md parser
├── heartbeat/scheduler.ts       Proactive cron behavior
└── utils/logger.ts
```
