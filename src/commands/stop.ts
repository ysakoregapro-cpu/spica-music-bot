import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { replyEphemeral } from '../utils/interaction.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('再生を停止し、キューを削除してVCから退出します');

export async function execute(
  interaction: ChatInputCommandInteraction,
  musicManager: MusicManager,
): Promise<void> {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, 'サーバー内でのみ使用できます。');
    return;
  }

  const player = musicManager.get(interaction.guildId);
  if (!player) {
    await replyEphemeral(interaction, '現在再生中の曲はありません。');
    return;
  }

  await player.stop();
  musicManager.remove(interaction.guildId);

  await interaction.reply({
    content: '再生を停止し、キューを削除してボイスチャンネルから退出しました。',
  });
}
