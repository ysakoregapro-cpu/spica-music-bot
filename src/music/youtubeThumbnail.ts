import type { Track } from './types.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const THUMBNAIL_HOSTS = new Set([
  'i.ytimg.com',
  'i9.ytimg.com',
  'img.youtube.com',
]);

export interface YouTubeMediaFields {
  videoId?: string;
  thumbnail?: string;
}

interface ThumbnailCandidate {
  url: string;
  height: number;
}

export function isYouTubeVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function sanitizeYouTubeThumbnailUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return null;
    }
    if (!THUMBNAIL_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function videoIdFromYouTubeUrl(input: string): string | null {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return isYouTubeVideoId(id) ? id : null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const fromQuery = url.searchParams.get('v');
      if (isYouTubeVideoId(fromQuery)) {
        return fromQuery;
      }

      const [kind, id] = url.pathname.split('/').filter(Boolean);
      if ((kind === 'embed' || kind === 'shorts' || kind === 'live' || kind === 'v') && isYouTubeVideoId(id)) {
        return id;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function resolveTrackVideoId(track: Pick<Track, 'url' | 'videoId'>): string | null {
  if (isYouTubeVideoId(track.videoId)) {
    return track.videoId;
  }
  return videoIdFromYouTubeUrl(track.url);
}

export function resolveTrackThumbnail(track: Pick<Track, 'url' | 'videoId' | 'thumbnail'>): string | null {
  const direct = sanitizeYouTubeThumbnailUrl(track.thumbnail);
  if (direct) {
    return direct;
  }

  const videoId = resolveTrackVideoId(track);
  return videoId ? youtubeThumbnailUrl(videoId) : null;
}

export function resolveTrackWatchUrl(track: Pick<Track, 'url' | 'videoId'>): string | null {
  const videoId = resolveTrackVideoId(track);
  if (videoId) {
    return youtubeWatchUrl(videoId);
  }

  try {
    const url = new URL(track.url);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return track.url;
    }
  } catch {
    return null;
  }

  return null;
}

export function youtubeMediaFields(source: {
  id?: string;
  videoId?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string; height?: number }>;
}): YouTubeMediaFields {
  const videoId = isYouTubeVideoId(source.videoId)
    ? source.videoId
    : isYouTubeVideoId(source.id)
      ? source.id
      : undefined;
  const ranked = [...(source.thumbnails ?? [])].sort((left, right) => (right.height ?? 0) - (left.height ?? 0));
  const thumbnail = [source.thumbnail, ...ranked.map((item) => item.url)]
    .map((value) => sanitizeYouTubeThumbnailUrl(value))
    .find((value): value is string => value != null);

  return {
    ...(videoId ? { videoId } : {}),
    ...(thumbnail ? { thumbnail } : {}),
  };
}

function collectThumbnailCandidates(
  list: ThumbnailCandidate[],
  value: unknown,
  height: number,
  depth: number,
): void {
  if (depth > 4 || value == null) {
    return;
  }

  if (typeof value === 'string') {
    const safe = sanitizeYouTubeThumbnailUrl(value);
    if (safe) {
      list.push({ url: safe, height });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectThumbnailCandidates(list, item, height, depth + 1);
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  const nextHeight = typeof record.height === 'number' ? record.height : height;
  if (typeof record.url === 'string') {
    const safe = sanitizeYouTubeThumbnailUrl(record.url);
    if (safe) {
      list.push({ url: safe, height: nextHeight });
    }
  }
  if (record.contents != null) {
    collectThumbnailCandidates(list, record.contents, nextHeight, depth + 1);
  }
}

/** Reads a video thumbnail from a yt-dlp entry or a youtubei.js item, ignoring non-image URLs. */
export function extractYouTubeThumbnailUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return sanitizeYouTubeThumbnailUrl(value);
  }

  const record = value as Record<string, unknown>;
  const found: ThumbnailCandidate[] = [];
  collectThumbnailCandidates(found, record.thumbnail, 0, 0);
  collectThumbnailCandidates(found, record.thumbnails, 0, 0);
  if (found.length === 0) {
    return null;
  }

  found.sort((left, right) => right.height - left.height);
  return found[0]?.url ?? null;
}
