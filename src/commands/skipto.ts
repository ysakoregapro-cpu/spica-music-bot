import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { replyEphemeral } from '../utils/interaction.js';

export const data = new SlashCommandBuilder()
  .setName('skipto')
  .setDescription('指定番号の曲までスキップします')
  .addIntegerOption((option) =>
    option
      .setName('index')
      .setDescription('再生するキュー番号 (1から)')
      .setRequired(true)
      .setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  musicManager: MusicManager,
): Promise<void> {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, 'サーバー内でのみ使用できます。');
    return;
  }

  const index = interaction.options.getInteger('index', true);
  const player = musicManager.get(interaction.guildId);

  if (!player || (!player.isPlaying && !player.queue.current)) {
    await replyEphemeral(interaction, '現在再生中の曲がありません。');
    return;
  }

  if (index > player.queue.upcomingCount) {
    await replyEphemeral(
      interaction,
      `キュー番号が不正です。現在のキュー件数は ${player.queue.upcomingCount} 件です。`,
    );
    return;
  }

  await interaction.deferReply();
  player.attachInteractionStatus(interaction);

  const next = await player.skipTo(index);
  if (!next) {
    await replyEphemeral(interaction, '指定番号の曲へスキップできませんでした。');
    return;
  }

  await interaction.editReply({
    content: `${index}番目の **${next.title}** を次に再生します。`,
  });
}
