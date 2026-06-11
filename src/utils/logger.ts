type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function formatMessage(level: LogLevel, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
}

export const logger = {
  info(message: string): void {
    console.log(formatMessage('info', message));
  },
  warn(message: string): void {
    console.warn(formatMessage('warn', message));
  },
  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? error.message : String(error ?? '');
    console.error(formatMessage('error', detail ? `${message}: ${detail}` : message));
  },
  debug(message: string): void {
    console.debug(formatMessage('debug', message));
  },
};
