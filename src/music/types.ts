export const MAX_PLAYLIST_TRACKS = 50;
export const MAX_QUEUE_SIZE = 100;
export const MAX_TRACK_DURATION = 7200;
export const MAX_LIST_DISPLAY = 20;

export type RepeatMode = 'off' | 'one' | 'list';

export interface Track {
  title: string;
  url: string;
  duration: number;
  requestedBy: string;
}

export interface FetchResult {
  tracks: Track[];
  skipped: number;
  skippedReasons: string[];
}

export interface QueueAddResult {
  added: number;
  skipped: number;
  queueFull: number;
  message?: string;
}

export interface QueueListView {
  current: Track | null;
  upcoming: Track[];
  totalUpcoming: number;
  repeatMode: RepeatMode;
}
