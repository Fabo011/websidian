import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BlacklistService } from '../users/blacklist.service';
import { EntitlementsService } from '../users/entitlements.service';
import { UsersService } from '../users/users.service';
import { VaultService } from '../vault/vault.service';
import { BillingService } from './billing.service';

/**
 * Nightly reconciliation of accounts against their entitlements.
 *
 * Each user's subscription is first pulled fresh from Stripe (no webhooks), so
 * cancellations, renewals and failed payments are reflected. Then, for every
 * user that is neither privileged nor has an active paid plan, if their vault
 * exceeds the free 1 GB allowance they are added to the blacklist (slated for
 * deletion). Users who pay or shrink back under the limit are removed again.
 */
@Injectable()
export class BillingCron {
  private readonly logger = new Logger('BillingCron');

  constructor(
    private readonly users: UsersService,
    private readonly entitlements: EntitlementsService,
    private readonly blacklist: BlacklistService,
    private readonly vault: VaultService,
    private readonly billing: BillingService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async reconcile(): Promise<void> {
    // Only reconcile when users can actually pay. If billing is off, or the
    // feature is on but Stripe is not configured yet, never blacklist anyone.
    if (!this.entitlements.billingReady) {
      return;
    }

    const users = await this.users.findAll();
    const freeBytes = this.entitlements.freeBytes;
    let flagged = 0;

    for (const user of users) {
      try {
        // Pull the latest subscription state from Stripe first.
        await this.billing.syncUser(user);
        const ent = await this.entitlements.forUser(user);
        // Privileged or actively paid: ensure they are not blacklisted.
        if (ent.privileged || ent.paidActive) {
          await this.blacklist.remove(user.username);
          continue;
        }
        // Free tier: flag if over the allowance, otherwise clear any flag.
        const used = await this.vault.usedBytes(user.username);
        if (used > freeBytes) {
          await this.blacklist.add(
            user.username,
            'Over the free 1 GB allowance without an active paid plan.',
          );
          flagged++;
        } else {
          await this.blacklist.remove(user.username);
        }
      } catch (err) {
        this.logger.error(
          `Failed to reconcile user "${user.username}": ${String(err)}`,
        );
      }
    }

    this.logger.log(
      `Nightly reconcile complete: ${users.length} users checked, ${flagged} blacklisted.`,
    );
  }
}
