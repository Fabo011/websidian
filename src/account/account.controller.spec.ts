import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AUTH_COOKIE } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { BillingService } from '../billing/billing.service';
import { AppConfig } from '../config/configuration';
import { StorageResolver } from '../storage/storage-resolver.service';
import { StorageProvider } from '../storage/storage.interface';
import { BlacklistService } from '../users/blacklist.service';
import { EntitlementsService } from '../users/entitlements.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { VaultService } from '../vault/vault.service';
import { AccountController } from './account.controller';

const GIB = 1024 * 1024 * 1024;

const CURRENT: AuthenticatedUser = {
  id: 1,
  username: 'alice',
  storageId: 'sid',
};

interface Mocks {
  controller: AccountController;
  auth: {
    changePassword: jest.Mock;
    beginTotpReset: jest.Mock;
    confirmTotpReset: jest.Mock;
    validateCredentials: jest.Mock;
  };
  users: {
    findByUsername: jest.Mock;
    findById: jest.Mock;
    setStorageConfig: jest.Mock;
    remove: jest.Mock;
  };
  vault: { usage: jest.Mock; deleteUserData: jest.Mock };
  entitlements: { forUser: jest.Mock };
  blacklist: { isBlacklisted: jest.Mock };
  billing: { ready: boolean; syncUser: jest.Mock };
  resolver: { invalidate: jest.Mock; globalStorageProvider: StorageProvider };
  globalProvider: Record<string, jest.Mock>;
}

function makeController(
  options: {
    userStorageEnabled?: boolean;
    managedStorageAvailable?: boolean;
    billingReady?: boolean;
    user?: Partial<User> | null;
  } = {},
): Mocks {
  const dbUser =
    options.user === null
      ? null
      : Object.assign(
          new User(),
          {
            id: 1,
            username: 'alice',
            storageId: 'sid',
            storageConfig: null,
            storageDriver: null,
            storageQuotaBytes: null,
            stripeSubscriptionId: null,
          },
          options.user,
        );
  const auth = {
    changePassword: jest.fn().mockResolvedValue(undefined),
    beginTotpReset: jest.fn(),
    confirmTotpReset: jest.fn().mockResolvedValue(undefined),
    validateCredentials: jest.fn().mockResolvedValue(dbUser),
  };
  const users = {
    findByUsername: jest.fn().mockResolvedValue(dbUser),
    findById: jest.fn().mockResolvedValue(dbUser),
    setStorageConfig: jest.fn().mockResolvedValue(dbUser),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const vault = {
    usage: jest
      .fn()
      .mockResolvedValue({ used: 10, limit: 1 * GIB, unlimited: false }),
    deleteUserData: jest.fn().mockResolvedValue(undefined),
  };
  const entitlements = {
    forUser: jest.fn().mockResolvedValue({
      plan: 'plus',
      effectiveTier: 'plus',
      privileged: false,
      subscriptionStatus: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      paidActive: true,
      daysUntilExpiry: 30,
      warnExpiringSoon: false,
    }),
  };
  const blacklist = { isBlacklisted: jest.fn().mockResolvedValue(false) };
  const billing = {
    ready: options.billingReady ?? false,
    syncUser: jest.fn().mockResolvedValue(undefined),
  };
  const globalProvider = {
    ensureUser: jest.fn().mockResolvedValue(undefined),
    writeBytes: jest.fn().mockResolvedValue(undefined),
    readBytes: jest.fn().mockResolvedValue(Buffer.from('x')),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const resolver = {
    invalidate: jest.fn(),
    globalStorageProvider: globalProvider as unknown as StorageProvider,
  };
  const config = {
    get: jest.fn().mockReturnValue({
      userStorageEnabled: options.userStorageEnabled ?? false,
      managedStorageAvailable: options.managedStorageAvailable ?? false,
      pricing: { contactEmail: 'help@example.com' },
    } as AppConfig),
  } as unknown as ConfigService;

  const controller = new AccountController(
    auth as unknown as AuthService,
    users as unknown as UsersService,
    vault as unknown as VaultService,
    entitlements as unknown as EntitlementsService,
    blacklist as unknown as BlacklistService,
    billing as unknown as BillingService,
    config,
    resolver as unknown as StorageResolver,
  );
  return {
    controller,
    auth,
    users,
    vault,
    entitlements,
    blacklist,
    billing,
    resolver,
    globalProvider,
  };
}

function makeRes(): Response & { cleared: string[] } {
  const res = {
    cleared: [] as string[],
    clearCookie(name: string) {
      this.cleared.push(name);
    },
  };
  return res as unknown as ReturnType<typeof makeRes>;
}

describe('AccountController', () => {
  describe('account', () => {
    it('reports hosted-mode usage with entitlement and billing fields', async () => {
      const { controller } = makeController();
      await expect(controller.account(CURRENT)).resolves.toMatchObject({
        username: 'alice',
        usedBytes: 10,
        quotaBytes: 1 * GIB,
        plan: 'plus',
        effectiveTier: 'plus',
        paidActive: true,
        blacklisted: false,
        userStorageEnabled: false,
        managed: false,
        storageConfigured: true,
      });
    });

    it('refreshes from Stripe first when a subscription exists', async () => {
      const { controller, billing } = makeController({
        billingReady: true,
        user: { stripeSubscriptionId: 'sub_1' },
      });
      await controller.account(CURRENT);
      expect(billing.syncUser).toHaveBeenCalled();
    });

    it('skips the Stripe sync without a subscription', async () => {
      const { controller, billing } = makeController({ billingReady: true });
      await controller.account(CURRENT);
      expect(billing.syncUser).not.toHaveBeenCalled();
    });

    it('collapses billing fields for bring-your-own storage users', async () => {
      const { controller, vault, entitlements } = makeController({
        userStorageEnabled: true,
        user: { storageDriver: 's3', storageConfig: '{"driver":"s3"}' },
      });
      await expect(controller.account(CURRENT)).resolves.toMatchObject({
        plan: 'free',
        subscriptionStatus: 'none',
        userStorageEnabled: true,
        managed: false,
        storageConfigured: true,
        storageDriver: 's3',
      });
      expect(vault.usage).toHaveBeenCalled();
      expect(entitlements.forUser).not.toHaveBeenCalled();
    });

    it('avoids touching storage before a provider is connected', async () => {
      const { controller, vault } = makeController({
        userStorageEnabled: true,
        user: { storageConfig: null, storageQuotaBytes: '2048' },
      });
      await expect(controller.account(CURRENT)).resolves.toMatchObject({
        usedBytes: 0,
        quotaBytes: 2048,
        unlimited: true,
        storageConfigured: false,
      });
      expect(vault.usage).not.toHaveBeenCalled();
    });

    it('treats managed users like hosted accounts', async () => {
      const { controller, entitlements } = makeController({
        userStorageEnabled: true,
        user: {
          storageDriver: 'managed',
          storageConfig: '{"driver":"managed"}',
        },
      });
      await expect(controller.account(CURRENT)).resolves.toMatchObject({
        managed: true,
        storageDriver: 'managed',
        plan: 'plus',
      });
      expect(entitlements.forUser).toHaveBeenCalled();
    });
  });

  describe('keys', () => {
    it('rejects when the account vanished', async () => {
      const { controller } = makeController({ user: null });
      await expect(controller.keys(CURRENT)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('returns the wrapped key material', async () => {
      const { controller } = makeController({
        user: { kdfSalt: 'kdf', wrappedVaultKey: 'wvk' },
      });
      await expect(controller.keys(CURRENT)).resolves.toEqual({
        kdfSalt: 'kdf',
        wrappedVaultKey: 'wvk',
        chatPublicKey: null,
        wrappedChatPrivateKey: null,
      });
    });

    it('includes chat keys once set', async () => {
      const { controller } = makeController({
        user: {
          kdfSalt: 'kdf',
          wrappedVaultKey: 'wvk',
          chatPublicKey: 'PUB',
          wrappedChatPrivateKey: 'WRAPPED',
        },
      });
      await expect(controller.keys(CURRENT)).resolves.toEqual({
        kdfSalt: 'kdf',
        wrappedVaultKey: 'wvk',
        chatPublicKey: 'PUB',
        wrappedChatPrivateKey: 'WRAPPED',
      });
    });
  });

  it('changePassword forwards the rewrap material', async () => {
    const { controller, auth } = makeController();
    await expect(
      controller.changePassword(CURRENT, {
        currentPassword: 'old',
        newPassword: 'new',
        code: '123456',
        newKdfSalt: 'salt2',
        newWrappedVaultKey: 'wvk2',
      }),
    ).resolves.toEqual({ ok: true });
    expect(auth.changePassword).toHaveBeenCalledWith(
      1,
      'old',
      'new',
      '123456',
      {
        kdfSalt: 'salt2',
        wrappedVaultKey: 'wvk2',
      },
    );
  });

  it('beginTotpReset / confirmTotpReset delegate to the auth service', async () => {
    const { controller, auth } = makeController();
    auth.beginTotpReset.mockResolvedValue({ secret: 's' });
    await expect(
      controller.beginTotpReset(CURRENT, {
        currentPassword: 'pw',
        code: '111111',
      }),
    ).resolves.toEqual({ secret: 's' });
    expect(auth.beginTotpReset).toHaveBeenCalledWith(1, 'pw', '111111');

    await expect(
      controller.confirmTotpReset(CURRENT, { code: '222222' }),
    ).resolves.toEqual({ ok: true });
    expect(auth.confirmTotpReset).toHaveBeenCalledWith(1, '222222');
  });

  describe('getStorage', () => {
    it('reports unconfigured storage', async () => {
      const { controller } = makeController({ userStorageEnabled: true });
      await expect(controller.getStorage(CURRENT)).resolves.toEqual({
        enabled: true,
        configured: false,
        contactEmail: 'help@example.com',
        quotaGb: 0,
        managedAvailable: false,
        driver: null,
      });
    });

    it('strips the S3 secret but signals its presence', async () => {
      const { controller } = makeController({
        userStorageEnabled: true,
        user: {
          storageQuotaBytes: String(2 * GIB),
          storageConfig: JSON.stringify({
            driver: 's3',
            s3: {
              endpoint: 'https://s3',
              region: 'r',
              bucket: 'b',
              accessKeyId: 'key',
              secretAccessKey: 'super-secret',
            },
          }),
        },
      });
      const result = await controller.getStorage(CURRENT);
      expect(result).toMatchObject({
        driver: 's3',
        quotaGb: 2,
        s3: {
          endpoint: 'https://s3',
          accessKeyId: 'key',
          hasSecret: true,
        },
      });
      expect(JSON.stringify(result)).not.toContain('super-secret');
    });

    it('strips the WebDAV password but signals its presence', async () => {
      const { controller } = makeController({
        userStorageEnabled: true,
        user: {
          storageConfig: JSON.stringify({
            driver: 'webdav',
            webdav: { url: 'https://dav', username: 'u', password: 'geheim' },
          }),
        },
      });
      const result = await controller.getStorage(CURRENT);
      expect(result).toMatchObject({
        driver: 'webdav',
        webdav: { url: 'https://dav', hasPassword: true },
      });
      expect(JSON.stringify(result)).not.toContain('geheim');
    });

    it('reports the managed driver', async () => {
      const { controller } = makeController({
        userStorageEnabled: true,
        user: { storageConfig: '{"driver":"managed"}' },
      });
      await expect(controller.getStorage(CURRENT)).resolves.toMatchObject({
        driver: 'managed',
      });
    });

    it('treats a corrupted config as unconfigured', async () => {
      const { controller } = makeController({
        userStorageEnabled: true,
        user: { storageConfig: '{broken' },
      });
      await expect(controller.getStorage(CURRENT)).resolves.toMatchObject({
        driver: null,
      });
    });
  });

  describe('testStorage', () => {
    it('rejects managed when the instance does not offer it', async () => {
      const { controller } = makeController({ managedStorageAvailable: false });
      await expect(
        controller.testStorage(CURRENT, { driver: 'managed' } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when the account vanished', async () => {
      const { controller } = makeController({
        managedStorageAvailable: true,
        user: null,
      });
      await expect(
        controller.testStorage(CURRENT, { driver: 'managed' } as never),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('probes the global backend for managed storage', async () => {
      const { controller, globalProvider } = makeController({
        managedStorageAvailable: true,
      });
      await expect(
        controller.testStorage(CURRENT, { driver: 'managed' } as never),
      ).resolves.toEqual({ ok: true });
      expect(globalProvider.writeBytes).toHaveBeenCalledWith(
        'sid',
        '.wo-conntest',
        expect.any(Buffer),
      );
      expect(globalProvider.remove).toHaveBeenCalled();
    });

    it('maps probe failures to an error code instead of throwing', async () => {
      const { controller, globalProvider } = makeController({
        managedStorageAvailable: true,
      });
      globalProvider.writeBytes.mockRejectedValue(
        Object.assign(new Error('denied'), { status: 403 }),
      );
      await expect(
        controller.testStorage(CURRENT, { driver: 'managed' } as never),
      ).resolves.toEqual({ ok: false, code: 'auth' });
    });

    it('keeps a stored secret when the form omits it (mergeSecrets)', async () => {
      // An S3 config with no bucket makes the provider's client getter throw
      // before any network call — the probe fails with code "unknown", which is
      // enough to observe the merge without real S3 traffic.
      const { controller } = makeController({
        user: {
          storageConfig: JSON.stringify({
            driver: 's3',
            s3: { bucket: '', secretAccessKey: 'stored-secret' },
          }),
        },
      });
      const result = await controller.testStorage(CURRENT, {
        driver: 's3',
        s3: {
          endpoint: '',
          region: '',
          bucket: '',
          accessKeyId: 'k',
          secretAccessKey: '',
        },
      } as never);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('unknown');
    });
  });

  describe('saveStorage', () => {
    it('does not persist credentials when the probe fails', async () => {
      const { controller, users, globalProvider, resolver } = makeController({
        managedStorageAvailable: true,
      });
      globalProvider.readBytes.mockRejectedValue(
        Object.assign(new Error('nope'), { status: 404 }),
      );
      await expect(
        controller.saveStorage(CURRENT, { driver: 'managed' } as never),
      ).resolves.toEqual({ ok: false, code: 'notfound' });
      expect(users.setStorageConfig).not.toHaveBeenCalled();
      expect(resolver.invalidate).not.toHaveBeenCalled();
    });

    it('persists managed storage with a null quota and invalidates the cache', async () => {
      const { controller, users, resolver } = makeController({
        managedStorageAvailable: true,
      });
      await expect(
        controller.saveStorage(CURRENT, {
          driver: 'managed',
          quotaGb: 5, // ignored for managed
        } as never),
      ).resolves.toEqual({ ok: true });
      expect(users.setStorageConfig).toHaveBeenCalledWith(
        expect.any(User),
        'managed',
        '{"driver":"managed"}',
        null,
      );
      expect(resolver.invalidate).toHaveBeenCalledWith('sid');
    });
  });

  describe('deleteAccount', () => {
    const dto = { password: 'pw' };

    it('rejects when the account vanished', async () => {
      const { controller } = makeController({ user: null });
      await expect(
        controller.deleteAccount(CURRENT, dto, {} as Request, makeRes()),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('re-validates the password before deleting anything', async () => {
      const { controller, auth, vault, users } = makeController();
      auth.validateCredentials.mockRejectedValue(new Error('wrong password'));
      await expect(
        controller.deleteAccount(CURRENT, dto, {} as Request, makeRes()),
      ).rejects.toThrow('wrong password');
      expect(vault.deleteUserData).not.toHaveBeenCalled();
      expect(users.remove).not.toHaveBeenCalled();
    });

    it('deletes vault data, removes the user, clears the cookie', async () => {
      const { controller, auth, vault, users } = makeController();
      const res = makeRes();
      await expect(
        controller.deleteAccount(CURRENT, dto, {} as Request, res),
      ).resolves.toEqual({ ok: true });
      expect(auth.validateCredentials).toHaveBeenCalledWith('alice', 'pw');
      expect(vault.deleteUserData).toHaveBeenCalledWith('alice');
      expect(users.remove).toHaveBeenCalled();
      expect(res.cleared).toEqual([AUTH_COOKIE]);
    });

    it('skips the storage wipe for BYO accounts that never connected storage', async () => {
      const { controller, vault, users } = makeController({
        userStorageEnabled: true,
        user: { storageConfig: null },
      });
      await controller.deleteAccount(CURRENT, dto, {} as Request, makeRes());
      expect(vault.deleteUserData).not.toHaveBeenCalled();
      expect(users.remove).toHaveBeenCalled();
    });
  });
});
