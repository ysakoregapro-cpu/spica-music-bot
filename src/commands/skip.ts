import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { replyEphemeral } from '../utils/interaction.js';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('現在の曲をスキップします');

export async function execute(
  interaction: ChatInputCommandInteraction,
  musicManager: MusicManager,
): Promise<void> {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, 'サーバー内でのみ使用できます。');
    return;
  }

  const player = musicManager.get(interaction.guildId);
  if (!player || (!player.isPlaying && !player.queue.current)) {
    await replyEphemeral(interaction, '現在再生中の曲がありません。');
    return;
  }

  await interaction.deferReply();
  player.attachInteractionStatus(interaction);

  const next = await player.skip();

  if (next) {
    await interaction.editReply({
      content: `スキップしました。次は **${next.title}** を再生します。`,
    });
    return;
  }

  await interaction.editReply({
    content: 'スキップしました。キューが空のため再生を停止しました。',
  });
}
