import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    AppConfig,
    bytesForTier,
    PlanTier,
} from '../config/configuration';
import { PrivilegedUsersService } from './privileged-users.service';
import { SubscriptionStatus, User } from './user.entity';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Show the renewal warning when fewer than this many days remain. */
const WARN_WINDOW_DAYS = 30;

/** A user's resolved storage entitlement at a point in time. */
export interface Entitlement {
  /** Member of the privileged list (free top tier, never expires). */
  privileged: boolean;
  /** The plan the user pays for. */
  plan: PlanTier;
  /** The plan actually in effect right now. */
  effectiveTier: PlanTier;
  /** Storage allowance for the effective tier, in bytes. */
  quotaBytes: number;
  subscriptionStatus: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Whether a paid plan is currently active (paid period not yet ended). */
  paidActive: boolean;
  /** Whole days remaining until the paid period ends, or null. */
  daysUntilExpiry: number | null;
  /**
   * True when the user has a paid plan that will NOT auto-renew and the paid
   * period ends within the warning window — they must pay again or reduce their
   * vault to the free allowance or the account will be deleted.
   */
  warnExpiringSoon: boolean;
}

/**
 * Computes what storage a user is actually entitled to, combining the
 * privileged list, the paid plan, and the Stripe subscription window. A paid
 * plan stays in effect until {@link User.currentPeriodEnd} even after the user
 * cancels (they have already paid for the year).
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly config: ConfigService,
    private readonly privileged: PrivilegedUsersService,
  ) {}

  private get app(): AppConfig {
    return this.config.get<AppConfig>('app');
  }

  bytesFor(tier: PlanTier): number {
    return bytesForTier(this.app.tiers, tier);
  }

  /** Whether the Stripe billing feature is switched on. */
  get billingEnabled(): boolean {
    return this.app.stripe.enabled;
  }

  /** Whether Stripe is fully configured so users can actually pay. */
  get billingReady(): boolean {
    return this.app.stripe.ready;
  }

  /** The free allowance in bytes (1 GB by default). */
  get freeBytes(): number {
    return this.app.tiers.free;
  }

  async forUser(user: User): Promise<Entitlement> {
    // Billing switched off (self-hosting): everyone shares the same allowance
    // (STORAGE_QUOTA_GB). No plans, subscriptions, privileges or warnings apply.
    if (!this.billingEnabled) {
      return {
        privileged: false,
        plan: 'free',
        effectiveTier: 'free',
        quotaBytes: this.freeBytes,
        subscriptionStatus: 'none',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        paidActive: false,
        daysUntilExpiry: null,
        warnExpiringSoon: false,
      };
    }

    const privileged = await this.privileged.isPrivileged(user.username);
    const now = Date.now();
    const periodEnd = user.currentPeriodEnd
      ? new Date(user.currentPeriodEnd)
      : null;
    const periodEndMs = periodEnd ? periodEnd.getTime() : 0;

    if (privileged) {
      return {
        privileged: true,
        plan: user.plan,
        effectiveTier: 'plus20',
        quotaBytes: this.bytesFor('plus20'),
        subscriptionStatus: user.subscriptionStatus,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: user.cancelAtPeriodEnd,
        paidActive: false,
        daysUntilExpiry: null,
        warnExpiringSoon: false,
      };
    }

    const paidActive =
      user.plan !== 'free' && periodEndMs > now;
    const effectiveTier: PlanTier = paidActive ? user.plan : 'free';
    const daysUntilExpiry = paidActive
      ? Math.ceil((periodEndMs - now) / DAY_MS)
      : null;

    // Warn when a paid, non-renewing plan is about to lapse.
    const notRenewing =
      user.cancelAtPeriodEnd || user.subscriptionStatus === 'canceled';
    const warnExpiringSoon =
      paidActive &&
      notRenewing &&
      daysUntilExpiry !== null &&
      daysUntilExpiry <= WARN_WINDOW_DAYS;

    return {
      privileged: false,
      plan: user.plan,
      effectiveTier,
      quotaBytes: this.bytesFor(effectiveTier),
      subscriptionStatus: user.subscriptionStatus,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: user.cancelAtPeriodEnd,
      paidActive,
      daysUntilExpiry,
      warnExpiringSoon,
    };
  }
}
