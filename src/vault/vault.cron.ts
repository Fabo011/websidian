import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UsersService } from '../users/users.service';
import { VaultService } from './vault.service';

/**
 * Nightly purge of soft-deleted items. For every user, trash batches older than
 * the configured retention window (TRASH_RETENTION_DAYS, default 7) are removed
 * permanently. When retention is disabled the vault service short-circuits, so
 * this is a no-op.
 */
@Injectable()
export class TrashCron {
  private readonly logger = new Logger('TrashCron');

  constructor(
    private readonly users: UsersService,
    private readonly vault: VaultService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purge(): Promise<void> {
    const users = await this.users.findAll();
    let purged = 0;

    for (const user of users) {
      try {
        purged += await this.vault.purgeExpiredTrash(user.username);
      } catch (err) {
        this.logger.error(
          `Failed to purge trash for user "${user.username}": ${String(err)}`,
        );
      }
    }

    if (purged > 0) {
      this.logger.log(
        `Trash purge complete: ${purged} expired batch(es) removed across ${users.length} users.`,
      );
    }
  }
}
