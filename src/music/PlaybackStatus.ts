import type { TextBasedChannel } from 'discord.js';

/** Updates a single Discord message during buffering / playback transitions. */
export interface PlaybackStatusHandler {
  update(content: string): Promise<void>;
  clear?(): void;
}

export function createChannelPlaybackStatus(channel: TextBasedChannel): PlaybackStatusHandler {
  let messageId: string | null = null;

  return {
    async update(content: string): Promise<void> {
      try {
        if (messageId) {
          const message = await channel.messages.fetch(messageId);
          await message.edit({ content });
          return;
        }

        if (!channel.isSendable()) {
          return;
        }

        const sent = await channel.send({ content });
        messageId = sent.id;
      } catch {
        messageId = null;
      }
    },
    clear(): void {
      messageId = null;
    },
  };
}
