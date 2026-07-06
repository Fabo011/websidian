import { Repository } from 'typeorm';
import { BlacklistService } from './blacklist.service';
import { BlacklistedUser } from './blacklisted-user.entity';

describe('BlacklistService', () => {
  let repo: {
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let service: BlacklistService;

  beforeEach(() => {
    repo = {
      count: jest.fn(),
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    service = new BlacklistService(
      repo as unknown as Repository<BlacklistedUser>,
    );
  });

  describe('isBlacklisted', () => {
    it('is true when a row exists, matching case-insensitively', async () => {
      repo.count.mockResolvedValue(1);
      await expect(service.isBlacklisted('Alice')).resolves.toBe(true);
      expect(repo.count).toHaveBeenCalledWith({
        where: { username: 'alice' },
      });
    });

    it('is false when no row exists', async () => {
      repo.count.mockResolvedValue(0);
      await expect(service.isBlacklisted('alice')).resolves.toBe(false);
    });
  });

  describe('add', () => {
    it('stores the lowercased username with the reason', async () => {
      repo.count.mockResolvedValue(0);
      await service.add('Alice', 'over quota');
      expect(repo.save).toHaveBeenCalledWith({
        username: 'alice',
        reason: 'over quota',
      });
    });

    it('is idempotent', async () => {
      repo.count.mockResolvedValue(1);
      await service.add('alice', 'again');
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  it('remove deletes by lowercased username', async () => {
    await service.remove('Alice');
    expect(repo.delete).toHaveBeenCalledWith({ username: 'alice' });
  });
});
