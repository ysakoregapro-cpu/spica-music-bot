import type { ChildProcess } from 'node:child_process';
import type { ChatInputCommandInteraction } from 'discord.js';
import {
  AudioPlayer,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import {
  BUFFER_MAX_WAIT_INITIAL_MS,
  BUFFER_MAX_WAIT_SKIP_MS,
  BUFFER_TARGET_INITIAL,
  BUFFER_TARGET_SKIP,
  runCountdownStatus,
  showPlaybackStarted,
} from './audioBuffer.js';
import { createChannelPlaybackStatus, type PlaybackStatusHandler } from './PlaybackStatus.js';
import {
  PrefetchManager,
  prepareBufferedStreamWithFallback,
  type BufferedPreparedStream,
} from './PrefetchManager.js';
import {
  isUnplayableTrackError,
  UnplayableTrackError,
  type AdvanceReason,
} from './playbackErrors.js';
import { noopLifecycleHooks, type PlayerLifecycleHooks } from './PlayerLifecycle.js';
import { TrackQueue } from './TrackQueue.js';
import { isStreamTimeoutError, killAudioProcesses } from './youtube.js';
import type { RepeatMode, Track } from './types.js';
import { logger } from '../utils/logger.js';

export interface PlayOptions {
  forceTranscode?: boolean;
  initialBuffer?: boolean;
  showCountdown?: boolean;
}

export class GuildPlayer {
  readonly queue = new TrackQueue();
  private connection: VoiceConnection | null = null;
  private readonly player: AudioPlayer;
  private readonly prefetchManager = new PrefetchManager();
  private readonly lifecycle: PlayerLifecycleHooks;
  private currentStreamProcesses: ChildProcess[] = [];
  private currentPassthrough = false;
  private currentStreamSource = 'fresh-live-stream';
  private currentRoute = 'webm-opus-passthrough';
  private currentBytesBuffered = 0;
  private passthroughRetryUsed = false;
  private prematureCloseRetried = false;
  private playbackStatus: PlaybackStatusHandler | null = null;
  private voiceChannelId: string | null = null;
  private idleAdvanceBlocked = false;
  private blockNaturalEnd = false;
  private playbackStoppedByUser = false;
  private handlingNaturalEnd = false;
  private skipRequested = false;

  constructor(
    private readonly guildId: string,
    lifecycle: PlayerLifecycleHooks = noopLifecycleHooks,
  ) {
    this.lifecycle = lifecycle;
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    this.player.on('stateChange', (_oldState, newState) => {
      if (newState.status !== AudioPlayerStatus.Idle) {
        return;
      }
      void this.onPlayerIdle();
    });

    this.player.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Audio player error in guild ${this.guildId}`, error);
      logger.info(
        `Premature close context: route=${this.currentRoute}, prefix=${String(this.currentBytesBuffered)}, streamSource=${this.currentStreamSource}`,
      );

      if (this.playbackStoppedByUser) {
        logger.info('Ignored player error: playback stopped by user');
        return;
      }

      if (this.idleAdvanceBlocked && !message.includes('Premature close')) {
        logger.info('Ignored player error: stop or advance transition in progress');
        return;
      }

      if (message.includes('Premature close')) {
        this.blockNaturalEnd = true;
        this.idleAdvanceBlocked = true;
        logger.info('Premature close detected');
        void this.handlePrematureClose();
        return;
      }

      this.idleAdvanceBlocked = true;
      this.killCurrentStreamOnly();

      const current = this.queue.current;
      if (current && this.currentPassthrough && !this.passthroughRetryUsed) {
        this.passthroughRetryUsed = true;
        logger.warn(`Passthrough playback failed, retrying with FFmpeg: ${current.title}`);
        void this.play(current, { forceTranscode: true }, 'failed-track').catch(() => {
          void this.advanceToNextTrack('failed-track');
        });
        return;
      }

      void this.advanceToNextTrack('failed-track');
    });
  }

  get isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing
      || this.player.state.status === AudioPlayerStatus.Buffering;
  }

  get isConnected(): boolean {
    return this.connection !== null;
  }

  attachInteractionStatus(interaction: ChatInputCommandInteraction): void {
    const channel = interaction.channel;
    if (channel?.isTextBased()) {
      this.playbackStatus = createChannelPlaybackStatus(channel);
    }
  }

  setPlaybackStatus(handler: PlaybackStatusHandler | null): void {
    this.playbackStatus = handler;
  }

  invalidatePrefetch(reason: string): void {
    this.prefetchManager.invalidate(reason);
  }

  notifyQueueChanged(reason: string): void {
    const next = this.queue.peekNext();
    const prefetchUrl = this.prefetchManager.getTargetUrl();
    if (prefetchUrl && prefetchUrl !== next?.url) {
      this.prefetchManager.invalidate(reason);
    }
    this.schedulePrefetch();
  }

  refreshPrefetch(): void {
    this.schedulePrefetch();
  }

  async connect(channel: VoiceBasedChannel): Promise<void> {
    if (this.connection && this.voiceChannelId === channel.id) {
      return;
    }

    this.disconnect();

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    this.voiceChannelId = channel.id;
    this.connection.subscribe(this.player);
    this.lifecycle.onVoiceJoin?.(this.guildId, channel.id);

    this.connection.on('stateChange', (_oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        if (
          newState.reason === VoiceConnectionDisconnectReason.WebSocketClose
          && newState.closeCode === 4014
        ) {
          this.destroy();
        }
      }
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  async play(
    track: Track,
    options: PlayOptions = {},
    advanceReason?: AdvanceReason,
  ): Promise<void> {
    const forceTranscode = options.forceTranscode ?? false;

    logger.info(`Playback opening fresh live stream: ${track.title}`);

    this.idleAdvanceBlocked = true;
    this.killCurrentStreamOnly();
    this.queue.setCurrent(track);
    this.prematureCloseRetried = false;

    if (!forceTranscode) {
      this.passthroughRetryUsed = false;
    }

    if (advanceReason === 'skip' || advanceReason === 'skipto' || advanceReason === 'natural-end') {
      logger.info(`Advance reason: ${advanceReason}`);
    }

    try {
      const prefetchValidated = this.prefetchManager.consumeValidation(track);
      if (prefetchValidated) {
        logger.info(`Prefetch validated — opening fresh live stream: ${track.title}`);
      }

      const useInitialBuffer = options.initialBuffer ?? false;
      const bufferTarget = useInitialBuffer ? BUFFER_TARGET_INITIAL : BUFFER_TARGET_SKIP;
      const maxWait = useInitialBuffer ? BUFFER_MAX_WAIT_INITIAL_MS : BUFFER_MAX_WAIT_SKIP_MS;
      const showCountdown = options.showCountdown ?? false;

      if (!prefetchValidated && !useInitialBuffer && showCountdown) {
        logger.info(`Prefetch not ready, waiting with normal buffer: ${track.title}`);
      }

      const prepared = await this.loadBufferedStream(track, {
        targetBytes: bufferTarget,
        maxWaitMs: maxWait,
        logLabel: useInitialBuffer ? 'Initial buffer' : 'Playback buffer',
        forceTranscode,
        showCountdown,
      });

      await this.startPreparedStream(track, prepared);
      this.lifecycle.onTrackStart?.(this.guildId, track.url);
      this.schedulePrefetch();
    } catch (error) {
      if (isUnplayableTrackError(error)) {
        await this.handleUnplayableTrack(track, (error as UnplayableTrackError).message);
        return;
      }

      if (!forceTranscode) {
        const detail = error instanceof Error ? error.message : String(error);
        if (isStreamTimeoutError(detail)) {
          logger.warn(`Playback stream acquisition failed (timeout): ${track.title}`);
          throw error;
        }
        logger.warn(`Playback failed on passthrough route, retrying with FFmpeg: ${track.title} (${detail})`);
        this.killCurrentStreamOnly();
        this.passthroughRetryUsed = true;
        await this.play(track, { ...options, forceTranscode: true }, advanceReason);
        return;
      }
      throw error;
    } finally {
      this.skipRequested = false;
      if (!this.playbackStoppedByUser && !this.blockNaturalEnd) {
        this.idleAdvanceBlocked = false;
      }
    }
  }

  async start(track: Track, options: PlayOptions = {}): Promise<void> {
    await this.play(track, {
      initialBuffer: true,
      showCountdown: true,
      ...options,
    });
  }

  async skip(): Promise<Track | null> {
    logger.info('skip requested');
    this.skipRequested = true;
    this.idleAdvanceBlocked = true;
    this.killCurrentStreamOnly();
    this.player.stop(true);
    return this.advanceToNextTrack('skip');
  }

  async skipTo(index: number): Promise<Track | null> {
    if (!this.queue.skipTo(index)) {
      return null;
    }

    this.notifyQueueChanged('skipto');
    logger.info('skip requested');
    this.skipRequested = true;
    this.idleAdvanceBlocked = true;
    this.killCurrentStreamOnly();
    this.player.stop(true);
    return this.advanceToNextTrack('skipto');
  }

  shuffle(): boolean {
    const shuffled = this.queue.shuffle();
    if (shuffled) {
      this.notifyQueueChanged('shuffle');
    }
    return shuffled;
  }

  setRepeatMode(mode: RepeatMode): RepeatMode {
    const previous = this.queue.repeatMode;
    const updated = this.queue.setRepeatMode(mode);
    if (previous !== mode && (mode === 'list' || previous === 'list')) {
      this.notifyQueueChanged('repeat mode changed');
    }
    return updated;
  }

  async stop(): Promise<void> {
    this.playbackStoppedByUser = true;
    this.idleAdvanceBlocked = true;
    this.blockNaturalEnd = false;
    this.killCurrentStreamOnly();
    this.prefetchManager.killAll();
    this.player.stop(true);
    this.queue.clear();
    this.playbackStatus?.clear?.();
    this.playbackStatus = null;
    this.lifecycle.onSessionEnd?.(this.guildId);
    this.lifecycle.onVoiceLeave?.(this.guildId);
    this.destroy();
  }

  disconnect(): void {
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    this.voiceChannelId = null;
  }

  destroy(): void {
    this.killCurrentStreamOnly();
    this.prefetchManager.killAll();
    this.disconnect();
  }

  private async onPlayerIdle(): Promise<void> {
    if (this.playbackStoppedByUser) {
      logger.info('Ignored idle: playback stopped by user');
      return;
    }

    if (this.blockNaturalEnd) {
      logger.info('Ignored idle: Premature close detected');
      return;
    }

    if (this.idleAdvanceBlocked) {
      logger.info('Ignored idle: double-advance prevention');
      return;
    }

    if (this.skipRequested) {
      logger.info('Ignored idle: skip already handling advance');
      return;
    }

    if (!this.queue.current) {
      logger.info('Ignored idle: no current track');
      return;
    }

    if (this.handlingNaturalEnd) {
      logger.info('Ignored idle: natural end already handling');
      return;
    }

    logger.info('Natural end confirmed');
    this.handlingNaturalEnd = true;
    try {
      await this.handleNaturalTrackEnd();
    } finally {
      this.handlingNaturalEnd = false;
    }
  }

  private async handleNaturalTrackEnd(): Promise<void> {
    if (this.queue.repeatMode === 'one' && this.queue.current) {
      try {
        await this.play(this.queue.current, { showCountdown: false }, 'repeat-one');
      } catch (error) {
        if (isUnplayableTrackError(error)) {
          await this.handleUnplayableTrack(this.queue.current, (error as UnplayableTrackError).message);
          return;
        }
        logger.error('Failed to repeat current track', error);
        await this.advanceToNextTrack('failed-track');
      }
      return;
    }

    logger.info('Advance reason: natural-end');
    await this.advanceToNextTrack('natural-end');
  }

  private async handlePrematureClose(): Promise<void> {
    const current = this.queue.current;
    if (!current) {
      this.blockNaturalEnd = false;
      this.idleAdvanceBlocked = false;
      return;
    }

    this.killCurrentStreamOnly();

    if (!this.prematureCloseRetried) {
      this.prematureCloseRetried = true;
      logger.info(`Premature close retry with fresh live stream: ${current.title}`);
      try {
        await this.play(current, { showCountdown: false }, 'failed-track');
        this.blockNaturalEnd = false;
        this.idleAdvanceBlocked = false;
        return;
      } catch (error) {
        if (isUnplayableTrackError(error)) {
          this.blockNaturalEnd = false;
          this.idleAdvanceBlocked = false;
          await this.handleUnplayableTrack(current, (error as UnplayableTrackError).message);
          return;
        }
      }
    }

    logger.info(`Premature close retry failed, skipping track: ${current.title}`);
    this.blockNaturalEnd = false;
    await this.advanceToNextTrack('failed-track');
  }

  private async handleUnplayableTrack(track: Track, reason: string): Promise<void> {
    logger.info(`premium-only skipped: ${track.title} (${reason})`);
    await this.notifySkippedTrack(track.title);
    this.queue.setCurrent(null);
    await this.advanceToNextTrack('unplayable');
  }

  private async notifySkippedTrack(title: string): Promise<void> {
    if (!this.playbackStatus) {
      return;
    }
    try {
      await this.playbackStatus.update(`⚠ 再生できない曲をスキップしました: **${title}**`);
    } catch {
      // Ignore notification failures.
    }
  }

  private async advanceToNextTrack(reason: AdvanceReason): Promise<Track | null> {
    logger.info(`Advance reason: ${reason}`);
    this.idleAdvanceBlocked = true;
    this.blockNaturalEnd = false;

    const next = this.queue.takeNextTrack();
    if (!next) {
      this.killCurrentStreamOnly();
      this.prefetchManager.killAll();
      this.idleAdvanceBlocked = false;
      this.lifecycle.onSessionEnd?.(this.guildId);
      return null;
    }

    const prefetchValidated = this.prefetchManager.isValidatedFor(next);

    try {
      await this.play(next, {
        initialBuffer: false,
        showCountdown: !prefetchValidated,
      }, reason);
      return next;
    } catch (error) {
      if (isUnplayableTrackError(error)) {
        await this.handleUnplayableTrack(next, (error as UnplayableTrackError).message);
        return this.advanceToNextTrack('unplayable');
      }
      logger.error(`Failed to play track ${next.url}`, error);
      const detail = error instanceof Error ? error.message : String(error);
      if (isStreamTimeoutError(detail)) {
        logger.warn(`Advance reason: failed-track (yt-dlp timeout): ${next.title}`);
      }
      return this.advanceToNextTrack('failed-track');
    }
  }

  private async loadBufferedStream(
    track: Track,
    options: {
      targetBytes: number;
      maxWaitMs: number;
      logLabel: string;
      forceTranscode: boolean;
      showCountdown: boolean;
    },
  ): Promise<BufferedPreparedStream> {
    const prepared = await prepareBufferedStreamWithFallback(track, {
      targetBytes: options.targetBytes,
      maxWaitMs: options.maxWaitMs,
      logLabel: options.logLabel,
      forceTranscode: options.forceTranscode,
      showCountdown: options.showCountdown,
      onCountdown: options.showCountdown
        ? (seconds) => runCountdownStatus(this.playbackStatus, track.title, seconds)
        : undefined,
    });

    if (prepared.countdownShown) {
      await showPlaybackStarted(this.playbackStatus, track.title);
    }

    return prepared;
  }

  private async startPreparedStream(track: Track, prepared: BufferedPreparedStream): Promise<void> {
    if (prepared.streamSource !== 'fresh-live-stream') {
      logger.info('unsafe prefetched-buffer playback disabled');
      throw new UnplayableTrackError(`Unsafe stream source rejected: ${prepared.streamSource}`);
    }

    if (!prepared.liveSourceAlive) {
      logger.warn(`Live source ended during buffer for ${track.title} — short track or stream issue`);
    }

    this.currentStreamProcesses = prepared.processes;
    this.currentPassthrough = prepared.passthrough;
    this.currentStreamSource = prepared.streamSource;
    this.currentRoute = prepared.route;
    this.currentBytesBuffered = prepared.bytesBuffered;

    logger.info(`Playback live stream started: "${track.title}" [${prepared.route}]`);
    logger.info(`stream source: ${prepared.streamSource}`);

    for (const process of prepared.processes) {
      process.on('close', (code) => {
        if (code !== 0 && code !== null) {
          logger.warn(`Audio process closed with code ${String(code)} for ${track.url}`);
        }
      });
    }

    const resource = createAudioResource(prepared.stream, {
      inputType: prepared.inputType,
      inlineVolume: false,
    });

    this.player.play(resource);

    try {
      await entersState(this.player, AudioPlayerStatus.Playing, 20_000);
    } catch {
      await entersState(this.player, AudioPlayerStatus.Buffering, 20_000);
    }
  }

  private schedulePrefetch(): void {
    if (this.playbackStoppedByUser) {
      return;
    }

    const next = this.queue.peekNext();
    if (!next) {
      return;
    }

    if (this.prefetchManager.isValidatedFor(next) || this.prefetchManager.isLoadingFor(next)) {
      return;
    }

    this.prefetchManager.startPrefetch(next);
  }

  private killCurrentStreamOnly(): void {
    killAudioProcesses(this.currentStreamProcesses);
    this.currentStreamProcesses = [];
    this.currentPassthrough = false;
  }
}
