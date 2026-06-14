import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { demuxProbe, StreamType } from '@discordjs/voice';
import {
  MAX_PLAYLIST_TRACKS,
  MAX_TRACK_DURATION,
  type FetchResult,
  type Track,
} from './types.js';
import { isPlaylistUrl } from '../utils/validators.js';
import { isPremiumOnlyMessage, UnplayableTrackError } from './playbackErrors.js';
import {
  isYoutubeAccessError,
  runYtDlp,
  sanitizeYtDlpLogText,
  spawnYtDlpProcess,
  throwIfYoutubeAccessError,
  YTDLP_BIN,
} from './ytdlp.js';
import { logger } from '../utils/logger.js';

/**
 * Audio pipeline routes:
 *
 * 1. webm-opus-passthrough / ogg-opus-passthrough
 *    yt-dlp -> demuxProbe -> createAudioResource(StreamType.WebmOpus|OggOpus)
 *    @discordjs/voice runs WebmDemuxer/OggDemuxer only. No FFmpeg, no libopus re-encode.
 *
 * 2. ffmpeg-transcode (fallback)
 *    yt-dlp -> FFmpeg(libopus, 48kHz stereo, 256k VBR) -> createAudioResource(StreamType.OggOpus)
 *    Used for AAC/M4A sources, or when passthrough probe/playback fails.
 *
 * demuxProbe accepts passthrough only when the Opus header is 48kHz stereo (Discord VC requirement).
 * A small probe buffer can miss the WebM Opus head and falsely fall back to FFmpeg; use DEMUX_PROBE_SIZE.
 */

/** yt-dlp format: prefer native Opus in WebM, then any Opus, then WebM, then best audio. */
export const YTDLP_AUDIO_FORMAT =
  'bestaudio[ext=webm][acodec=opus]/bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio';

/** Socket wait before yt-dlp gives up on a read (seconds). */
export const YTDLP_SOCKET_TIMEOUT_SEC = 10;

/** Download / fragment retry counts (stable range, avoids very long stalls). */
export const YTDLP_RETRIES = 8;
export const YTDLP_FRAGMENT_RETRIES = 8;
export const YTDLP_EXTRACTOR_RETRIES = 8;

/** Shared network/resilience flags for yt-dlp subprocesses. */
export const YTDLP_NETWORK_ARGS = [
  '--socket-timeout',
  String(YTDLP_SOCKET_TIMEOUT_SEC),
  '--retries',
  String(YTDLP_RETRIES),
  '--fragment-retries',
  String(YTDLP_FRAGMENT_RETRIES),
  '--extractor-retries',
  String(YTDLP_EXTRACTOR_RETRIES),
] as const;

export function isStreamTimeoutError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('read timed out')
    || lower.includes('timed out')
    || lower.includes('timeout')
    || lower.includes('connection reset')
    || lower.includes('connection aborted')
  );
}

/** Bytes read before deciding passthrough vs transcode (default demuxProbe size is 1024). */
export const DEMUX_PROBE_SIZE = 8192;

/** FFmpeg args for high-quality Discord-oriented Opus when re-encoding is required. */
export const FFMPEG_OPUS_TRANSCODE_ARGS = [
  '-vn',
  '-ac',
  '2',
  '-ar',
  '48000',
  '-c:a',
  'libopus',
  '-b:a',
  '256k',
  '-vbr',
  'on',
  '-application',
  'audio',
  '-frame_duration',
  '20',
  '-compression_level',
  '10',
  '-f',
  'ogg',
] as const;

export type AudioStreamRoute =
  | 'webm-opus-passthrough'
  | 'ogg-opus-passthrough'
  | 'ffmpeg-transcode';

export type PassthroughStreamType = StreamType.WebmOpus | StreamType.OggOpus;

export interface PrepareAudioStreamOptions {
  /** Skip passthrough probe and always run the FFmpeg libopus transcode route. */
  forceTranscode?: boolean;
}

export interface PreparedAudioStream {
  processes: ChildProcess[];
  stream: Readable;
  inputType: PassthroughStreamType;
  route: AudioStreamRoute;
  /** True when yt-dlp output is fed directly to @discordjs/voice demuxer (no FFmpeg re-encode). */
  passthrough: boolean;
}

interface YtDlpEntry {
  id?: string;
  title?: string;
  webpage_url?: string;
  url?: string;
  duration?: number | null;
  is_live?: boolean;
  live_status?: string;
}

function buildVideoUrl(entry: YtDlpEntry): string | null {
  if (entry.webpage_url) {
    return entry.webpage_url.split('&list=')[0] ?? entry.webpage_url;
  }

  if (entry.url && entry.url.startsWith('http')) {
    return entry.url.split('&list=')[0] ?? entry.url;
  }

  if (entry.id) {
    return `https://www.youtube.com/watch?v=${entry.id}`;
  }

  return null;
}

function getSkipReason(entry: YtDlpEntry): string | null {
  if (!entry.title || !buildVideoUrl(entry)) {
    return 'タイトルまたはURLを取得できませんでした';
  }

  if (entry.is_live === true) {
    return `ライブ配信は非対応: ${entry.title}`;
  }

  if (entry.live_status === 'is_live' || entry.live_status === 'is_upcoming') {
    return `ライブ配信は非対応: ${entry.title}`;
  }

  if (entry.duration == null || entry.duration <= 0) {
    return `再生時間を取得できませんでした: ${entry.title}`;
  }

  if (entry.duration > MAX_TRACK_DURATION) {
    return `2時間を超える動画: ${entry.title}`;
  }

  return null;
}

function entryToTrack(entry: YtDlpEntry, requestedBy: string): Track | null {
  const skipReason = getSkipReason(entry);
  if (skipReason) {
    return null;
  }

  const url = buildVideoUrl(entry);
  if (!url || !entry.title || entry.duration == null) {
    return null;
  }

  return {
    title: entry.title,
    url,
    duration: entry.duration,
    requestedBy,
  };
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

function spawnYtDlpStream(url: string): { process: ChildProcess; stream: Readable } {
  logger.info(
    `yt-dlp stream open: ${url} (bin=${YTDLP_BIN}, socket-timeout=${String(YTDLP_SOCKET_TIMEOUT_SEC)}s, retries=${String(YTDLP_RETRIES)})`,
  );

  const process = spawnYtDlpProcess([
    '-f',
    YTDLP_AUDIO_FORMAT,
    '--no-playlist',
    ...YTDLP_NETWORK_ARGS,
    '-o',
    '-',
    url,
  ]);

  if (!process.stdout || !process.stderr) {
    process.kill();
    throw new Error('yt-dlp stdout/stderr is unavailable');
  }

  const stdout = process.stdout;
  const stderr = process.stderr;

  let stderrText = '';
  let timeoutLogged = false;

  const logTimeoutOnce = (detail: string): void => {
    if (timeoutLogged) {
      return;
    }
    timeoutLogged = true;
    logger.warn(
      `yt-dlp stream read timed out (socket-timeout=${String(YTDLP_SOCKET_TIMEOUT_SEC)}s): ${detail}`,
    );
  };

  stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrText += text;
    const safeText = sanitizeYtDlpLogText(text.trim());

    if (isYoutubeAccessError(stderrText)) {
      logger.warn(`yt-dlp stream YouTube access error: ${formatYoutubeAccessLog(stderrText)}`);
    } else if (safeText) {
      logger.debug(`yt-dlp stream stderr: ${safeText}`);
    }

    if (isStreamTimeoutError(text)) {
      logTimeoutOnce(safeText || url);
    }

    if (isPremiumOnlyMessage(text) || isPremiumOnlyMessage(stderrText)) {
      logger.info(`premium-only skipped: ${url}`);
      process.kill();
      stdout.destroy(new UnplayableTrackError('premium-only track'));
    }

    try {
      throwIfYoutubeAccessError(stderrText);
    } catch (error) {
      process.kill();
      stdout.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });

  process.on('close', (code) => {
    if (code !== 0 && isPremiumOnlyMessage(stderrText)) {
      logger.info(`premium-only skipped (process exit): ${url}`);
    }
    if (code !== 0 && isStreamTimeoutError(stderrText)) {
      logTimeoutOnce(sanitizeYtDlpLogText(stderrText.trim()) || url);
    }
    if (code !== 0 && isYoutubeAccessError(stderrText) && !stdout.destroyed) {
      try {
        throwIfYoutubeAccessError(stderrText);
      } catch (error) {
        stdout.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  stdout.on('error', (error) => {
    if (isPremiumOnlyMessage(stderrText)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isStreamTimeoutError(message) || isStreamTimeoutError(stderrText)) {
      logTimeoutOnce(message || stderrText.trim() || url);
    }
    stdout.destroy(error);
  });

  return {
    process,
    stream: stdout,
  };
}

function spawnFfmpegTranscode(input: Readable): { process: ChildProcess; stream: Readable } {
  const process = spawn(
    'ffmpeg',
    ['-nostdin', '-loglevel', 'error', '-i', '-', ...FFMPEG_OPUS_TRANSCODE_ARGS, '-'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  process.stderr.on('data', (chunk: Buffer) => {
    logger.debug(`ffmpeg stderr: ${chunk.toString('utf8').trim()}`);
  });

  input.pipe(process.stdin);
  input.on('end', () => {
    process.stdin?.end();
  });
  input.on('error', (error) => {
    logger.error('yt-dlp stream error during transcode', error);
    process.stdin?.destroy();
  });
  process.stdin.on('error', () => {
    // Ignore EPIPE when the downstream closes early.
  });

  return {
    process,
    stream: process.stdout,
  };
}

function buildPassthroughResult(
  processes: ChildProcess[],
  stream: Readable,
  type: PassthroughStreamType,
): PreparedAudioStream {
  const route = type === StreamType.WebmOpus ? 'webm-opus-passthrough' : 'ogg-opus-passthrough';
  logger.info(`Audio route: ${route} (no FFmpeg re-encode)`);
  return {
    processes,
    stream,
    inputType: type,
    route,
    passthrough: true,
  };
}

function buildTranscodeResult(
  processes: ChildProcess[],
  stream: Readable,
  reason: string,
): PreparedAudioStream {
  logger.info(`Audio route: ffmpeg-transcode (${reason})`);
  return {
    processes,
    stream,
    inputType: StreamType.OggOpus,
    route: 'ffmpeg-transcode',
    passthrough: false,
  };
}

type PassthroughProbeResult =
  | { passthrough: true; type: PassthroughStreamType; stream: Readable }
  | { passthrough: false; stream: Readable };

async function probeAudioStream(stream: Readable): Promise<PassthroughProbeResult> {
  const probed = await demuxProbe(stream, DEMUX_PROBE_SIZE);

  if (probed.type === StreamType.WebmOpus || probed.type === StreamType.OggOpus) {
    return { passthrough: true, type: probed.type, stream: probed.stream };
  }

  logger.debug(`demuxProbe result: ${probed.type} (passthrough unavailable, will transcode if needed)`);
  return { passthrough: false, stream: probed.stream };
}

export function killAudioProcesses(processes: ChildProcess[]): void {
  for (const process of processes) {
    if (!process.killed) {
      process.kill();
    }
  }
}

/**
 * Downloads audio via yt-dlp and prepares a stream for @discordjs/voice.
 * Prefers native WebM/Ogg Opus passthrough; falls back to FFmpeg libopus transcode.
 */
export async function prepareAudioStream(
  url: string,
  options: PrepareAudioStreamOptions = {},
): Promise<PreparedAudioStream> {
  const ytdlp = spawnYtDlpStream(url);
  const processes: ChildProcess[] = [ytdlp.process];

  if (options.forceTranscode) {
    const ffmpeg = spawnFfmpegTranscode(ytdlp.stream);
    processes.push(ffmpeg.process);
    return buildTranscodeResult(processes, ffmpeg.stream, 'forced fallback');
  }

  try {
    const probed = await probeAudioStream(ytdlp.stream);

    if (probed.passthrough) {
      return buildPassthroughResult(processes, probed.stream, probed.type);
    }

    const ffmpeg = spawnFfmpegTranscode(probed.stream);
    processes.push(ffmpeg.process);
    return buildTranscodeResult(processes, ffmpeg.stream, 'non-Opus or non-Discord-compatible Opus');
  } catch (error) {
    killAudioProcesses(processes);
    throw error;
  }
}

export async function fetchSingleTrack(
  url: string,
  requestedBy: string,
): Promise<FetchResult> {
  const args = ['--dump-json', '--no-warnings', '--no-playlist', ...YTDLP_NETWORK_ARGS, url];
  const lines = await runYtDlp(args);
  const tracks: Track[] = [];
  const skippedReasons: string[] = [];

  for (const line of lines) {
    let entry: YtDlpEntry;
    try {
      entry = JSON.parse(line) as YtDlpEntry;
    } catch {
      skippedReasons.push('JSONの解析に失敗したエントリをスキップしました');
      continue;
    }

    const skipReason = getSkipReason(entry);
    if (skipReason) {
      skippedReasons.push(skipReason);
      continue;
    }

    const track = entryToTrack(entry, requestedBy);
    if (!track) {
      skippedReasons.push(`追加できない動画をスキップしました: ${entry.title ?? '不明'}`);
      continue;
    }

    tracks.push(track);
  }

  return {
    tracks,
    skipped: skippedReasons.length,
    skippedReasons,
  };
}

export async function fetchTracks(
  url: string,
  requestedBy: string,
  maxTracks: number = MAX_PLAYLIST_TRACKS,
): Promise<FetchResult> {
  if (!isPlaylistUrl(url)) {
    return fetchSingleTrack(url, requestedBy);
  }

  const { fetchPlaylistTracksLightweight } = await import('./playlistImport.js');
  return fetchPlaylistTracksLightweight(url, requestedBy, maxTracks);
}
