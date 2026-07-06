import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
  };
  let service: UsersService;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      create: jest.fn().mockImplementation((data) => data as User),
      save: jest.fn().mockImplementation((user) => Promise.resolve(user)),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    service = new UsersService(repo as unknown as Repository<User>);
  });

  it('findByUsername queries by username', async () => {
    const user = { id: 1 } as User;
    repo.findOne.mockResolvedValue(user);
    await expect(service.findByUsername('alice')).resolves.toBe(user);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { username: 'alice' },
    });
  });

  it('findById queries by id', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.findById(7)).resolves.toBeNull();
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  it('findByStorageId queries by storageId', async () => {
    repo.findOne.mockResolvedValue(null);
    await service.findByStorageId('sid');
    expect(repo.findOne).toHaveBeenCalledWith({ where: { storageId: 'sid' } });
  });

  it('findAll returns every user', async () => {
    const all = [{ id: 1 }, { id: 2 }] as User[];
    repo.find.mockResolvedValue(all);
    await expect(service.findAll()).resolves.toBe(all);
  });

  it('count delegates to the repository', async () => {
    repo.count.mockResolvedValue(3);
    await expect(service.count()).resolves.toBe(3);
  });

  describe('create', () => {
    const data = {
      username: 'alice',
      passwordHash: 'hash',
      totpSecret: 'secret',
      kdfSalt: 'kdf',
      recoverySalt: 'rec',
      wrappedVaultKey: 'wvk',
      recoveryWrappedVaultKey: 'rwvk',
    };

    it('initialises a free, unconfirmed account', async () => {
      await service.create(data);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ...data,
          totpEnabled: false,
          plan: 'free',
          subscriptionStatus: 'none',
          cancelAtPeriodEnd: false,
        }),
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('assigns an opaque random storage id, unique per user', async () => {
      await service.create(data);
      await service.create({ ...data, username: 'bob' });
      const first = repo.create.mock.calls[0][0] as { storageId: string };
      const second = repo.create.mock.calls[1][0] as { storageId: string };
      expect(first.storageId).toMatch(/^[0-9a-f]{32}$/);
      expect(second.storageId).toMatch(/^[0-9a-f]{32}$/);
      expect(first.storageId).not.toBe(second.storageId);
      expect(first.storageId).not.toContain('alice');
    });
  });

  describe('setStorageConfig', () => {
    it('stores driver, config JSON, and a positive quota as string', async () => {
      const user = new User();
      await service.setStorageConfig(user, 's3', '{"driver":"s3"}', 1024);
      expect(user.storageDriver).toBe('s3');
      expect(user.storageConfig).toBe('{"driver":"s3"}');
      expect(user.storageQuotaBytes).toBe('1024');
      expect(repo.save).toHaveBeenCalledWith(user);
    });

    it.each([[null], [0], [-5]])(
      'normalises quota %p to null (unlimited)',
      async (quota) => {
        const user = new User();
        await service.setStorageConfig(user, 'webdav', '{}', quota);
        expect(user.storageQuotaBytes).toBeNull();
      },
    );
  });

  it('save and remove delegate to the repository', async () => {
    const user = new User();
    await service.save(user);
    expect(repo.save).toHaveBeenCalledWith(user);
    await service.remove(user);
    expect(repo.remove).toHaveBeenCalledWith(user);
  });
});
