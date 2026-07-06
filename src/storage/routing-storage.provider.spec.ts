import { Readable } from 'stream';
import { RoutingStorageProvider } from './routing-storage.provider';
import { StorageResolver } from './storage-resolver.service';
import { StorageProvider } from './storage.interface';

describe('RoutingStorageProvider', () => {
  let delegate: jest.Mocked<StorageProvider>;
  let resolver: { getForStorageId: jest.Mock };
  let routing: RoutingStorageProvider;

  beforeEach(() => {
    delegate = {
      ensureUser: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue([{ name: 'a.md', type: 'file' }]),
      readText: jest.fn().mockResolvedValue('text'),
      readBytes: jest.fn().mockResolvedValue(Buffer.from('bytes')),
      openReadStream: jest.fn().mockResolvedValue({
        stream: Readable.from([]),
        size: 1,
      }),
      writeBytes: jest.fn().mockResolvedValue(undefined),
      writeStream: jest.fn().mockResolvedValue(undefined),
      makeDir: jest.fn().mockResolvedValue(undefined),
      move: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      statFile: jest.fn().mockResolvedValue({ size: 3, mtimeMs: 1 }),
      isFile: jest.fn().mockResolvedValue(true),
      isDir: jest.fn().mockResolvedValue(false),
      usage: jest.fn().mockResolvedValue(42),
      removeUser: jest.fn().mockResolvedValue(undefined),
      walkFiles: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<StorageProvider>;
    resolver = { getForStorageId: jest.fn().mockResolvedValue(delegate) };
    routing = new RoutingStorageProvider(
      resolver as unknown as StorageResolver,
    );
  });

  it('resolves the provider per storage namespace and forwards every call', async () => {
    await routing.ensureUser('sid');
    expect(delegate.ensureUser).toHaveBeenCalledWith('sid');

    await expect(routing.list('sid', 'dir')).resolves.toEqual([
      { name: 'a.md', type: 'file' },
    ]);
    expect(delegate.list).toHaveBeenCalledWith('sid', 'dir');

    await expect(routing.readText('sid', 'a.md')).resolves.toBe('text');
    await expect(routing.readBytes('sid', 'a.md')).resolves.toEqual(
      Buffer.from('bytes'),
    );
    await expect(routing.openReadStream('sid', 'a.md')).resolves.toMatchObject({
      size: 1,
    });

    const buf = Buffer.from('data');
    await routing.writeBytes('sid', 'a.md', buf);
    expect(delegate.writeBytes).toHaveBeenCalledWith('sid', 'a.md', buf);

    const stream = Readable.from([]);
    await routing.writeStream('sid', 'a.md', stream, 4);
    expect(delegate.writeStream).toHaveBeenCalledWith('sid', 'a.md', stream, 4);

    await routing.makeDir('sid', 'folder');
    expect(delegate.makeDir).toHaveBeenCalledWith('sid', 'folder');

    await routing.move('sid', 'a', 'b');
    expect(delegate.move).toHaveBeenCalledWith('sid', 'a', 'b');

    await routing.remove('sid', 'a');
    expect(delegate.remove).toHaveBeenCalledWith('sid', 'a');

    await expect(routing.statFile('sid', 'a.md')).resolves.toEqual({
      size: 3,
      mtimeMs: 1,
    });
    await expect(routing.isFile('sid', 'a.md')).resolves.toBe(true);
    await expect(routing.isDir('sid', 'a.md')).resolves.toBe(false);
    await expect(routing.usage('sid')).resolves.toBe(42);

    await routing.removeUser('sid');
    expect(delegate.removeUser).toHaveBeenCalledWith('sid');

    expect(resolver.getForStorageId).toHaveBeenCalledWith('sid');
  });

  it('forwards walkFiles when the delegate implements it', async () => {
    delegate.walkFiles = jest
      .fn()
      .mockResolvedValue([{ relPath: 'a.md', size: 1, mtimeMs: 0 }]);
    await expect(routing.walkFiles('sid')).resolves.toEqual([
      { relPath: 'a.md', size: 1, mtimeMs: 0 },
    ]);
  });

  it('returns undefined when the delegate has no fast path', async () => {
    delete (delegate as { walkFiles?: unknown }).walkFiles;
    await expect(routing.walkFiles('sid')).resolves.toBeUndefined();
  });

  it('propagates resolver failures', async () => {
    resolver.getForStorageId.mockRejectedValue(new Error('no storage'));
    await expect(routing.list('sid', '')).rejects.toThrow('no storage');
  });
});
