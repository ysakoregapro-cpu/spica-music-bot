import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import { ensurePlayerReady } from '../music/MusicManager.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('YouTubeのURLまたはプレイリストURLを再生します')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('YouTube動画またはプレイリストのURL')
      .setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  musicManager: MusicManager,
): Promise<void> {
  const url = interaction.options.getString('url', true);
  await interaction.deferReply();

  const ready = await ensurePlayerReady(interaction, musicManager);
  if (!ready) {
    return;
  }

  const player = musicManager.getOrCreate(ready.guildId);
  musicManager.enqueuePlayJob({
    guildId: ready.guildId,
    interaction,
    url,
    player,
  });
}
