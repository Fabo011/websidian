import { S3StorageProvider } from './s3-storage.provider';
import {
  buildUserProvider,
  mapStorageError,
  probeProvider,
  UserStorageConfig,
} from './storage-config';
import { StorageProvider } from './storage.interface';
import { WebdavStorageProvider } from './webdav-storage.provider';

describe('buildUserProvider', () => {
  it('builds an S3 provider from user credentials', () => {
    const cfg: UserStorageConfig = {
      driver: 's3',
      s3: {
        endpoint: ' https://s3.example.com ',
        region: '',
        bucket: ' vault ',
        accessKeyId: ' key ',
        secretAccessKey: 'secret',
        prefix: '/apps/me/',
      },
    };
    const provider = buildUserProvider(cfg);
    expect(provider).toBeInstanceOf(S3StorageProvider);
    // Normalisation: trimming, default region, prefix slash stripping.
    const normalized = (provider as unknown as { cfg: Record<string, unknown> })
      .cfg;
    expect(normalized).toEqual({
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'vault',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      forcePathStyle: true,
      prefix: 'apps/me',
    });
  });

  it('builds a WebDAV provider with defaults filled in', () => {
    const cfg: UserStorageConfig = {
      driver: 'webdav',
      webdav: {
        url: ' https://dav.example.com ',
        username: ' user ',
        password: 'pw',
        basePath: '/websidian/',
      },
    };
    const provider = buildUserProvider(cfg);
    expect(provider).toBeInstanceOf(WebdavStorageProvider);
    const normalized = (provider as unknown as { cfg: Record<string, unknown> })
      .cfg;
    expect(normalized).toEqual({
      url: 'https://dav.example.com',
      username: 'user',
      password: 'pw',
      authType: 'auto',
      basePath: 'websidian',
    });
  });

  it('refuses the managed driver (must use the global provider)', () => {
    expect(() => buildUserProvider({ driver: 'managed' })).toThrow(/managed/);
  });
});

describe('mapStorageError', () => {
  it.each([
    [{ status: 401 }, 'auth'],
    [{ status: 403 }, 'auth'],
    [{ $metadata: { httpStatusCode: 403 } }, 'auth'],
    [{ name: 'AccessDenied' }, 'auth'],
    [{ code: 'AccessDenied' }, 'auth'],
    [{ message: 'InvalidAccessKeyId: bad key' }, 'auth'],
    [{ message: 'SignatureDoesNotMatch' }, 'auth'],
    [{ status: 404 }, 'notfound'],
    [{ name: 'NoSuchBucket' }, 'notfound'],
    [{ message: 'bucket not found' }, 'notfound'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'tls'],
    [{ message: 'self signed certificate' }, 'tls'],
    [{ message: 'unable to verify TLS' }, 'tls'],
    [{ code: 'ENOTFOUND' }, 'unreachable'],
    [{ code: 'ECONNREFUSED' }, 'unreachable'],
    [{ code: 'ETIMEDOUT' }, 'unreachable'],
    [{ code: 'EAI_AGAIN' }, 'unreachable'],
    [{ code: 'ECONNRESET' }, 'unreachable'],
    [{ code: 'EHOSTUNREACH' }, 'unreachable'],
    [{ message: 'connect ECONNREFUSED 1.2.3.4' }, 'unreachable'],
    [{ message: 'request timeout' }, 'unreachable'],
    [{ message: 'getaddrinfo failed' }, 'unreachable'],
    [{ message: 'something odd' }, 'unknown'],
    [{}, 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    ['string error', 'unknown'],
  ])('classifies %j as %s', (err, expected) => {
    expect(mapStorageError(err)).toBe(expected);
  });

  it('prioritises auth over unreachable for 401 + network-y message', () => {
    expect(mapStorageError({ status: 401, message: 'network thing' })).toBe(
      'auth',
    );
  });
});

describe('probeProvider', () => {
  function makeProvider(
    overrides: Partial<Record<keyof StorageProvider, jest.Mock>> = {},
  ): StorageProvider {
    return {
      ensureUser: jest.fn().mockResolvedValue(undefined),
      writeBytes: jest.fn().mockResolvedValue(undefined),
      readBytes: jest.fn().mockResolvedValue(Buffer.from('x')),
      remove: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as StorageProvider;
  }

  it('round-trips a marker object and cleans it up', async () => {
    const provider = makeProvider();
    await probeProvider(provider, 'sid-1');

    expect(provider.ensureUser).toHaveBeenCalledWith('sid-1');
    expect(provider.writeBytes).toHaveBeenCalledWith(
      'sid-1',
      '.wo-conntest',
      expect.any(Buffer),
    );
    expect(provider.readBytes).toHaveBeenCalledWith('sid-1', '.wo-conntest');
    expect(provider.remove).toHaveBeenCalledWith('sid-1', '.wo-conntest');
  });

  it('propagates write failures', async () => {
    const provider = makeProvider({
      writeBytes: jest.fn().mockRejectedValue(new Error('denied')),
    });
    await expect(probeProvider(provider, 'sid-1')).rejects.toThrow('denied');
  });

  it('still deletes the marker when read-back fails, and propagates the error', async () => {
    const provider = makeProvider({
      readBytes: jest.fn().mockRejectedValue(new Error('read failed')),
    });
    await expect(probeProvider(provider, 'sid-1')).rejects.toThrow(
      'read failed',
    );
    expect(provider.remove).toHaveBeenCalled();
  });

  it('swallows cleanup failures', async () => {
    const provider = makeProvider({
      remove: jest.fn().mockRejectedValue(new Error('cleanup failed')),
    });
    await expect(probeProvider(provider, 'sid-1')).resolves.toBeUndefined();
  });
});
