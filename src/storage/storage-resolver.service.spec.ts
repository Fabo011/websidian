import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { StorageResolver } from './storage-resolver.service';
import { WebdavStorageProvider } from './webdav-storage.provider';

function makeResolver(options: {
  userStorageEnabled: boolean;
  storage?: Record<string, unknown>;
  users?: Partial<Record<'findByStorageId', jest.Mock>>;
}): {
  resolver: StorageResolver;
  users: { findByStorageId: jest.Mock };
  local: LocalStorageProvider;
} {
  const config = {
    get: jest.fn().mockReturnValue({
      userStorageEnabled: options.userStorageEnabled,
      storage: options.storage ?? { driver: 'local' },
    }),
  } as unknown as ConfigService;
  const users = {
    findByStorageId: jest.fn(),
    ...options.users,
  };
  const local = {} as LocalStorageProvider;
  const resolver = new StorageResolver(
    config,
    users as unknown as UsersService,
    local,
  );
  return { resolver, users, local };
}

const userConfig = (cfg: unknown): { storageConfig: string } => ({
  storageConfig: JSON.stringify(cfg),
});

describe('StorageResolver', () => {
  describe('global provider construction', () => {
    it('uses the local provider for the local driver', () => {
      const { resolver, local } = makeResolver({ userStorageEnabled: false });
      expect(resolver.globalStorageProvider).toBe(local);
    });

    it('builds an S3 provider for the s3 driver', () => {
      const { resolver } = makeResolver({
        userStorageEnabled: false,
        storage: { driver: 's3', s3: { bucket: 'b' } },
      });
      expect(resolver.globalStorageProvider).toBeInstanceOf(S3StorageProvider);
    });

    it('builds a WebDAV provider for the webdav driver', () => {
      const { resolver } = makeResolver({
        userStorageEnabled: false,
        storage: { driver: 'webdav', webdav: { url: 'https://dav' } },
      });
      expect(resolver.globalStorageProvider).toBeInstanceOf(
        WebdavStorageProvider,
      );
    });
  });

  describe('default mode (user storage disabled)', () => {
    it('returns the global provider without touching the database', async () => {
      const { resolver, users, local } = makeResolver({
        userStorageEnabled: false,
      });
      await expect(resolver.getForStorageId('sid')).resolves.toBe(local);
      expect(users.findByStorageId).not.toHaveBeenCalled();
    });
  });

  describe('bring-your-own mode', () => {
    it('rejects when the user has no stored config', async () => {
      const { resolver, users } = makeResolver({ userStorageEnabled: true });
      users.findByStorageId.mockResolvedValue(null);
      await expect(resolver.getForStorageId('sid')).rejects.toThrow(
        ServiceUnavailableException,
      );

      users.findByStorageId.mockResolvedValue({ storageConfig: null });
      await expect(resolver.getForStorageId('sid')).rejects.toThrow(
        'No storage provider is connected',
      );
    });

    it('rejects corrupted (non-JSON) configs', async () => {
      const { resolver, users } = makeResolver({ userStorageEnabled: true });
      users.findByStorageId.mockResolvedValue({ storageConfig: '{oops' });
      await expect(resolver.getForStorageId('sid')).rejects.toThrow(
        'corrupted',
      );
    });

    it('builds a provider from the saved credentials', async () => {
      const { resolver, users } = makeResolver({ userStorageEnabled: true });
      users.findByStorageId.mockResolvedValue(
        userConfig({ driver: 's3', s3: { bucket: 'user-bucket' } }),
      );
      const provider = await resolver.getForStorageId('sid');
      expect(provider).toBeInstanceOf(S3StorageProvider);
    });

    it('returns the global provider for managed users', async () => {
      const { resolver, users, local } = makeResolver({
        userStorageEnabled: true,
      });
      users.findByStorageId.mockResolvedValue(
        userConfig({ driver: 'managed' }),
      );
      await expect(resolver.getForStorageId('sid')).resolves.toBe(local);
    });

    it('caches per storageId while the config is unchanged', async () => {
      const { resolver, users } = makeResolver({ userStorageEnabled: true });
      users.findByStorageId.mockResolvedValue(
        userConfig({ driver: 's3', s3: { bucket: 'b' } }),
      );
      const first = await resolver.getForStorageId('sid');
      const second = await resolver.getForStorageId('sid');
      expect(second).toBe(first);
    });

    it('rebuilds when the stored config changes', async () => {
      const { resolver, users } = makeResolver({ userStorageEnabled: true });
      users.findByStorageId.mockResolvedValue(
        userConfig({ driver: 's3', s3: { bucket: 'b1' } }),
      );
      const first = await resolver.getForStorageId('sid');

      users.findByStorageId.mockResolvedValue(
        userConfig({ driver: 's3', s3: { bucket: 'b2' } }),
      );
      const second = await resolver.getForStorageId('sid');
      expect(second).not.toBe(first);
    });

    it('rebuilds after invalidate()', async () => {
      const { resolver, users } = makeResolver({ userStorageEnabled: true });
      users.findByStorageId.mockResolvedValue(
        userConfig({ driver: 's3', s3: { bucket: 'b' } }),
      );
      const first = await resolver.getForStorageId('sid');
      resolver.invalidate('sid');
      const second = await resolver.getForStorageId('sid');
      expect(second).not.toBe(first);
    });
  });
});
