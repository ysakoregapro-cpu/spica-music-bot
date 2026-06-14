import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { isQueueListError } from '../music/types.js';
import { formatQueueList } from '../utils/format.js';
import { replyEphemeral } from '../utils/interaction.js';

export const data = new SlashCommandBuilder()
  .setName('list')
  .setDescription('現在の曲とキュー一覧を表示します')
  .addIntegerOption((option) =>
    option
      .setName('page')
      .setDescription('表示するページ番号（1ページ25曲）')
      .setMinValue(1)
      .setRequired(false),
  );

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

  const page = interaction.options.getInteger('page') ?? 1;
  const result = player.queue.getListView(page);

  if (isQueueListError(result)) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  await interaction.reply({
    content: formatQueueList(result),
  });
}
