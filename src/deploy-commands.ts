import 'dotenv/config';
import { REST, Routes, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import * as list from './commands/list.js';
import * as nextplay from './commands/nextplay.js';
import * as now from './commands/now.js';
import * as play from './commands/play.js';
import * as repeat from './commands/repeat.js';
import * as shuffle from './commands/shuffle.js';
import * as skip from './commands/skip.js';
import * as skipto from './commands/skipto.js';
import * as stop from './commands/stop.js';
import * as player from './commands/player.js';
import * as mute from './commands/mute.js';
import { logger } from './utils/logger.js';

const commandModules = [play, nextplay, list, skip, skipto, shuffle, repeat, stop, now, player, mute];

const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = commandModules.map(
  (command) => command.data.toJSON(),
);

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;
  const global = process.env.COMMAND_SCOPE === 'global';
  if (process.env.COMMAND_SCOPE && !['guild', 'global'].includes(process.env.COMMAND_SCOPE)) {
    throw new Error('COMMAND_SCOPE は guild または global を指定してください。');
  }

  if (!token || !clientId || (!global && !guildId)) {
    throw new Error('DISCORD_TOKEN, CLIENT_ID と、guild登録時は GUILD_ID を .env に設定してください。');
  }

  const rest = new REST({ version: '10' }).setToken(token);

  logger.info(`${commands.length} 件のスラッシュコマンドを登録しています...`);

  await rest.put(global ? Routes.applicationCommands(clientId) : Routes.applicationGuildCommands(clientId, guildId!), {
    body: commands,
  });

  logger.info('スラッシュコマンドの登録が完了しました。');
}

main().catch((error: unknown) => {
  logger.error('コマンド登録に失敗しました', error);
  process.exit(1);
});
