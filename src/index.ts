import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import * as list from './commands/list.js';
import {
  handleListButtonInteraction,
  LIST_NEXT_BUTTON_ID,
  LIST_PREV_BUTTON_ID,
} from './commands/listPagination.js';
import * as nextplay from './commands/nextplay.js';
import * as now from './commands/now.js';
import * as play from './commands/play.js';
import * as repeat from './commands/repeat.js';
import * as shuffle from './commands/shuffle.js';
import * as skip from './commands/skip.js';
import * as skipto from './commands/skipto.js';
import * as stop from './commands/stop.js';
import { musicManager } from './music/MusicManager.js';
import { safeErrorReply } from './utils/interaction.js';
import { logger } from './utils/logger.js';

interface BotCommand {
  execute(
    interaction: ChatInputCommandInteraction,
    manager: typeof musicManager,
  ): Promise<void>;
}

const commandMap = new Map<string, BotCommand>([
  ['play', play],
  ['nextplay', nextplay],
  ['list', list],
  ['skip', skip],
  ['skipto', skipto],
  ['shuffle', shuffle],
  ['repeat', repeat],
  ['stop', stop],
  ['now', now],
]);

const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error('DISCORD_TOKEN を .env に設定してください。');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (readyClient) => {
  logger.info(`Logged in as ${readyClient.user.tag}`);
});

client.on('error', (error) => {
  logger.error('Discord client error', error);
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (interaction.isButton()) {
    if (
      interaction.customId === LIST_PREV_BUTTON_ID
      || interaction.customId === LIST_NEXT_BUTTON_ID
    ) {
      try {
        await handleListButtonInteraction(
          interaction.customId,
          interaction.message.id,
          interaction.user.id,
          interaction.guildId,
          musicManager,
          interaction,
        );
      } catch (error) {
        logger.error('List pagination button failed', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'ページ移動中にエラーが発生しました。',
            ephemeral: true,
          }).catch(() => undefined);
        }
      }
      return;
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commandMap.get(interaction.commandName);
  if (!command) {
    return;
  }

  try {
    await command.execute(interaction, musicManager);
  } catch (error) {
    logger.error(`Command /${interaction.commandName} failed`, error);
    await safeErrorReply(interaction, 'コマンド実行中にエラーが発生しました。');
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

client.login(token).catch((error: unknown) => {
  logger.error('Discord login failed', error);
  process.exit(1);
});
