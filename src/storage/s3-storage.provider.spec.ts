import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { S3Config } from '../config/configuration';
import { S3StorageProvider } from './s3-storage.provider';

const CFG: S3Config = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'vault',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  forcePathStyle: true,
  prefix: 'app',
};

const notFoundError = (): Error =>
  Object.assign(new Error('missing'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });

type SendMock = jest.Mock;

/** Build a provider whose S3 client is a plain jest mock. */
function makeProvider(cfg: Partial<S3Config> = {}): {
  provider: S3StorageProvider;
  send: SendMock;
} {
  const provider = new S3StorageProvider({ ...CFG, ...cfg });
  const send = jest.fn();
  (provider as unknown as { _client: { send: SendMock } })._client = { send };
  return { provider, send };
}

/** Default empty listing so head/list-based helpers resolve. */
const emptyList = { Contents: [], CommonPrefixes: [], IsTruncated: false };

describe('S3StorageProvider', () => {
  it('fails clearly when no bucket is configured', async () => {
    const provider = new S3StorageProvider({ ...CFG, bucket: '' });
    await expect(provider.isDir('user', '')).rejects.toThrow(/S3_BUCKET/);
  });

  it('ensureUser is a no-op', async () => {
    const { provider, send } = makeProvider();
    await provider.ensureUser('user');
    expect(send).not.toHaveBeenCalled();
  });

  describe('path handling', () => {
    it('rejects traversal segments', async () => {
      const { provider } = makeProvider();
      await expect(provider.readBytes('user', '../other')).rejects.toThrow(
        BadRequestException,
      );
      await expect(provider.readBytes('user', 'a/./b')).rejects.toThrow(
        'Invalid path.',
      );
    });

    it('builds keys as prefix/user/path with normalised slashes', async () => {
      const { provider, send } = makeProvider();
      send.mockResolvedValue({});
      await provider.writeBytes('user', '\\folder\\a.md', Buffer.from('x'));
      const cmd = send.mock.calls[0][0] as PutObjectCommand;
      expect(cmd).toBeInstanceOf(PutObjectCommand);
      expect(cmd.input).toMatchObject({
        Bucket: 'vault',
        Key: 'app/user/folder/a.md',
      });
    });

    it('omits an empty prefix from keys', async () => {
      const { provider, send } = makeProvider({ prefix: '' });
      send.mockResolvedValue({});
      await provider.writeBytes('user', 'a.md', Buffer.from('x'));
      const cmd = send.mock.calls[0][0] as PutObjectCommand;
      expect(cmd.input.Key).toBe('user/a.md');
    });
  });

  describe('list', () => {
    it('maps prefixes to dirs and keys to files, hiding dotfiles', async () => {
      const { provider, send } = makeProvider();
      send.mockResolvedValue({
        CommonPrefixes: [
          { Prefix: 'app/user/folder/' },
          { Prefix: 'app/user/.trash/' },
        ],
        Contents: [
          { Key: 'app/user/note.md' },
          { Key: 'app/user/.keep' },
          { Key: 'app/user/nested/skip.md' },
        ],
        IsTruncated: false,
      });

      const entries = await provider.list('user', '');
      expect(entries).toEqual([
        { name: 'folder', type: 'dir' },
        { name: 'note.md', type: 'file' },
      ]);
      const cmd = send.mock.calls[0][0] as ListObjectsV2Command;
      expect(cmd.input).toMatchObject({
        Bucket: 'vault',
        Prefix: 'app/user/',
        Delimiter: '/',
      });
    });

    it('lists a subdirectory and follows pagination', async () => {
      const { provider, send } = makeProvider();
      send
        .mockResolvedValueOnce({
          Contents: [{ Key: 'app/user/dir/a.md' }],
          IsTruncated: true,
          NextContinuationToken: 'token-1',
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: 'app/user/dir/b.md' }],
          IsTruncated: false,
        });

      const entries = await provider.list('user', 'dir');
      expect(entries).toEqual([
        { name: 'a.md', type: 'file' },
        { name: 'b.md', type: 'file' },
      ]);
      expect(send).toHaveBeenCalledTimes(2);
      const second = send.mock.calls[1][0] as ListObjectsV2Command;
      expect(second.input.ContinuationToken).toBe('token-1');
      expect(second.input.Prefix).toBe('app/user/dir/');
    });
  });

  describe('reads', () => {
    it('readBytes buffers the body stream', async () => {
      const { provider, send } = makeProvider();
      send.mockResolvedValue({ Body: Readable.from([Buffer.from('hello')]) });
      await expect(provider.readBytes('user', 'a.md')).resolves.toEqual(
        Buffer.from('hello'),
      );
      const cmd = send.mock.calls[0][0] as GetObjectCommand;
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      expect(cmd.input.Key).toBe('app/user/a.md');
    });

    it('readText decodes UTF-8', async () => {
      const { provider, send } = makeProvider();
      send.mockResolvedValue({ Body: Readable.from([Buffer.from('héllo')]) });
      await expect(provider.readText('user', 'a.md')).resolves.toBe('héllo');
    });

    it('maps missing objects to NotFoundException', async () => {
      const { provider, send } = makeProvider();
      send.mockRejectedValue(notFoundError());
      await expect(provider.readBytes('user', 'ghost.md')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('openReadStream returns the raw stream and content length', async () => {
      const { provider, send } = makeProvider();
      const body = Readable.from([]);
      send.mockResolvedValue({ Body: body, ContentLength: 99 });
      await expect(provider.openReadStream('user', 'a.md')).resolves.toEqual({
        stream: body,
        size: 99,
      });
    });
  });

  describe('writes', () => {
    it('writeStream passes the known content length', async () => {
      const { provider, send } = makeProvider();
      send.mockResolvedValue({});
      const stream = Readable.from([]);
      await provider.writeStream('user', 'big.bin', stream, 12345);
      const cmd = send.mock.calls[0][0] as PutObjectCommand;
      expect(cmd.input).toMatchObject({
        Key: 'app/user/big.bin',
        ContentLength: 12345,
      });
    });

    it('makeDir writes a .keep marker', async () => {
      const { provider, send } = makeProvider();
      send.mockResolvedValue({});
      await provider.makeDir('user', 'folder/sub');
      const cmd = send.mock.calls[0][0] as PutObjectCommand;
      expect(cmd.input.Key).toBe('app/user/folder/sub/.keep');
    });

    it('makeDir ignores the root', async () => {
      const { provider, send } = makeProvider();
      await provider.makeDir('user', '');
      expect(send).not.toHaveBeenCalled();
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
      const { provider, send } = makeProvider();
      await provider.move('user', 'a.md', 'a.md');
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses moving a folder into itself', async () => {
      const { provider } = makeProvider();
      await expect(provider.move('user', 'dir', 'dir/sub')).rejects.toThrow(
        'Cannot move a folder into itself.',
      );
    });

    it('throws NotFound when the source does not exist', async () => {
      const { provider, send } = makeProvider();
      send.mockImplementation((cmd: object) => {
        if (cmd instanceof ListObjectsV2Command) {
          return Promise.resolve(emptyList);
        }
        return Promise.reject(notFoundError()); // HeadObject
      });
      await expect(provider.move('user', 'ghost', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses when the target already exists', async () => {
      const { provider, send } = makeProvider();
      send.mockImplementation((cmd: object) => {
        if (cmd instanceof ListObjectsV2Command) {
          return Promise.resolve(emptyList);
        }
        return Promise.resolve({}); // every HeadObject succeeds
      });
      await expect(provider.move('user', 'a.md', 'b.md')).rejects.toThrow(
        'Target already exists.',
      );
    });

    it('copies then deletes for a single-file move', async () => {
      const { provider, send } = makeProvider();
      send.mockImplementation((cmd: object) => {
        if (cmd instanceof ListObjectsV2Command) {
          return Promise.resolve(emptyList);
        }
        if (cmd instanceof HeadObjectCommand) {
          const key = (cmd as HeadObjectCommand).input.Key;
          return key === 'app/user/a.md'
            ? Promise.resolve({})
            : Promise.reject(notFoundError());
        }
        return Promise.resolve({});
      });

      await provider.move('user', 'a.md', 'b.md');

      const copy = send.mock.calls
        .map((c) => c[0] as object)
        .find((c) => c instanceof CopyObjectCommand) as CopyObjectCommand;
      expect(copy.input).toMatchObject({
        CopySource: 'vault/app/user/a.md',
        Key: 'app/user/b.md',
      });
      const del = send.mock.calls
        .map((c) => c[0] as object)
        .find((c) => c instanceof DeleteObjectsCommand) as DeleteObjectsCommand;
      expect(del.input.Delete?.Objects).toEqual([{ Key: 'app/user/a.md' }]);
    });

    it('moves folder contents key by key', async () => {
      const { provider, send } = makeProvider();
      send.mockImplementation((cmd: object) => {
        if (cmd instanceof ListObjectsV2Command) {
          const prefix = (cmd as ListObjectsV2Command).input.Prefix;
          if (prefix === 'app/user/src/') {
            return Promise.resolve({
              Contents: [
                { Key: 'app/user/src/a.md' },
                { Key: 'app/user/src/deep/b.md' },
              ],
              IsTruncated: false,
            });
          }
          return Promise.resolve(emptyList);
        }
        if (cmd instanceof HeadObjectCommand) {
          return Promise.reject(notFoundError()); // neither src nor dst exist as files
        }
        return Promise.resolve({});
      });

      await provider.move('user', 'src', 'dst');

      const copies = send.mock.calls
        .map((c) => c[0] as object)
        .filter((c) => c instanceof CopyObjectCommand) as CopyObjectCommand[];
      expect(copies.map((c) => c.input.Key).sort()).toEqual([
        'app/user/dst/a.md',
        'app/user/dst/deep/b.md',
      ]);
    });

    it('URL-encodes copy sources per segment', async () => {
      const { provider, send } = makeProvider();
      send.mockImplementation((cmd: object) => {
        if (cmd instanceof ListObjectsV2Command) {
          return Promise.resolve(emptyList);
        }
        if (cmd instanceof HeadObjectCommand) {
          const key = (cmd as HeadObjectCommand).input.Key;
          return key === 'app/user/nöte #1.md'
            ? Promise.resolve({})
            : Promise.reject(notFoundError());
        }
        return Promise.resolve({});
      });

      await provider.move('user', 'nöte #1.md', 'renamed.md');

      const copy = send.mock.calls
        .map((c) => c[0] as object)
        .find((c) => c instanceof CopyObjectCommand) as CopyObjectCommand;
      expect(copy.input.CopySource).toBe(
        `vault/app/user/${encodeURIComponent('nöte #1.md')}`,
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

    it('throws NotFound when nothing matches', async () => {
      const { provider, send } = makeProvider();
      send.mockImplementation((cmd: object) =>
        cmd instanceof ListObjectsV2Command
          ? Promise.resolve(emptyList)
          : Promise.reject(notFoundError()),
      );
      await expect(provider.remove('user', 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deletes a folder subtree plus the bare key', async () => {
      const { provider, send } = makeProvider();
      send.mockImplementation((cmd: object) => {
        if (cmd instanceof ListObjectsV2Command) {
          return Promise.resolve({
            Contents: [
              { Key: 'app/user/dir/a.md' },
              { Key: 'app/user/dir/b.md' },
            ],
            IsTruncated: false,
          });
        }
        if (cmd instanceof HeadObjectCommand) {
          return Promise.resolve({}); // bare "dir" object also exists
        }
        return Promise.resolve({});
      });

      await provider.remove('user', 'dir');

      const del = send.mock.calls
        .map((c) => c[0] as object)
        .find((c) => c instanceof DeleteObjectsCommand) as DeleteObjectsCommand;
      expect(del.input.Delete?.Objects).toEqual([
        { Key: 'app/user/dir/a.md' },
        { Key: 'app/user/dir/b.md' },
        { Key: 'app/user/dir' },
      ]);
    });

    it('splits deletions into batches of 1000', async () => {
      const { provider, send } = makeProvider();
      const contents = Array.from({ length: 1001 }, (_, i) => ({
        Key: `app/user/dir/f${i}.md`,
      }));
      send.mockImplementation((cmd: object) => {
        if (cmd instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: contents, IsTruncated: false });
        }
        if (cmd instanceof HeadObjectCommand) {
          return Promise.reject(notFoundError());
        }
        return Promise.resolve({});
      });

      await provider.remove('user', 'dir');

      const deletes = send.mock.calls
        .map((c) => c[0] as object)
        .filter(
          (c) => c instanceof DeleteObjectsCommand,
        ) as DeleteObjectsCommand[];
      expect(deletes).toHaveLength(2);
      expect(deletes[0].input.Delete?.Objects).toHaveLength(1000);
      expect(deletes[1].input.Delete?.Objects).toHaveLength(1);
    });
  });

  describe('metadata', () => {
    it('statFile returns size and mtime', async () => {
      const { provider, send } = makeProvider();
      const when = new Date('2026-01-02T03:04:05Z');
      send.mockResolvedValue({ ContentLength: 7, LastModified: when });
      await expect(provider.statFile('user', 'a.md')).resolves.toEqual({
        size: 7,
        mtimeMs: when.getTime(),
      });
    });

    it('statFile maps 404 to NotFoundException', async () => {
      const { provider, send } = makeProvider();
      send.mockRejectedValue(notFoundError());
      await expect(provider.statFile('user', 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('isFile reflects HeadObject success/failure', async () => {
      const { provider, send } = makeProvider();
      send.mockResolvedValueOnce({});
      await expect(provider.isFile('user', 'a.md')).resolves.toBe(true);
      send.mockRejectedValueOnce(notFoundError());
      await expect(provider.isFile('user', 'ghost')).resolves.toBe(false);
    });

    it('isDir checks whether any key lives under the prefix', async () => {
      const { provider, send } = makeProvider();
      send.mockResolvedValueOnce({ KeyCount: 1 });
      await expect(provider.isDir('user', 'dir')).resolves.toBe(true);
      send.mockResolvedValueOnce({ KeyCount: 0 });
      await expect(provider.isDir('user', 'empty')).resolves.toBe(false);
    });
  });

  describe('usage', () => {
    it('sums object sizes across pages and caches the result', async () => {
      const { provider, send } = makeProvider();
      send
        .mockResolvedValueOnce({
          Contents: [{ Size: 10 }, { Size: 20 }],
          IsTruncated: true,
          NextContinuationToken: 't',
        })
        .mockResolvedValueOnce({
          Contents: [{ Size: 5 }],
          IsTruncated: false,
        });

      await expect(provider.usage('user')).resolves.toBe(35);
      // Cached: no further S3 calls.
      await expect(provider.usage('user')).resolves.toBe(35);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('invalidates the cache after a write', async () => {
      const { provider, send } = makeProvider();
      send.mockResolvedValue({ Contents: [{ Size: 1 }], IsTruncated: false });
      await provider.usage('user');
      send.mockClear();

      send.mockResolvedValue({});
      await provider.writeBytes('user', 'a.md', Buffer.from('x'));

      send.mockResolvedValue({ Contents: [{ Size: 2 }], IsTruncated: false });
      await expect(provider.usage('user')).resolves.toBe(2);
    });
  });

  describe('removeUser', () => {
    it('deletes everything under the user prefix', async () => {
      const { provider, send } = makeProvider();
      send.mockImplementation((cmd: object) => {
        if (cmd instanceof ListObjectsV2Command) {
          return Promise.resolve({
            Contents: [{ Key: 'app/user/a.md' }],
            IsTruncated: false,
          });
        }
        return Promise.resolve({});
      });
      await provider.removeUser('user');
      const del = send.mock.calls
        .map((c) => c[0] as object)
        .find((c) => c instanceof DeleteObjectsCommand) as DeleteObjectsCommand;
      expect(del.input.Delete?.Objects).toEqual([{ Key: 'app/user/a.md' }]);
    });

    it('does not issue a delete for an empty namespace', async () => {
      const { provider, send } = makeProvider();
      send.mockResolvedValue(emptyList);
      await provider.removeUser('user');
      expect(
        send.mock.calls.some((c) => c[0] instanceof DeleteObjectsCommand),
      ).toBe(false);
    });
  });

  describe('walkFiles', () => {
    it('returns vault-relative files, hiding the trash', async () => {
      const { provider, send } = makeProvider();
      const when = new Date('2026-01-01T00:00:00Z');
      send.mockResolvedValue({
        Contents: [
          { Key: 'app/user/a.md', Size: 3, LastModified: when },
          { Key: 'app/user/folder/.keep', Size: 0 },
          { Key: 'app/user/.trash/deleted.md', Size: 9 },
          { Key: 'app/user/.trash', Size: 0 },
        ],
        IsTruncated: false,
      });

      const files = await provider.walkFiles('user');
      expect(files).toEqual([
        { relPath: 'a.md', size: 3, mtimeMs: when.getTime() },
        { relPath: 'folder/.keep', size: 0, mtimeMs: 0 },
      ]);
    });
  });
});
