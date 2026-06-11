import type { ChildProcess } from 'node:child_process';
import type { Track } from './types.js';
import {
  BUFFER_TARGET_PREFETCH_VALIDATE,
  PREFETCH_TTL_MS,
  PREFETCH_VALIDATE_MAX_WAIT_MS,
  collectStreamBuffer,
  probeStreamBytes,
} from './audioBuffer.js';
import { isPremiumOnlyMessage, isUnplayableTrackError } from './playbackErrors.js';
import type { StreamSourceKind } from './playbackErrors.js';
import {
  killAudioProcesses,
  isStreamTimeoutError,
  prepareAudioStream,
  type AudioStreamRoute,
  type PassthroughStreamType,
  type PreparedAudioStream,
} from './youtube.js';
import { isYtDlpYouTubeAccessFailure } from './ytdlp.js';
import { logger } from '../utils/logger.js';

export interface BufferedPreparedStream extends PreparedAudioStream {
  bytesBuffered: number;
  countdownShown: boolean;
  streamSource: StreamSourceKind;
  liveSourceAlive: boolean;
}

export interface PrepareBufferedOptions {
  targetBytes: number;
  maxWaitMs: number;
  logLabel: string;
  forceTranscode?: boolean;
  showCountdown?: boolean;
  onCountdown?: (seconds: number) => Promise<void>;
}

async function prepareBufferedStreamInternal(
  track: Track,
  options: PrepareBufferedOptions,
): Promise<BufferedPreparedStream> {
  const prepared = await prepareAudioStream(track.url, {
    forceTranscode: options.forceTranscode ?? false,
  });

  const buffered = await collectStreamBuffer(prepared.stream, {
    targetBytes: options.targetBytes,
    maxWaitMs: options.maxWaitMs,
    logLabel: options.logLabel,
    onCountdown: options.showCountdown ? options.onCountdown : undefined,
  });

  return {
    ...prepared,
    stream: buffered.stream,
    bytesBuffered: buffered.totalBytes,
    countdownShown: buffered.countdownShown,
    streamSource: buffered.streamSource,
    liveSourceAlive: buffered.liveSourceAlive,
  };
}

function isTimeoutFailure(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return isStreamTimeoutError(detail);
}

function isNonRetryableYtDlpFailure(error: unknown): boolean {
  return isTimeoutFailure(error) || isYtDlpYouTubeAccessFailure(error);
}

export async function prepareBufferedStreamWithFallback(
  track: Track,
  options: PrepareBufferedOptions,
): Promise<BufferedPreparedStream> {
  try {
    return await prepareBufferedStreamInternal(track, options);
  } catch (firstError) {
    if (isUnplayableTrackError(firstError)) {
      throw firstError;
    }

    const firstDetail = firstError instanceof Error ? firstError.message : String(firstError);
    if (isPremiumOnlyMessage(firstDetail)) {
      logger.info(`premium-only skipped: ${track.title}`);
      throw firstError;
    }

    if (isNonRetryableYtDlpFailure(firstError)) {
      logger.warn(`yt-dlp stream acquisition failed, skipping fallback: ${track.title}`);
      throw firstError;
    }

    logger.info(`Fallback reason: passthrough buffer failed (${firstDetail})`);

    try {
      return await prepareBufferedStreamInternal(track, {
        ...options,
        forceTranscode: false,
        logLabel: `${options.logLabel} (retry)`,
      });
    } catch (secondError) {
      if (isUnplayableTrackError(secondError)) {
        throw secondError;
      }

      const secondDetail = secondError instanceof Error ? secondError.message : String(secondError);
      if (isPremiumOnlyMessage(secondDetail)) {
        logger.info(`premium-only skipped: ${track.title}`);
        throw secondError;
      }

      if (isNonRetryableYtDlpFailure(secondError)) {
        logger.warn(`yt-dlp stream acquisition failed, skipping transcode fallback: ${track.title}`);
        throw secondError;
      }

      logger.info(`Fallback reason: retry failed, using ffmpeg-transcode (${secondDetail})`);
      return prepareBufferedStreamInternal(track, {
        ...options,
        forceTranscode: true,
        logLabel: `${options.logLabel} (transcode)`,
      });
    }
  }
}

interface ValidatedPrefetch {
  track: Track;
  route: AudioStreamRoute;
  expiryTimer: ReturnType<typeof setTimeout>;
}

/**
 * Prefetch validates playability only — never stores playback streams or audio buffers.
 * Playback always opens a fresh yt-dlp stream with prefix buffer + live continuation.
 */
export class PrefetchManager {
  private slot: ValidatedPrefetch | null = null;
  private loadingUrl: string | null = null;

  getTargetUrl(): string | null {
    return this.slot?.track.url ?? this.loadingUrl;
  }

  invalidate(reason: string): void {
    if (!this.slot && !this.loadingUrl) {
      return;
    }

    const title = this.slot?.track.title ?? this.loadingUrl ?? 'unknown';
    if (this.slot) {
      clearTimeout(this.slot.expiryTimer);
      this.slot = null;
    }
    this.loadingUrl = null;
    logger.info(`Prefetch discarded: ${reason} (${title})`);
  }

  startPrefetch(track: Track): void {
    if (this.slot?.track.url === track.url || this.loadingUrl === track.url) {
      return;
    }

    this.invalidate('replaced by new prefetch');
    logger.info(`Next track prefetch start: ${track.title}`);
    this.loadingUrl = track.url;
    void this.runValidation(track);
  }

  /** Returns true when a prior validation exists for this track (no audio data is transferred). */
  consumeValidation(track: Track): boolean {
    if (!this.slot || this.slot.track.url !== track.url) {
      return false;
    }

    clearTimeout(this.slot.expiryTimer);
    this.slot = null;
    logger.info(`Prefetch validation hit: ${track.title}`);
    return true;
  }

  isValidatedFor(track: Track): boolean {
    return this.slot?.track.url === track.url;
  }

  isLoadingFor(track: Track): boolean {
    return this.loadingUrl === track.url;
  }

  killAll(): void {
    this.invalidate('player stopped');
  }

  private async runValidation(track: Track): Promise<void> {
    let processes: ChildProcess[] = [];

    try {
      const prepared = await prepareAudioStream(track.url);
      processes = prepared.processes;

      await probeStreamBytes(prepared.stream, {
        targetBytes: BUFFER_TARGET_PREFETCH_VALIDATE,
        maxWaitMs: PREFETCH_VALIDATE_MAX_WAIT_MS,
        logLabel: 'Prefetch validation',
      });

      killAudioProcesses(processes);
      processes = [];

      if (this.loadingUrl !== track.url) {
        return;
      }

      this.loadingUrl = null;
      this.slot = {
        track,
        route: prepared.route,
        expiryTimer: setTimeout(() => {
          if (this.slot?.track.url === track.url) {
            this.invalidate('expired');
          }
        }, PREFETCH_TTL_MS),
      };

      logger.info(`Prefetch validation success: ${track.title} [${prepared.route}]`);
    } catch (error) {
      killAudioProcesses(processes);

      const detail = error instanceof Error ? error.message : String(error);
      if (isUnplayableTrackError(error)) {
        logger.info(`Prefetch validation failed: ${track.title} (${detail})`);
      } else if (isStreamTimeoutError(detail)) {
        logger.warn(`Prefetch validation timed out: ${track.title}`);
      } else if (isYtDlpYouTubeAccessFailure(error)) {
        logger.warn(`Prefetch validation failed (YouTube access): ${track.title}`);
      } else if (isPremiumOnlyMessage(detail)) {
        logger.info(`premium-only skipped (prefetch): ${track.title}`);
      } else {
        logger.info(`Prefetch validation failed: ${track.title} (${detail})`);
      }

      if (this.loadingUrl === track.url) {
        this.loadingUrl = null;
      }
    }
  }
}

export type { PassthroughStreamType, AudioStreamRoute };
