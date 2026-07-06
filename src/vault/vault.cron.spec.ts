import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { TrashCron } from './vault.cron';
import { VaultService } from './vault.service';

function makeCron(usernames: string[]): {
  cron: TrashCron;
  vault: { purgeExpiredTrash: jest.Mock };
} {
  const users = {
    findAll: jest
      .fn()
      .mockResolvedValue(
        usernames.map((username) => Object.assign(new User(), { username })),
      ),
  };
  const vault = { purgeExpiredTrash: jest.fn().mockResolvedValue(0) };
  const cron = new TrashCron(
    users as unknown as UsersService,
    vault as unknown as VaultService,
  );
  return { cron, vault };
}

describe('TrashCron.purge', () => {
  it('purges every user', async () => {
    const { cron, vault } = makeCron(['alice', 'bob']);
    vault.purgeExpiredTrash.mockResolvedValue(2);
    await cron.purge();
    expect(vault.purgeExpiredTrash).toHaveBeenCalledWith('alice');
    expect(vault.purgeExpiredTrash).toHaveBeenCalledWith('bob');
  });

  it('continues after a per-user failure', async () => {
    const { cron, vault } = makeCron(['broken', 'ok']);
    vault.purgeExpiredTrash
      .mockRejectedValueOnce(new Error('storage down'))
      .mockResolvedValueOnce(1);
    await expect(cron.purge()).resolves.toBeUndefined();
    expect(vault.purgeExpiredTrash).toHaveBeenCalledTimes(2);
  });

  it('handles an empty user list', async () => {
    const { cron, vault } = makeCron([]);
    await cron.purge();
    expect(vault.purgeExpiredTrash).not.toHaveBeenCalled();
  });
});
