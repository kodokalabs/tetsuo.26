// ============================================================
// Logger — Structured, colored console logging
// ============================================================

import chalk from 'chalk';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_COLORS = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

function log(level: LogLevel, module: string, message: string, data?: unknown): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const time = new Date().toISOString().slice(11, 23);
  const prefix = `${chalk.dim(time)} ${LEVEL_COLORS[level](level.toUpperCase().padEnd(5))} ${chalk.bold(module)}`;
  console.log(`${prefix}  ${message}`);
  if (data) console.log(chalk.dim(JSON.stringify(data, null, 2)));
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, data?: unknown) => log('debug', module, msg, data),
    info:  (msg: string, data?: unknown) => log('info', module, msg, data),
    warn:  (msg: string, data?: unknown) => log('warn', module, msg, data),
    error: (msg: string, data?: unknown) => log('error', module, msg, data),
  };
}
