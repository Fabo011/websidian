import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedUser } from '../auth/auth.types';
import { AppConfig } from '../config/configuration';
import { UsersService } from '../users/users.service';
import { ChatBlockService } from './chat-block.service';
import { ChatController } from './chat.controller';

const USER: AuthenticatedUser = {
  id: 1,
  username: 'alice',
  storageId: 'sid-alice',
};

describe('ChatController', () => {
  let users: { findPublicKeyByUsername: jest.Mock; findByUsername: jest.Mock };
  let config: { get: jest.Mock };
  let blocks: {
    list: jest.Mock;
    add: jest.Mock;
    remove: jest.Mock;
    isBlocked: jest.Mock;
  };
  let controller: ChatController;

  function build(chatEnabled = true) {
    users = { findPublicKeyByUsername: jest.fn(), findByUsername: jest.fn() };
    config = {
      get: jest.fn().mockReturnValue({ chatEnabled } as Partial<AppConfig>),
    };
    blocks = {
      list: jest.fn().mockResolvedValue([]),
      add: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      isBlocked: jest.fn().mockResolvedValue(false),
    };
    controller = new ChatController(
      users as unknown as UsersService,
      config as unknown as ConfigService,
      blocks as unknown as ChatBlockService,
    );
  }

  it('returns the public key for a known user', async () => {
    build();
    users.findPublicKeyByUsername.mockResolvedValue({
      username: 'bob',
      publicKey: 'PUB',
    });
    await expect(controller.pubkey('bob')).resolves.toEqual({
      username: 'bob',
      publicKey: 'PUB',
    });
  });

  it('404s with error "no_user" when the account does not exist', async () => {
    build();
    users.findPublicKeyByUsername.mockResolvedValue(null);
    users.findByUsername.mockResolvedValue(null);
    await expect(controller.pubkey('ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.pubkey('ghost')).rejects.toMatchObject({
      response: { error: 'no_user' },
    });
    expect(users.findByUsername).toHaveBeenCalledWith('ghost');
  });

  it('404s with error "chat_not_setup" when the account exists but has no key', async () => {
    build();
    users.findPublicKeyByUsername.mockResolvedValue(null);
    users.findByUsername.mockResolvedValue({ username: 'bob' });
    await expect(controller.pubkey('Bob')).rejects.toMatchObject({
      response: { error: 'chat_not_setup' },
    });
    // Lookup is lowercased so a mixed-case username still resolves.
    expect(users.findByUsername).toHaveBeenCalledWith('bob');
  });

  it('is forbidden when chat is disabled', async () => {
    build(false);
    await expect(controller.pubkey('bob')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(users.findPublicKeyByUsername).not.toHaveBeenCalled();
  });

  describe('blocks', () => {
    it('lists the current user blocklist', async () => {
      build();
      blocks.list.mockResolvedValue(['bob', 'carol']);
      await expect(controller.listBlocks(USER)).resolves.toEqual({
        blocked: ['bob', 'carol'],
      });
      expect(blocks.list).toHaveBeenCalledWith('sid-alice');
    });

    it('adds a block (lowercased) for the owner', async () => {
      build();
      await expect(
        controller.addBlock(USER, { username: 'Bob' }),
      ).resolves.toEqual({ ok: true });
      expect(blocks.add).toHaveBeenCalledWith('sid-alice', 'bob');
    });

    it('refuses to block yourself', async () => {
      build();
      await expect(
        controller.addBlock(USER, { username: 'Alice' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(blocks.add).not.toHaveBeenCalled();
    });

    it('removes a block', async () => {
      build();
      await expect(controller.removeBlock(USER, 'bob')).resolves.toEqual({
        ok: true,
      });
      expect(blocks.remove).toHaveBeenCalledWith('sid-alice', 'bob');
    });
  });
});
