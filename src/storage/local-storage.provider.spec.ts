import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { LocalStorageProvider } from './local-storage.provider';

describe('LocalStorageProvider', () => {
  let dataRoot: string;
  let provider: LocalStorageProvider;
  const user = 'user-a';

  beforeEach(async () => {
    dataRoot = await fs.mkdtemp(join(tmpdir(), 'websidian-test-'));
    const config = {
      get: jest.fn().mockReturnValue({ dataRoot }),
    } as unknown as ConfigService;
    provider = new LocalStorageProvider(config);
  });

  afterEach(async () => {
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  it('ensureUser creates the user root', async () => {
    await provider.ensureUser(user);
    const stat = await fs.stat(join(dataRoot, user));
    expect(stat.isDirectory()).toBe(true);
  });

  describe('write + read', () => {
    it('round-trips bytes and creates parents', async () => {
      await provider.writeBytes(user, 'notes/deep/a.md', Buffer.from('hello'));
      expect(await provider.readText(user, 'notes/deep/a.md')).toBe('hello');
      expect(
        (await provider.readBytes(user, 'notes/deep/a.md')).toString(),
      ).toBe('hello');
    });

    it('writeStream stores streamed content', async () => {
      await provider.writeStream(
        user,
        'big.bin',
        Readable.from([Buffer.from('part1-'), Buffer.from('part2')]),
      );
      expect(await provider.readText(user, 'big.bin')).toBe('part1-part2');
    });

    it('readText rejects a directory', async () => {
      await provider.makeDir(user, 'folder');
      await expect(provider.readText(user, 'folder')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('readText rejects a missing file', async () => {
      await expect(provider.readText(user, 'nope.md')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects path traversal', async () => {
      await expect(
        provider.readText(user, '../other-user/secret.md'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('openReadStream', () => {
    it('streams a file with its size', async () => {
      await provider.writeBytes(user, 'a.md', Buffer.from('12345'));
      const { stream, size } = await provider.openReadStream(user, 'a.md');
      expect(size).toBe(5);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).toString()).toBe('12345');
    });

    it('rejects directories', async () => {
      await provider.makeDir(user, 'folder');
      await expect(provider.openReadStream(user, 'folder')).rejects.toThrow(
        'Not a file.',
      );
    });
  });

  describe('list', () => {
    it('lists files and folders, hiding .keep and .trash', async () => {
      await provider.writeBytes(user, 'note.md', Buffer.from('x'));
      await provider.makeDir(user, 'folder');
      await provider.writeBytes(user, '.keep', Buffer.alloc(0));
      await provider.makeDir(user, '.trash');

      const entries = await provider.list(user, '');
      expect(entries).toEqual(
        expect.arrayContaining([
          { name: 'note.md', type: 'file' },
          { name: 'folder', type: 'dir' },
        ]),
      );
      expect(entries).toHaveLength(2);
    });

    it('keeps other dotfiles visible', async () => {
      await provider.writeBytes(user, '.DS_Store', Buffer.from('junk'));
      const entries = await provider.list(user, '');
      expect(entries).toContainEqual({ name: '.DS_Store', type: 'file' });
    });
  });

  describe('move', () => {
    it('renames a file', async () => {
      await provider.writeBytes(user, 'a.md', Buffer.from('x'));
      await provider.move(user, 'a.md', 'b.md');
      expect(await provider.isFile(user, 'b.md')).toBe(true);
      expect(await provider.isFile(user, 'a.md')).toBe(false);
    });

    it('moves folders recursively', async () => {
      await provider.writeBytes(user, 'src/inner/a.md', Buffer.from('x'));
      await provider.move(user, 'src', 'dst');
      expect(await provider.isFile(user, 'dst/inner/a.md')).toBe(true);
    });

    it('is a no-op when source equals target', async () => {
      await provider.writeBytes(user, 'a.md', Buffer.from('x'));
      await expect(
        provider.move(user, 'a.md', 'a.md'),
      ).resolves.toBeUndefined();
      expect(await provider.isFile(user, 'a.md')).toBe(true);
    });

    it('refuses moving a folder into itself', async () => {
      await provider.makeDir(user, 'folder');
      await expect(provider.move(user, 'folder', 'folder/sub')).rejects.toThrow(
        'Cannot move a folder into itself.',
      );
    });

    it('refuses when the target exists', async () => {
      await provider.writeBytes(user, 'a.md', Buffer.from('a'));
      await provider.writeBytes(user, 'b.md', Buffer.from('b'));
      await expect(provider.move(user, 'a.md', 'b.md')).rejects.toThrow(
        'Target already exists.',
      );
    });

    it('rejects a missing source', async () => {
      await expect(provider.move(user, 'ghost.md', 'x.md')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('deletes a file', async () => {
      await provider.writeBytes(user, 'a.md', Buffer.from('x'));
      await provider.remove(user, 'a.md');
      expect(await provider.isFile(user, 'a.md')).toBe(false);
    });

    it('deletes a folder recursively', async () => {
      await provider.writeBytes(user, 'folder/deep/a.md', Buffer.from('x'));
      await provider.remove(user, 'folder');
      expect(await provider.isDir(user, 'folder')).toBe(false);
    });

    it('rejects missing paths', async () => {
      await expect(provider.remove(user, 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('statFile / isFile / isDir', () => {
    it('stats a file with size and mtime', async () => {
      await provider.writeBytes(user, 'a.md', Buffer.from('12345'));
      const stat = await provider.statFile(user, 'a.md');
      expect(stat.size).toBe(5);
      expect(stat.mtimeMs).toBeGreaterThan(0);
    });

    it('statFile rejects directories and missing paths', async () => {
      await provider.makeDir(user, 'folder');
      await expect(provider.statFile(user, 'folder')).rejects.toThrow(
        'Not a file.',
      );
      await expect(provider.statFile(user, 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('isFile / isDir answer without throwing', async () => {
      await provider.writeBytes(user, 'a.md', Buffer.from('x'));
      await provider.makeDir(user, 'folder');
      expect(await provider.isFile(user, 'a.md')).toBe(true);
      expect(await provider.isFile(user, 'folder')).toBe(false);
      expect(await provider.isDir(user, 'folder')).toBe(true);
      expect(await provider.isDir(user, 'a.md')).toBe(false);
      expect(await provider.isFile(user, 'ghost')).toBe(false);
      expect(await provider.isDir(user, 'ghost')).toBe(false);
    });
  });

  describe('usage', () => {
    it('sums file sizes, skipping dotfiles but counting trash', async () => {
      await provider.writeBytes(user, 'a.md', Buffer.from('12345')); // 5
      await provider.writeBytes(user, 'folder/b.md', Buffer.from('1234567')); // 7
      await provider.writeBytes(user, '.DS_Store', Buffer.from('xxxx')); // skipped
      await provider.writeBytes(user, '.trash/c.md', Buffer.from('123')); // 3

      expect(await provider.usage(user)).toBe(15);
    });

    it('returns 0 for an unknown user', async () => {
      expect(await provider.usage('nobody')).toBe(0);
    });
  });

  it('removeUser wipes all data and tolerates unknown users', async () => {
    await provider.writeBytes(user, 'a.md', Buffer.from('x'));
    await provider.removeUser(user);
    await expect(fs.stat(join(dataRoot, user))).rejects.toThrow();
    await expect(provider.removeUser('nobody')).resolves.toBeUndefined();
  });
});
