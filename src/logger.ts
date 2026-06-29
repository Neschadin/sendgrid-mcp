type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLevel(input: string | undefined): LogLevel {
  const normalized = (input ?? '').trim().toLowerCase();
  if (normalized === 'debug') return 'debug';
  if (normalized === 'warn') return 'warn';
  if (normalized === 'error') return 'error';
  return 'info';
}

const currentLevel = parseLevel(Bun.env['SENDGRID_MCP_LOG_LEVEL']);

function canLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

export function log(level: LogLevel, message: string): void {
  if (!canLog(level)) return;
  process.stderr.write(`[sendgrid-mcp] ${level.toUpperCase()} ${message}\n`);
}

export function logDebug(message: string): void {
  log('debug', message);
}

export function logInfo(message: string): void {
  log('info', message);
}

export function logWarn(message: string): void {
  log('warn', message);
}

export function logError(message: string): void {
  log('error', message);
}
