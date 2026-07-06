import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import type { WebDAVClient } from 'webdav';
import { WebdavConfig } from '../config/configuration';
import { WebdavStorageProvider } from './webdav-storage.provider';

const CFG: WebdavConfig = {
  url: 'https://dav.example.com',
  username: 'user',
  password: 'pw',
  authType: 'auto',
  basePath: 'app',
};

const httpError = (status: number): Error =>
  Object.assign(new Error(`http ${status}`), { status });

interface MockClient {
  createDirectory: jest.Mock;
  getDirectoryContents: jest.Mock;
  getFileContents: jest.Mock;
  createReadStream: jest.Mock;
  putFileContents: jest.Mock;
  moveFile: jest.Mock;
  deleteFile: jest.Mock;
  exists: jest.Mock;
  stat: jest.Mock;
}

function makeProvider(cfg: Partial<WebdavConfig> = {}): {
  provider: WebdavStorageProvider;
  client: MockClient;
} {
  const client: MockClient = {
    createDirectory: jest.fn().mockResolvedValue(undefined),
    getDirectoryContents: jest.fn().mockResolvedValue([]),
    getFileContents: jest.fn(),
    createReadStream: jest.fn(),
    putFileContents: jest.fn().mockResolvedValue(undefined),
    moveFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    stat: jest.fn(),
  };
  const provider = new WebdavStorageProvider({ ...CFG, ...cfg });
  (
    provider as unknown as { clientPromise: Promise<WebDAVClient> }
  ).clientPromise = Promise.resolve(client as unknown as WebDAVClient);
  return { provider, client };
}

const fileStat = (
  filename: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  filename,
  basename: filename.split('/').pop(),
  type: 'file',
  size: 1,
  lastmod: 'Mon, 05 Jan 2026 10:00:00 GMT',
  ...overrides,
});

describe('WebdavStorageProvider', () => {
  it('fails clearly when no URL is configured', async () => {
    const provider = new WebdavStorageProvider({ ...CFG, url: '' });
    await expect(provider.ensureUser('user')).rejects.toThrow(/WEBDAV_URL/);
  });

  describe('path handling', () => {
    it('rejects traversal segments', async () => {
      const { provider } = makeProvider();
      await expect(provider.readBytes('user', '../other')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('builds remote paths as /basePath/user/relPath', async () => {
      const { provider, client } = makeProvider();
      client.getFileContents.mockResolvedValue(Buffer.from('x'));
      await provider.readBytes('user', 'folder/a.md');
      expect(client.getFileContents).toHaveBeenCalledWith(
        '/app/user/folder/a.md',
        { format: 'binary' },
      );
    });

    it('omits an empty basePath', async () => {
      const { provider, client } = makeProvider({ basePath: '' });
      client.getFileContents.mockResolvedValue(Buffer.from('x'));
      await provider.readBytes('user', 'a.md');
      expect(client.getFileContents).toHaveBeenCalledWith('/user/a.md', {
        format: 'binary',
      });
    });
  });

  describe('ensureUser', () => {
    it('creates each path segment, tolerating already-exists responses', async () => {
      const { provider, client } = makeProvider();
      client.createDirectory
        .mockRejectedValueOnce(httpError(405)) // /app exists
        .mockResolvedValueOnce(undefined); // /app/user created
      await provider.ensureUser('user');
      expect(client.createDirectory.mock.calls.map((c) => c[0])).toEqual([
        '/app',
        '/app/user',
      ]);
    });

    it('rethrows non-conflict errors', async () => {
      const { provider, client } = makeProvider();
      client.createDirectory.mockRejectedValue(httpError(500));
      await expect(provider.ensureUser('user')).rejects.toThrow('http 500');
    });
  });

  describe('list', () => {
    it('maps entries and hides .keep and .trash', async () => {
      const { provider, client } = makeProvider();
      client.getDirectoryContents.mockResolvedValue([
        fileStat('/app/user/a.md'),
        fileStat('/app/user/folder', { type: 'directory' }),
        fileStat('/app/user/.keep'),
        fileStat('/app/user/.trash', { type: 'directory' }),
      ]);

      await expect(provider.list('user', '')).resolves.toEqual([
        { name: 'a.md', type: 'file' },
        { name: 'folder', type: 'dir' },
      ]);
    });

    it('returns [] for a missing directory', async () => {
      const { provider, client } = makeProvider();
      client.getDirectoryContents.mockRejectedValue(httpError(404));
      await expect(provider.list('user', 'ghost')).resolves.toEqual([]);
    });

    it('propagates other errors', async () => {
      const { provider, client } = makeProvider();
      client.getDirectoryContents.mockRejectedValue(httpError(500));
      await expect(provider.list('user', 'dir')).rejects.toThrow('http 500');
    });
  });

  describe('reads', () => {
    it('readBytes returns a Buffer (converting ArrayBuffer bodies)', async () => {
      const { provider, client } = makeProvider();
      client.getFileContents.mockResolvedValue(
        new Uint8Array([104, 105]).buffer,
      );
      await expect(provider.readBytes('user', 'a.md')).resolves.toEqual(
        Buffer.from('hi'),
      );
    });

    it('readText decodes UTF-8', async () => {
      const { provider, client } = makeProvider();
      client.getFileContents.mockResolvedValue(Buffer.from('héllo'));
      await expect(provider.readText('user', 'a.md')).resolves.toBe('héllo');
    });

    it('maps 404 to NotFoundException', async () => {
      const { provider, client } = makeProvider();
      client.getFileContents.mockRejectedValue(httpError(404));
      await expect(provider.readBytes('user', 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('openReadStream stats first, then streams', async () => {
      const { provider, client } = makeProvider();
      client.stat.mockResolvedValue(fileStat('/app/user/a.md', { size: 9 }));
      const stream = Readable.from([]);
      client.createReadStream.mockReturnValue(stream);

      await expect(provider.openReadStream('user', 'a.md')).resolves.toEqual({
        stream,
        size: 9,
      });
      expect(client.createReadStream).toHaveBeenCalledWith('/app/user/a.md');
    });
  });

  describe('writes', () => {
    it('writeBytes ensures the parent then puts with overwrite', async () => {
      const { provider, client } = makeProvider();
      const data = Buffer.from('x');
      await provider.writeBytes('user', 'folder/a.md', data);

      // Parent /app/user/folder created segment by segment.
      expect(client.createDirectory.mock.calls.map((c) => c[0])).toEqual([
        '/app',
        '/app/user',
        '/app/user/folder',
      ]);
      expect(client.putFileContents).toHaveBeenCalledWith(
        '/app/user/folder/a.md',
        data,
        { overwrite: true },
      );
    });

    it('writeBytes for a root-level file ensures the user root', async () => {
      const { provider, client } = makeProvider();
      await provider.writeBytes('user', 'a.md', Buffer.from('x'));
      expect(client.createDirectory.mock.calls.map((c) => c[0])).toEqual([
        '/app',
        '/app/user',
      ]);
    });

    it('writeStream passes the content length', async () => {
      const { provider, client } = makeProvider();
      const stream = Readable.from([]);
      await provider.writeStream('user', 'a.md', stream, 123);
      expect(client.putFileContents).toHaveBeenCalledWith(
        '/app/user/a.md',
        stream,
        { overwrite: true, contentLength: 123 },
      );
    });

    it('makeDir materialises the folder via a .keep placeholder', async () => {
      const { provider, client } = makeProvider();
      await provider.makeDir('user', 'folder');
      expect(client.putFileContents).toHaveBeenCalledWith(
        '/app/user/folder/.keep',
        expect.any(Buffer),
        { overwrite: true },
      );
    });

    it('makeDir ignores the root', async () => {
      const { provider, client } = makeProvider();
      await provider.makeDir('user', '');
      expect(client.putFileContents).not.toHaveBeenCalled();
    });
  });

  describe('move', () => {
    it('requires both paths', async () => {
      const { provider } = makeProvider();
      await expect(provider.move('user', '', 'x')).rejects.toThrow(
        'A path is required.',
      );
    });

    it('is a no-op for identical paths', async () => {
      const { provider, client } = makeProvider();
      await provider.move('user', 'a.md', 'a.md');
      expect(client.moveFile).not.toHaveBeenCalled();
    });

    it('refuses moving a folder into itself', async () => {
      const { provider } = makeProvider();
      await expect(provider.move('user', 'dir', 'dir/sub')).rejects.toThrow(
        'Cannot move a folder into itself.',
      );
    });

    it('throws NotFound when the source is missing', async () => {
      const { provider, client } = makeProvider();
      client.exists.mockResolvedValue(false);
      await expect(provider.move('user', 'ghost', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses when the target exists', async () => {
      const { provider, client } = makeProvider();
      client.exists.mockResolvedValue(true); // both source and target
      await expect(provider.move('user', 'a.md', 'b.md')).rejects.toThrow(
        'Target already exists.',
      );
    });

    it('moves after ensuring the target parent', async () => {
      const { provider, client } = makeProvider();
      client.exists.mockImplementation((path: string) =>
        Promise.resolve(path === '/app/user/a.md'),
      );
      await provider.move('user', 'a.md', 'sub/b.md');
      expect(client.moveFile).toHaveBeenCalledWith(
        '/app/user/a.md',
        '/app/user/sub/b.md',
        { overwrite: false },
      );
    });
  });

  describe('remove', () => {
    it('requires a path', async () => {
      const { provider } = makeProvider();
      await expect(provider.remove('user', '')).rejects.toThrow(
        'Path is required.',
      );
    });

    it('throws NotFound for missing paths', async () => {
      const { provider, client } = makeProvider();
      client.exists.mockResolvedValue(false);
      await expect(provider.remove('user', 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deletes the remote path', async () => {
      const { provider, client } = makeProvider();
      client.exists.mockResolvedValue(true);
      await provider.remove('user', 'folder');
      expect(client.deleteFile).toHaveBeenCalledWith('/app/user/folder');
    });
  });

  describe('metadata', () => {
    it('statFile returns size and parsed mtime', async () => {
      const { provider, client } = makeProvider();
      client.stat.mockResolvedValue(
        fileStat('/app/user/a.md', {
          size: 5,
          lastmod: 'Mon, 05 Jan 2026 10:00:00 GMT',
        }),
      );
      await expect(provider.statFile('user', 'a.md')).resolves.toEqual({
        size: 5,
        mtimeMs: Date.parse('Mon, 05 Jan 2026 10:00:00 GMT'),
      });
    });

    it('statFile rejects directories', async () => {
      const { provider, client } = makeProvider();
      client.stat.mockResolvedValue(
        fileStat('/app/user/dir', { type: 'directory' }),
      );
      await expect(provider.statFile('user', 'dir')).rejects.toThrow(
        'Not a file.',
      );
    });

    it('statFile maps 404 to NotFoundException', async () => {
      const { provider, client } = makeProvider();
      client.stat.mockRejectedValue(httpError(404));
      await expect(provider.statFile('user', 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('isFile / isDir answer from stat and swallow errors', async () => {
      const { provider, client } = makeProvider();
      client.stat.mockResolvedValueOnce(fileStat('/app/user/a.md'));
      await expect(provider.isFile('user', 'a.md')).resolves.toBe(true);

      client.stat.mockResolvedValueOnce(
        fileStat('/app/user/dir', { type: 'directory' }),
      );
      await expect(provider.isFile('user', 'dir')).resolves.toBe(false);

      client.stat.mockResolvedValueOnce(
        fileStat('/app/user/dir', { type: 'directory' }),
      );
      await expect(provider.isDir('user', 'dir')).resolves.toBe(true);

      client.stat.mockRejectedValue(httpError(404));
      await expect(provider.isFile('user', 'ghost')).resolves.toBe(false);
      await expect(provider.isDir('user', 'ghost')).resolves.toBe(false);
    });
  });

  describe('usage', () => {
    it('sums file sizes from a deep listing and caches the result', async () => {
      const { provider, client } = makeProvider();
      client.getDirectoryContents.mockResolvedValue([
        fileStat('/app/user/a.md', { size: 10 }),
        fileStat('/app/user/dir', { type: 'directory' }),
        fileStat('/app/user/dir/b.md', { size: 5 }),
      ]);

      await expect(provider.usage('user')).resolves.toBe(15);
      await expect(provider.usage('user')).resolves.toBe(15);
      expect(client.getDirectoryContents).toHaveBeenCalledTimes(1);
      expect(client.getDirectoryContents).toHaveBeenCalledWith('/app/user', {
        deep: true,
      });
    });

    it('treats a missing user root as zero usage', async () => {
      const { provider, client } = makeProvider();
      client.getDirectoryContents.mockRejectedValue(httpError(404));
      await expect(provider.usage('user')).resolves.toBe(0);
    });

    it('is invalidated by writes', async () => {
      const { provider, client } = makeProvider();
      client.getDirectoryContents.mockResolvedValue([
        fileStat('/app/user/a.md', { size: 1 }),
      ]);
      await provider.usage('user');

      await provider.writeBytes('user', 'b.md', Buffer.from('x'));

      client.getDirectoryContents.mockResolvedValue([
        fileStat('/app/user/a.md', { size: 1 }),
        fileStat('/app/user/b.md', { size: 1 }),
      ]);
      await expect(provider.usage('user')).resolves.toBe(2);
    });
  });

  describe('removeUser', () => {
    it('deletes the user root when it exists', async () => {
      const { provider, client } = makeProvider();
      client.exists.mockResolvedValue(true);
      await provider.removeUser('user');
      expect(client.deleteFile).toHaveBeenCalledWith('/app/user');
    });

    it('is a no-op when the root is gone', async () => {
      const { provider, client } = makeProvider();
      client.exists.mockResolvedValue(false);
      await provider.removeUser('user');
      expect(client.deleteFile).not.toHaveBeenCalled();
    });
  });

  describe('walkFiles', () => {
    it('lists files relative to the user root, hiding trash but keeping .keep', async () => {
      const { provider, client } = makeProvider();
      client.getDirectoryContents.mockResolvedValue([
        fileStat('/app/user/a.md', { size: 3 }),
        fileStat('/app/user/dir', { type: 'directory' }),
        fileStat('/app/user/dir/.keep', { size: 0 }),
        fileStat('/app/user/.trash/gone.md', { size: 9 }),
      ]);

      const files = await provider.walkFiles('user');
      expect(files.map((f) => f.relPath)).toEqual(['a.md', 'dir/.keep']);
    });

    it('returns [] when the user root does not exist yet', async () => {
      const { provider, client } = makeProvider();
      client.getDirectoryContents.mockRejectedValue(httpError(404));
      await expect(provider.walkFiles('user')).resolves.toEqual([]);
    });
  });
});
