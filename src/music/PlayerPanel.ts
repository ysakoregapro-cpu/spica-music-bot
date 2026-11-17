import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits,
  type ButtonInteraction, type ChatInputCommandInteraction, type Guild, type Message, type SendableChannels,
} from 'discord.js';
import type { MusicManager } from './MusicManager.js';
import { logger } from '../utils/logger.js';
import { formatRepeatMode, formatTrackDuration } from '../utils/format.js';
import { resolveTrackThumbnail, resolveTrackWatchUrl } from './youtubeThumbnail.js';

type ControlInteraction = ButtonInteraction | ChatInputCommandInteraction;
const panels = new Map<string, Message>();
const updates = new Map<string, Promise<void>>();
const busy = new Set<string>();
const welcoming = new Set<string>();

export function forgetPanel(guildId: string): void {
  panels.delete(guildId);
  welcoming.delete(guildId);
}

export function controls(welcome = false, muteOnly = false) {
  const items = welcome
    ? [['personal-mute', '自分だけミュートする方法'], ['personal-unmute', 'ミュート解除の方法']]
    : [['previous', '⏮ 前へ'], ['next', '次へ ⏭'], ['mute', 'ミュート'], ['unmute', 'ミュート解除']];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(items.filter(([id]) => !muteOnly || id === 'mute' || id === 'unmute').map(([id, label]) =>
    new ButtonBuilder().setCustomId(`spica:${id}`).setLabel(label!).setStyle(ButtonStyle.Secondary)))];
}

export function ensureAutoPanel(manager: MusicManager, guildId: string, channel: SendableChannels): void {
  const pending = (updates.get(guildId) ?? Promise.resolve()).then(async () => {
    if (!panels.has(guildId)) {
      panels.set(guildId, await channel.send(panelPayload(manager, guildId)));
    }
  }).catch((error) => logger.error(`Automatic player panel failed guild=${guildId}`, error));
  updates.set(guildId, pending);
  void pending.finally(() => { if (updates.get(guildId) === pending) updates.delete(guildId); });
}

export function panelPayload(manager: MusicManager, guildId: string) {
  const player = manager.get(guildId);
  const track = player?.isConnected ? player.queue.current : null;
  const embed = new EmbedBuilder().setColor(0x7061de).setAuthor({ name: 'Spring Triangle' })
    .setTitle(track ? track.title.slice(0, 256) : '再生待機中')
    .setDescription(track ? '♪ NOW PLAYING' : '/play で音楽を再生できます。')
    .addFields(
      { name: '待機曲', value: String(player?.queue.upcomingCount ?? 0), inline: true },
      { name: 'リピート', value: formatRepeatMode(player?.queue.repeatMode ?? 'off'), inline: true },
      { name: '音声', value: player?.isMuted ? 'ミュート中' : 'ON', inline: true },
      { name: '曲の長さ', value: formatTrackDuration(track?.duration ?? null), inline: true },
    ).setFooter({ text: '操作はBotと同じVCから • ミュートはVC全員に適用されます' });
  if (track) {
    const watchUrl = resolveTrackWatchUrl(track);
    const thumbnail = resolveTrackThumbnail(track);
    if (watchUrl) embed.setURL(watchUrl);
    if (thumbnail) embed.setImage(thumbnail);
  }
  return { embeds: [embed], components: controls(), allowedMentions: { parse: [] as never[] } };
}

export function refreshPanel(manager: MusicManager, guildId: string): void {
  const pending = (updates.get(guildId) ?? Promise.resolve()).then(async () => {
    const message = panels.get(guildId);
    if (!message) return;
    try { await message.edit(panelPayload(manager, guildId)); }
    catch (error) {
      logger.error(`Player panel update failed guild=${guildId}`, error);
      if ((error as { code?: number }).code === 10008) panels.delete(guildId);
    }
  });
  updates.set(guildId, pending);
  void pending.finally(() => { if (updates.get(guildId) === pending) updates.delete(guildId); });
}

export async function openPanel(interaction: ControlInteraction, manager: MusicManager): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.channel?.isSendable()) {
    await interaction.reply({ content: 'サーバーのテキストチャンネルで実行してください。', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  if (busy.has(guildId)) {
    await interaction.editReply('別の操作を処理中です。少し待ってからお試しください。');
    return;
  }
  busy.add(guildId);
  try {
    await updates.get(guildId);
    let message = panels.get(guildId);
    if (message) {
      try { await message.fetch(); }
      catch (error) {
        if ((error as { code?: number }).code !== 10008) throw error;
        panels.delete(guildId);
        message = undefined;
      }
    }
    if (!message) {
      message = await interaction.channel.send(panelPayload(manager, guildId));
      panels.set(guildId, message);
    }
    refreshPanel(manager, guildId);
    await interaction.editReply(`音楽プレイヤー: ${message.url}`);
  } finally { busy.delete(guildId); }
}

export async function handlePlayerButton(interaction: ButtonInteraction, manager: MusicManager): Promise<void> {
  const action = interaction.customId.slice('spica:'.length);
  if (action === 'personal-mute' || action === 'personal-unmute') {
    const content = action === 'personal-mute'
      ? '自分だけ音楽を聞こえなくするには、DiscordでSpring Triangleを右クリックし、個別の「ミュート」をオンにするか「ユーザー音量」を0%にしてください。スマートフォンではBotのプロフィール／VCのメンバー操作から音量を調整してください。\nこのボタンは手順の案内です。設定はまだ変更されていません。VC参加前でも案内は開けますが、設定項目が表示されない場合はBotと同じVCに入ってから設定してください。\n「サーバーミュート」ではなく個別のミュートを使用してください。他の人には影響しません。'
      : 'DiscordでSpring Triangleの個別の「ミュート」をオフにし、「ユーザー音量」を必要な音量に戻してください。スマートフォンではBotのプロフィール／VCのメンバー操作から調整してください。\nこのボタンは手順の案内です。設定はまだ変更されていません。';
    await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
    return;
  }
  if (action === 'open') return openPanel(interaction, manager);
  if (action === 'help') {
    await interaction.reply({ content: '/play /player /mute /repeat /shuffle /skip /skipto /nextplay /list /now /stop', ephemeral: true });
    return;
  }
  const guildId = interaction.guildId;
  const player = guildId ? manager.get(guildId) : undefined;
  const member = await interaction.guild?.members.fetch(interaction.user.id);
  if (!guildId || !player?.isConnected || !member?.voice.channelId
      || member.voice.channelId !== player.getVoiceChannelId()) {
    await interaction.reply({ content: 'Botと同じボイスチャンネルに参加して操作してください。', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  if (busy.has(guildId)) {
    await interaction.editReply('別の操作を処理中です。少し待ってからお試しください。');
    return;
  }
  busy.add(guildId);
  try {
    // Resolve again after acknowledgement: an auto-leave may have occurred meanwhile.
    if (manager.get(guildId) !== player || !player.isConnected
        || member.voice.channelId !== player.getVoiceChannelId()) {
      await interaction.editReply('音声接続が変わりました。もう一度操作してください。');
      return;
    }
    if (player.isTransitioning) {
      await interaction.editReply('曲の切り替え中です。少し待ってから操作してください。');
      return;
    }
    if (action === 'mute' || action === 'unmute') player.setMuted(action === 'mute');
    else if (action === 'next') await player.skip();
    else if (action === 'previous') {
      if (!player.canGoBack) { await interaction.editReply('前の曲の履歴がありません。'); return; }
      await player.previous();
    } else { await interaction.editReply('不明な操作です。'); return; }
    refreshPanel(manager, guildId);
    await interaction.editReply('操作を反映しました。');
  } finally { busy.delete(guildId); }
}

export async function sendWelcome(guild: Guild): Promise<void> {
  if (welcoming.has(guild.id)) return;
  welcoming.add(guild.id);
  const me = await guild.members.fetchMe();
  const channels = await guild.channels.fetch();
  const candidates = [guild.systemChannel, ...channels.values()];
  const visited = new Set<string>();
  for (const channel of candidates) {
    if (!channel || visited.has(channel.id) || !channel.isTextBased() || !channel.isSendable() || channel.isThread()) continue;
    visited.add(channel.id);
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) continue;
    try {
      await channel.send({
        content: 'はじめまして！音楽bot Spicaです！\nコマンドは主にplay,repeat,shuffle,stop等がありますが、スラッシュを入力すると見えます！\nボイスチャンネルに人がいなくなると勝手に消えます！\n\n音楽を聞きたくない方は、下のボタンから自分だけミュートする方法を確認できます。ボタンは設定手順の案内です。\nその他不明点は作者まで問い合わせお願いします！@saisa_you',
        components: controls(true), allowedMentions: { parse: [] },
      });
      return;
    } catch (error) { logger.error(`Welcome send failed guild=${guild.id}`, error); }
  }
  logger.warn(`No writable welcome channel guild=${guild.id}`);
}
