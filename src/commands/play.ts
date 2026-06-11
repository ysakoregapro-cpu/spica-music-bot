import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { ensurePlayerReady, resolveYouTubeTracks } from '../music/MusicManager.js';
import { formatAddResult } from '../utils/format.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('YouTubeのURLまたはプレイリストURLを再生します')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('YouTube動画またはプレイリストのURL')
      .setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  musicManager: MusicManager,
): Promise<void> {
  const url = interaction.options.getString('url', true);
  await interaction.deferReply();

  const ready = await ensurePlayerReady(interaction, musicManager);
  if (!ready) {
    return;
  }

  const fetchResult = await resolveYouTubeTracks(interaction, url);
  if (!fetchResult) {
    return;
  }

  const player = musicManager.getOrCreate(ready.guildId);
  const previousNextUrl = player.queue.peekNext()?.url;
  const addResult = player.queue.enqueue(fetchResult.tracks);
  const wasIdle = !player.isPlaying && player.queue.current === null;

  if (!wasIdle) {
    const newNextUrl = player.queue.peekNext()?.url;
    if (previousNextUrl !== newNextUrl) {
      player.notifyQueueChanged('play');
    } else {
      player.refreshPrefetch();
    }
  }

  if (wasIdle) {
    const next = player.queue.takeNextTrack();
    if (next) {
      player.attachInteractionStatus(interaction);
      try {
        await player.start(next);
      } catch {
        await interaction.editReply({
          content: '再生を開始できませんでした。',
        });
        return;
      }
    }
  }

  const firstTrack = fetchResult.tracks[0]!;
  const prefix = wasIdle
    ? `▶ **${firstTrack.title}** を再生開始しました。`
    : `**${firstTrack.title}** をキューに追加しました。`;

  await interaction.editReply({
    content: `${prefix}\n${formatAddResult(addResult, fetchResult)}`,
  });
}
