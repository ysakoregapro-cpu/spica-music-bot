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

export class TrackQueue {
  private upcoming: Track[] = [];
  private sessionTracks: Track[] = [];
  private _current: Track | null = null;
  private _repeatMode: RepeatMode = 'off';

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

    if (this._repeatMode === 'list' && this.sessionTracks.length > 0) {
      return this.sessionTracks[0]!;
    }

    // Shuffle repeat order is decided only when the queue wraps.
    return null;
  }

  setRepeatMode(mode: RepeatMode): RepeatMode {
    this._repeatMode = mode;
    return this._repeatMode;
  }

  clear(): void {
    this.upcoming = [];
    this.sessionTracks = [];
    this._current = null;
    this._repeatMode = 'off';
  }

  private registerSessionTracks(tracks: Track[]): void {
    for (const track of tracks) {
      this.sessionTracks.push(track);
    }
  }

  private shuffleArrayInPlace(tracks: Track[]): void {
    for (let i = tracks.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!];
    }
  }

  private refillUpcomingFromSession(shuffle: boolean): void {
    this.upcoming = [...this.sessionTracks];
    if (shuffle) {
      this.shuffleArrayInPlace(this.upcoming);
    }
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
    this.registerSessionTracks(accepted);

    return {
      added: accepted.length,
      skipped: tracks.length - accepted.length - dropped,
      queueFull: dropped,
    };
  }

  insertNext(tracks: Track[]): QueueAddResult {
    const { accepted, dropped } = this.trimToQueueLimit(tracks);
    this.upcoming.unshift(...accepted);
    this.registerSessionTracks(accepted);

    return {
      added: accepted.length,
      skipped: tracks.length - accepted.length - dropped,
      queueFull: dropped,
    };
  }

  shuffle(): boolean {
    if (this.upcoming.length <= 1) {
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

  takeNextTrack(): Track | null {
    if (this.upcoming.length > 0) {
      const next = this.upcoming.shift()!;
      this._current = next;
      return next;
    }

    if (this._repeatMode === 'list' && this.sessionTracks.length > 0) {
      this.refillUpcomingFromSession(false);
      const next = this.upcoming.shift()!;
      this._current = next;
      return next;
    }

    if (this._repeatMode === 'shuffle' && this.sessionTracks.length > 0) {
      this.refillUpcomingFromSession(true);
      const next = this.upcoming.shift()!;
      this._current = next;
      return next;
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
