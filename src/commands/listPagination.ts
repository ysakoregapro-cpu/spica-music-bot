import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type InteractionReplyOptions,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { ButtonInteraction, InteractionEditReplyOptions } from 'discord.js';
import type { MusicManager } from '../music/MusicManager.js';
import {
  getListMessageSession,
  registerListMessage,
  updateListMessagePage,
} from '../music/listSession.js';
import { isQueueListError } from '../music/types.js';
import { formatQueueList } from '../utils/format.js';

export const LIST_PREV_BUTTON_ID = 'list:prev';
export const LIST_NEXT_BUTTON_ID = 'list:next';

function buildListButtons(
  page: number,
  totalPages: number,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  if (totalPages <= 1) {
    return [];
  }

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(LIST_PREV_BUTTON_ID)
      .setLabel('◀ 前へ')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(LIST_NEXT_BUTTON_ID)
      .setLabel('次へ ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
  );

  return [row];
}

export function buildListReplyOptions(
  guildId: string,
  page: number,
  musicManager: MusicManager,
): InteractionReplyOptions | { error: string } {
  const player = musicManager.get(guildId);
  if (!player) {
    return { error: '現在再生中の曲はありません。' };
  }

  const result = player.queue.getListView(page);
  if (isQueueListError(result)) {
    return { error: result.error };
  }

  return {
    content: formatQueueList(result),
    components: buildListButtons(result.page, result.totalPages),
  };
}

export async function handleListButtonInteraction(
  customId: string,
  messageId: string,
  userId: string,
  guildId: string | null,
  musicManager: MusicManager,
  interaction: ButtonInteraction,
): Promise<void> {
  if (!guildId) {
    await interaction.reply({
      content: 'サーバー内でのみ使用できます。',
      ephemeral: true,
    });
    return;
  }

  const session = getListMessageSession(messageId);
  if (!session || session.guildId !== guildId) {
    await interaction.reply({
      content: 'このリストは期限切れです。`/list` を再度実行してください。',
      ephemeral: true,
    });
    return;
  }

  if (session.userId !== userId) {
    await interaction.reply({
      content: 'このリストを操作できるのは実行者のみです。',
      ephemeral: true,
    });
    return;
  }

  const delta = customId === LIST_PREV_BUTTON_ID ? -1 : 1;
  const options = buildListReplyOptions(guildId, session.page + delta, musicManager);
  if ('error' in options) {
    await interaction.reply({
      content: options.error,
      ephemeral: true,
    });
    return;
  }

  const player = musicManager.get(guildId);
  if (!player) {
    await interaction.reply({
      content: '現在再生中の曲はありません。',
      ephemeral: true,
    });
    return;
  }

  const nextPage = session.page + delta;
  const view = player.queue.getListView(nextPage);
  if (isQueueListError(view)) {
    await interaction.reply({
      content: view.error,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();
  const editOptions: InteractionEditReplyOptions = {
    content: formatQueueList(view),
    components: buildListButtons(view.page, view.totalPages),
  };
  await interaction.editReply(editOptions);
  updateListMessagePage(messageId, view.page);
}

export function registerListReplyMessage(
  messageId: string,
  userId: string,
  guildId: string,
  page: number,
): void {
  registerListMessage(messageId, { userId, guildId, page });
}
