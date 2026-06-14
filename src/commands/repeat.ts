import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import type { RepeatMode } from '../music/types.js';
import { formatRepeatMode } from '../utils/format.js';
import { replyEphemeral } from '../utils/interaction.js';

const REPEAT_CHOICES: { name: string; value: RepeatMode }[] = [
  { name: 'off', value: 'off' },
  { name: 'one', value: 'one' },
  { name: 'list', value: 'list' },
  { name: 'Shuffle Repeat', value: 'shuffle' },
];

export const data = new SlashCommandBuilder()
  .setName('repeat')
  .setDescription('リピートモードを変更します')
  .addStringOption((option) =>
    option
      .setName('mode')
      .setDescription('off / one / list / shuffle')
      .setRequired(true)
      .addChoices(...REPEAT_CHOICES),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  musicManager: MusicManager,
): Promise<void> {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, 'サーバー内でのみ使用できます。');
    return;
  }

  const mode = interaction.options.getString('mode', true) as RepeatMode;
  const player = musicManager.getOrCreate(interaction.guildId);
  player.setRepeatMode(mode);

  await interaction.reply({
    content: `リピートモードを **${formatRepeatMode(mode)}** に設定しました。`,
  });
}
