import 'dotenv/config';
import { runMusicResolverDiagnostics } from '../src/music/youtubeMusicResolver.js';

const DEFAULT_LIST_ID = 'PLBuviRo-wjxHhVfmzOaRrz4TpvvMTO5oX';

const listId = process.argv[2]?.trim() || DEFAULT_LIST_ID;
const maxItems = Number.parseInt(process.argv[3] ?? '999', 10);

void runMusicResolverDiagnostics(
  listId,
  Number.isFinite(maxItems) && maxItems > 0 ? maxItems : 999,
).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`debug-youtube-music-resolver failed: ${message}`);
  process.exitCode = 1;
});
