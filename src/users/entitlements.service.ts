import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, bytesForTier, PlanTier } from '../config/configuration';
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

  /**
   * Collapse any stored plan value to the current model. Older records may hold
   * legacy tier ids (e.g. "plus5"/"plus20") from before the single paid plan;
   * treat anything that isn't "free" as the paid "plus" tier.
   */
  private normalizePlan(plan: PlanTier | string): PlanTier {
    return plan === 'free' ? 'free' : 'plus';
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

  /** The dedicated privileged-user allowance in bytes (STORAGE_PRIVILEGED_USERS_GB). */
  get privilegedBytes(): number {
    return this.app.privilegedQuotaBytes;
  }

  async forUser(user: User): Promise<Entitlement> {
    const now = Date.now();
    const periodEnd = user.currentPeriodEnd
      ? new Date(user.currentPeriodEnd)
      : null;
    const periodEndMs = periodEnd ? periodEnd.getTime() : 0;
    const plan = this.normalizePlan(user.plan);

    // Privileged users get a fixed, dedicated allowance
    // (STORAGE_PRIVILEGED_USERS_GB) for free, no payment, no upgrade button.
    // Checked regardless of whether billing is on so the override always wins.
    if (await this.privileged.isPrivileged(user.username)) {
      return {
        privileged: true,
        plan,
        effectiveTier: 'plus',
        quotaBytes: this.privilegedBytes,
        subscriptionStatus: user.subscriptionStatus,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: user.cancelAtPeriodEnd,
        paidActive: false,
        daysUntilExpiry: null,
        warnExpiringSoon: false,
      };
    }

    // Billing switched off (self-hosting): everyone else shares the same
    // allowance (STORAGE_QUOTA_GB). No plans, subscriptions or warnings apply.
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

    const paidActive = plan !== 'free' && periodEndMs > now;
    const effectiveTier: PlanTier = paidActive ? plan : 'free';
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
      plan,
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
