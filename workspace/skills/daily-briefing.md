---
name: daily-briefing
description: Generate a personalized daily briefing with weather, tasks, calendar, and news.
triggers:
  - briefing
  - morning
  - daily update
  - what's happening today
version: 1.0.0
---

# Daily Briefing Skill

When the user asks for a briefing or this triggers during a heartbeat:

1. Check the current date and time
2. Look up the user's location preferences in memory (use `recall` tool)
3. Fetch current weather for their location using `web_fetch` (e.g., wttr.in API)
4. Check for any scheduled tasks or reminders in memory
5. Fetch top news headlines using `web_fetch` on a news API
6. Compile everything into a clean, scannable briefing format:

```
☀️ Good morning! Here's your briefing for [date]:

🌤 Weather: [summary]
📋 Tasks: [list any pending tasks]
📰 Headlines: [top 3 news items]
💡 Reminder: [any relevant memories or follow-ups]
```

Keep it concise. The user wants a quick overview, not an essay.
