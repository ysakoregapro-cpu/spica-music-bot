import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { formatRepeatMode } from '../utils/format.js';
import { replyEphemeral } from '../utils/interaction.js';

export const data = new SlashCommandBuilder()
  .setName('now')
  .setDescription('現在再生中の曲情報を表示します');

export async function execute(
  interaction: ChatInputCommandInteraction,
  musicManager: MusicManager,
): Promise<void> {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, 'サーバー内でのみ使用できます。');
    return;
  }

  const player = musicManager.get(interaction.guildId);
  const current = player?.queue.current;

  if (!player || !current) {
    await replyEphemeral(interaction, '現在再生中の曲はありません。');
    return;
  }

  await interaction.reply({
    content: [
      '**現在再生中**',
      current.title,
      current.url,
      '',
      `残りキュー: ${player.queue.upcomingCount} 曲`,
      `リピート: ${formatRepeatMode(player.queue.repeatMode)}`,
    ].join('\n'),
  });
}
