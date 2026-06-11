import { PassThrough, type Readable } from 'node:stream';
import type { PlaybackStatusHandler } from './PlaybackStatus.js';
import { UnplayableTrackError } from './playbackErrors.js';
import type { StreamSourceKind } from './playbackErrors.js';
import { logger } from '../utils/logger.js';

/** Minimum bytes to treat buffer/prefetch validation as successful. */
export const MIN_VALID_BUFFER_BYTES = 64 * 1024;

/** Initial playback buffer (~2MB). */
export const BUFFER_TARGET_INITIAL = 2 * 1024 * 1024;

/** Prefetch validation probe target (discarded after validation). */
export const BUFFER_TARGET_PREFETCH_VALIDATE = MIN_VALID_BUFFER_BYTES;

/** Buffer when opening a fresh live stream (skip / validated next track). */
export const BUFFER_TARGET_SKIP = 512 * 1024;

export const BUFFER_MAX_WAIT_INITIAL_MS = 20_000;
export const BUFFER_MAX_WAIT_SKIP_MS = 20_000;
export const PREFETCH_VALIDATE_MAX_WAIT_MS = 30_000;
export const PREFETCH_TTL_MS = 12 * 60 * 1000;

export interface BufferCollectResult {
  stream: Readable;
  totalBytes: number;
  countdownShown: boolean;
  streamSource: StreamSourceKind;
  liveSourceAlive: boolean;
}

export interface BufferCollectOptions {
  targetBytes: number;
  maxWaitMs: number;
  logLabel: string;
  onCountdown?: (seconds: number) => Promise<void>;
}

function validateByteCount(totalBytes: number, sourceEnded: boolean, logLabel: string): void {
  if (totalBytes === 0) {
    logger.info('0 bytes rejected');
    throw new UnplayableTrackError(`${logLabel}: 0 bytes rejected`);
  }

  if (totalBytes < MIN_VALID_BUFFER_BYTES && !sourceEnded) {
    logger.info(`0 bytes rejected: insufficient data (${String(totalBytes)} bytes)`);
    throw new UnplayableTrackError(`${logLabel}: insufficient audio data (${String(totalBytes)} bytes)`);
  }
}

/**
 * Prefetch-only probe: reads bytes then destroys the source. Never used for playback.
 */
export function probeStreamBytes(
  source: Readable,
  options: Pick<BufferCollectOptions, 'targetBytes' | 'maxWaitMs' | 'logLabel'>,
): Promise<number> {
  const { targetBytes, maxWaitMs, logLabel } = options;
  logger.info(`${logLabel}: probe start (target=${String(targetBytes)} bytes)`);

  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    let sourceEnded = false;
    const startedAt = Date.now();
    let finished = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const cleanup = (): void => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      source.removeListener('data', onData);
      source.removeListener('end', onEnd);
      source.removeListener('error', onError);
    };

    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      source.destroy();

      try {
        validateByteCount(totalBytes, sourceEnded, logLabel);
        logger.info(`${logLabel}: probe complete (${String(totalBytes)} bytes)`);
        resolve(totalBytes);
      } catch (error) {
        reject(error);
      }
    };

    const fail = (error: Error): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      source.destroy();
      reject(error);
    };

    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.length;
      if (totalBytes >= targetBytes) {
        finish();
      }
    };

    const onEnd = (): void => {
      sourceEnded = true;
      finish();
    };

    const onError = (error: Error): void => {
      fail(error);
    };

    source.on('data', onData);
    source.on('end', onEnd);
    source.on('error', onError);
    source.resume();

    pollInterval = setInterval(() => {
      if (Date.now() - startedAt >= maxWaitMs) {
        if (totalBytes === 0) {
          fail(new UnplayableTrackError(`${logLabel}: timed out with 0 bytes`));
        } else {
          finish();
        }
      }
    }, 250);
  });
}

/**
 * Builds one continuous fresh-live stream: [prefix buffer] + [same yt-dlp stdout still running].
 */
function attachPrefixToLiveSource(
  source: Readable,
  buffered: Buffer[],
  sourceEndedDuringBuffer: boolean,
): Readable {
  if (source.destroyed) {
    throw new UnplayableTrackError('live source destroyed before playback attach');
  }

  const output = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });

  for (const chunk of buffered) {
    output.write(chunk);
  }

  if (sourceEndedDuringBuffer || source.readableEnded) {
    if (buffered.length === 0) {
      throw new UnplayableTrackError('live source ended with no buffered data');
    }
    output.end();
    return output;
  }

  let outputEnded = false;
  const endOutput = (): void => {
    if (outputEnded) {
      return;
    }
    outputEnded = true;
    output.end();
  };

  const forward = (chunk: Buffer): void => {
    if (outputEnded) {
      return;
    }
    if (!output.write(chunk)) {
      source.pause();
      output.once('drain', () => source.resume());
    }
  };

  source.on('data', forward);
  source.once('end', endOutput);
  source.once('error', (error) => {
    if (!outputEnded) {
      output.destroy(error);
    }
  });

  let pending: Buffer | string | null;
  while ((pending = source.read()) !== null) {
    forward(Buffer.isBuffer(pending) ? pending : Buffer.from(pending));
  }

  if (source.readableEnded) {
    endOutput();
  } else {
    source.resume();
  }

  return output;
}

function isPlaybackBufferLabel(logLabel: string): boolean {
  return logLabel.includes('Playback buffer') || logLabel.includes('Initial buffer');
}

/**
 * Buffers prefix bytes on a live yt-dlp stream, then returns prefix+live continuation for AudioPlayer.
 * Never returns a finite buffer-only stream.
 */
export function collectStreamBuffer(
  source: Readable,
  options: BufferCollectOptions,
): Promise<BufferCollectResult> {
  const { targetBytes, maxWaitMs, logLabel, onCountdown } = options;
  const isPlayback = isPlaybackBufferLabel(logLabel);

  if (isPlayback) {
    logger.info(`Playback buffer start (target=${String(targetBytes)} bytes, maxWait=${String(maxWaitMs)}ms)`);
  } else {
    logger.info(`${logLabel}: buffer start (target=${String(targetBytes)} bytes, maxWait=${String(maxWaitMs)}ms)`);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let sourceEndedDuringBuffer = false;
    const startedAt = Date.now();
    let finished = false;
    let countdownStarted = false;
    let countdownShown = false;
    let countdownInterval: ReturnType<typeof setInterval> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const cleanup = (): void => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      source.removeListener('data', onData);
      source.removeListener('end', onEnd);
      source.removeListener('error', onError);
    };

    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();

      try {
        validateByteCount(totalBytes, sourceEndedDuringBuffer, logLabel);
      } catch (error) {
        source.destroy();
        reject(error);
        return;
      }

      if (source.destroyed) {
        reject(new UnplayableTrackError(`${logLabel}: source destroyed during buffer`));
        return;
      }

      source.pause();

      const liveSourceAlive = !sourceEndedDuringBuffer && !source.readableEnded;
      const streamSource: StreamSourceKind = 'fresh-live-stream';

      if (isPlayback) {
        logger.info(`Playback buffer complete (${String(totalBytes)} bytes, live=${String(liveSourceAlive)})`);
      } else {
        logger.info(`${logLabel}: buffer complete (${String(totalBytes)} bytes)`);
      }
      logger.info(`stream source: ${streamSource}`);

      if (!liveSourceAlive && totalBytes < MIN_VALID_BUFFER_BYTES) {
        source.destroy();
        reject(new UnplayableTrackError(`${logLabel}: source ended before sufficient buffer`));
        return;
      }

      resolve({
        stream: attachPrefixToLiveSource(source, chunks, sourceEndedDuringBuffer),
        totalBytes,
        countdownShown,
        streamSource,
        liveSourceAlive,
      });
    };

    const fail = (error: Error): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      source.destroy();
      reject(error);
    };

    const maybeStartCountdown = (): void => {
      if (countdownStarted || !onCountdown) {
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= 3000 && totalBytes < targetBytes) {
        countdownStarted = true;
        countdownShown = true;
        logger.info('Countdown start');
        let seconds = 3;
        void onCountdown(seconds).catch(() => {});
        countdownInterval = setInterval(() => {
          seconds -= 1;
          if (seconds >= 1) {
            void onCountdown(seconds).catch(() => {});
          } else if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
        }, 1000);
      }
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes >= targetBytes) {
        finish();
      }
    };

    const onEnd = (): void => {
      sourceEndedDuringBuffer = true;
      finish();
    };

    const onError = (error: Error): void => {
      fail(error);
    };

    source.on('data', onData);
    source.on('end', onEnd);
    source.on('error', onError);
    source.resume();

    pollInterval = setInterval(() => {
      maybeStartCountdown();
      if (Date.now() - startedAt >= maxWaitMs) {
        if (totalBytes === 0) {
          fail(new UnplayableTrackError(`${logLabel}: timed out with 0 bytes`));
        } else {
          finish();
        }
      }
    }, 250);
  });
}

export async function runCountdownStatus(
  handler: PlaybackStatusHandler | null | undefined,
  trackTitle: string,
  seconds: number,
): Promise<void> {
  if (!handler) {
    return;
  }
  try {
    await handler.update(`🎧 読み込み中... 再生まで ${String(seconds)}`);
  } catch {
    // Ignore stale channel / webhook errors.
  }
}

export async function showPlaybackStarted(
  handler: PlaybackStatusHandler | null | undefined,
  trackTitle: string,
): Promise<void> {
  if (!handler) {
    return;
  }
  try {
    await handler.update(`▶ 再生開始：${trackTitle}`);
  } catch {
    // Ignore notification failures.
  }
}
