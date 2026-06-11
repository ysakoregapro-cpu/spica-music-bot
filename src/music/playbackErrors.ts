/** Thrown when a track cannot be streamed (premium-only, 0 bytes, etc.). */
export class UnplayableTrackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnplayableTrackError';
  }
}

export function isUnplayableTrackError(error: unknown): boolean {
  return error instanceof UnplayableTrackError;
}

export function isPremiumOnlyMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('music premium')
    || lower.includes('only available to')
    || lower.includes('members only')
  );
}

/** Playback stream origin — only `fresh-live-stream` may be passed to AudioPlayer. */
export type StreamSourceKind = 'fresh-live-stream' | 'unsafe-buffer-disabled';

export type AdvanceReason =
  | 'natural-end'
  | 'skip'
  | 'skipto'
  | 'failed-track'
  | 'repeat-one'
  | 'unplayable';
