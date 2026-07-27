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
  let users: { findPublicKeyByUsername: jest.Mock };
  let config: { get: jest.Mock };
  let blocks: {
    list: jest.Mock;
    add: jest.Mock;
    remove: jest.Mock;
    isBlocked: jest.Mock;
  };
  let controller: ChatController;

  function build(chatEnabled = true) {
    users = { findPublicKeyByUsername: jest.fn() };
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

  it('404s when the user is unknown or has no chat key', async () => {
    build();
    users.findPublicKeyByUsername.mockResolvedValue(null);
    await expect(controller.pubkey('ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
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
