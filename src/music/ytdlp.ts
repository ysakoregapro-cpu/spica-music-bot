import { accessSync, constants, existsSync } from 'node:fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { logger } from '../utils/logger.js';

/** yt-dlp executable (override with YTDLP_BIN). */
export const YTDLP_BIN = process.env.YTDLP_BIN?.trim() || 'yt-dlp';

/** JS runtime for YouTube signature solving (--js-runtimes). */
export const YTDLP_JS_RUNTIME = process.env.YTDLP_JS_RUNTIME?.trim() || 'node';

let cookiesStatusLogged = false;

export class YtDlpCookiesFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YtDlpCookiesFileError';
  }
}

export class YtDlpYouTubeAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YtDlpYouTubeAccessError';
  }
}

function resolveCookiesPath(): string | undefined {
  const configured = process.env.YTDLP_COOKIES_PATH?.trim();
  if (!configured) {
    return undefined;
  }

  if (!existsSync(configured)) {
    throw new YtDlpCookiesFileError(
      'YTDLP_COOKIES_PATH に指定された Cookie ファイルが見つかりません。VPS上のパスとファイルの存在を確認してください。',
    );
  }

  try {
    accessSync(configured, constants.R_OK);
  } catch {
    throw new YtDlpCookiesFileError(
      'YTDLP_COOKIES_PATH に指定された Cookie ファイルを読み取れません。権限を確認してください。',
    );
  }

  return configured;
}

function logCookiesStatusOnce(enabled: boolean): void {
  if (cookiesStatusLogged) {
    return;
  }
  cookiesStatusLogged = true;
  logger.info(enabled ? 'yt-dlp cookies enabled' : 'yt-dlp cookies disabled');
}

/** Base flags shared by every yt-dlp invocation. */
export function buildYtDlpBaseArgs(): string[] {
  const args: string[] = ['--js-runtimes', YTDLP_JS_RUNTIME];

  const cookiesPath = resolveCookiesPath();
  logCookiesStatusOnce(cookiesPath !== undefined);

  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }

  return args;
}

export function buildYtDlpArgs(userArgs: readonly string[]): string[] {
  return [...buildYtDlpBaseArgs(), ...userArgs];
}

export function spawnYtDlpProcess(
  userArgs: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(YTDLP_BIN, buildYtDlpArgs(userArgs), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
  });
}

const YOUTUBE_ACCESS_PATTERNS: ReadonlyArray<{ match: (text: string) => boolean; message: string }> = [
  {
    match: (text) => text.toLowerCase().includes('sign in to confirm'),
    message:
      'YouTubeがボット確認を要求しています。Cookie（YTDLP_COOKIES_PATH）が有効か確認してください。',
  },
  {
    match: (text) => text.toLowerCase().includes('signature solving failed'),
    message:
      'YouTubeの署名検証に失敗しました。YTDLP_JS_RUNTIME=node と Cookie の設定を確認してください。',
  },
  {
    match: (text) => text.toLowerCase().includes('n challenge solving failed'),
    message:
      'YouTubeのチャレンジ検証に失敗しました。YTDLP_JS_RUNTIME=node と Cookie の設定を確認してください。',
  },
  {
    match: (text) => text.toLowerCase().includes('only images are available for download'),
    message:
      'YouTubeから音声フォーマットを取得できませんでした。Cookie または yt-dlp の設定を確認してください。',
  },
  {
    match: (text) => text.toLowerCase().includes('requested format is not available'),
    message:
      'YouTubeで要求した音声フォーマットが利用できません。Cookie または yt-dlp の設定を確認してください。',
  },
];

export function isYoutubeAccessError(text: string): boolean {
  return YOUTUBE_ACCESS_PATTERNS.some((pattern) => pattern.match(text));
}

export function formatYoutubeAccessError(text: string): string | null {
  for (const pattern of YOUTUBE_ACCESS_PATTERNS) {
    if (pattern.match(text)) {
      return pattern.message;
    }
  }
  return null;
}

function redactSensitiveYtDlpText(text: string): string {
  const cookiesPath = process.env.YTDLP_COOKIES_PATH?.trim();
  if (!cookiesPath) {
    return text;
  }

  return text.split(cookiesPath).join('<cookies>');
}

export function sanitizeYtDlpLogText(text: string): string {
  return redactSensitiveYtDlpText(text);
}

export function throwIfYoutubeAccessError(text: string): void {
  const friendly = formatYoutubeAccessError(text);
  if (friendly) {
    throw new YtDlpYouTubeAccessError(friendly);
  }
}

export function mapYtDlpProcessError(stderr: string, fallback: string): Error {
  const trimmed = stderr.trim();
  const friendly = formatYoutubeAccessError(trimmed);
  if (friendly) {
    return new YtDlpYouTubeAccessError(friendly);
  }
  return new Error(trimmed || fallback);
}

export function isYtDlpYouTubeAccessFailure(error: unknown): boolean {
  if (error instanceof YtDlpYouTubeAccessError) {
    return true;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return isYoutubeAccessError(detail);
}

function formatYoutubeAccessLog(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('sign in to confirm')) {
    return 'bot confirmation required';
  }
  if (lower.includes('signature solving failed')) {
    return 'signature solving failed';
  }
  if (lower.includes('n challenge solving failed')) {
    return 'n challenge solving failed';
  }
  if (lower.includes('only images are available for download')) {
    return 'only images available';
  }
  if (lower.includes('requested format is not available')) {
    return 'requested format not available';
  }
  return 'YouTube access error';
}

/** Run yt-dlp and collect stdout lines (metadata / playlist import). */
export async function runYtDlp(args: readonly string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let process: ChildProcess;
    try {
      process = spawnYtDlpProcess(args);
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    process.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    process.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    process.on('error', (error) => {
      reject(error);
    });

    process.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (code !== 0 && stdout.trim().length === 0) {
        reject(mapYtDlpProcessError(stderr, `yt-dlp exited with code ${String(code)}`));
        return;
      }

      if (stderr.trim()) {
        const safeStderr = sanitizeYtDlpLogText(stderr.trim());
        if (isYoutubeAccessError(safeStderr)) {
          logger.warn(`yt-dlp YouTube access error: ${formatYoutubeAccessLog(safeStderr)}`);
        } else {
          logger.debug(`yt-dlp stderr: ${safeStderr}`);
        }
      }

      resolve(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      );
    });
  });
}
