import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { controls } from '../music/PlayerPanel.js';
export const data = new SlashCommandBuilder().setName('mute').setDescription('ミュート・解除ボタンを表示します').setDMPermission(false);
export async function execute(interaction: ChatInputCommandInteraction, _manager: MusicManager): Promise<void> {
  await interaction.reply({ content: '音声操作（Botと同じVCから操作できます。VC全員に適用）', components: controls(false, true), ephemeral: true });
}
