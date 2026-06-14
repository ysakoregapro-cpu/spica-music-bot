import {
  MAX_PLAYLIST_TRACKS,
  MAX_TRACK_DURATION,
  type FetchResult,
  type Track,
} from './types.js';
import { isPlaylistUrl } from '../utils/validators.js';
import { logger } from '../utils/logger.js';
import { runYtDlp } from './ytdlp.js';
import { YTDLP_NETWORK_ARGS } from './youtube.js';

/** Use single flat-playlist call when the requested count is at most this. */
export const FLAT_SINGLE_MAX = 100;

/** Chunk size for chunked flat-playlist fetching. */
export const PLAYLIST_CHUNK_SIZE = 100;

export type PlaylistFetchStrategy = 'flat' | 'chunked-flat' | 'full-fallback';

export interface PlaylistChunkInfo {
  start: number;
  end: number;
  count: number;
}

export interface PlaylistImportCallbacks {
  onStrategy: (strategy: PlaylistFetchStrategy) => void;
  onChunk: (tracks: Track[], info: PlaylistChunkInfo) => Promise<void>;
  getRemainingSlots: () => number;
}

export interface PlaylistImportResult {
  strategy: PlaylistFetchStrategy;
  totalFetched: number;
  totalSkipped: number;
  skippedReasons: string[];
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

function parseYtDlpLines(lines: string[]): YtDlpEntry[] {
  const entries: YtDlpEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as YtDlpEntry);
    } catch {
      // ignore malformed lines
    }
  }
  return entries;
}

function getLightweightSkipReason(entry: YtDlpEntry): string | null {
  const url = buildVideoUrl(entry);
  if (!url) {
    return 'URLを取得できない動画をスキップしました';
  }

  const title = entry.title?.trim();
  if (!title) {
    return 'タイトルを取得できない動画をスキップしました';
  }

  if (entry.is_live === true) {
    return `ライブ配信は非対応: ${title}`;
  }

  if (entry.live_status === 'is_live' || entry.live_status === 'is_upcoming') {
    return `ライブ配信は非対応: ${title}`;
  }

  if (entry.duration != null && entry.duration > MAX_TRACK_DURATION) {
    return `2時間を超える動画: ${title}`;
  }

  return null;
}

function entryToLightweightTrack(entry: YtDlpEntry, requestedBy: string): Track | null {
  const skipReason = getLightweightSkipReason(entry);
  if (skipReason) {
    return null;
  }

  const url = buildVideoUrl(entry);
  const title = entry.title?.trim();
  if (!url || !title) {
    return null;
  }

  return {
    title,
    url,
    duration:
      entry.duration != null && entry.duration > 0 ? entry.duration : null,
    requestedBy,
  };
}

function entriesToTracks(
  entries: YtDlpEntry[],
  requestedBy: string,
  skippedReasons: string[],
): Track[] {
  const tracks: Track[] = [];
  for (const entry of entries) {
    const skipReason = getLightweightSkipReason(entry);
    if (skipReason) {
      skippedReasons.push(skipReason);
      continue;
    }
    const track = entryToLightweightTrack(entry, requestedBy);
    if (!track) {
      skippedReasons.push(`追加できない動画をスキップしました: ${entry.title ?? '不明'}`);
      continue;
    }
    tracks.push(track);
  }
  return tracks;
}

async function fetchFlatPlaylistArgs(
  url: string,
  playlistItems: string | undefined,
  playlistEnd: number,
): Promise<YtDlpEntry[]> {
  const args: string[] = [
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
    '--flat-playlist',
  ];

  if (playlistItems) {
    args.push('--playlist-items', playlistItems);
  }

  args.push('--playlist-end', String(playlistEnd), ...YTDLP_NETWORK_ARGS, url);

  const lines = await runYtDlp(args);
  return parseYtDlpLines(lines);
}

async function deliverChunk(
  entries: YtDlpEntry[],
  requestedBy: string,
  chunkStart: number,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
): Promise<number> {
  if (entries.length === 0) {
    return 0;
  }

  const tracks = entriesToTracks(entries, requestedBy, skippedReasons);
  const chunkEnd = chunkStart + entries.length - 1;
  logger.info(
    `Playlist chunk fetched: start=${String(chunkStart)} end=${String(chunkEnd)} count=${String(entries.length)}`,
  );

  if (tracks.length > 0) {
    await callbacks.onChunk(tracks, {
      start: chunkStart,
      end: chunkEnd,
      count: tracks.length,
    });
  }

  return tracks.length;
}

async function importFlatSingle(
  url: string,
  requestedBy: string,
  limit: number,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
): Promise<number> {
  callbacks.onStrategy('flat');
  const entries = await fetchFlatPlaylistArgs(url, undefined, limit);
  logger.info(`Playlist flat fetch: ${String(entries.length)} entries (limit=${String(limit)})`);
  return deliverChunk(entries, requestedBy, 1, skippedReasons, callbacks);
}

async function importChunkedFlat(
  url: string,
  requestedBy: string,
  limit: number,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
): Promise<number> {
  callbacks.onStrategy('chunked-flat');

  let totalDelivered = 0;
  let chunkStart = 1;

  while (chunkStart <= limit) {
    if (callbacks.getRemainingSlots() <= 0) {
      break;
    }

    const chunkEnd = Math.min(chunkStart + PLAYLIST_CHUNK_SIZE - 1, limit);
    const entries = await fetchFlatPlaylistArgs(
      url,
      `${String(chunkStart)}:${String(chunkEnd)}`,
      chunkEnd - chunkStart + 1,
    );

    if (entries.length === 0) {
      break;
    }

    const delivered = await deliverChunk(
      entries,
      requestedBy,
      chunkStart,
      skippedReasons,
      callbacks,
    );
    totalDelivered += delivered;

    if (entries.length < chunkEnd - chunkStart + 1) {
      break;
    }

    chunkStart += PLAYLIST_CHUNK_SIZE;
  }

  return totalDelivered;
}

function getFullSkipReason(entry: YtDlpEntry): string | null {
  const lightweight = getLightweightSkipReason(entry);
  if (lightweight) {
    return lightweight;
  }

  if (entry.duration == null || entry.duration <= 0) {
    return `再生時間を取得できませんでした: ${entry.title ?? '不明'}`;
  }

  return null;
}

function entryToFullTrack(entry: YtDlpEntry, requestedBy: string): Track | null {
  const skipReason = getFullSkipReason(entry);
  if (skipReason) {
    return null;
  }

  const url = buildVideoUrl(entry);
  const title = entry.title?.trim();
  if (!url || !title || entry.duration == null) {
    return null;
  }

  return {
    title,
    url,
    duration: entry.duration,
    requestedBy,
  };
}

async function importFullFallback(
  url: string,
  requestedBy: string,
  limit: number,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
): Promise<number> {
  callbacks.onStrategy('full-fallback');

  const args = [
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
    '--playlist-end',
    String(limit),
    ...YTDLP_NETWORK_ARGS,
    url,
  ];

  const lines = await runYtDlp(args);
  logger.info(`Playlist full fallback: ${String(lines.length)} entries (limit=${String(limit)})`);

  const tracks: Track[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as YtDlpEntry;
      const skipReason = getFullSkipReason(entry);
      if (skipReason) {
        skippedReasons.push(skipReason);
        continue;
      }
      const track = entryToFullTrack(entry, requestedBy);
      if (!track) {
        skippedReasons.push(`追加できない動画をスキップしました: ${entry.title ?? '不明'}`);
        continue;
      }
      tracks.push(track);
    } catch {
      skippedReasons.push('JSONの解析に失敗したエントリをスキップしました');
    }
  }

  if (tracks.length > 0) {
    await callbacks.onChunk(tracks, {
      start: 1,
      end: tracks.length,
      count: tracks.length,
    });
  }

  return tracks.length;
}

export async function importPlaylist(
  url: string,
  requestedBy: string,
  maxTracks: number,
  callbacks: PlaylistImportCallbacks,
): Promise<PlaylistImportResult> {
  const limit = Math.min(MAX_PLAYLIST_TRACKS, Math.max(1, maxTracks));
  const skippedReasons: string[] = [];
  let strategy: PlaylistFetchStrategy = 'flat';
  let totalFetched = 0;

  try {
    if (limit <= FLAT_SINGLE_MAX) {
      totalFetched = await importFlatSingle(url, requestedBy, limit, skippedReasons, callbacks);
      if (totalFetched === 0) {
        strategy = 'chunked-flat';
        totalFetched = await importChunkedFlat(url, requestedBy, limit, skippedReasons, callbacks);
      }
    } else {
      strategy = 'chunked-flat';
      totalFetched = await importChunkedFlat(url, requestedBy, limit, skippedReasons, callbacks);
    }

    if (totalFetched === 0) {
      strategy = 'full-fallback';
      totalFetched = await importFullFallback(url, requestedBy, limit, skippedReasons, callbacks);
    }
  } catch (error) {
    if (totalFetched === 0) {
      strategy = 'full-fallback';
      totalFetched = await importFullFallback(url, requestedBy, limit, skippedReasons, callbacks);
    } else {
      throw error;
    }
  }

  return {
    strategy,
    totalFetched,
    totalSkipped: skippedReasons.length,
    skippedReasons,
  };
}

/** Collect all playlist tracks at once (for /nextplay). */
export async function fetchPlaylistTracksLightweight(
  url: string,
  requestedBy: string,
  maxTracks: number,
): Promise<FetchResult> {
  const tracks: Track[] = [];

  const result = await importPlaylist(url, requestedBy, maxTracks, {
    onStrategy: (strategy) => {
      logger.info(`Playlist fetch strategy: ${strategy}`);
    },
    getRemainingSlots: () => Math.max(0, maxTracks - tracks.length),
    onChunk: async (chunkTracks) => {
      tracks.push(...chunkTracks);
    },
  });

  return {
    tracks,
    skipped: result.totalSkipped,
    skippedReasons: result.skippedReasons,
  };
}

export function isYouTubePlaylistUrl(url: string): boolean {
  return isPlaylistUrl(url);
}
