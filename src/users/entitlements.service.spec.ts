import { ConfigService } from '@nestjs/config';
import { EntitlementsService } from './entitlements.service';
import { PrivilegedUsersService } from './privileged-users.service';
import { User } from './user.entity';

const GIB = 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeService(options: {
  billingEnabled?: boolean;
  billingReady?: boolean;
  privileged?: boolean;
  tiers?: { free: number; plus: number };
  privilegedQuotaBytes?: number;
}): EntitlementsService {
  const config = {
    get: jest.fn().mockReturnValue({
      tiers: options.tiers ?? { free: 1 * GIB, plus: 3 * GIB },
      privilegedQuotaBytes: options.privilegedQuotaBytes ?? 20 * GIB,
      stripe: {
        enabled: options.billingEnabled ?? true,
        ready: options.billingReady ?? true,
      },
    }),
  } as unknown as ConfigService;
  const privileged = {
    isPrivileged: jest.fn().mockResolvedValue(options.privileged ?? false),
  } as unknown as PrivilegedUsersService;
  return new EntitlementsService(config, privileged);
}

function makeUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    username: 'alice',
    plan: 'free',
    subscriptionStatus: 'none',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  });
}

describe('EntitlementsService', () => {
  describe('config accessors', () => {
    it('exposes billing flags and byte allowances', () => {
      const service = makeService({
        billingEnabled: true,
        billingReady: false,
        tiers: { free: 100, plus: 500 },
        privilegedQuotaBytes: 999,
      });
      expect(service.billingEnabled).toBe(true);
      expect(service.billingReady).toBe(false);
      expect(service.freeBytes).toBe(100);
      expect(service.privilegedBytes).toBe(999);
      expect(service.bytesFor('free')).toBe(100);
      expect(service.bytesFor('plus')).toBe(500);
    });
  });

  describe('privileged users', () => {
    it('always get the dedicated privileged allowance, even with billing off', async () => {
      const service = makeService({
        privileged: true,
        billingEnabled: false,
        privilegedQuotaBytes: 20 * GIB,
      });
      const ent = await service.forUser(makeUser());
      expect(ent).toMatchObject({
        privileged: true,
        effectiveTier: 'plus',
        quotaBytes: 20 * GIB,
        paidActive: false,
        daysUntilExpiry: null,
        warnExpiringSoon: false,
      });
    });
  });

  describe('billing disabled (self-hosting)', () => {
    it('everyone shares the free allowance without plans or warnings', async () => {
      const service = makeService({
        billingEnabled: false,
        tiers: { free: 8 * GIB, plus: 3 * GIB },
      });
      const ent = await service.forUser(
        makeUser({
          plan: 'plus',
          subscriptionStatus: 'active',
          currentPeriodEnd: new Date(Date.now() + 100 * DAY_MS),
        }),
      );
      expect(ent).toEqual({
        privileged: false,
        plan: 'free',
        effectiveTier: 'free',
        quotaBytes: 8 * GIB,
        subscriptionStatus: 'none',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        paidActive: false,
        daysUntilExpiry: null,
        warnExpiringSoon: false,
      });
    });
  });

  describe('billing enabled', () => {
    it('free users get the free tier', async () => {
      const service = makeService({});
      const ent = await service.forUser(makeUser());
      expect(ent).toMatchObject({
        plan: 'free',
        effectiveTier: 'free',
        quotaBytes: 1 * GIB,
        paidActive: false,
        warnExpiringSoon: false,
      });
    });

    it('an active paid plan grants the plus tier until the period end', async () => {
      const service = makeService({});
      const ent = await service.forUser(
        makeUser({
          plan: 'plus',
          subscriptionStatus: 'active',
          currentPeriodEnd: new Date(Date.now() + 100 * DAY_MS),
        }),
      );
      expect(ent).toMatchObject({
        plan: 'plus',
        effectiveTier: 'plus',
        quotaBytes: 3 * GIB,
        paidActive: true,
        daysUntilExpiry: 100,
        warnExpiringSoon: false,
      });
    });

    it('a lapsed paid plan falls back to the free tier', async () => {
      const service = makeService({});
      const ent = await service.forUser(
        makeUser({
          plan: 'plus',
          subscriptionStatus: 'canceled',
          currentPeriodEnd: new Date(Date.now() - DAY_MS),
        }),
      );
      expect(ent).toMatchObject({
        plan: 'plus',
        effectiveTier: 'free',
        quotaBytes: 1 * GIB,
        paidActive: false,
        daysUntilExpiry: null,
        warnExpiringSoon: false,
      });
    });

    it('normalises legacy plan ids to the paid tier', async () => {
      const service = makeService({});
      const ent = await service.forUser(
        makeUser({
          plan: 'plus20' as User['plan'],
          currentPeriodEnd: new Date(Date.now() + 10 * DAY_MS),
        }),
      );
      expect(ent.plan).toBe('plus');
      expect(ent.effectiveTier).toBe('plus');
    });

    describe('renewal warning', () => {
      it('warns when a cancelled plan lapses within 30 days', async () => {
        const service = makeService({});
        const ent = await service.forUser(
          makeUser({
            plan: 'plus',
            subscriptionStatus: 'active',
            cancelAtPeriodEnd: true,
            currentPeriodEnd: new Date(Date.now() + 10 * DAY_MS),
          }),
        );
        expect(ent.warnExpiringSoon).toBe(true);
        expect(ent.daysUntilExpiry).toBe(10);
      });

      it('warns for a canceled subscription status too', async () => {
        const service = makeService({});
        const ent = await service.forUser(
          makeUser({
            plan: 'plus',
            subscriptionStatus: 'canceled',
            currentPeriodEnd: new Date(Date.now() + 5 * DAY_MS),
          }),
        );
        expect(ent.warnExpiringSoon).toBe(true);
      });

      it('does not warn when auto-renew stays on', async () => {
        const service = makeService({});
        const ent = await service.forUser(
          makeUser({
            plan: 'plus',
            subscriptionStatus: 'active',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: new Date(Date.now() + 10 * DAY_MS),
          }),
        );
        expect(ent.warnExpiringSoon).toBe(false);
      });

      it('does not warn while more than 30 days remain', async () => {
        const service = makeService({});
        const ent = await service.forUser(
          makeUser({
            plan: 'plus',
            subscriptionStatus: 'active',
            cancelAtPeriodEnd: true,
            currentPeriodEnd: new Date(Date.now() + 60 * DAY_MS),
          }),
        );
        expect(ent.warnExpiringSoon).toBe(false);
      });
    });
  });
});
