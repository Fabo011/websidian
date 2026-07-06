import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { StorageProvider } from '../storage/storage.interface';
import { EntitlementsService } from '../users/entitlements.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { VaultService } from './vault.service';

const GIB = 1024 * 1024 * 1024;

interface Mocks {
  service: VaultService;
  storage: jest.Mocked<StorageProvider>;
  users: { findByUsername: jest.Mock };
  entitlements: { forUser: jest.Mock; freeBytes: number };
}

function makeService(
  options: {
    trashRetentionDays?: number;
    searchCacheTtlMs?: number;
    userStorageEnabled?: boolean;
    quotaBytes?: number;
    user?: Partial<User> | null;
  } = {},
): Mocks {
  const storage = {
    ensureUser: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue([]),
    readText: jest.fn(),
    readBytes: jest.fn().mockResolvedValue(Buffer.from('cipher')),
    openReadStream: jest.fn(),
    writeBytes: jest.fn().mockResolvedValue(undefined),
    writeStream: jest.fn().mockResolvedValue(undefined),
    makeDir: jest.fn().mockResolvedValue(undefined),
    move: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    statFile: jest.fn().mockResolvedValue({ size: 6, mtimeMs: 1000 }),
    isFile: jest.fn().mockResolvedValue(false),
    isDir: jest.fn().mockResolvedValue(false),
    usage: jest.fn().mockResolvedValue(0),
    removeUser: jest.fn().mockResolvedValue(undefined),
    walkFiles: undefined as unknown as jest.Mock,
  } as unknown as jest.Mocked<StorageProvider>;

  const user =
    options.user === null
      ? null
      : Object.assign(
          new User(),
          { username: 'alice', storageId: 'sid', storageDriver: null },
          options.user,
        );
  const users = { findByUsername: jest.fn().mockResolvedValue(user) };
  const entitlements = {
    freeBytes: 1 * GIB,
    forUser: jest
      .fn()
      .mockResolvedValue({ quotaBytes: options.quotaBytes ?? 0 }),
  };
  const config = {
    get: jest.fn().mockReturnValue({
      trashRetentionDays: options.trashRetentionDays ?? 7,
      searchCacheTtlMs: options.searchCacheTtlMs ?? 0,
      userStorageEnabled: options.userStorageEnabled ?? false,
    }),
  } as unknown as ConfigService;

  const service = new VaultService(
    storage,
    users as unknown as UsersService,
    entitlements as unknown as EntitlementsService,
    config,
  );
  return { service, storage, users, entitlements };
}

describe('VaultService', () => {
  describe('sid resolution', () => {
    it('maps a username to its opaque storageId and caches it', async () => {
      const { service, storage, users } = makeService();
      await service.usedBytes('Alice');
      await service.usedBytes('alice');
      expect(storage.usage).toHaveBeenCalledWith('sid');
      expect(users.findByUsername).toHaveBeenCalledTimes(1);
      expect(users.findByUsername).toHaveBeenCalledWith('alice');
    });

    it('rejects unknown users', async () => {
      const { service } = makeService({ user: null });
      await expect(service.usedBytes('ghost')).rejects.toThrow('Unknown user.');
    });
  });

  it('ensureUserRoot creates the namespace', async () => {
    const { service, storage } = makeService();
    await service.ensureUserRoot('alice');
    expect(storage.ensureUser).toHaveBeenCalledWith('sid');
  });

  describe('isTextFile', () => {
    it.each(['note.md', 'a/b/c.markdown', 'x.JSON', 'script.ts', 'q.sql'])(
      'treats %s as text',
      (name) => {
        const { service } = makeService();
        expect(service.isTextFile(name)).toBe(true);
      },
    );

    it.each(['image.png', 'doc.pdf', 'archive.zip', 'noext'])(
      'treats %s as binary',
      (name) => {
        const { service } = makeService();
        expect(service.isTextFile(name)).toBe(false);
      },
    );
  });

  describe('usage / quota resolution', () => {
    it('reports usage against the entitlement quota', async () => {
      const { service, storage } = makeService({ quotaBytes: 2 * GIB });
      storage.usage.mockResolvedValue(100);
      await expect(service.usage('alice')).resolves.toEqual({
        used: 100,
        limit: 2 * GIB,
        unlimited: false,
      });
    });

    it('reports unlimited when the quota is 0', async () => {
      const { service } = makeService({ quotaBytes: 0 });
      await expect(service.usage('alice')).resolves.toMatchObject({
        unlimited: true,
      });
    });

    it('uses the self-set cap for bring-your-own storage users', async () => {
      const { service, entitlements } = makeService({
        userStorageEnabled: true,
        user: { storageDriver: 's3', storageQuotaBytes: '12345' },
      });
      await expect(service.usage('alice')).resolves.toMatchObject({
        limit: 12345,
      });
      expect(entitlements.forUser).not.toHaveBeenCalled();
    });

    it('treats a missing self-set cap as unlimited', async () => {
      const { service } = makeService({
        userStorageEnabled: true,
        user: { storageDriver: 'webdav', storageQuotaBytes: null },
      });
      await expect(service.usage('alice')).resolves.toMatchObject({
        limit: 0,
        unlimited: true,
      });
    });

    it('managed users still use the plan entitlement', async () => {
      const { service, entitlements } = makeService({
        userStorageEnabled: true,
        quotaBytes: 3 * GIB,
        user: { storageDriver: 'managed' },
      });
      await expect(service.usage('alice')).resolves.toMatchObject({
        limit: 3 * GIB,
      });
      expect(entitlements.forUser).toHaveBeenCalled();
    });
  });

  describe('listTree', () => {
    it('builds the tree from the flat fast path when available', async () => {
      const { service, storage } = makeService();
      storage.walkFiles = jest.fn().mockResolvedValue([
        { relPath: 'b.md', size: 1, mtimeMs: 0 },
        { relPath: 'folder/nested/deep.md', size: 1, mtimeMs: 0 },
        { relPath: 'folder/.keep', size: 0, mtimeMs: 0 },
        { relPath: 'empty/.keep', size: 0, mtimeMs: 0 },
        { relPath: '.trash/123-ab/x.md', size: 1, mtimeMs: 0 },
        { relPath: 'a.md', size: 1, mtimeMs: 0 },
      ]);

      const tree = await service.listTree('alice');

      // Dirs first, then files, both alphabetically; trash hidden; .keep
      // materialises its folder but is not itself shown.
      expect(tree.map((n) => `${n.type}:${n.name}`)).toEqual([
        'dir:empty',
        'dir:folder',
        'file:a.md',
        'file:b.md',
      ]);
      const folder = tree.find((n) => n.name === 'folder');
      expect(folder?.children?.map((n) => n.name)).toEqual(['nested']);
      expect(folder?.children?.[0].children?.[0]).toMatchObject({
        name: 'deep.md',
        path: 'folder/nested/deep.md',
        type: 'file',
        ext: 'md',
      });
      expect(tree.find((n) => n.name === 'empty')?.children).toEqual([]);
    });

    it('falls back to a recursive walk without a fast path', async () => {
      const { service, storage } = makeService();
      storage.list.mockImplementation(async (_sid, dir) => {
        if (dir === '') {
          return [
            { name: 'note.md', type: 'file' as const },
            { name: 'sub', type: 'dir' as const },
          ];
        }
        if (dir === 'sub') {
          return [{ name: 'inner.md', type: 'file' as const }];
        }
        return [];
      });

      const tree = await service.listTree('alice');
      expect(tree.map((n) => n.name)).toEqual(['sub', 'note.md']);
      expect(tree[0].children?.[0]).toMatchObject({
        name: 'inner.md',
        path: 'sub/inner.md',
      });
    });
  });

  describe('readTextFile', () => {
    it('rejects binary extensions', async () => {
      const { service } = makeService();
      await expect(service.readTextFile('alice', 'img.png')).rejects.toThrow(
        'not editable as text',
      );
    });

    it('returns base64 ciphertext with a version token', async () => {
      const { service, storage } = makeService();
      storage.statFile.mockResolvedValue({ size: 6, mtimeMs: 1234 });
      storage.readBytes.mockResolvedValue(Buffer.from('cipher'));

      await expect(
        service.readTextFile('alice', 'notes/a.md'),
      ).resolves.toEqual({
        path: 'notes/a.md',
        name: 'a.md',
        ext: 'md',
        content: Buffer.from('cipher').toString('base64'),
        version: '1234-6',
      });
    });
  });

  describe('writeTextFile', () => {
    it('requires a file name', async () => {
      const { service } = makeService();
      await expect(service.writeTextFile('alice', '', 'x')).rejects.toThrow(
        'A file name is required.',
      );
      await expect(
        service.writeTextFile('alice', 'folder/', 'x'),
      ).rejects.toThrow(BadRequestException);
    });

    it('writes the decoded bytes and returns the new version', async () => {
      const { service, storage } = makeService();
      storage.isFile.mockResolvedValue(false);
      storage.statFile.mockResolvedValue({ size: 5, mtimeMs: 999 });
      const content = Buffer.from('hello').toString('base64');

      const result = await service.writeTextFile('alice', 'a.md', content);

      expect(storage.writeBytes).toHaveBeenCalledWith(
        'sid',
        'a.md',
        Buffer.from('hello'),
      );
      expect(result).toMatchObject({ path: 'a.md', version: '999-5' });
    });

    it('detects concurrent edits via the base version', async () => {
      const { service, storage } = makeService();
      storage.isFile.mockResolvedValue(true);
      storage.statFile.mockResolvedValue({ size: 10, mtimeMs: 2000 });

      await expect(
        service.writeTextFile('alice', 'a.md', 'eA==', '1000-10'),
      ).rejects.toThrow(ConflictException);
      expect(storage.writeBytes).not.toHaveBeenCalled();
    });

    it('accepts a matching base version', async () => {
      const { service, storage } = makeService();
      storage.isFile.mockResolvedValue(true);
      storage.statFile.mockResolvedValue({ size: 10, mtimeMs: 2000 });

      await expect(
        service.writeTextFile('alice', 'a.md', 'eA==', '2000-10'),
      ).resolves.toBeDefined();
      expect(storage.writeBytes).toHaveBeenCalled();
    });

    it('force-writes when no base version is supplied', async () => {
      const { service, storage } = makeService();
      storage.isFile.mockResolvedValue(true);
      storage.statFile.mockResolvedValue({ size: 10, mtimeMs: 2000 });
      await expect(
        service.writeTextFile('alice', 'a.md', 'eA=='),
      ).resolves.toBeDefined();
    });

    it('enforces the quota, crediting the overwritten size', async () => {
      const { service, storage } = makeService({ quotaBytes: 100 });
      storage.isFile.mockResolvedValue(true);
      storage.statFile.mockResolvedValue({ size: 50, mtimeMs: 1 });
      storage.usage.mockResolvedValue(100); // at the limit

      // 50 freed, 60 incoming -> 110 > 100.
      const tooBig = Buffer.alloc(60).toString('base64');
      await expect(
        service.writeTextFile('alice', 'a.md', tooBig),
      ).rejects.toThrow(/quota exceeded/i);

      // 50 freed, 40 incoming -> 90 <= 100.
      const fits = Buffer.alloc(40).toString('base64');
      await expect(
        service.writeTextFile('alice', 'a.md', fits),
      ).resolves.toBeDefined();
    });

    it('skips the quota check when unlimited', async () => {
      const { service, storage } = makeService({ quotaBytes: 0 });
      storage.statFile.mockResolvedValue({ size: 1, mtimeMs: 1 });
      await service.writeTextFile('alice', 'a.md', 'eA==');
      expect(storage.usage).not.toHaveBeenCalled();
    });
  });

  it('createFolder validates and delegates', async () => {
    const { service, storage } = makeService();
    await expect(service.createFolder('alice', '')).rejects.toThrow(
      'A folder name is required.',
    );
    await service.createFolder('alice', 'new-folder');
    expect(storage.makeDir).toHaveBeenCalledWith('sid', 'new-folder');
  });

  it('rename delegates to storage.move', async () => {
    const { service, storage } = makeService();
    await service.rename('alice', 'a.md', 'b.md');
    expect(storage.move).toHaveBeenCalledWith('sid', 'a.md', 'b.md');
  });

  describe('deleteEntry', () => {
    it('requires a path', async () => {
      const { service } = makeService();
      await expect(service.deleteEntry('alice', '')).rejects.toThrow(
        'Path is required.',
      );
    });

    it('soft-deletes into a stamped trash batch with an origin marker', async () => {
      const { service, storage } = makeService({ trashRetentionDays: 7 });
      storage.isFile.mockResolvedValue(true);

      await service.deleteEntry('alice', '/notes/a.md/');

      const [, from, to] = storage.move.mock.calls[0];
      expect(from).toBe('notes/a.md');
      expect(to).toMatch(/^\.trash\/\d+-[0-9a-f]{8}\/notes\/a\.md$/);
      const [, markerPath, markerData] = storage.writeBytes.mock.calls[0];
      expect(markerPath).toMatch(/^\.trash\/\d+-[0-9a-f]{8}\/\.origin$/);
      expect(JSON.parse((markerData as Buffer).toString())).toEqual({
        path: 'notes/a.md',
        type: 'file',
      });
    });

    it('deletes immediately when retention is disabled', async () => {
      const { service, storage } = makeService({ trashRetentionDays: 0 });
      await service.deleteEntry('alice', 'notes/a.md');
      expect(storage.remove).toHaveBeenCalledWith('sid', 'notes/a.md');
      expect(storage.move).not.toHaveBeenCalled();
    });

    it('deletes items already in the trash for good', async () => {
      const { service, storage } = makeService({ trashRetentionDays: 7 });
      await service.deleteEntry('alice', '.trash/123-ab/notes/a.md');
      expect(storage.remove).toHaveBeenCalledWith(
        'sid',
        '.trash/123-ab/notes/a.md',
      );
      expect(storage.move).not.toHaveBeenCalled();
    });
  });

  describe('purgeExpiredTrash', () => {
    it('is a no-op when retention is disabled', async () => {
      const { service, storage } = makeService({ trashRetentionDays: 0 });
      await expect(service.purgeExpiredTrash('alice')).resolves.toBe(0);
      expect(storage.isDir).not.toHaveBeenCalled();
    });

    it('is a no-op without a trash folder', async () => {
      const { service, storage } = makeService();
      storage.isDir.mockResolvedValue(false);
      await expect(service.purgeExpiredTrash('alice')).resolves.toBe(0);
    });

    it('removes only batches older than the retention window', async () => {
      const { service, storage } = makeService({ trashRetentionDays: 7 });
      const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const recent = Date.now() - 1 * 24 * 60 * 60 * 1000;
      storage.isDir.mockResolvedValue(true);
      storage.list.mockResolvedValue([
        { name: `${old}-aaaa`, type: 'dir' },
        { name: `${recent}-bbbb`, type: 'dir' },
        { name: 'not-a-batch-file', type: 'file' },
        { name: 'garbage-name', type: 'dir' },
      ]);

      await expect(service.purgeExpiredTrash('alice')).resolves.toBe(1);
      expect(storage.remove).toHaveBeenCalledTimes(1);
      expect(storage.remove).toHaveBeenCalledWith('sid', `.trash/${old}-aaaa`);
    });
  });

  describe('uploads', () => {
    it('saveUploadStream strips any client-sent directory from the name', async () => {
      const { service, storage } = makeService({ quotaBytes: 0 });
      const stream = Readable.from([]);
      await expect(
        service.saveUploadStream(
          'alice',
          'attachments',
          '/tmp/evil/img.png',
          stream,
          10,
        ),
      ).resolves.toBe('attachments/img.png');
      expect(storage.writeStream).toHaveBeenCalledWith(
        'sid',
        'attachments/img.png',
        stream,
        10,
      );
    });

    it('saveUploadStream works without a destination folder', async () => {
      const { service } = makeService({ quotaBytes: 0 });
      await expect(
        service.saveUploadStream('alice', '', 'img.png', Readable.from([]), 1),
      ).resolves.toBe('img.png');
    });

    it('saveUploadStream rejects an empty name', async () => {
      const { service } = makeService();
      await expect(
        service.saveUploadStream('alice', '', '/', Readable.from([]), 1),
      ).rejects.toThrow('Invalid file name.');
    });

    it('writeStreamAtPath enforces the quota with overwrite credit', async () => {
      const { service, storage } = makeService({ quotaBytes: 100 });
      storage.isFile.mockResolvedValue(true);
      storage.statFile.mockResolvedValue({ size: 30, mtimeMs: 1 });
      storage.usage.mockResolvedValue(90);

      // 90 - 30 + 50 = 110 > 100.
      await expect(
        service.writeStreamAtPath('alice', 'a.bin', Readable.from([]), 50),
      ).rejects.toThrow(/quota exceeded/i);

      // 90 - 30 + 20 = 80 <= 100.
      await expect(
        service.writeStreamAtPath('alice', 'a.bin', Readable.from([]), 20),
      ).resolves.toBe('a.bin');
    });
  });

  it('resolveAttachment returns the stream with mime metadata inputs', async () => {
    const { service, storage } = makeService();
    const stream = Readable.from([]);
    storage.openReadStream.mockResolvedValue({ stream, size: 42 });

    await expect(
      service.resolveAttachment('alice', 'media/img.PNG'),
    ).resolves.toEqual({ stream, size: 42, ext: 'png', name: 'img.PNG' });
  });

  describe('listAllFiles', () => {
    it('uses the fast path, hiding dot-segments', async () => {
      const { service, storage } = makeService();
      storage.walkFiles = jest.fn().mockResolvedValue([
        { relPath: 'a.md', size: 1, mtimeMs: 100 },
        { relPath: 'dir/b.md', size: 2, mtimeMs: 200 },
        { relPath: '.trash/x/c.md', size: 3, mtimeMs: 300 },
        { relPath: 'dir/.keep', size: 0, mtimeMs: 0 },
      ]);
      await expect(service.listAllFiles('alice')).resolves.toEqual([
        { relPath: 'a.md', version: '100-1' },
        { relPath: 'dir/b.md', version: '200-2' },
      ]);
    });

    it('falls back to a stat-per-file walk', async () => {
      const { service, storage } = makeService();
      storage.list.mockImplementation(async (_sid, dir) =>
        dir === ''
          ? [
              { name: 'a.md', type: 'file' as const },
              { name: 'sub', type: 'dir' as const },
            ]
          : dir === 'sub'
            ? [{ name: 'b.md', type: 'file' as const }]
            : [],
      );
      storage.statFile.mockResolvedValue({ size: 5, mtimeMs: 50 });
      await expect(service.listAllFiles('alice')).resolves.toEqual([
        { relPath: 'a.md', version: '50-5' },
        { relPath: 'sub/b.md', version: '50-5' },
      ]);
    });
  });

  it('readBytes / fileExists / deleteUserData delegate with the storageId', async () => {
    const { service, storage } = makeService();
    storage.readBytes.mockResolvedValue(Buffer.from('x'));
    storage.isFile.mockResolvedValue(true);

    await expect(service.readBytes('alice', 'a.md')).resolves.toEqual(
      Buffer.from('x'),
    );
    await expect(service.fileExists('alice', 'a.md')).resolves.toBe(true);

    await service.deleteUserData('alice');
    expect(storage.removeUser).toHaveBeenCalledWith('sid');
  });

  it('deleteUserData drops the cached storageId', async () => {
    const { service, users } = makeService();
    await service.usedBytes('alice');
    await service.deleteUserData('alice');
    await service.usedBytes('alice').catch(() => {});
    // Second lookup needed after the cache was dropped.
    expect(users.findByUsername).toHaveBeenCalledTimes(2);
  });

  describe('search', () => {
    it('returns [] for a blank query without touching storage', async () => {
      const { service, storage } = makeService();
      await expect(service.search('alice', '   ')).resolves.toEqual([]);
      expect(storage.list).not.toHaveBeenCalled();
    });

    it('matches names case-insensitively and hides the trash', async () => {
      const { service, storage } = makeService();
      storage.walkFiles = jest.fn().mockResolvedValue([
        { relPath: 'Notes/Alpha.md', size: 1, mtimeMs: 0 },
        { relPath: 'beta.md', size: 1, mtimeMs: 0 },
        { relPath: '.trash/1-a/alpha-old.md', size: 1, mtimeMs: 0 },
      ]);

      await expect(service.search('alice', 'ALPHA')).resolves.toEqual([
        {
          path: 'Notes/Alpha.md',
          name: 'Alpha.md',
          matchedName: true,
          matchedContent: false,
        },
      ]);
    });

    it('caps the results at 100 hits', async () => {
      const { service, storage } = makeService();
      storage.walkFiles = jest.fn().mockResolvedValue(
        Array.from({ length: 150 }, (_, i) => ({
          relPath: `note-${i}.md`,
          size: 1,
          mtimeMs: 0,
        })),
      );
      await expect(service.search('alice', 'note')).resolves.toHaveLength(100);
    });

    it('reuses the cached file list within the TTL', async () => {
      const { service, storage } = makeService({ searchCacheTtlMs: 60_000 });
      storage.walkFiles = jest
        .fn()
        .mockResolvedValue([{ relPath: 'a.md', size: 1, mtimeMs: 0 }]);

      await service.search('alice', 'a');
      await service.search('alice', 'a');
      expect(storage.walkFiles).toHaveBeenCalledTimes(1);
    });

    it('re-enumerates when caching is disabled', async () => {
      const { service, storage } = makeService({ searchCacheTtlMs: 0 });
      storage.walkFiles = jest
        .fn()
        .mockResolvedValue([{ relPath: 'a.md', size: 1, mtimeMs: 0 }]);

      await service.search('alice', 'a');
      await service.search('alice', 'a');
      expect(storage.walkFiles).toHaveBeenCalledTimes(2);
    });

    it('falls back to a recursive walk when the provider has no fast path', async () => {
      const { service, storage } = makeService();
      storage.list.mockImplementation(async (_sid, dir) =>
        dir === ''
          ? [
              { name: 'match.md', type: 'file' as const },
              { name: 'sub', type: 'dir' as const },
            ]
          : dir === 'sub'
            ? [{ name: 'deep-match.md', type: 'file' as const }]
            : [],
      );

      const hits = await service.search('alice', 'match');
      expect(hits.map((h) => h.path).sort()).toEqual([
        'match.md',
        'sub/deep-match.md',
      ]);
    });
  });

  describe('legacy trash batches (no .origin marker)', () => {
    it('derives the original path by walking the single-child chain', async () => {
      const { service, storage } = makeService();
      storage.isDir.mockResolvedValue(true);
      storage.isFile.mockResolvedValue(false); // no .origin marker anywhere
      storage.list.mockImplementation(async (_sid, dir) => {
        if (dir === '.trash') {
          return [{ name: '1700000000000-ab12', type: 'dir' as const }];
        }
        if (dir === '.trash/1700000000000-ab12') {
          return [{ name: 'notes', type: 'dir' as const }];
        }
        if (dir === '.trash/1700000000000-ab12/notes') {
          return [{ name: 'a.md', type: 'file' as const }];
        }
        return [];
      });

      const items = await service.listTrash('alice');
      expect(items).toEqual([
        {
          id: '1700000000000-ab12',
          path: 'notes/a.md',
          name: 'a.md',
          type: 'file',
          deletedAt: 1700000000000,
        },
      ]);
    });

    it('treats a multi-child level as the deleted folder itself', async () => {
      const { service, storage } = makeService();
      storage.isDir.mockResolvedValue(true);
      storage.isFile.mockResolvedValue(false);
      storage.list.mockImplementation(async (_sid, dir) => {
        if (dir === '.trash') {
          return [{ name: '1700000000000-cd34', type: 'dir' as const }];
        }
        if (dir === '.trash/1700000000000-cd34') {
          return [{ name: 'project', type: 'dir' as const }];
        }
        if (dir === '.trash/1700000000000-cd34/project') {
          return [
            { name: 'a.md', type: 'file' as const },
            { name: 'b.md', type: 'file' as const },
          ];
        }
        return [];
      });

      const items = await service.listTrash('alice');
      expect(items[0]).toMatchObject({ path: 'project', type: 'dir' });
    });

    it('skips empty batches', async () => {
      const { service, storage } = makeService();
      storage.isDir.mockResolvedValue(true);
      storage.isFile.mockResolvedValue(false);
      storage.list.mockImplementation(async (_sid, dir) =>
        dir === '.trash'
          ? [{ name: '1700000000000-ef56', type: 'dir' as const }]
          : [],
      );
      await expect(service.listTrash('alice')).resolves.toEqual([]);
    });

    it('falls back to deriving when the marker is corrupt', async () => {
      const { service, storage } = makeService();
      storage.isDir.mockResolvedValue(true);
      storage.isFile.mockImplementation(async (_sid, p) =>
        p.endsWith('/.origin'),
      );
      storage.readBytes.mockResolvedValue(Buffer.from('{not json'));
      storage.list.mockImplementation(async (_sid, dir) => {
        if (dir === '.trash') {
          return [{ name: '1700000000000-9999', type: 'dir' as const }];
        }
        if (dir === '.trash/1700000000000-9999') {
          return [
            { name: '.origin', type: 'file' as const },
            { name: 'x.md', type: 'file' as const },
          ];
        }
        return [];
      });

      const items = await service.listTrash('alice');
      expect(items[0]).toMatchObject({ path: 'x.md', type: 'file' });
    });
  });

  describe('quota error formatting', () => {
    it('reports the projected size and limit in human units', async () => {
      const { service, storage } = makeService({ quotaBytes: 5 * GIB });
      storage.isFile.mockResolvedValue(false);
      storage.usage.mockResolvedValue(5 * GIB);

      await expect(
        service.writeStreamAtPath(
          'alice',
          'big.bin',
          Readable.from([]),
          2 * GIB,
        ),
      ).rejects.toThrow(/needs 7\.0 GB but your limit is 5\.0 GB/);
    });

    it('uses byte units for tiny limits', async () => {
      const { service, storage } = makeService({ quotaBytes: 100 });
      storage.isFile.mockResolvedValue(false);
      storage.usage.mockResolvedValue(100);

      await expect(
        service.writeStreamAtPath('alice', 'a.bin', Readable.from([]), 5),
      ).rejects.toThrow(/needs 105 B but your limit is 100 B/);
    });
  });

  describe('readNotesContent', () => {
    it('returns base64 ciphertext for markdown notes only, skipping trash and failures', async () => {
      const { service, storage } = makeService();
      storage.walkFiles = jest.fn().mockResolvedValue([
        { relPath: 'a.md', size: 1, mtimeMs: 0 },
        { relPath: 'b.markdown', size: 1, mtimeMs: 0 },
        { relPath: 'img.png', size: 1, mtimeMs: 0 },
        { relPath: '.trash/1-a/c.md', size: 1, mtimeMs: 0 },
        { relPath: 'broken.md', size: 1, mtimeMs: 0 },
      ]);
      storage.readBytes.mockImplementation(async (_sid, p) => {
        if (p === 'broken.md') throw new Error('unreadable');
        return Buffer.from(p);
      });

      const notes = await service.readNotesContent('alice');
      const paths = notes.map((n) => n.path).sort();
      expect(paths).toEqual(['a.md', 'b.markdown']);
      expect(notes.find((n) => n.path === 'a.md')?.content).toBe(
        Buffer.from('a.md').toString('base64'),
      );
    });

    it('handles an empty vault', async () => {
      const { service, storage } = makeService();
      storage.walkFiles = jest.fn().mockResolvedValue([]);
      await expect(service.readNotesContent('alice')).resolves.toEqual([]);
    });
  });
});
