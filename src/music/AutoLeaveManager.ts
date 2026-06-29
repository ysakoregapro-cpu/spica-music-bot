import type { Client, VoiceBasedChannel, VoiceState } from 'discord.js';
import type { MusicManager } from './MusicManager.js';
import { logger } from '../utils/logger.js';

const AUTO_LEAVE_DELAY_MS = 5 * 60 * 1000;

export class AutoLeaveManager {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  handleVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
    client: Client,
    musicManager: MusicManager,
  ): void {
    const guildId = newState.guild.id;
    const player = musicManager.get(guildId);
    if (!player?.isConnected) {
      return;
    }

    const channelId = player.getVoiceChannelId();
    if (!channelId) {
      return;
    }

    const affectsChannel =
      oldState.channelId === channelId
      || newState.channelId === channelId
      || newState.member?.id === client.user?.id;

    if (!affectsChannel) {
      return;
    }

    this.syncChannelOccupancy(guildId, channelId, newState, musicManager);
  }

  checkAfterConnect(guildId: string, channelId: string, client: Client, musicManager: MusicManager): void {
    const guild = client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) {
      return;
    }

    const humans = this.countHumanMembers(channel);
    if (humans === 0) {
      this.scheduleAutoLeave(guildId, musicManager);
    } else {
      this.cancelAutoLeave(guildId);
    }
  }

  cancelAutoLeave(guildId: string): void {
    const timer = this.timers.get(guildId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.timers.delete(guildId);
    logger.info(`Auto-leave timer cancelled: guild=${guildId}`);
  }

  private syncChannelOccupancy(
    guildId: string,
    channelId: string,
    voiceState: VoiceState,
    musicManager: MusicManager,
  ): void {
    const channel = voiceState.guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) {
      return;
    }

    const humans = this.countHumanMembers(channel);
    if (humans === 0) {
      this.scheduleAutoLeave(guildId, musicManager);
    } else {
      this.cancelAutoLeave(guildId);
    }
  }

  private countHumanMembers(channel: VoiceBasedChannel): number {
    return channel.members.filter((member) => !member.user.bot).size;
  }

  private scheduleAutoLeave(guildId: string, musicManager: MusicManager): void {
    if (this.timers.has(guildId)) {
      return;
    }

    logger.info(`Auto-leave timer started: guild=${guildId} delayMs=${String(AUTO_LEAVE_DELAY_MS)}`);

    const timer = setTimeout(() => {
      this.timers.delete(guildId);
      void this.executeAutoLeave(guildId, musicManager);
    }, AUTO_LEAVE_DELAY_MS);

    this.timers.set(guildId, timer);
  }

  private async executeAutoLeave(guildId: string, musicManager: MusicManager): Promise<void> {
    const player = musicManager.get(guildId);
    if (!player?.isConnected) {
      return;
    }

    const channelId = player.getVoiceChannelId();
    if (!channelId) {
      return;
    }

    const humans = musicManager.countHumansInPlayerChannel(guildId);
    if (humans != null && humans > 0) {
      logger.info(`Auto-leave aborted: human present guild=${guildId}`);
      return;
    }

    logger.info(`Auto-leave executing: guild=${guildId} channel=${channelId}`);
    await player.autoLeave();
    musicManager.remove(guildId);
    logger.info(`Auto-leave complete: guild=${guildId}`);
  }
}

export const autoLeaveManager = new AutoLeaveManager();
