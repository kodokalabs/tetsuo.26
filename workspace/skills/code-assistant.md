---
name: code-assistant
description: Autonomously write, test, and fix code. Can create files, run tests, debug errors, and submit PRs.
triggers:
  - fix tests
  - write code
  - debug
  - create script
  - run tests
  - code review
version: 1.0.0
---

# Code Assistant Skill

When asked to write or fix code:

1. **Understand the task**: Read the relevant files using `read_file` and `list_directory`
2. **Plan**: Break the task into discrete steps
3. **Implement**: Write code using `write_file`. Prefer small, focused changes.
4. **Test**: Run tests with `run_shell` (e.g., `npm test`, `pytest`, etc.)
5. **Debug**: If tests fail, read the error output, fix the code, re-test
6. **Report**: Summarize what was done and any remaining issues

## Guidelines
- Always read existing code before modifying it
- Run linters/formatters after changes (if available)
- If a fix requires more than 5 iterations, stop and ask the user
- Never commit directly to main — create branches when possible
- For multi-file changes, work on one file at a time
