const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

export function isValidHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isYouTubeUrl(input: string): boolean {
  if (!isValidHttpUrl(input)) {
    return false;
  }

  const url = new URL(input);
  return YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
}

export function isPlaylistUrl(input: string): boolean {
  return input.includes('list=');
}

export function validateYouTubeInput(url: string): string | null {
  if (!isValidHttpUrl(url)) {
    return 'URL形式で入力してください。';
  }

  if (!isYouTubeUrl(url)) {
    return 'YouTubeのURLのみ受け付けています。';
  }

  return null;
}
