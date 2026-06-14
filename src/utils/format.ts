import type {
  FetchResult,
  QueueAddResult,
  QueueListView,
  RepeatMode,
  Track,
} from '../music/types.js';
import { MAX_QUEUE_SIZE } from '../music/types.js';
import type { PlaylistImportResult } from '../music/playlistImport.js';

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function formatTrackDuration(seconds: number | null): string {
  if (seconds == null || seconds <= 0) {
    return '--:--';
  }
  return formatDuration(seconds);
}

export function formatRepeatMode(mode: RepeatMode): string {
  switch (mode) {
    case 'off':
      return 'オフ';
    case 'one':
      return '1曲リピート';
    case 'list':
      return 'リストリピート';
    case 'shuffle':
      return 'Shuffle Repeat';
  }
}

function formatTrackLine(index: number | null, track: Track, prefix: string): string {
  const number = index === null ? '▶' : String(index);
  return `${prefix}${number}. **${track.title}** (${formatTrackDuration(track.duration)})`;
}

export function formatQueueList(view: QueueListView): string {
  const lines: string[] = [];

  if (view.current) {
    lines.push(formatTrackLine(null, view.current, ''));
    lines.push('');
  } else {
    lines.push('現在再生中の曲はありません。');
    lines.push('');
  }

  if (view.totalUpcoming === 0) {
    lines.push('キューは空です。');
  } else {
    lines.push(`**キュー** ${view.rangeStart}-${view.rangeEnd} / ${view.totalUpcoming}`);
    lines.push(`Page ${view.page} / ${view.totalPages}`);
    lines.push('');
    view.upcoming.forEach((track, index) => {
      lines.push(formatTrackLine(view.rangeStart + index, track, ''));
    });

    if (view.page < view.totalPages) {
      lines.push('');
      lines.push(`次ページ: \`/list page:${view.page + 1}\``);
    }
  }

  lines.push('');
  lines.push(`リピート: ${formatRepeatMode(view.repeatMode)}`);

  return lines.join('\n');
}

export function formatPlayJobComplete(result: {
  added: number;
  skipped: number;
  queueFull: number;
}): string {
  const lines: string[] = [];

  if (result.added > 0) {
    lines.push(`${result.added}曲をキューに追加しました。`);
  }

  if (result.skipped > 0) {
    lines.push(`${result.skipped}曲をスキップしました。`);
  }

  if (result.queueFull > 0) {
    lines.push(
      `キュー上限(${MAX_QUEUE_SIZE}曲)のため${result.queueFull}曲を追加できませんでした。`,
    );
  }

  return lines.join('\n');
}

export function formatPlaylistImportUserMessage(
  importResult: PlaylistImportResult,
  added: number,
): string | null {
  if (importResult.source === 'music-resolver' && added > 0) {
    return `YouTube Musicから${added}曲を取得しました。`;
  }

  const playlistCount = importResult.playlistCount;
  if (
    playlistCount != null
    && playlistCount >= 200
    && added > 0
    && added < playlistCount
    && importResult.ytDlpEntryCount > 0
    && importResult.resolverCount <= importResult.ytDlpEntryCount
  ) {
    return [
      `このプレイリストはYouTube上では${playlistCount}曲ありますが、Botが取得できた再生可能な曲は${added}曲でした。`,
      'YouTube Music専用曲、非公開曲、地域制限、またはCookieアカウントで見えない曲が含まれる可能性があります。',
    ].join('\n');
  }

  return null;
}

export function formatAddResult(result: QueueAddResult, fetchResult: FetchResult): string {
  const lines: string[] = [];

  if (result.added > 0) {
    lines.push(`${result.added}曲をキューに追加しました。`);
  }

  if (fetchResult.skipped > 0) {
    lines.push(`${fetchResult.skipped}曲をスキップしました。`);
  }

  if (result.queueFull > 0) {
    lines.push(
      `キュー上限(${MAX_QUEUE_SIZE}曲)のため${result.queueFull}曲を追加できませんでした。`,
    );
  }

  return lines.join('\n');
}
