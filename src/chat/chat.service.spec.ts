import { Repository } from 'typeorm';
import { ChatService } from './chat.service';
import { PendingMessage } from './pending-message.entity';

describe('ChatService', () => {
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
  };
  let service: ChatService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockImplementation((d) => d as PendingMessage),
      save: jest.fn().mockImplementation((r) => Promise.resolve(r)),
      find: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    service = new ChatService(repo as unknown as Repository<PendingMessage>);
  });

  it('enqueue stores an opaque envelope for the recipient', async () => {
    await service.enqueue('sid-1', 'alice', 'ENVELOPE');
    expect(repo.create).toHaveBeenCalledWith({
      toStorageId: 'sid-1',
      fromUsername: 'alice',
      envelope: 'ENVELOPE',
    });
    expect(repo.save).toHaveBeenCalled();
  });

  it('drain returns queued envelopes oldest first', async () => {
    const created = new Date('2020-01-01T00:00:00Z');
    repo.find.mockResolvedValue([
      { id: 5, fromUsername: 'bob', envelope: 'E', createdAt: created },
    ]);
    const out = await service.drain('sid-1');
    expect(repo.find).toHaveBeenCalledWith({
      where: { toStorageId: 'sid-1' },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    expect(out).toEqual([
      { id: 5, fromUsername: 'bob', envelope: 'E', createdAt: created },
    ]);
  });

  it('deleteByIds is a no-op for an empty list', async () => {
    await service.deleteByIds([]);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('deleteByIds removes the given ids', async () => {
    await service.deleteByIds([1, 2, 3]);
    expect(repo.delete).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('purgeOlderThan deletes rows past the ttl and returns the count', async () => {
    repo.delete.mockResolvedValue({ affected: 4 });
    const removed = await service.purgeOlderThan(30);
    expect(removed).toBe(4);
    expect(repo.delete).toHaveBeenCalledTimes(1);
    // The where clause carries a LessThan(cutoff) filter on createdAt.
    const arg = repo.delete.mock.calls[0][0];
    expect(arg).toHaveProperty('createdAt');
  });
});
