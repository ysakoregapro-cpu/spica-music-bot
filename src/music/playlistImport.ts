import {
  MAX_PLAYLIST_TRACKS,
  MAX_TRACK_DURATION,
  MAX_QUEUE_SIZE,
  type FetchResult,
  type Track,
} from './types.js';
import { extractPlaylistListId, isPlaylistUrl } from '../utils/validators.js';
import { getBuildLabel } from '../utils/buildInfo.js';
import { logger } from '../utils/logger.js';
import { runYtDlp } from './ytdlp.js';
import { YTDLP_NETWORK_ARGS } from './youtube.js';
import {
  fetchYouTubeMusicPlaylistVideoIds,
  musicResolverItemsToTracks,
  shouldTriggerMusicResolver,
} from './youtubeMusicResolver.js';

/** Use single flat-playlist call when the requested count is at most this. */
export const FLAT_SINGLE_MAX = 100;

/** Chunk size for chunked flat-playlist fetching. */
export const PLAYLIST_CHUNK_SIZE = 100;

/** flat-playlist often caps near this count when pagination fails. */
export const FLAT_PLAYLIST_SUSPICIOUS_CAP = 110;

export type PlaylistFetchStrategy =
  | 'flat'
  | 'flat-single-json'
  | 'chunked-flat'
  | 'full-fallback'
  | 'music-resolver';

export type PlaylistImportSource = 'yt-dlp' | 'music-resolver';

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
  source: PlaylistImportSource;
  totalFetched: number;
  totalSkipped: number;
  skippedReasons: string[];
  playlistCount: number | null;
  ytDlpEntryCount: number;
  resolverCount: number;
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

interface PlaylistJsonRoot {
  entries?: YtDlpEntry[];
  playlist_count?: number;
}

interface FlatSingleJsonProbe {
  entries: YtDlpEntry[];
  playlistCount: number | null;
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

function logStrategy(strategy: PlaylistFetchStrategy, callbacks: PlaylistImportCallbacks): void {
  callbacks.onStrategy(strategy);
  logger.info(`Playlist fetch strategy: ${strategy}`);
}

async function runYtDlpEntries(args: readonly string[]): Promise<YtDlpEntry[]> {
  const safeArgs = args.filter((arg) => !arg.startsWith('http'));
  logger.debug(`yt-dlp playlist args: ${safeArgs.join(' ')}`);
  const lines = await runYtDlp(args);
  return parseYtDlpLines(lines);
}

/** Flat playlist: one JSON line per entry. */
async function fetchFlatPlaylistLines(
  url: string,
  options: { playlistItems?: string; playlistEnd?: number },
): Promise<YtDlpEntry[]> {
  const args: string[] = [
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
    '--flat-playlist',
  ];

  if (options.playlistItems) {
    args.push('--playlist-items', options.playlistItems);
  } else if (options.playlistEnd != null) {
    args.push('--playlist-end', String(options.playlistEnd));
  }

  args.push(...YTDLP_NETWORK_ARGS, url);
  return runYtDlpEntries(args);
}

/** Flat playlist: single JSON object with entries array and optional playlist_count. */
async function probeFlatPlaylistSingleJson(
  url: string,
  limit: number,
): Promise<FlatSingleJsonProbe> {
  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--ignore-errors',
    '--flat-playlist',
    '--playlist-end',
    String(limit),
    ...YTDLP_NETWORK_ARGS,
    url,
  ];

  const lines = await runYtDlp(args);
  if (lines.length === 0) {
    return { entries: [], playlistCount: null };
  }

  try {
    const root = JSON.parse(lines[0]!) as PlaylistJsonRoot;
    const playlistCount =
      typeof root.playlist_count === 'number' && root.playlist_count > 0
        ? root.playlist_count
        : null;
    return { entries: root.entries ?? [], playlistCount };
  } catch {
    logger.warn('Playlist flat-single-json: failed to parse root JSON');
    return { entries: [], playlistCount: null };
  }
}

/** Flat playlist: single JSON object with entries array. */
async function fetchFlatPlaylistSingleJson(
  url: string,
  limit: number,
): Promise<YtDlpEntry[]> {
  const probe = await probeFlatPlaylistSingleJson(url, limit);
  return probe.entries;
}

/** Full metadata (heavy) for a playlist item range. */
async function fetchFullPlaylistRange(
  url: string,
  rangeStart: number,
  rangeEnd: number,
): Promise<YtDlpEntry[]> {
  const args = [
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
    '--playlist-items',
    `${String(rangeStart)}:${String(rangeEnd)}`,
    ...YTDLP_NETWORK_ARGS,
    url,
  ];

  return runYtDlpEntries(args);
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

function entriesToTracksFull(
  entries: YtDlpEntry[],
  requestedBy: string,
  skippedReasons: string[],
): Track[] {
  const tracks: Track[] = [];
  for (const entry of entries) {
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
  }
  return tracks;
}

async function deliverChunk(
  entries: YtDlpEntry[],
  requestedBy: string,
  chunkStart: number,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
  useFullMetadata: boolean,
): Promise<number> {
  if (entries.length === 0) {
    return 0;
  }

  const chunkEnd = chunkStart + entries.length - 1;
  logger.info(
    `Playlist chunk fetched: start=${String(chunkStart)} end=${String(chunkEnd)} count=${String(entries.length)}`,
  );

  const tracks = useFullMetadata
    ? entriesToTracksFull(entries, requestedBy, skippedReasons)
    : entriesToTracks(entries, requestedBy, skippedReasons);

  if (tracks.length > 0) {
    await callbacks.onChunk(tracks, {
      start: chunkStart,
      end: chunkEnd,
      count: tracks.length,
    });
  }

  return tracks.length;
}

async function deliverEntriesInSubChunks(
  entries: YtDlpEntry[],
  requestedBy: string,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
  useFullMetadata: boolean,
): Promise<number> {
  let total = 0;
  for (let offset = 0; offset < entries.length; offset += PLAYLIST_CHUNK_SIZE) {
    if (callbacks.getRemainingSlots() <= 0) {
      logger.info(
        `Playlist import stopped: queue full at offset=${String(offset)} remainingSlots=0`,
      );
      break;
    }

    const slice = entries.slice(offset, offset + PLAYLIST_CHUNK_SIZE);
    const chunkStart = offset + 1;
    total += await deliverChunk(
      slice,
      requestedBy,
      chunkStart,
      skippedReasons,
      callbacks,
      useFullMetadata,
    );
  }
  return total;
}

async function importFlatSingle(
  url: string,
  requestedBy: string,
  limit: number,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
): Promise<number> {
  logStrategy('flat', callbacks);
  logger.info(`Playlist chunk fetch start: start=1 end=${String(limit)}`);
  const entries = await fetchFlatPlaylistLines(url, { playlistEnd: limit });
  logger.info(`Playlist flat fetch: ${String(entries.length)} entries (limit=${String(limit)})`);
  return deliverChunk(entries, requestedBy, 1, skippedReasons, callbacks, false);
}

async function importFlatSingleJson(
  url: string,
  requestedBy: string,
  limit: number,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
  preloadedEntries?: YtDlpEntry[],
): Promise<number> {
  if (preloadedEntries == null) {
    logStrategy('flat-single-json', callbacks);
    logger.info(`Playlist flat-single-json fetch start: limit=${String(limit)}`);
  }

  const entries = preloadedEntries ?? await fetchFlatPlaylistSingleJson(url, limit);
  if (preloadedEntries == null) {
    logger.info(
      `Playlist flat-single-json fetched: count=${String(entries.length)} limit=${String(limit)}`,
    );
  }

  return deliverEntriesInSubChunks(entries, requestedBy, skippedReasons, callbacks, false);
}

async function tryMusicResolverImport(
  url: string,
  requestedBy: string,
  limit: number,
  ytDlpEntryCount: number,
  playlistCount: number | null,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
): Promise<{ selected: boolean; totalDelivered: number; resolverCount: number }> {
  const remainingSlots = callbacks.getRemainingSlots();
  if (!shouldTriggerMusicResolver(playlistCount, ytDlpEntryCount, remainingSlots, url)) {
    return { selected: false, totalDelivered: 0, resolverCount: 0 };
  }

  logger.info(
    `YouTube Music resolver triggered: playlistCount=${String(playlistCount)} visibleEntries=${String(ytDlpEntryCount)}`,
  );

  const listId = extractPlaylistListId(url);
  if (!listId) {
    return { selected: false, totalDelivered: 0, resolverCount: 0 };
  }

  try {
    const maxItems = Math.min(limit, remainingSlots);
    const resolverResult = await fetchYouTubeMusicPlaylistVideoIds(listId, maxItems);
    const resolverCount = resolverResult.videoIds.length;

    logger.info(`YouTube Music resolver fetched: count=${String(resolverCount)}`);

    if (resolverCount <= ytDlpEntryCount) {
      logger.info(
        `YouTube Music resolver ignored: resolverCount=${String(resolverCount)} ytDlpCount=${String(ytDlpEntryCount)}`,
      );
      return { selected: false, totalDelivered: 0, resolverCount };
    }

    logger.info(
      `YouTube Music resolver selected: resolverCount=${String(resolverCount)} ytDlpCount=${String(ytDlpEntryCount)}`,
    );

    logStrategy('music-resolver', callbacks);
    const tracks = musicResolverItemsToTracks(resolverResult.videoIds, requestedBy);
    const totalDelivered = await deliverTracksInSubChunks(tracks, callbacks);
    return { selected: true, totalDelivered, resolverCount };
  } catch (error) {
    logger.warn(
      `YouTube Music resolver failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { selected: false, totalDelivered: 0, resolverCount: 0 };
  }
}

async function deliverTracksInSubChunks(
  tracks: Track[],
  callbacks: PlaylistImportCallbacks,
): Promise<number> {
  let total = 0;
  for (let offset = 0; offset < tracks.length; offset += PLAYLIST_CHUNK_SIZE) {
    if (callbacks.getRemainingSlots() <= 0) {
      logger.info(
        `Playlist import stopped: queue full at offset=${String(offset)} remainingSlots=0`,
      );
      break;
    }

    const slice = tracks.slice(offset, offset + PLAYLIST_CHUNK_SIZE);
    const chunkStart = offset + 1;
    const chunkEnd = offset + slice.length;
    logger.info(
      `Playlist chunk fetched: start=${String(chunkStart)} end=${String(chunkEnd)} count=${String(slice.length)}`,
    );

    if (slice.length > 0) {
      await callbacks.onChunk(slice, {
        start: chunkStart,
        end: chunkEnd,
        count: slice.length,
      });
      total += slice.length;
    }
  }

  return total;
}

interface ChunkedFlatResult {
  totalDelivered: number;
  lastChunkRawCount: number;
  stoppedAt: number;
}

async function importChunkedFlat(
  url: string,
  requestedBy: string,
  limit: number,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
): Promise<ChunkedFlatResult> {
  logStrategy('chunked-flat', callbacks);

  let totalDelivered = 0;
  let chunkStart = 1;
  let lastChunkRawCount = 0;

  while (chunkStart <= limit) {
    const remainingSlots = callbacks.getRemainingSlots();
    if (remainingSlots <= 0) {
      logger.info(
        `Playlist import stopped: queue full before chunk start=${String(chunkStart)}`,
      );
      break;
    }

    const chunkEnd = Math.min(chunkStart + PLAYLIST_CHUNK_SIZE - 1, limit);
    logger.info(
      `Playlist chunk fetch start: start=${String(chunkStart)} end=${String(chunkEnd)} remainingSlots=${String(remainingSlots)}`,
    );

    const entries = await fetchFlatPlaylistLines(url, {
      playlistItems: `${String(chunkStart)}:${String(chunkEnd)}`,
    });

    lastChunkRawCount = entries.length;

    if (entries.length === 0) {
      logger.warn(
        `Playlist chunk empty: start=${String(chunkStart)} end=${String(chunkEnd)} — stopping chunked-flat`,
      );
      break;
    }

    const delivered = await deliverChunk(
      entries,
      requestedBy,
      chunkStart,
      skippedReasons,
      callbacks,
      false,
    );
    totalDelivered += delivered;

    if (entries.length < chunkEnd - chunkStart + 1) {
      logger.info(
        `Playlist chunked-flat end of playlist at index=${String(chunkStart + entries.length - 1)}`,
      );
      break;
    }

    chunkStart += PLAYLIST_CHUNK_SIZE;
  }

  return { totalDelivered, lastChunkRawCount, stoppedAt: chunkStart };
}

async function importFullFallback(
  url: string,
  requestedBy: string,
  limit: number,
  skippedReasons: string[],
  callbacks: PlaylistImportCallbacks,
  rangeStart = 1,
): Promise<number> {
  logStrategy('full-fallback', callbacks);

  const rangeEnd = limit;
  logger.info(
    `Playlist full-fallback fetch start: start=${String(rangeStart)} end=${String(rangeEnd)}`,
  );

  let entries: YtDlpEntry[];
  if (rangeStart > 1) {
    entries = await fetchFullPlaylistRange(url, rangeStart, rangeEnd);
  } else {
    const args = [
      '--dump-json',
      '--no-warnings',
      '--ignore-errors',
      '--playlist-end',
      String(limit),
      ...YTDLP_NETWORK_ARGS,
      url,
    ];
    entries = await runYtDlpEntries(args);
  }

  logger.info(
    `Playlist full-fallback fetched: count=${String(entries.length)} start=${String(rangeStart)} end=${String(rangeEnd)}`,
  );

  if (entries.length === 0) {
    return 0;
  }

  return deliverEntriesInSubChunks(
    entries,
    requestedBy,
    skippedReasons,
    callbacks,
    true,
  );
}

function shouldTryFullFallback(
  totalFetched: number,
  limit: number,
  stoppedEarly: boolean,
): boolean {
  if (totalFetched === 0) {
    return true;
  }

  if (!stoppedEarly) {
    return false;
  }

  if (limit <= FLAT_PLAYLIST_SUSPICIOUS_CAP) {
    return false;
  }

  if (totalFetched <= FLAT_PLAYLIST_SUSPICIOUS_CAP) {
    logger.warn(
      `Playlist lightweight fetch suspicious cap: fetched=${String(totalFetched)} limit=${String(limit)}`,
    );
    return true;
  }

  return false;
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
  let source: PlaylistImportSource = 'yt-dlp';
  let totalFetched = 0;
  let playlistCount: number | null = null;
  let ytDlpEntryCount = 0;
  let resolverCount = 0;

  logger.info(
    `Playlist import start: build=${getBuildLabel()} limit=${String(limit)} maxQueue=${String(MAX_QUEUE_SIZE)} remainingSlots=${String(callbacks.getRemainingSlots())}`,
  );

  try {
    if (limit <= FLAT_SINGLE_MAX) {
      strategy = 'flat';
      totalFetched = await importFlatSingle(url, requestedBy, limit, skippedReasons, callbacks);
      if (totalFetched === 0) {
        strategy = 'chunked-flat';
        const chunked = await importChunkedFlat(url, requestedBy, limit, skippedReasons, callbacks);
        totalFetched = chunked.totalDelivered;
      }
    } else {
      strategy = 'flat-single-json';
      logStrategy('flat-single-json', callbacks);
      logger.info(`Playlist flat-single-json fetch start: limit=${String(limit)}`);

      const probe = await probeFlatPlaylistSingleJson(url, limit);
      ytDlpEntryCount = probe.entries.length;
      playlistCount = probe.playlistCount;

      logger.info(
        `Playlist flat-single-json fetched: count=${String(ytDlpEntryCount)} limit=${String(limit)} playlist_count=${String(playlistCount ?? 'unknown')}`,
      );

      if (playlistCount != null && ytDlpEntryCount < playlistCount) {
        logger.info(
          `Playlist count mismatch detected: playlistCount=${String(playlistCount)} entries=${String(ytDlpEntryCount)}`,
        );
      }

      const resolverAttempt = await tryMusicResolverImport(
        url,
        requestedBy,
        limit,
        ytDlpEntryCount,
        playlistCount,
        skippedReasons,
        callbacks,
      );
      resolverCount = resolverAttempt.resolverCount;

      if (resolverAttempt.selected) {
        strategy = 'music-resolver';
        source = 'music-resolver';
        totalFetched = resolverAttempt.totalDelivered;
      } else {
        totalFetched = await importFlatSingleJson(
          url,
          requestedBy,
          limit,
          skippedReasons,
          callbacks,
          probe.entries,
        );

        let stoppedEarly =
          totalFetched > 0
          && totalFetched < limit
          && totalFetched <= FLAT_PLAYLIST_SUSPICIOUS_CAP;

        if (shouldTryFullFallback(totalFetched, limit, stoppedEarly || totalFetched === 0)) {
          if (totalFetched === 0) {
            strategy = 'chunked-flat';
            const chunked = await importChunkedFlat(
              url,
              requestedBy,
              limit,
              skippedReasons,
              callbacks,
            );
            totalFetched = chunked.totalDelivered;
            ytDlpEntryCount = Math.max(ytDlpEntryCount, chunked.totalDelivered);
            stoppedEarly =
              chunked.totalDelivered > 0
              && chunked.totalDelivered < limit
              && (chunked.lastChunkRawCount === 0 || chunked.totalDelivered <= FLAT_PLAYLIST_SUSPICIOUS_CAP);
          }

          if (shouldTryFullFallback(totalFetched, limit, stoppedEarly)) {
            const resumeFrom = totalFetched > 0 ? totalFetched + 1 : 1;
            logger.warn(
              `Playlist switching to full-fallback: resumeFrom=${String(resumeFrom)} alreadyFetched=${String(totalFetched)} limit=${String(limit)}`,
            );
            strategy = 'full-fallback';
            const fallbackAdded = await importFullFallback(
              url,
              requestedBy,
              limit,
              skippedReasons,
              callbacks,
              resumeFrom,
            );
            totalFetched += fallbackAdded;
          }
        } else if (totalFetched === 0) {
          strategy = 'chunked-flat';
          const chunked = await importChunkedFlat(url, requestedBy, limit, skippedReasons, callbacks);
          totalFetched = chunked.totalDelivered;
          ytDlpEntryCount = Math.max(ytDlpEntryCount, chunked.totalDelivered);

          if (shouldTryFullFallback(
            chunked.totalDelivered,
            limit,
            chunked.totalDelivered < limit && chunked.lastChunkRawCount === 0,
          )) {
            const resumeFrom = chunked.totalDelivered > 0 ? chunked.totalDelivered + 1 : 1;
            strategy = 'full-fallback';
            totalFetched += await importFullFallback(
              url,
              requestedBy,
              limit,
              skippedReasons,
              callbacks,
              resumeFrom,
            );
          }
        }
      }
    }

    if (totalFetched === 0) {
      strategy = 'full-fallback';
      totalFetched = await importFullFallback(
        url,
        requestedBy,
        limit,
        skippedReasons,
        callbacks,
        1,
      );
    }
  } catch (error) {
    logger.warn(
      `Playlist import error (${strategy}): ${error instanceof Error ? error.message : String(error)}`,
    );
    if (totalFetched === 0) {
      strategy = 'full-fallback';
      totalFetched = await importFullFallback(
        url,
        requestedBy,
        limit,
        skippedReasons,
        callbacks,
        1,
      );
    } else {
      throw error;
    }
  }

  logger.info(
    `Playlist import complete: added=${String(totalFetched)} skipped=${String(skippedReasons.length)} source=${source}`,
  );

  return {
    strategy,
    source,
    totalFetched,
    totalSkipped: skippedReasons.length,
    skippedReasons,
    playlistCount,
    ytDlpEntryCount,
    resolverCount,
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
    onStrategy: () => {
      // strategy logged inside importPlaylist
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
