import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlacklistService } from '../users/blacklist.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { BillingService } from './billing.service';

interface StripeMock {
  checkout: { sessions: { create: jest.Mock; retrieve: jest.Mock } };
  billingPortal: { sessions: { create: jest.Mock } };
  subscriptions: { retrieve: jest.Mock };
}

function makeStripeMock(): StripeMock {
  return {
    checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    subscriptions: { retrieve: jest.fn() },
  };
}

function makeService(
  options: { enabled?: boolean; withStripe?: boolean } = {},
): {
  service: BillingService;
  stripe: StripeMock;
  users: { findById: jest.Mock; save: jest.Mock };
  blacklist: { remove: jest.Mock };
} {
  const config = {
    get: jest.fn().mockReturnValue({
      stripe: {
        enabled: options.enabled ?? true,
        // Always construct without a real Stripe client; tests inject a mock.
        ready: false,
        secretKey: '',
        priceIdPlus: 'price_plus',
        appUrl: 'https://app.example.com',
      },
    }),
  } as unknown as ConfigService;
  const users = {
    findById: jest.fn(),
    save: jest.fn().mockImplementation((u) => Promise.resolve(u)),
  };
  const blacklist = { remove: jest.fn().mockResolvedValue(undefined) };
  const service = new BillingService(
    config,
    users as unknown as UsersService,
    blacklist as unknown as BlacklistService,
  );
  const stripe = makeStripeMock();
  if (options.withStripe !== false) {
    (service as unknown as { stripe: StripeMock }).stripe = stripe;
  }
  return { service, stripe, users, blacklist };
}

const makeUser = (overrides: Partial<User> = {}): User =>
  Object.assign(new User(), {
    id: 7,
    username: 'alice',
    plan: 'free',
    subscriptionStatus: 'none',
    cancelAtPeriodEnd: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    ...overrides,
  });

const subscription = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  cancel_at_period_end: false,
  metadata: { userId: '7', plan: 'plus' },
  items: { data: [{ price: { id: 'price_plus' } }] },
  current_period_end: Math.floor(Date.now() / 1000) + 86400,
  ...overrides,
});

describe('BillingService', () => {
  describe('flags', () => {
    it('reflects the feature flag and Stripe readiness', () => {
      const withStripe = makeService({ enabled: true });
      expect(withStripe.service.enabled).toBe(true);
      expect(withStripe.service.ready).toBe(true);

      const without = makeService({ enabled: false, withStripe: false });
      expect(without.service.enabled).toBe(false);
      expect(without.service.ready).toBe(false);
    });
  });

  describe('createCheckoutSession', () => {
    it('rejects when Stripe is not configured', async () => {
      const { service } = makeService({ withStripe: false });
      await expect(
        service.createCheckoutSession(makeUser(), 'plus'),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('rejects unknown plans', async () => {
      const { service } = makeService();
      await expect(
        service.createCheckoutSession(makeUser(), 'free'),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates an annual subscription session tagged with the user id', async () => {
      const { service, stripe } = makeService();
      stripe.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/s/1',
      });

      const url = await service.createCheckoutSession(
        makeUser({ stripeCustomerId: 'cus_1' }),
        'plus',
      );

      expect(url).toBe('https://checkout.stripe.com/s/1');
      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          line_items: [{ price: 'price_plus', quantity: 1 }],
          customer: 'cus_1',
          client_reference_id: '7',
          success_url:
            'https://app.example.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
          cancel_url: 'https://app.example.com/?checkout=cancel',
          metadata: { userId: '7', plan: 'plus' },
        }),
      );
    });

    it('omits the customer for first-time buyers', async () => {
      const { service, stripe } = makeService();
      stripe.checkout.sessions.create.mockResolvedValue({ url: 'https://x' });
      await service.createCheckoutSession(makeUser(), 'plus');
      expect(
        stripe.checkout.sessions.create.mock.calls[0][0].customer,
      ).toBeUndefined();
    });

    it('fails when Stripe returns no URL', async () => {
      const { service, stripe } = makeService();
      stripe.checkout.sessions.create.mockResolvedValue({ url: null });
      await expect(
        service.createCheckoutSession(makeUser(), 'plus'),
      ).rejects.toThrow('Stripe did not return a checkout URL.');
    });
  });

  describe('createPortalSession', () => {
    it('requires an existing billing account', async () => {
      const { service } = makeService();
      await expect(service.createPortalSession(makeUser())).rejects.toThrow(
        'No billing account exists yet.',
      );
    });

    it('returns the portal URL', async () => {
      const { service, stripe } = makeService();
      stripe.billingPortal.sessions.create.mockResolvedValue({
        url: 'https://portal.stripe.com/p/1',
      });
      await expect(
        service.createPortalSession(makeUser({ stripeCustomerId: 'cus_1' })),
      ).resolves.toBe('https://portal.stripe.com/p/1');
      expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_1',
        return_url: 'https://app.example.com/',
      });
    });
  });

  describe('syncFromCheckoutSession', () => {
    it('returns false when the session cannot be retrieved', async () => {
      const { service, stripe } = makeService();
      stripe.checkout.sessions.retrieve.mockRejectedValue(new Error('nope'));
      await expect(service.syncFromCheckoutSession('cs_1')).resolves.toBe(
        false,
      );
    });

    it('returns false without a numeric client reference', async () => {
      const { service, stripe } = makeService();
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        client_reference_id: 'not-a-number',
        subscription: 'sub_1',
      });
      await expect(service.syncFromCheckoutSession('cs_1')).resolves.toBe(
        false,
      );
    });

    it("rejects another user's session id", async () => {
      const { service, stripe } = makeService();
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        client_reference_id: '7',
        subscription: 'sub_1',
      });
      await expect(service.syncFromCheckoutSession('cs_1', 99)).resolves.toBe(
        false,
      );
    });

    it('returns false when the session carries no subscription', async () => {
      const { service, stripe } = makeService();
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        client_reference_id: '7',
        subscription: null,
      });
      await expect(service.syncFromCheckoutSession('cs_1', 7)).resolves.toBe(
        false,
      );
    });

    it('applies the subscription to the user on success', async () => {
      const { service, stripe, users } = makeService();
      const user = makeUser();
      users.findById.mockResolvedValue(user);
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        client_reference_id: '7',
        subscription: 'sub_1',
      });
      stripe.subscriptions.retrieve.mockResolvedValue(subscription());

      await expect(service.syncFromCheckoutSession('cs_1', 7)).resolves.toBe(
        true,
      );
      expect(user.plan).toBe('plus');
      expect(user.stripeSubscriptionId).toBe('sub_1');
      expect(user.stripeCustomerId).toBe('cus_1');
      expect(user.subscriptionStatus).toBe('active');
      expect(users.save).toHaveBeenCalledWith(user);
    });
  });

  describe('syncUser', () => {
    it('does nothing without Stripe or a subscription id', async () => {
      const noStripe = makeService({ withStripe: false });
      await expect(
        noStripe.service.syncUser(makeUser()),
      ).resolves.toBeUndefined();

      const { service, stripe } = makeService();
      await service.syncUser(makeUser({ stripeSubscriptionId: null }));
      expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    });

    it('swallows Stripe errors (best effort)', async () => {
      const { service, stripe } = makeService();
      stripe.subscriptions.retrieve.mockRejectedValue(new Error('down'));
      await expect(
        service.syncUser(makeUser({ stripeSubscriptionId: 'sub_1' })),
      ).resolves.toBeUndefined();
    });

    it('refreshes the user from the live subscription', async () => {
      const { service, stripe, users } = makeService();
      const user = makeUser({ stripeSubscriptionId: 'sub_1' });
      users.findById.mockResolvedValue(user);
      stripe.subscriptions.retrieve.mockResolvedValue(
        subscription({ cancel_at_period_end: true }),
      );

      await service.syncUser(user);
      expect(user.cancelAtPeriodEnd).toBe(true);
      expect(users.save).toHaveBeenCalledWith(user);
    });
  });

  describe('applySubscription (via sync)', () => {
    async function apply(
      sub: Record<string, unknown>,
      user: User | null = makeUser(),
    ): Promise<{
      users: { findById: jest.Mock; save: jest.Mock };
      blacklist: { remove: jest.Mock };
    }> {
      const { service, stripe, users, blacklist } = makeService();
      users.findById.mockResolvedValue(user);
      stripe.subscriptions.retrieve.mockResolvedValue(sub);
      await service.syncUser(makeUser({ stripeSubscriptionId: 'sub_1' }));
      return { users, blacklist };
    }

    it('ignores subscriptions without a resolvable user', async () => {
      const { users } = await apply(subscription({ metadata: {} }), null);
      expect(users.save).not.toHaveBeenCalled();
    });

    it('maps stripe statuses to internal ones', async () => {
      const user = makeUser();
      const cases: Array<[string, string]> = [
        ['active', 'active'],
        ['trialing', 'active'],
        ['past_due', 'past_due'],
        ['canceled', 'canceled'],
        ['unpaid', 'incomplete'],
      ];
      for (const [stripeStatus, internal] of cases) {
        await apply(subscription({ status: stripeStatus }), user);
        expect(user.subscriptionStatus).toBe(internal);
      }
    });

    it('keeps the existing plan for unknown price ids', async () => {
      const user = makeUser({ plan: 'plus' });
      await apply(
        subscription({ items: { data: [{ price: { id: 'price_other' } }] } }),
        user,
      );
      expect(user.plan).toBe('plus');
    });

    it('reads the period end from the item level when top-level is absent', async () => {
      const user = makeUser();
      const end = Math.floor(Date.now() / 1000) + 1000;
      await apply(
        subscription({
          current_period_end: undefined,
          items: {
            data: [{ price: { id: 'price_plus' }, current_period_end: end }],
          },
        }),
        user,
      );
      expect(user.currentPeriodEnd).toEqual(new Date(end * 1000));
    });

    it('falls back to cancel_at, then ended_at', async () => {
      const user = makeUser();
      const cancelAt = Math.floor(Date.now() / 1000) + 500;
      await apply(
        subscription({
          current_period_end: undefined,
          items: { data: [{ price: { id: 'price_plus' } }] },
          cancel_at: cancelAt,
        }),
        user,
      );
      expect(user.currentPeriodEnd).toEqual(new Date(cancelAt * 1000));

      const endedAt = Math.floor(Date.now() / 1000) - 500;
      await apply(
        subscription({
          current_period_end: undefined,
          items: { data: [{ price: { id: 'price_plus' } }] },
          ended_at: endedAt,
        }),
        user,
      );
      expect(user.currentPeriodEnd).toEqual(new Date(endedAt * 1000));
    });

    it('accepts an expanded customer object', async () => {
      const user = makeUser();
      await apply(subscription({ customer: { id: 'cus_9' } }), user);
      expect(user.stripeCustomerId).toBe('cus_9');
    });

    it('clears the deletion blacklist after an active, unexpired payment', async () => {
      const { blacklist } = await apply(subscription());
      expect(blacklist.remove).toHaveBeenCalledWith('alice');
    });

    it('does not clear the blacklist for lapsed subscriptions', async () => {
      const { blacklist } = await apply(
        subscription({
          status: 'canceled',
          current_period_end: Math.floor(Date.now() / 1000) - 86400,
        }),
      );
      expect(blacklist.remove).not.toHaveBeenCalled();
    });
  });
});
