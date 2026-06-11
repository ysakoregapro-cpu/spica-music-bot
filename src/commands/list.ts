import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { formatQueueList } from '../utils/format.js';
import { replyEphemeral } from '../utils/interaction.js';

export const data = new SlashCommandBuilder()
  .setName('list')
  .setDescription('現在の曲とキュー一覧を表示します');

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

  await interaction.reply({
    content: formatQueueList(player.queue.getListView()),
  });
}
