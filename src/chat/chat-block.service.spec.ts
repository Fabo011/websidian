import { Repository } from 'typeorm';
import { ChatBlock } from './chat-block.entity';
import { ChatBlockService } from './chat-block.service';

describe('ChatBlockService', () => {
  let repo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let service: ChatBlockService;

  beforeEach(() => {
    repo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((d) => d as ChatBlock),
      save: jest.fn().mockImplementation((r) => Promise.resolve(r)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service = new ChatBlockService(repo as unknown as Repository<ChatBlock>);
  });

  it('list returns blocked usernames newest first', async () => {
    repo.find.mockResolvedValue([
      { blockedUsername: 'bob' },
      { blockedUsername: 'carol' },
    ]);
    await expect(service.list('sid')).resolves.toEqual(['bob', 'carol']);
    expect(repo.find).toHaveBeenCalledWith({
      where: { ownerStorageId: 'sid' },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  });

  it('add lowercases and skips duplicates', async () => {
    repo.findOne.mockResolvedValueOnce(null);
    await service.add('sid', 'Bob');
    expect(repo.create).toHaveBeenCalledWith({
      ownerStorageId: 'sid',
      blockedUsername: 'bob',
    });
    expect(repo.save).toHaveBeenCalled();

    repo.save.mockClear();
    repo.findOne.mockResolvedValueOnce({ id: 1 } as ChatBlock);
    await service.add('sid', 'bob');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('remove deletes the lowercased block', async () => {
    await service.remove('sid', 'Bob');
    expect(repo.delete).toHaveBeenCalledWith({
      ownerStorageId: 'sid',
      blockedUsername: 'bob',
    });
  });

  it('isBlocked reflects presence of a row', async () => {
    repo.findOne.mockResolvedValueOnce({ id: 1 } as ChatBlock);
    await expect(service.isBlocked('sid', 'Bob')).resolves.toBe(true);
    repo.findOne.mockResolvedValueOnce(null);
    await expect(service.isBlocked('sid', 'bob')).resolves.toBe(false);
  });
});
