export const MAX_PLAYLIST_TRACKS = 999;
export const MAX_QUEUE_SIZE = 999;
export const MAX_TRACK_DURATION = 7200;
/** Tracks shown per `/list` page. */
export const LIST_PAGE_SIZE = 25;
/** Max pages for a 999-track queue (999 / 25 = 40). */
export const MAX_LIST_PAGES = 40;

export type RepeatMode = 'off' | 'one' | 'list' | 'shuffle';

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
  page: number;
  totalPages: number;
  rangeStart: number;
  rangeEnd: number;
}

export interface QueueListError {
  error: string;
}

export function isQueueListError(
  result: QueueListView | QueueListError,
): result is QueueListError {
  return 'error' in result;
}
