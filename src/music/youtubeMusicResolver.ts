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
}

function loadYoutubeCookieHeader(): string | undefined {
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

interface PlaylistVideoLike {
  type?: string;
  id?: string;
  title?: { toString(): string };
}

function extractVideoIdFromItem(item: unknown): MusicResolverVideoItem | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as PlaylistVideoLike;
  if (candidate.type !== 'PlaylistVideo') {
    return null;
  }

  const videoId = candidate.id?.trim();
  if (!videoId) {
    return null;
  }

  const title = candidate.title?.toString()?.trim();
  return title ? { videoId, title } : { videoId };
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
  const innertube = await Innertube.create({
    cookie,
    retrieve_player: false,
    client_type: ClientType.MUSIC,
  });

  let playlist = await innertube.getPlaylist(listId);
  const videoIds: MusicResolverVideoItem[] = [];

  while (videoIds.length < maxItems) {
    for (const item of playlist.items) {
      const parsed = extractVideoIdFromItem(item);
      if (!parsed) {
        continue;
      }

      videoIds.push(parsed);
      if (videoIds.length >= maxItems) {
        break;
      }
    }

    if (videoIds.length >= maxItems || !playlist.has_continuation) {
      break;
    }

    playlist = await playlist.getContinuation();
  }

  logger.info(`YouTube Music resolver fetched videoIds: count=${String(videoIds.length)}`);

  return { listId, videoIds };
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
