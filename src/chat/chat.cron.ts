import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppConfig } from '../config/configuration';
import { ChatService } from './chat.service';

/**
 * Nightly purge of the transient offline-delivery queue. Envelopes that have
 * sat undelivered longer than CHAT_PENDING_TTL_DAYS (the recipient never came
 * back) are removed so ciphertext cannot accumulate forever. This never touches
 * real chat history, which lives in users' own vault storage.
 */
@Injectable()
export class ChatCron {
  private readonly logger = new Logger('ChatCron');

  constructor(
    private readonly chat: ChatService,
    private readonly config: ConfigService,
  ) {}

  private get app(): AppConfig {
    return this.config.get<AppConfig>('app');
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purge(): Promise<void> {
    try {
      const removed = await this.chat.purgeOlderThan(
        this.app.chatPendingTtlDays,
      );
      if (removed > 0) {
        this.logger.log(`Purged ${removed} expired pending chat envelope(s).`);
      }
    } catch (err) {
      this.logger.error(`Pending chat purge failed: ${String(err)}`);
    }
  }
}
