/**
 * Extension hooks for future production features (VC idle disconnect, 24h limit, PM2 recovery).
 * Wire implementations in GuildPlayer when ready — no-op defaults keep current behavior unchanged.
 */
export interface PlayerLifecycleHooks {
  /** Called when the bot joins a voice channel. */
  onVoiceJoin?(guildId: string, channelId: string): void;
  /** Called when playback stops or the bot leaves voice. */
  onVoiceLeave?(guildId: string): void;
  /** Called when a track starts playing. */
  onTrackStart?(guildId: string, trackUrl: string): void;
  /** Called when playback session ends (queue empty or /stop). */
  onSessionEnd?(guildId: string): void;
}

export const noopLifecycleHooks: PlayerLifecycleHooks = {};
