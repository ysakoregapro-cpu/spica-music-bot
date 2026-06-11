import {
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { logger } from './logger.js';

export async function safeErrorReply(
  interaction: ChatInputCommandInteraction,
  message: string,
): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: message,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: message,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    logger.error('Failed to send error reply', error);
  }
}

export async function respondToInteraction(
  interaction: ChatInputCommandInteraction,
  content: string,
  ephemeral = true,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
    return;
  }

  await interaction.reply({
    content,
    flags: ephemeral ? MessageFlags.Ephemeral : undefined,
  });
}

export async function replyEphemeral(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}
