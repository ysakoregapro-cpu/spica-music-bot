import {
  MAX_QUEUE_SIZE,
  type QueueAddResult,
  type QueueListView,
  type RepeatMode,
  type Track,
} from './types.js';
import { MAX_LIST_DISPLAY } from './types.js';

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

    for (let i = this.upcoming.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.upcoming[i], this.upcoming[j]] = [this.upcoming[j]!, this.upcoming[i]!];
    }

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
      this.upcoming = [...this.sessionTracks];
      const next = this.upcoming.shift()!;
      this._current = next;
      return next;
    }

    this._current = null;
    return null;
  }

  getListView(): QueueListView {
    return {
      current: this._current,
      upcoming: this.upcoming.slice(0, MAX_LIST_DISPLAY),
      totalUpcoming: this.upcoming.length,
      repeatMode: this._repeatMode,
    };
  }
}
