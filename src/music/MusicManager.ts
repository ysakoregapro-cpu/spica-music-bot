import type { ChatInputCommandInteraction, Client, GuildMember, VoiceBasedChannel } from 'discord.js';
import { GuildPlayer } from './GuildPlayer.js';
import { PlayJobQueue } from './PlayJobQueue.js';
import { autoLeaveManager } from './AutoLeaveManager.js';
import type { FetchResult } from './types.js';
import { MAX_QUEUE_SIZE } from './types.js';
import { fetchTracks } from './youtube.js';
import { YtDlpCookiesFileError, YtDlpYouTubeAccessError } from './ytdlp.js';
import { respondToInteraction } from '../utils/interaction.js';
import { validateYouTubeInput } from '../utils/validators.js';

function getMemberVoiceChannel(member: GuildMember | null): VoiceBasedChannel | null {
  if (!member?.voice.channel) {
    return null;
  }

  return member.voice.channel;
}

export async function requireVoiceChannel(
  interaction: ChatInputCommandInteraction,
): Promise<VoiceBasedChannel | null> {
  const member = interaction.member as GuildMember | null;
  const channel = getMemberVoiceChannel(member);

  if (!channel) {
    await respondToInteraction(
      interaction,
      'ボイスチャンネルに参加してからコマンドを実行してください。',
    );
    return null;
  }

  return channel;
}

export async function resolveYouTubeTracks(
  interaction: ChatInputCommandInteraction,
  url: string,
  maxTracks: number = MAX_QUEUE_SIZE,
): Promise<FetchResult | null> {
  const validationError = validateYouTubeInput(url);
  if (validationError) {
    await interaction.editReply({ content: validationError });
    return null;
  }

  if (maxTracks <= 0) {
    await interaction.editReply({
      content: `キューが上限（${MAX_QUEUE_SIZE}曲）に達しているため、曲を追加できません。`,
    });
    return null;
  }

  try {
    const result = await fetchTracks(url, interaction.user.tag, maxTracks);

    if (result.tracks.length === 0) {
      await interaction.editReply({
        content:
          result.skippedReasons.length > 0
            ? `追加できる曲がありませんでした。\n${result.skippedReasons.slice(0, 5).join('\n')}`
            : '追加できる曲がありませんでした。',
      });
      return null;
    }

    return result;
  } catch (error) {
    let message = error instanceof Error ? error.message : '不明なエラー';
    if (error instanceof YtDlpCookiesFileError || error instanceof YtDlpYouTubeAccessError) {
      message = error.message;
    }
    await interaction.editReply({
      content: `YouTubeから曲情報を取得できませんでした。\n${message}`,
    });
    return null;
  }
}

export class MusicManager {
  private readonly players = new Map<string, GuildPlayer>();
  private readonly playJobQueue = new PlayJobQueue();
  private client: Client | null = null;

  setClient(client: Client): void {
    this.client = client;
  }

  countHumansInPlayerChannel(guildId: string): number | null {
    const player = this.players.get(guildId);
    const channelId = player?.getVoiceChannelId();
    if (!this.client || !channelId) {
      return null;
    }

    const channel = this.client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) {
      return null;
    }

    return channel.members.filter((member) => !member.user.bot).size;
  }

  enqueuePlayJob(params: {
    guildId: string;
    interaction: ChatInputCommandInteraction;
    url: string;
    player: GuildPlayer;
  }): void {
    this.playJobQueue.enqueue(params);
  }

  get(guildId: string): GuildPlayer | undefined {
    return this.players.get(guildId);
  }

  getOrCreate(guildId: string): GuildPlayer {
    const existing = this.players.get(guildId);
    if (existing) {
      return existing;
    }

    const player = new GuildPlayer(guildId);
    this.players.set(guildId, player);
    return player;
  }

  async ensureConnected(guildId: string, channel: VoiceBasedChannel): Promise<GuildPlayer> {
    const player = this.getOrCreate(guildId);
    await player.connect(channel);
    if (this.client) {
      autoLeaveManager.checkAfterConnect(guildId, channel.id, this.client, this);
    }
    return player;
  }

  remove(guildId: string): void {
    autoLeaveManager.cancelAutoLeave(guildId);
    const player = this.players.get(guildId);
    if (player) {
      player.destroy();
      this.players.delete(guildId);
    }
  }
}

export async function ensurePlayerReady(
  interaction: ChatInputCommandInteraction,
  manager: MusicManager,
): Promise<{ channel: VoiceBasedChannel; guildId: string } | null> {
  const channel = await requireVoiceChannel(interaction);
  if (!channel || !interaction.guildId) {
    return null;
  }

  try {
    await manager.ensureConnected(interaction.guildId, channel);
  } catch {
    await respondToInteraction(interaction, 'ボイスチャンネルへの接続に失敗しました。');
    return null;
  }

  return { channel, guildId: interaction.guildId };
}

export const musicManager = new MusicManager();
