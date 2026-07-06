import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedUser } from '../auth/auth.types';
import { EntitlementsService } from '../users/entitlements.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

const CURRENT: AuthenticatedUser = {
  id: 7,
  username: 'alice',
  storageId: 'sid-7',
};

function makeController(options: { ready?: boolean } = {}): {
  controller: BillingController;
  billing: {
    enabled: boolean;
    ready: boolean;
    createCheckoutSession: jest.Mock;
    createPortalSession: jest.Mock;
    syncFromCheckoutSession: jest.Mock;
    syncUser: jest.Mock;
  };
  users: { findById: jest.Mock };
} {
  const billing = {
    enabled: true,
    ready: options.ready ?? true,
    createCheckoutSession: jest.fn(),
    createPortalSession: jest.fn(),
    syncFromCheckoutSession: jest.fn(),
    syncUser: jest.fn().mockResolvedValue(undefined),
  };
  const users = { findById: jest.fn() };
  const config = {
    get: jest.fn().mockReturnValue({
      pricing: {
        planGb: 3,
        pricePlus: '€10 / year',
        donationLink: '',
        contactEmail: 'help@example.com',
      },
    }),
  } as unknown as ConfigService;
  const controller = new BillingController(
    billing as unknown as BillingService,
    users as unknown as UsersService,
    {} as EntitlementsService,
    config,
  );
  return { controller, billing, users };
}

describe('BillingController', () => {
  it('config exposes the billing flags and plan labelling', () => {
    const { controller } = makeController();
    expect(controller.config()).toEqual({
      enabled: true,
      ready: true,
      planGb: 3,
      planPrice: '€10 / year',
      donationLink: '',
      contactEmail: 'help@example.com',
    });
  });

  describe('checkout', () => {
    it('rejects when the account vanished', async () => {
      const { controller, users } = makeController();
      users.findById.mockResolvedValue(null);
      await expect(
        controller.checkout(CURRENT, { plan: 'plus' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('returns the checkout URL', async () => {
      const { controller, billing, users } = makeController();
      const user = new User();
      users.findById.mockResolvedValue(user);
      billing.createCheckoutSession.mockResolvedValue('https://checkout');

      await expect(
        controller.checkout(CURRENT, { plan: 'plus' }),
      ).resolves.toEqual({ url: 'https://checkout' });
      expect(billing.createCheckoutSession).toHaveBeenCalledWith(user, 'plus');
    });
  });

  describe('portal', () => {
    it('rejects when the account vanished', async () => {
      const { controller, users } = makeController();
      users.findById.mockResolvedValue(null);
      await expect(controller.portal(CURRENT)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('returns the portal URL', async () => {
      const { controller, billing, users } = makeController();
      users.findById.mockResolvedValue(new User());
      billing.createPortalSession.mockResolvedValue('https://portal');
      await expect(controller.portal(CURRENT)).resolves.toEqual({
        url: 'https://portal',
      });
    });
  });

  describe('sync', () => {
    it('reports not-synced when Stripe is unavailable', async () => {
      const { controller, users } = makeController({ ready: false });
      await expect(controller.sync(CURRENT, {})).resolves.toEqual({
        synced: false,
      });
      expect(users.findById).not.toHaveBeenCalled();
    });

    it('rejects when the account vanished', async () => {
      const { controller, users } = makeController();
      users.findById.mockResolvedValue(null);
      await expect(controller.sync(CURRENT, {})).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('syncs from the checkout session when a session id is given', async () => {
      const { controller, billing, users } = makeController();
      const user = Object.assign(new User(), { id: 7 });
      users.findById.mockResolvedValue(user);
      billing.syncFromCheckoutSession.mockResolvedValue(true);

      await expect(
        controller.sync(CURRENT, { sessionId: 'cs_1' }),
      ).resolves.toEqual({ synced: true });
      expect(billing.syncFromCheckoutSession).toHaveBeenCalledWith('cs_1', 7);
      expect(billing.syncUser).not.toHaveBeenCalled();
    });

    it('falls back to a plain user sync without a session id', async () => {
      const { controller, billing, users } = makeController();
      const user = new User();
      users.findById.mockResolvedValue(user);

      await expect(controller.sync(CURRENT, {})).resolves.toEqual({
        synced: true,
      });
      expect(billing.syncUser).toHaveBeenCalledWith(user);
    });
  });
});
