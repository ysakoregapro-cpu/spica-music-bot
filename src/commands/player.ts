import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { openPanel } from '../music/PlayerPanel.js';
export const data = new SlashCommandBuilder().setName('player').setDescription('音楽プレイヤーを表示します').setDMPermission(false);
export async function execute(interaction: ChatInputCommandInteraction, manager: MusicManager): Promise<void> {
  await openPanel(interaction, manager);
}
