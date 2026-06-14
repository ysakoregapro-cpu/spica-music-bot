import { readFileSync } from 'node:fs';
import { ClientType, Innertube } from 'youtubei.js';
import { extractPlaylistListId } from '../utils/validators.js';
import { logger } from '../utils/logger.js';
import { resolveCookiesPath } from './ytdlp.js';
import type { Track } from './types.js';

export const MUSIC_RESOLVER_MIN_PLAYLIST_COUNT = 200;
export const MUSIC_RESOLVER_VISIBLE_RATIO = 0.5;

export interface MusicResolverVideoItem {
  videoId: string;
  title?: string;
}

export interface MusicResolverResult {
  listId: string;
  videoIds: MusicResolverVideoItem[];
  parsePath: MusicResolverParsePath;
}

export type MusicResolverParsePath =
  | 'music-responsive-list-item'
  | 'playlist-video'
  | 'none';

type ResolverClientMode = 'music-ytmusic' | 'web-playlist';

interface MusicItemLike {
  type?: string;
  item_type?: string;
  id?: string;
  title?: string | { toString(): string };
  endpoint?: { payload?: { videoId?: string } };
}

interface PlaylistVideoLike {
  type?: string;
  id?: string;
  title?: { toString(): string };
  endpoint?: { payload?: { videoId?: string } };
}

export function loadYoutubeCookieHeader(): string | undefined {
  let cookiesPath: string | undefined;
  try {
    cookiesPath = resolveCookiesPath();
  } catch {
    return undefined;
  }

  if (!cookiesPath) {
    return undefined;
  }

  const pairs: string[] = [];
  const content = readFileSync(cookiesPath, 'utf8');

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const parts = trimmed.split('\t');
    if (parts.length < 7) {
      continue;
    }

    const domain = parts[0]?.toLowerCase() ?? '';
    const name = parts[5]?.trim();
    const value = parts[6]?.trim();
    if (!name || !value) {
      continue;
    }

    if (domain.includes('youtube.com') || domain.includes('google.com')) {
      pairs.push(`${name}=${value}`);
    }
  }

  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

function summarizeObjectKeys(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return 'none';
  }

  return Object.keys(value as Record<string, unknown>).join(',');
}

function summarizeItemSample(item: unknown): string {
  if (!item || typeof item !== 'object') {
    return 'invalid-item';
  }

  const candidate = item as MusicItemLike & PlaylistVideoLike;
  const titlePresent = candidate.title != null;
  const videoIdPresent = Boolean(
    candidate.id?.trim()
    || candidate.endpoint?.payload?.videoId?.trim(),
  );

  return [
    `type=${candidate.type ?? 'unknown'}`,
    `item_type=${candidate.item_type ?? 'n/a'}`,
    `title=${titlePresent ? 'yes' : 'no'}`,
    `videoId=${videoIdPresent ? 'yes' : 'no'}`,
  ].join(' ');
}

function logResolverDebug(message: string): void {
  logger.info(message);
}

function extractVideoIdFromMusicItem(item: unknown): MusicResolverVideoItem | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as MusicItemLike;
  if (candidate.type === 'ContinuationItem') {
    return null;
  }

  if (candidate.type !== 'MusicResponsiveListItem') {
    return null;
  }

  if (
    candidate.item_type === 'playlist'
    || candidate.item_type === 'album'
    || candidate.item_type === 'artist'
    || candidate.item_type === 'library_artist'
    || candidate.item_type === 'podcast_show'
  ) {
    return null;
  }

  const videoId = (
    candidate.id?.trim()
    || candidate.endpoint?.payload?.videoId?.trim()
    || ''
  );

  if (!videoId) {
    return null;
  }

  const titleRaw = candidate.title;
  const title = typeof titleRaw === 'string'
    ? titleRaw.trim()
    : titleRaw?.toString()?.trim();

  return title ? { videoId, title } : { videoId };
}

function extractVideoIdFromPlaylistVideo(item: unknown): MusicResolverVideoItem | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as PlaylistVideoLike;
  if (candidate.type !== 'PlaylistVideo') {
    return null;
  }

  const videoId = (
    candidate.id?.trim()
    || candidate.endpoint?.payload?.videoId?.trim()
    || ''
  );

  if (!videoId) {
    return null;
  }

  const title = candidate.title?.toString()?.trim();
  return title ? { videoId, title } : { videoId };
}

function countItemTypes(items: readonly unknown[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const type = (item as { type?: string }).type ?? 'unknown';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([type, count]) => `${type}=${String(count)}`)
    .join(' ');
}

async function collectFromMusicPlaylist(
  listId: string,
  maxItems: number,
  cookie: string | undefined,
): Promise<{ videoIds: MusicResolverVideoItem[]; parsePath: MusicResolverParsePath }> {
  logResolverDebug('YouTube Music resolver client type: MUSIC (innertube.music.getPlaylist)');

  const innertube = await Innertube.create({
    cookie,
    retrieve_player: false,
    client_type: ClientType.MUSIC,
  });

  let playlist = await innertube.music.getPlaylist(listId);
  logResolverDebug(`YouTube Music resolver playlist response keys: ${summarizeObjectKeys(playlist)}`);

  const videoIds: MusicResolverVideoItem[] = [];
  let pageIndex = 0;

  while (videoIds.length < maxItems) {
    const items = [...playlist.items];
    logResolverDebug(
      `YouTube Music resolver items candidate count: ${String(items.length)} page=${String(pageIndex)}`,
    );

    if (items.length > 0) {
      logResolverDebug(`YouTube Music resolver first item keys: ${summarizeObjectKeys(items[0])}`);
      logResolverDebug(`YouTube Music resolver first item sample: ${summarizeItemSample(items[0])}`);
      logResolverDebug(`YouTube Music resolver item type breakdown: ${countItemTypes(items)}`);
    }

    for (const item of items) {
      const parsed = extractVideoIdFromMusicItem(item);
      if (!parsed) {
        continue;
      }

      videoIds.push(parsed);
      if (videoIds.length >= maxItems) {
        break;
      }
    }

    logResolverDebug(
      `YouTube Music resolver continuation available: ${String(playlist.has_continuation)} page=${String(pageIndex)} parsed=${String(videoIds.length)}`,
    );

    if (videoIds.length >= maxItems || !playlist.has_continuation) {
      break;
    }

    playlist = await playlist.getContinuation();
    pageIndex += 1;
    logResolverDebug(
      `YouTube Music resolver continuation page fetched: page=${String(pageIndex)} runningTotal=${String(videoIds.length)}`,
    );
  }

  return {
    videoIds,
    parsePath: videoIds.length > 0 ? 'music-responsive-list-item' : 'none',
  };
}

async function collectFromWebPlaylist(
  listId: string,
  maxItems: number,
  cookie: string | undefined,
): Promise<{ videoIds: MusicResolverVideoItem[]; parsePath: MusicResolverParsePath }> {
  logResolverDebug('YouTube Music resolver client type: WEB (innertube.getPlaylist fallback)');

  const innertube = await Innertube.create({
    cookie,
    retrieve_player: false,
    client_type: ClientType.WEB,
  });

  let playlist = await innertube.getPlaylist(listId);
  logResolverDebug(`YouTube Music resolver playlist response keys: ${summarizeObjectKeys(playlist)}`);

  const videoIds: MusicResolverVideoItem[] = [];
  let pageIndex = 0;

  while (videoIds.length < maxItems) {
    const items = [...playlist.items];
    logResolverDebug(
      `YouTube Music resolver items candidate count: ${String(items.length)} page=${String(pageIndex)}`,
    );

    if (items.length > 0) {
      logResolverDebug(`YouTube Music resolver first item keys: ${summarizeObjectKeys(items[0])}`);
      logResolverDebug(`YouTube Music resolver first item sample: ${summarizeItemSample(items[0])}`);
      logResolverDebug(`YouTube Music resolver item type breakdown: ${countItemTypes(items)}`);
    }

    for (const item of items) {
      const parsed = extractVideoIdFromPlaylistVideo(item);
      if (!parsed) {
        continue;
      }

      videoIds.push(parsed);
      if (videoIds.length >= maxItems) {
        break;
      }
    }

    logResolverDebug(
      `YouTube Music resolver continuation available: ${String(playlist.has_continuation)} page=${String(pageIndex)} parsed=${String(videoIds.length)}`,
    );

    if (videoIds.length >= maxItems || !playlist.has_continuation) {
      break;
    }

    playlist = await playlist.getContinuation();
    pageIndex += 1;
    logResolverDebug(
      `YouTube Music resolver continuation page fetched: page=${String(pageIndex)} runningTotal=${String(videoIds.length)}`,
    );
  }

  return {
    videoIds,
    parsePath: videoIds.length > 0 ? 'playlist-video' : 'none',
  };
}

export function shouldTriggerMusicResolver(
  playlistCount: number | null,
  visibleEntries: number,
  remainingSlots: number,
  url: string,
): boolean {
  if (!extractPlaylistListId(url)) {
    return false;
  }

  if (remainingSlots <= 0) {
    return false;
  }

  if (playlistCount == null || playlistCount < MUSIC_RESOLVER_MIN_PLAYLIST_COUNT) {
    return false;
  }

  return visibleEntries <= playlistCount * MUSIC_RESOLVER_VISIBLE_RATIO;
}

export async function fetchYouTubeMusicPlaylistVideoIds(
  listId: string,
  maxItems: number,
): Promise<MusicResolverResult> {
  logger.info(`YouTube Music resolver start: listId=${listId}`);

  const cookie = loadYoutubeCookieHeader();
  logger.info(`YouTube Music resolver cookies: ${cookie ? 'enabled' : 'disabled'}`);

  const attempts: Array<{ mode: ResolverClientMode; run: () => Promise<{ videoIds: MusicResolverVideoItem[]; parsePath: MusicResolverParsePath }> }> = [
    {
      mode: 'music-ytmusic',
      run: () => collectFromMusicPlaylist(listId, maxItems, cookie),
    },
    {
      mode: 'web-playlist',
      run: () => collectFromWebPlaylist(listId, maxItems, cookie),
    },
  ];

  let best: MusicResolverResult = { listId, videoIds: [], parsePath: 'none' };

  for (const attempt of attempts) {
    if (best.videoIds.length > 0 && attempt.mode === 'web-playlist') {
      logResolverDebug(
        'YouTube Music resolver skipping WEB fallback: music-ytmusic path already returned items',
      );
      break;
    }

    try {
      const result = await attempt.run();
      logResolverDebug(
        `YouTube Music resolver parse path used: ${result.parsePath} mode=${attempt.mode} count=${String(result.videoIds.length)}`,
      );

      if (result.videoIds.length > best.videoIds.length) {
        best = { listId, videoIds: result.videoIds, parsePath: result.parsePath };
      }

      if (best.videoIds.length >= maxItems) {
        break;
      }
    } catch (error) {
      logger.warn(
        `YouTube Music resolver attempt failed (${attempt.mode}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  logger.info(`YouTube Music resolver fetched videoIds: count=${String(best.videoIds.length)}`);

  return best;
}

export function musicResolverItemsToTracks(
  items: MusicResolverVideoItem[],
  requestedBy: string,
): Track[] {
  return items.map((item, index) => ({
    title: item.title ?? `YouTube Music Track ${String(index + 1)}`,
    url: `https://music.youtube.com/watch?v=${item.videoId}`,
    duration: null,
    requestedBy,
  }));
}

export async function runMusicResolverDiagnostics(
  listId: string,
  maxItems = 999,
): Promise<MusicResolverResult> {
  const cookie = loadYoutubeCookieHeader();
  console.log(`listId=${listId}`);
  console.log(`cookies=${cookie ? 'enabled' : 'disabled'}`);
  console.log(`maxItems=${String(maxItems)}`);

  const result = await fetchYouTubeMusicPlaylistVideoIds(listId, maxItems);

  console.log(`parsePath=${result.parsePath}`);
  console.log(`total=${String(result.videoIds.length)}`);

  for (const [index, item] of result.videoIds.slice(0, 3).entries()) {
    console.log(
      `#${String(index + 1)} title=${item.title ?? '(none)'} videoId=${item.videoId} url=https://music.youtube.com/watch?v=${item.videoId}`,
    );
  }

  return result;
}
