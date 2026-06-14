import type { ChatInputCommandInteraction } from 'discord.js';
import type { GuildPlayer } from './GuildPlayer.js';
import { importPlaylist, isYouTubePlaylistUrl } from './playlistImport.js';
import { MAX_QUEUE_SIZE, type QueueAddResult } from './types.js';
import { fetchSingleTrack } from './youtube.js';
import { YtDlpCookiesFileError, YtDlpYouTubeAccessError } from './ytdlp.js';
import { formatAddResult, formatPlayJobComplete, formatPlaylistImportUserMessage } from '../utils/format.js';
import { validateYouTubeInput } from '../utils/validators.js';
import { getBuildLabel } from '../utils/buildInfo.js';
import { logger } from '../utils/logger.js';

interface PlayJob {
  guildId: string;
  interaction: ChatInputCommandInteraction;
  url: string;
  player: GuildPlayer;
}

export class PlayJobQueue {
  private readonly pending = new Map<string, PlayJob[]>();
  private readonly running = new Set<string>();

  enqueue(job: PlayJob): void {
    const queue = this.pending.get(job.guildId) ?? [];
    const waitCount = queue.length + (this.running.has(job.guildId) ? 1 : 0);
    queue.push(job);
    this.pending.set(job.guildId, queue);

    logger.info(`Play job queued: position=${String(waitCount + 1)} guild=${job.guildId}`);

    void job.interaction.editReply({
      content:
        waitCount > 0
          ? `プレイリスト取り込みを受け付けました。現在 ${String(waitCount)} 件待ちです。`
          : 'プレイリスト取り込みを受け付けました。',
    });

    void this.pump(job.guildId);
  }

  private async pump(guildId: string): Promise<void> {
    if (this.running.has(guildId)) {
      return;
    }

    const queue = this.pending.get(guildId);
    if (!queue || queue.length === 0) {
      return;
    }

    this.running.add(guildId);

    while (queue.length > 0) {
      const job = queue.shift()!;
      if (queue.length > 0) {
        logger.info(`Play job next started: guild=${guildId}`);
      }

      try {
        await this.processJob(job);
      } catch (error) {
        logger.error(`Play job failed: guild=${guildId}`, error);
        const message = error instanceof Error ? error.message : '不明なエラー';
        await job.interaction.editReply({
          content: `取り込み中にエラーが発生しました。\n${message}`,
        }).catch(() => undefined);
      }

      logger.info(`Play job finished: guild=${guildId}`);
    }

    this.running.delete(guildId);
    if (queue.length === 0) {
      this.pending.delete(guildId);
    }
  }

  private async processJob(job: PlayJob): Promise<void> {
    const { guildId, interaction, url, player } = job;

    logger.info(`Play job started: guild=${guildId} playlist=${String(isYouTubePlaylistUrl(url))} build=${getBuildLabel()}`);

    const validationError = validateYouTubeInput(url);
    if (validationError) {
      await interaction.editReply({ content: validationError });
      return;
    }

    const initialSlots = player.queue.availableEnqueueCount();
    logger.info(
      `Play job queue slots: availableEnqueueCount=${String(initialSlots)} limit=${String(MAX_QUEUE_SIZE)}`,
    );
    if (initialSlots <= 0) {
      await interaction.editReply({
        content: `キューが上限（${MAX_QUEUE_SIZE}曲）に達しているため、曲を追加できません。`,
      });
      return;
    }

    await interaction.editReply({
      content: 'プレイリストを取り込み中です。大規模リストの場合、数分かかる場合があります。',
    });

    const wasIdle = !player.isPlaying && player.queue.current === null;
    const previousNextUrl = player.queue.peekNext()?.url;
    let playbackStarted = false;
    let totalAdded = 0;
    let totalQueueFull = 0;
    let totalSkipped = 0;
    let firstTrackTitle = '';
    let queueNotified = false;

    const accumulateAdd = (addResult: QueueAddResult): void => {
      totalAdded += addResult.added;
      totalQueueFull += addResult.queueFull;
    };

    try {
      if (isYouTubePlaylistUrl(url)) {
        const importResult = await importPlaylist(
          url,
          interaction.user.tag,
          initialSlots,
          {
            onStrategy: () => {
              // logged inside importPlaylist
            },
            getRemainingSlots: () => {
              const slots = player.queue.availableEnqueueCount();
              return slots;
            },
            onChunk: async (tracks) => {
              const addResult = player.queue.enqueue(tracks);
              accumulateAdd(addResult);

              if (tracks.length > 0 && !firstTrackTitle) {
                firstTrackTitle = tracks[0]!.title;
              }

              logger.info(
                `Playlist import progress: added=${String(totalAdded)} skipped=${String(totalSkipped)} limit=${String(initialSlots)} remainingSlots=${String(player.queue.availableEnqueueCount())}`,
              );

              if (wasIdle && !playbackStarted && addResult.added > 0) {
                const next = player.queue.takeNextTrack();
                if (next) {
                  player.attachInteractionStatus(interaction);
                  try {
                    await player.start(next);
                    playbackStarted = true;
                    firstTrackTitle = next.title;
                  } catch {
                    await interaction.editReply({
                      content: '再生を開始できませんでした。',
                    });
                    return;
                  }
                }
              } else if (!wasIdle && addResult.added > 0 && !queueNotified) {
                const newNextUrl = player.queue.peekNext()?.url;
                if (previousNextUrl !== newNextUrl) {
                  player.notifyQueueChanged('play');
                } else {
                  player.refreshPrefetch();
                }
                queueNotified = true;
              }
            },
          },
        );

        totalSkipped = importResult.totalSkipped;

        logger.info(
          `Playlist import complete: added=${String(totalAdded)} skipped=${String(totalSkipped)} source=${importResult.source}`,
        );

        if (totalAdded === 0) {
          await interaction.editReply({
            content:
              importResult.skippedReasons.length > 0
                ? `追加できる曲がありませんでした。\n${importResult.skippedReasons.slice(0, 5).join('\n')}`
                : '追加できる曲がありませんでした。',
          });
          return;
        }

        const prefix = wasIdle && playbackStarted
          ? `▶ **${firstTrackTitle}** を再生開始しました。`
          : `**${firstTrackTitle || 'プレイリスト'}** をキューに追加しました。`;

        const importNotice = formatPlaylistImportUserMessage(importResult, totalAdded);
        const bodyLines = [
          importNotice,
          formatPlayJobComplete({
            added: totalAdded,
            skipped: totalSkipped,
            queueFull: totalQueueFull,
          }),
        ].filter((line): line is string => line != null && line.length > 0);

        await interaction.editReply({
          content: `${prefix}\n${bodyLines.join('\n')}`,
        });
        return;
      }

      const fetchResult = await fetchSingleTrack(url, interaction.user.tag);
      totalSkipped = fetchResult.skipped;

      if (fetchResult.tracks.length === 0) {
        await interaction.editReply({
          content:
            fetchResult.skippedReasons.length > 0
              ? `追加できる曲がありませんでした。\n${fetchResult.skippedReasons.slice(0, 5).join('\n')}`
              : '追加できる曲がありませんでした。',
        });
        return;
      }

      const addResult = player.queue.enqueue(fetchResult.tracks);
      accumulateAdd(addResult);
      firstTrackTitle = fetchResult.tracks[0]!.title;

      if (!wasIdle) {
        const newNextUrl = player.queue.peekNext()?.url;
        if (previousNextUrl !== newNextUrl) {
          player.notifyQueueChanged('play');
        } else {
          player.refreshPrefetch();
        }
      }

      if (wasIdle) {
        const next = player.queue.takeNextTrack();
        if (next) {
          player.attachInteractionStatus(interaction);
          try {
            await player.start(next);
            playbackStarted = true;
          } catch {
            await interaction.editReply({
              content: '再生を開始できませんでした。',
            });
            return;
          }
        }
      }

      const prefix = wasIdle && playbackStarted
        ? `▶ **${firstTrackTitle}** を再生開始しました。`
        : `**${firstTrackTitle}** をキューに追加しました。`;

      await interaction.editReply({
        content: `${prefix}\n${formatAddResult(addResult, fetchResult)}`,
      });
    } catch (error) {
      let message = error instanceof Error ? error.message : '不明なエラー';
      if (error instanceof YtDlpCookiesFileError || error instanceof YtDlpYouTubeAccessError) {
        message = error.message;
      }
      await interaction.editReply({
        content: `YouTubeから曲情報を取得できませんでした。\n${message}`,
      });
    }
  }
}
