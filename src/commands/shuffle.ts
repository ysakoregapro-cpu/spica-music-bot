import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { replyEphemeral } from '../utils/interaction.js';

export const data = new SlashCommandBuilder()
  .setName('shuffle')
  .setDescription('現在のキューをシャッフルします');

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
    await replyEphemeral(interaction, 'シャッフルできるキューがありません。');
    return;
  }

  const shuffled = player.shuffle();
  if (!shuffled) {
    await replyEphemeral(interaction, 'シャッフルできるキューが2曲以上ありません。');
    return;
  }

  await interaction.reply({
    content: 'キューをシャッフルしました。現在再生中の曲以外の待機キュー全体をシャッフルしました。',
  });
}
