import {
  LIST_PAGE_SIZE,
  MAX_LIST_PAGES,
  MAX_QUEUE_SIZE,
  type QueueAddResult,
  type QueueListError,
  type QueueListView,
  type RepeatMode,
  type Track,
} from './types.js';
import { logger } from '../utils/logger.js';

export class TrackQueue {
  private upcoming: Track[] = [];
  /** All tracks in the current playback session (repeat pool). */
  private repeatPool: Track[] = [];
  private _current: Track | null = null;
  private _repeatMode: RepeatMode = 'off';
  /** Tracks completed in the current shuffle-repeat cycle. */
  private playedCountInCycle = 0;

  get current(): Track | null {
    return this._current;
  }

  get repeatMode(): RepeatMode {
    return this._repeatMode;
  }

  get upcomingCount(): number {
    return this.upcoming.length;
  }

  peekNext(): Track | null {
    if (this.upcoming.length > 0) {
      return this.upcoming[0]!;
    }

    if (this._repeatMode === 'list' && this.repeatPool.length > 0) {
      return this.repeatPool[0] ?? null;
    }

    // Shuffle repeat order is decided only when the cycle completes.
    return null;
  }

  setRepeatMode(mode: RepeatMode): RepeatMode {
    const previous = this._repeatMode;
    this._repeatMode = mode;
    if (previous !== mode && (previous === 'shuffle' || mode === 'shuffle')) {
      this.playedCountInCycle = 0;
    }
    return this._repeatMode;
  }

  clear(): void {
    this.upcoming = [];
    this.repeatPool = [];
    this._current = null;
    this._repeatMode = 'off';
    this.playedCountInCycle = 0;
  }

  private registerRepeatPoolTracks(tracks: Track[]): void {
    for (const track of tracks) {
      this.repeatPool.push(track);
    }
  }

  private shuffleArrayInPlace(tracks: Track[]): void {
    for (let i = tracks.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!];
    }
  }

  private refillUpcomingFromSession(shuffle: boolean): void {
    const pool = this.buildFullSessionPool();
    if (pool.length === 0) {
      return;
    }

    if (shuffle) {
      logger.info(
        `Shuffle repeat: rebuilding next cycle from full queue pool count=${String(pool.length)}`,
      );
      this.shuffleArrayInPlace(pool);
      logger.info(`Shuffle repeat: next cycle shuffled count=${String(pool.length)}`);
    }

    this.upcoming = pool;
  }

  /** Full session repeat pool — queue order and duplicate entries preserved. */
  private buildFullSessionPool(): Track[] {
    return [...this.repeatPool];
  }

  private trimToQueueLimit(tracks: Track[]): { accepted: Track[]; dropped: number } {
    const available = MAX_QUEUE_SIZE - this.totalQueuedCount();
    if (available <= 0) {
      return { accepted: [], dropped: tracks.length };
    }

    if (tracks.length <= available) {
      return { accepted: tracks, dropped: 0 };
    }

    return {
      accepted: tracks.slice(0, available),
      dropped: tracks.length - available,
    };
  }

  private totalQueuedCount(): number {
    return this.upcoming.length + (this._current ? 1 : 0);
  }

  /** How many more tracks can be added without exceeding MAX_QUEUE_SIZE. */
  availableEnqueueCount(): number {
    return Math.max(0, MAX_QUEUE_SIZE - this.totalQueuedCount());
  }

  enqueue(tracks: Track[]): QueueAddResult {
    const { accepted, dropped } = this.trimToQueueLimit(tracks);
    this.upcoming.push(...accepted);
    this.registerRepeatPoolTracks(accepted);

    return {
      added: accepted.length,
      skipped: tracks.length - accepted.length - dropped,
      queueFull: dropped,
    };
  }

  insertNext(tracks: Track[]): QueueAddResult {
    const { accepted, dropped } = this.trimToQueueLimit(tracks);
    this.upcoming.unshift(...accepted);
    this.registerRepeatPoolTracks(accepted);

    return {
      added: accepted.length,
      skipped: tracks.length - accepted.length - dropped,
      queueFull: dropped,
    };
  }

  /** Shuffles all waiting tracks (current track is unchanged). */
  shuffle(): boolean {
    if (this.upcoming.length < 2) {
      return false;
    }

    this.shuffleArrayInPlace(this.upcoming);
    return true;
  }

  skipTo(index: number): boolean {
    if (index < 1 || index > this.upcoming.length) {
      return false;
    }

    this.upcoming = this.upcoming.slice(index - 1);
    return true;
  }

  setCurrent(track: Track | null): void {
    this._current = track;
  }

  /**
   * Natural track end: move the finished track to the queue tail, then take the next track.
   * Default (off/list) rotates the queue; shuffle-repeat shuffles only at cycle boundaries.
   */
  completeCurrentTrackNaturalEnd(): Track | null {
    const finished = this._current;
    if (!finished) {
      return this.takeNextTrack();
    }

    if (this._repeatMode === 'shuffle') {
      this.upcoming.push(finished);
      this.playedCountInCycle += 1;

      const cycleSize = this.repeatPool.length;
      logger.info(
        `Shuffle repeat cycle progress: played=${String(this.playedCountInCycle)} cycleSize=${String(cycleSize)} upcoming=${String(this.upcoming.length)}`,
      );

      if (cycleSize > 0 && this.playedCountInCycle >= cycleSize) {
        logger.info(
          `Shuffle repeat: cycle complete, shuffling waiting queue count=${String(this.upcoming.length)}`,
        );
        this.shuffleArrayInPlace(this.upcoming);
        this.playedCountInCycle = 0;
      }

      return this.shiftNextFromUpcoming();
    }

    // Default queue loop (off) and list repeat: rotate finished track to the tail.
    this.upcoming.push(finished);
    logger.info(
      `Queue rotate: moved "${finished.title}" to tail, upcoming=${String(this.upcoming.length)}`,
    );

    return this.shiftNextFromUpcoming();
  }

  /**
   * Skip / skipto / first track: take the next waiting track without rotating the current one.
   */
  takeNextTrack(): Track | null {
    return this.shiftNextFromUpcoming();
  }

  private shiftNextFromUpcoming(): Track | null {
    if (this.upcoming.length > 0) {
      const next = this.upcoming.shift()!;
      this._current = next;
      return next;
    }

    if (this._repeatMode === 'list' && this.repeatPool.length > 0) {
      this.refillUpcomingFromSession(false);
      if (this.upcoming.length > 0) {
        const next = this.upcoming.shift()!;
        this._current = next;
        return next;
      }
    }

    if (this._repeatMode === 'shuffle' && this.repeatPool.length > 0) {
      this.refillUpcomingFromSession(true);
      this.playedCountInCycle = 0;
      if (this.upcoming.length > 0) {
        const next = this.upcoming.shift()!;
        this._current = next;
        return next;
      }
    }

    this._current = null;
    return null;
  }

  getListView(page = 1): QueueListView | QueueListError {
    const totalUpcoming = this.upcoming.length;
    const totalPages = totalUpcoming === 0
      ? 1
      : Math.min(Math.ceil(totalUpcoming / LIST_PAGE_SIZE), MAX_LIST_PAGES);

    if (page < 1 || page > totalPages) {
      return {
        error: `そのページは存在しません。現在は 1〜${totalPages} ページです。`,
      };
    }

    const start = (page - 1) * LIST_PAGE_SIZE;
    const end = Math.min(start + LIST_PAGE_SIZE, totalUpcoming);
    const rangeStart = totalUpcoming === 0 ? 0 : start + 1;
    const rangeEnd = end;

    return {
      current: this._current,
      upcoming: this.upcoming.slice(start, end),
      totalUpcoming,
      repeatMode: this._repeatMode,
      page,
      totalPages,
      rangeStart,
      rangeEnd,
    };
  }
}
