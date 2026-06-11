import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { ensurePlayerReady, resolveYouTubeTracks } from '../music/MusicManager.js';
import { formatAddResult } from '../utils/format.js';

export const data = new SlashCommandBuilder()
  .setName('nextplay')
  .setDescription('次に再生する曲として割り込み追加します')
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
  const addResult = player.queue.insertNext(fetchResult.tracks);
  player.notifyQueueChanged('nextplay');
  const wasIdle = !player.isPlaying && player.queue.current === null;

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

  await interaction.editReply({
    content: `次の再生として **${fetchResult.tracks[0]!.title}** ほか${Math.max(addResult.added - 1, 0)}曲を割り込み追加しました。\n${formatAddResult(addResult, fetchResult)}`,
  });
}
