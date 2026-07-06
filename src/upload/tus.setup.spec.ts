import type { NestExpressApplication } from '@nestjs/platform-express';
import { promises as fs } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuthService } from '../auth/auth.service';
import { VaultService } from '../vault/vault.service';
import { setupTus, TUS_HEADERS } from './tus.setup';

jest.mock('@tus/server', () => ({
  Server: jest.fn().mockImplementation((options: unknown) => ({
    options,
    handle: jest.fn(),
  })),
}));
jest.mock('@tus/file-store', () => ({
  FileStore: jest.fn().mockImplementation(() => ({})),
}));

import { Server } from '@tus/server';

interface TusHooks {
  path: string;
  maxSize: number;
  allowedHeaders: string[];
  relativeLocation: boolean;
  respectForwardedHeaders: boolean;
  onUploadCreate: (
    req: unknown,
    res: unknown,
    upload: { metadata?: Record<string, string> },
  ) => Promise<unknown>;
  onIncomingRequest: (
    req: IncomingMessage & { woUsername?: string },
    res: unknown,
    uploadId: unknown,
  ) => Promise<void>;
  onUploadFinish: (
    req: IncomingMessage & { woUsername?: string },
    res: unknown,
    upload: { id: string; size?: number; metadata?: Record<string, string> },
  ) => Promise<unknown>;
}

function setup(): {
  hooks: TusHooks;
  auth: { verifyToken: jest.Mock };
  vault: { writeStreamAtPath: jest.Mock };
  mountedPath: RegExp;
} {
  const auth = { verifyToken: jest.fn() };
  // The hook unlinks the temp file right after the vault call resolves; a real
  // fs read stream opens lazily and would then emit an unhandled ENOENT. Drain
  // the stream inside the mock so the open/read completes before cleanup.
  const drain = (stream: NodeJS.ReadableStream): Promise<void> =>
    new Promise((resolvePromise) => {
      stream.on('error', () => resolvePromise());
      stream.on('end', () => resolvePromise());
      stream.resume();
    });
  const vault = {
    writeStreamAtPath: jest
      .fn()
      .mockImplementation(
        async (_user: string, _path: string, stream: NodeJS.ReadableStream) => {
          await drain(stream);
          return 'ok';
        },
      ),
  };
  const all = jest.fn();
  const app = {
    get: jest.fn().mockImplementation((token: unknown) => {
      if (token === AuthService) return auth;
      if (token === VaultService) return vault;
      throw new Error('unexpected token');
    }),
    getHttpAdapter: () => ({ getInstance: () => ({ all }) }),
  } as unknown as NestExpressApplication;

  setupTus(app);

  const serverCalls = (Server as unknown as jest.Mock).mock.calls;
  const hooks = serverCalls[serverCalls.length - 1][0];
  return { hooks, auth, vault, mountedPath: all.mock.calls[0][0] };
}

const reqWithCookie = (
  cookie?: string,
): IncomingMessage & { woUsername?: string } =>
  ({ headers: cookie === undefined ? {} : { cookie } }) as never;

// Where tus.setup assembles uploads; onUploadFinish reads the file back from
// here, so tests that reach the vault handoff must seed it.
const TUS_TMP_DIR = join(tmpdir(), 'websidian-tus');

async function seedTmpUpload(id: string): Promise<void> {
  await fs.mkdir(TUS_TMP_DIR, { recursive: true });
  await fs.writeFile(join(TUS_TMP_DIR, id), 'ciphertext');
}

describe('setupTus', () => {
  afterEach(() => jest.clearAllMocks());

  it('mounts the tus handler on /files and configures the server', () => {
    const { hooks, mountedPath } = setup();
    expect(hooks.path).toBe('/files');
    expect(hooks.allowedHeaders).toEqual(TUS_HEADERS);
    expect(hooks.relativeLocation).toBe(true);
    expect(hooks.respectForwardedHeaders).toBe(true);
    expect(hooks.maxSize).toBeGreaterThan(0);
    expect(mountedPath.test('/files')).toBe(true);
    expect(mountedPath.test('/files/abc123')).toBe(true);
    expect(mountedPath.test('/filesystem')).toBe(false);
  });

  describe('onUploadCreate (junk filter)', () => {
    it('rejects OS junk filenames with a 400', async () => {
      const { hooks } = setup();
      await expect(
        hooks.onUploadCreate({}, {}, { metadata: { filename: '.DS_Store' } }),
      ).rejects.toMatchObject({ status_code: 400 });
      await expect(
        hooks.onUploadCreate({}, {}, { metadata: { filename: '._sidecar' } }),
      ).rejects.toMatchObject({ status_code: 400 });
    });

    it('passes normal files through', async () => {
      const res = {};
      const { hooks } = setup();
      await expect(
        hooks.onUploadCreate({}, res, { metadata: { filename: 'note.md' } }),
      ).resolves.toBe(res);
      await expect(hooks.onUploadCreate({}, res, {})).resolves.toBe(res);
    });
  });

  describe('onIncomingRequest (cookie auth)', () => {
    it('rejects requests without the auth cookie', async () => {
      const { hooks } = setup();
      await expect(
        hooks.onIncomingRequest(reqWithCookie(), {}, undefined),
      ).rejects.toMatchObject({ status_code: 401 });
      await expect(
        hooks.onIncomingRequest(reqWithCookie('other=1'), {}, undefined),
      ).rejects.toMatchObject({ status_code: 401 });
    });

    it('rejects invalid tokens', async () => {
      const { hooks, auth } = setup();
      auth.verifyToken.mockImplementation(() => {
        throw new Error('expired');
      });
      await expect(
        hooks.onIncomingRequest(reqWithCookie('wo_token=bad'), {}, undefined),
      ).rejects.toMatchObject({ status_code: 401 });
    });

    it('rejects pending-stage tokens', async () => {
      const { hooks, auth } = setup();
      auth.verifyToken.mockReturnValue({
        purpose: 'pending',
        username: 'alice',
      });
      await expect(
        hooks.onIncomingRequest(reqWithCookie('wo_token=t'), {}, undefined),
      ).rejects.toMatchObject({ status_code: 401 });
    });

    it('decorates the request with the username on success', async () => {
      const { hooks, auth } = setup();
      auth.verifyToken.mockReturnValue({ purpose: 'auth', username: 'alice' });
      const req = reqWithCookie('a=1; wo_token=tok%20en; b=2');
      await hooks.onIncomingRequest(req, {}, undefined);
      expect(auth.verifyToken).toHaveBeenCalledWith('tok en');
      expect(req.woUsername).toBe('alice');
    });
  });

  describe('onUploadFinish (vault handoff)', () => {
    it('rejects when the request was never authenticated', async () => {
      const { hooks } = setup();
      await expect(
        hooks.onUploadFinish(reqWithCookie(), {}, { id: 'u1' }),
      ).rejects.toMatchObject({ status_code: 401 });
    });

    it('rejects traversal in the path metadata with a 400', async () => {
      const { hooks, vault } = setup();
      const req = reqWithCookie();
      req.woUsername = 'alice';
      await expect(
        hooks.onUploadFinish(
          req,
          {},
          {
            id: 'u1',
            metadata: { relativePath: '../../etc', filename: 'passwd' },
          },
        ),
      ).rejects.toMatchObject({ status_code: 400 });
      expect(vault.writeStreamAtPath).not.toHaveBeenCalled();
    });

    it('streams the assembled upload into the vault under the sanitized path', async () => {
      const { hooks, vault } = setup();
      await seedTmpUpload('upload-1');
      const req = reqWithCookie();
      req.woUsername = 'alice';
      const res = {};

      await expect(
        hooks.onUploadFinish(req, res, {
          id: 'upload-1',
          size: 123,
          metadata: {
            base: 'imports',
            relativePath: 'folder\\sub',
            filename: 'note.md',
          },
        }),
      ).resolves.toBe(res);

      expect(vault.writeStreamAtPath).toHaveBeenCalledWith(
        'alice',
        'imports/folder/sub/note.md',
        expect.anything(),
        123,
      );
    });

    it('propagates vault failures (quota etc.) after cleanup', async () => {
      const { hooks, vault } = setup();
      await seedTmpUpload('u1');
      vault.writeStreamAtPath.mockImplementation(
        async (_user: string, _path: string, stream: NodeJS.ReadableStream) => {
          stream.on('error', () => {});
          throw new Error('quota exceeded');
        },
      );
      const req = reqWithCookie();
      req.woUsername = 'alice';

      await expect(
        hooks.onUploadFinish(
          req,
          {},
          {
            id: 'u1',
            metadata: { filename: 'note.md' },
          },
        ),
      ).rejects.toThrow('quota exceeded');
    });
  });
});

// Keep TypeScript satisfied that ServerResponse is used (hooks are structural).
void (undefined as unknown as ServerResponse);
