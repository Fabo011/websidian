import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { PrivilegedUser } from './privileged-user.entity';
import { PrivilegedUsersService } from './privileged-users.service';

function makeService(
  envUsers: string[],
  dbCount: number,
): { service: PrivilegedUsersService; repo: { count: jest.Mock } } {
  const repo = { count: jest.fn().mockResolvedValue(dbCount) };
  const config = {
    get: jest.fn().mockReturnValue({ privilegedUsers: envUsers }),
  } as unknown as ConfigService;
  return {
    service: new PrivilegedUsersService(
      repo as unknown as Repository<PrivilegedUser>,
      config,
    ),
    repo,
  };
}

describe('PrivilegedUsersService', () => {
  it('matches env-configured usernames case-insensitively without a DB hit', async () => {
    const { service, repo } = makeService(['alice'], 0);
    await expect(service.isPrivileged('ALICE')).resolves.toBe(true);
    expect(repo.count).not.toHaveBeenCalled();
  });

  it('falls back to the privileged_users table', async () => {
    const { service, repo } = makeService([], 1);
    await expect(service.isPrivileged('Bob')).resolves.toBe(true);
    expect(repo.count).toHaveBeenCalledWith({ where: { username: 'bob' } });
  });

  it('is false when neither source matches', async () => {
    const { service } = makeService(['alice'], 0);
    await expect(service.isPrivileged('mallory')).resolves.toBe(false);
  });
});
