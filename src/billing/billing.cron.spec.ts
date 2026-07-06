import { ConfigService } from '@nestjs/config';
import { BlacklistService } from '../users/blacklist.service';
import { EntitlementsService } from '../users/entitlements.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { VaultService } from '../vault/vault.service';
import { BillingCron } from './billing.cron';
import { BillingService } from './billing.service';

const GIB = 1024 * 1024 * 1024;

function makeCron(options: {
  billingReady?: boolean;
  userStorageEnabled?: boolean;
  users?: Partial<User>[];
}): {
  cron: BillingCron;
  blacklist: { add: jest.Mock; remove: jest.Mock };
  billing: { syncUser: jest.Mock };
  entitlements: { forUser: jest.Mock };
  vault: { usedBytes: jest.Mock };
} {
  const users = {
    findAll: jest
      .fn()
      .mockResolvedValue(
        (options.users ?? []).map((u) => Object.assign(new User(), u)),
      ),
  };
  const entitlements = {
    billingReady: options.billingReady ?? true,
    freeBytes: 1 * GIB,
    forUser: jest
      .fn()
      .mockResolvedValue({ privileged: false, paidActive: false }),
  };
  const blacklist = {
    add: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const vault = { usedBytes: jest.fn().mockResolvedValue(0) };
  const billing = { syncUser: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: jest.fn().mockReturnValue({
      userStorageEnabled: options.userStorageEnabled ?? false,
    }),
  } as unknown as ConfigService;

  const cron = new BillingCron(
    users as unknown as UsersService,
    entitlements as unknown as EntitlementsService,
    blacklist as unknown as BlacklistService,
    vault as unknown as VaultService,
    billing as unknown as BillingService,
    config,
  );
  return { cron, blacklist, billing, entitlements, vault };
}

describe('BillingCron.reconcile', () => {
  it('does nothing when Stripe is not ready (never blacklists)', async () => {
    const { cron, blacklist, billing } = makeCron({
      billingReady: false,
      users: [{ username: 'alice' }],
    });
    await cron.reconcile();
    expect(billing.syncUser).not.toHaveBeenCalled();
    expect(blacklist.add).not.toHaveBeenCalled();
  });

  it('skips own-storage users entirely in bring-your-own mode', async () => {
    const { cron, blacklist, billing } = makeCron({
      userStorageEnabled: true,
      users: [{ username: 'alice', storageDriver: 's3' }],
    });
    await cron.reconcile();
    expect(billing.syncUser).not.toHaveBeenCalled();
    expect(blacklist.remove).toHaveBeenCalledWith('alice');
    expect(blacklist.add).not.toHaveBeenCalled();
  });

  it('still reconciles managed users in bring-your-own mode', async () => {
    const { cron, billing } = makeCron({
      userStorageEnabled: true,
      users: [{ username: 'alice', storageDriver: 'managed' }],
    });
    await cron.reconcile();
    expect(billing.syncUser).toHaveBeenCalled();
  });

  it('syncs from Stripe before evaluating entitlements', async () => {
    const order: string[] = [];
    const { cron, billing, entitlements } = makeCron({
      users: [{ username: 'alice' }],
    });
    billing.syncUser.mockImplementation(async () => {
      order.push('sync');
    });
    entitlements.forUser.mockImplementation(async () => {
      order.push('entitlements');
      return { privileged: false, paidActive: false };
    });
    await cron.reconcile();
    expect(order).toEqual(['sync', 'entitlements']);
  });

  it('clears the flag for privileged or paying users', async () => {
    const { cron, blacklist, entitlements, vault } = makeCron({
      users: [{ username: 'alice' }],
    });
    entitlements.forUser.mockResolvedValue({
      privileged: true,
      paidActive: false,
    });
    await cron.reconcile();
    expect(blacklist.remove).toHaveBeenCalledWith('alice');
    expect(vault.usedBytes).not.toHaveBeenCalled();
  });

  it('blacklists free users over the allowance', async () => {
    const { cron, blacklist, vault } = makeCron({
      users: [{ username: 'alice' }],
    });
    vault.usedBytes.mockResolvedValue(2 * GIB);
    await cron.reconcile();
    expect(blacklist.add).toHaveBeenCalledWith(
      'alice',
      expect.stringContaining('free'),
    );
  });

  it('clears the flag for free users within the allowance', async () => {
    const { cron, blacklist, vault } = makeCron({
      users: [{ username: 'alice' }],
    });
    vault.usedBytes.mockResolvedValue(0.5 * GIB);
    await cron.reconcile();
    expect(blacklist.add).not.toHaveBeenCalled();
    expect(blacklist.remove).toHaveBeenCalledWith('alice');
  });

  it('continues with the next user after a per-user failure', async () => {
    const { cron, billing, blacklist, vault } = makeCron({
      users: [{ username: 'broken' }, { username: 'ok' }],
    });
    billing.syncUser.mockRejectedValueOnce(new Error('stripe down'));
    vault.usedBytes.mockResolvedValue(2 * GIB);

    await expect(cron.reconcile()).resolves.toBeUndefined();
    expect(blacklist.add).toHaveBeenCalledTimes(1);
    expect(blacklist.add).toHaveBeenCalledWith('ok', expect.any(String));
  });
});
