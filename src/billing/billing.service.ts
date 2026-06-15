import {
    BadRequestException,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { AppConfig, PlanTier, StripeConfig } from '../config/configuration';
import { BlacklistService } from '../users/blacklist.service';
import { SubscriptionStatus, User } from '../users/user.entity';
import { UsersService } from '../users/users.service';

/**
 * Types are derived from the client instance because this package version
 * exposes resource types through the instance rather than a `Stripe.*`
 * namespace under the classic module resolution used by this project.
 */
type StripeClient = InstanceType<typeof Stripe>;
type StripeSubscription = Awaited<
  ReturnType<StripeClient['subscriptions']['retrieve']>
>;
type StripeCheckoutSession = Awaited<
  ReturnType<StripeClient['checkout']['sessions']['retrieve']>
>;


/**
 * Thin wrapper around the Stripe API for the recurring (annual) storage plans.
 *
 * Subscriptions are billed yearly. A user may cancel at any time; Stripe keeps
 * the subscription active until the end of the paid period, which we mirror via
 * {@link User.currentPeriodEnd} so the plan stays in effect for the full year.
 *
 * State is kept in sync without webhooks: the app pulls the current
 * subscription from Stripe right after checkout (via the returned session id)
 * and again during the nightly reconcile job / on dashboard load.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger('BillingService');
  private readonly cfg: StripeConfig;
  private readonly stripe: StripeClient | null;

  constructor(
    config: ConfigService,
    private readonly users: UsersService,
    private readonly blacklist: BlacklistService,
  ) {
    this.cfg = config.get<AppConfig>('app').stripe;
    this.stripe = this.cfg.ready ? new Stripe(this.cfg.secretKey) : null;
    if (this.cfg.enabled && !this.stripe) {
      this.logger.warn(
        'Billing is enabled but Stripe is not fully configured ' +
          '(STRIPE_SECRET_KEY missing). The plan UI is shown but checkout ' +
          'will be unavailable until Stripe keys are set.',
      );
    }
  }

  /** Whether the billing feature is switched on (tiers + dashboard UI). */
  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Whether Stripe is fully configured so checkout/portal actually work. */
  get ready(): boolean {
    return this.stripe !== null;
  }

  private requireStripe(): StripeClient {
    if (!this.stripe) {
      throw new ServiceUnavailableException('Billing is not configured.');
    }
    return this.stripe;
  }

  /** Stripe recurring price id for a paid plan. */
  private priceFor(plan: PlanTier): string {
    const price =
      plan === 'plus5'
        ? this.cfg.priceId5gb
        : plan === 'plus20'
          ? this.cfg.priceId20gb
          : '';
    if (!price) {
      throw new ServiceUnavailableException(
        'No Stripe price configured for this plan.',
      );
    }
    return price;
  }

  /** Reverse-map a Stripe price id back to one of our plans. */
  private planForPrice(priceId: string | undefined): PlanTier | null {
    if (priceId && priceId === this.cfg.priceId5gb) return 'plus5';
    if (priceId && priceId === this.cfg.priceId20gb) return 'plus20';
    return null;
  }

  /**
   * Create a Checkout Session for an annual subscription and return its URL.
   * The user id is attached as `client_reference_id` and subscription metadata
   * so the account can be resynced from the session after checkout.
   */
  async createCheckoutSession(user: User, plan: PlanTier): Promise<string> {
    const stripe = this.requireStripe();
    if (plan !== 'plus5' && plan !== 'plus20') {
      throw new BadRequestException('Invalid plan.');
    }
    const price = this.priceFor(plan);
    const base = this.cfg.appUrl;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer: user.stripeCustomerId || undefined,
      client_reference_id: String(user.id),
      success_url: `${base}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?checkout=cancel`,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { userId: String(user.id), plan },
      },
      metadata: { userId: String(user.id), plan },
    });
    if (!session.url) {
      throw new ServiceUnavailableException(
        'Stripe did not return a checkout URL.',
      );
    }
    return session.url;
  }

  /**
   * Create a Billing Portal session so the user can manage / cancel their
   * subscription. Returns the portal URL.
   */
  async createPortalSession(user: User): Promise<string> {
    const stripe = this.requireStripe();
    if (!user.stripeCustomerId) {
      throw new BadRequestException('No billing account exists yet.');
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${this.cfg.appUrl}/`,
    });
    return session.url;
  }

  /**
   * Sync a user's record from the Checkout Session they were redirected back
   * from (the `session_id` appended to the success URL). Called by the
   * dashboard right after a successful checkout. Returns true if a paid
   * subscription was applied.
   */
  async syncFromCheckoutSession(
    sessionId: string,
    expectedUserId?: number,
  ): Promise<boolean> {
    const stripe = this.requireStripe();
    let session: StripeCheckoutSession;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      return false;
    }
    const userId = Number(session.client_reference_id);
    if (!Number.isFinite(userId)) {
      return false;
    }
    // Guard against a user passing someone else's session id.
    if (expectedUserId !== undefined && userId !== expectedUserId) {
      return false;
    }
    if (
      typeof session.subscription === 'string' &&
      session.subscription.length > 0
    ) {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      await this.applySubscription(sub);
      return true;
    }
    return false;
  }

  /**
   * Refresh a user's plan/subscription fields from Stripe. Best-effort: returns
   * silently if the user has no subscription or Stripe is unavailable. Used by
   * the nightly reconcile job and on-demand from the dashboard.
   */
  async syncUser(user: User): Promise<void> {
    if (!this.stripe || !user.stripeSubscriptionId) {
      return;
    }
    try {
      const sub = await this.stripe.subscriptions.retrieve(
        user.stripeSubscriptionId,
      );
      await this.applySubscription(sub);
    } catch (err) {
      this.logger.warn(
        `Could not sync subscription for "${user.username}": ${String(err)}`,
      );
    }
  }

  /** Mirror a Stripe subscription onto the owning user record. */
  private async applySubscription(sub: StripeSubscription): Promise<void> {
    const userId = Number(sub.metadata?.userId);
    const user = Number.isFinite(userId)
      ? await this.users.findById(userId)
      : null;
    if (!user) {
      this.logger.warn(
        `Received subscription ${sub.id} with no resolvable user; ignoring.`,
      );
      return;
    }

    const priceId = sub.items?.data?.[0]?.price?.id;
    const plan = this.planForPrice(priceId);
    if (plan) {
      user.plan = plan;
    }
    user.stripeSubscriptionId = sub.id;
    user.stripeCustomerId =
      typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    user.cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);
    user.subscriptionStatus = this.mapStatus(sub.status);

    // `current_period_end` is a Unix timestamp (seconds). In newer Stripe API
    // versions it lives on each subscription item rather than the subscription
    // object, so fall back to the item-level value (then `cancel_at`/`ended_at`).
    const periodEnd = this.resolvePeriodEnd(sub);
    if (typeof periodEnd === 'number') {
      user.currentPeriodEnd = new Date(periodEnd * 1000);
    }

    await this.users.save(user);

    // An active payment clears any pending deletion flag.
    if (
      user.subscriptionStatus === 'active' &&
      user.currentPeriodEnd &&
      user.currentPeriodEnd.getTime() > Date.now()
    ) {
      await this.blacklist.remove(user.username);
    }
  }

  /**
   * Resolve the subscription's current period end (Unix seconds), handling both
   * the legacy top-level field and the newer per-item location.
   */
  private resolvePeriodEnd(sub: StripeSubscription): number | undefined {
    const anySub = sub as unknown as {
      current_period_end?: number;
      cancel_at?: number;
      ended_at?: number;
      items?: { data?: Array<{ current_period_end?: number }> };
    };
    if (typeof anySub.current_period_end === 'number') {
      return anySub.current_period_end;
    }
    const itemEnd = anySub.items?.data?.[0]?.current_period_end;
    if (typeof itemEnd === 'number') {
      return itemEnd;
    }
    if (typeof anySub.cancel_at === 'number') {
      return anySub.cancel_at;
    }
    if (typeof anySub.ended_at === 'number') {
      return anySub.ended_at;
    }
    return undefined;
  }

  private mapStatus(status: string): SubscriptionStatus {
    switch (status) {
      case 'active':
      case 'trialing':
        return 'active';
      case 'past_due':
        return 'past_due';
      case 'canceled':
        return 'canceled';
      default:
        return 'incomplete';
    }
  }
}
