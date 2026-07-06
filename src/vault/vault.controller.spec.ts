import { BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { AuthenticatedUser } from '../auth/auth.types';
import { VaultController } from './vault.controller';
import { VaultService } from './vault.service';

const USER: AuthenticatedUser = {
  id: 1,
  username: 'alice',
  storageId: 'sid',
};

function makeController(): {
  controller: VaultController;
  vault: jest.Mocked<
    Pick<
      VaultService,
      | 'listTree'
      | 'readTextFile'
      | 'writeTextFile'
      | 'createFolder'
      | 'listTrash'
      | 'restoreFromTrash'
      | 'emptyTrash'
      | 'rename'
      | 'deleteEntry'
      | 'deleteEntryProgress'
      | 'saveUploadStream'
      | 'search'
      | 'listAllFiles'
      | 'readNotesContent'
      | 'resolveAttachment'
    >
  >;
} {
  const vault = {
    listTree: jest.fn(),
    readTextFile: jest.fn(),
    writeTextFile: jest.fn(),
    createFolder: jest.fn().mockResolvedValue(undefined),
    listTrash: jest.fn(),
    restoreFromTrash: jest.fn(),
    emptyTrash: jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined),
    deleteEntry: jest.fn().mockResolvedValue(undefined),
    deleteEntryProgress: jest.fn().mockResolvedValue(undefined),
    saveUploadStream: jest.fn(),
    search: jest.fn(),
    listAllFiles: jest.fn(),
    readNotesContent: jest.fn(),
    resolveAttachment: jest.fn(),
  } as unknown as ReturnType<typeof makeController>['vault'];
  return {
    controller: new VaultController(vault as unknown as VaultService),
    vault,
  };
}

function makeRes(): Response & {
  headers: Record<string, string>;
  chunks: string[];
  ended: boolean;
} {
  const res = {
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
  };
  return res as unknown as ReturnType<typeof makeRes>;
}

describe('VaultController', () => {
  it('tree delegates to the service', async () => {
    const { controller, vault } = makeController();
    vault.listTree.mockResolvedValue([]);
    await expect(controller.tree(USER)).resolves.toEqual([]);
    expect(vault.listTree).toHaveBeenCalledWith('alice');
  });

  describe('file', () => {
    it('requires a path', () => {
      const { controller } = makeController();
      expect(() => controller.file(USER, '')).toThrow(BadRequestException);
    });

    it('reads the file', async () => {
      const { controller, vault } = makeController();
      vault.readTextFile.mockResolvedValue({ path: 'a.md' } as never);
      await expect(controller.file(USER, 'a.md')).resolves.toEqual({
        path: 'a.md',
      });
    });
  });

  it('writeFile forwards path/content/baseVersion', async () => {
    const { controller, vault } = makeController();
    vault.writeTextFile.mockResolvedValue({ version: 'v2' } as never);
    await controller.writeFile(USER, {
      path: 'a.md',
      content: 'AAA=',
      baseVersion: 'v1',
    });
    expect(vault.writeTextFile).toHaveBeenCalledWith(
      'alice',
      'a.md',
      'AAA=',
      'v1',
    );
  });

  it('folder creates and confirms', async () => {
    const { controller, vault } = makeController();
    await expect(controller.folder(USER, { path: 'new' })).resolves.toEqual({
      ok: true,
    });
    expect(vault.createFolder).toHaveBeenCalledWith('alice', 'new');
  });

  describe('trash endpoints', () => {
    it('lists the trash', async () => {
      const { controller, vault } = makeController();
      vault.listTrash.mockResolvedValue([]);
      await controller.listTrash(USER);
      expect(vault.listTrash).toHaveBeenCalledWith('alice');
    });

    it('restore requires an id', async () => {
      const { controller } = makeController();
      await expect(controller.restoreTrash(USER, '')).rejects.toThrow(
        'id is required.',
      );
    });

    it('restore returns the restored path', async () => {
      const { controller, vault } = makeController();
      vault.restoreFromTrash.mockResolvedValue({ restoredTo: 'notes' });
      await expect(controller.restoreTrash(USER, '1-a')).resolves.toEqual({
        ok: true,
        restoredTo: 'notes',
      });
    });

    it('empties the trash', async () => {
      const { controller, vault } = makeController();
      await expect(controller.emptyTrash(USER)).resolves.toEqual({ ok: true });
      expect(vault.emptyTrash).toHaveBeenCalledWith('alice');
    });
  });

  it('rename delegates', async () => {
    const { controller, vault } = makeController();
    await expect(
      controller.rename(USER, { from: 'a.md', to: 'b.md' }),
    ).resolves.toEqual({ ok: true });
    expect(vault.rename).toHaveBeenCalledWith('alice', 'a.md', 'b.md');
  });

  describe('remove', () => {
    it('requires a path', async () => {
      const { controller } = makeController();
      await expect(controller.remove(USER, '', '')).rejects.toThrow(
        'path is required.',
      );
    });

    it('deletes and returns JSON in default mode', async () => {
      const { controller, vault } = makeController();
      await expect(controller.remove(USER, 'a.md', '')).resolves.toEqual({
        ok: true,
      });
      expect(vault.deleteEntry).toHaveBeenCalledWith('alice', 'a.md');
    });

    it('streams NDJSON progress lines in streaming mode', async () => {
      const { controller, vault } = makeController();
      vault.deleteEntryProgress.mockImplementation(
        async (_user, _path, onProgress) => {
          onProgress(0, 2);
          onProgress(1, 2);
          onProgress(2, 2);
        },
      );
      const res = makeRes();

      await controller.remove(USER, 'folder', '1', res);

      expect(res.headers['Content-Type']).toBe('application/x-ndjson');
      const lines = res.chunks.map((c) => JSON.parse(c.trim()));
      expect(lines).toEqual([
        { done: 0, total: 2 },
        { done: 1, total: 2 },
        { done: 2, total: 2 },
        { ok: true },
      ]);
      expect(res.ended).toBe(true);
    });

    it('reports errors as an NDJSON line instead of throwing', async () => {
      const { controller, vault } = makeController();
      vault.deleteEntryProgress.mockRejectedValue(new Error('boom'));
      const res = makeRes();

      await controller.remove(USER, 'folder', '1', res);

      const last = JSON.parse(res.chunks[res.chunks.length - 1].trim());
      expect(last).toEqual({ error: 'boom' });
      expect(res.ended).toBe(true);
    });
  });

  describe('upload', () => {
    it('rejects a missing file', async () => {
      const { controller } = makeController();
      await expect(
        controller.upload(USER, undefined as never, ''),
      ).rejects.toThrow('No file uploaded.');
    });

    it('streams the spooled file into the vault and deletes the temp', async () => {
      const { controller, vault } = makeController();
      const tmp = join(tmpdir(), `websidian-upload-spec-${Date.now()}`);
      await fs.writeFile(tmp, 'ciphertext');
      vault.saveUploadStream.mockImplementation(
        async (
          _u: string,
          _f: string,
          _n: string,
          stream: NodeJS.ReadableStream,
        ) => {
          // Drain so the temp file is fully read before the finally-unlink.
          await new Promise((r) => {
            stream.on('end', r);
            stream.on('error', r);
            stream.resume();
          });
          return 'media/img.png';
        },
      );

      const file = {
        path: tmp,
        originalname: 'img.png',
        size: 10,
      } as Express.Multer.File;

      await expect(controller.upload(USER, file, 'media')).resolves.toEqual({
        ok: true,
        path: 'media/img.png',
      });
      expect(vault.saveUploadStream).toHaveBeenCalledWith(
        'alice',
        'media',
        'img.png',
        expect.anything(),
        10,
      );
      // Temp file removed even on success.
      await expect(fs.stat(tmp)).rejects.toThrow();
    });

    it('deletes the temp file even when the vault write fails', async () => {
      const { controller, vault } = makeController();
      const tmp = join(tmpdir(), `websidian-upload-spec-fail-${Date.now()}`);
      await fs.writeFile(tmp, 'ciphertext');
      vault.saveUploadStream.mockImplementation(
        async (
          _u: string,
          _f: string,
          _n: string,
          stream: NodeJS.ReadableStream,
        ) => {
          stream.on('error', () => {});
          throw new Error('quota exceeded');
        },
      );

      const file = {
        path: tmp,
        originalname: 'img.png',
        size: 10,
      } as Express.Multer.File;

      await expect(controller.upload(USER, file, '')).rejects.toThrow(
        'quota exceeded',
      );
      await expect(fs.stat(tmp)).rejects.toThrow();
    });
  });

  it('search delegates with a default empty query', async () => {
    const { controller, vault } = makeController();
    vault.search.mockResolvedValue([]);
    await controller.search(USER, 'query');
    expect(vault.search).toHaveBeenCalledWith('alice', 'query');
  });

  it('listFiles maps relPath to path', async () => {
    const { controller, vault } = makeController();
    vault.listAllFiles.mockResolvedValue([{ relPath: 'a.md', version: '1-1' }]);
    await expect(controller.listFiles(USER)).resolves.toEqual([
      { path: 'a.md', version: '1-1' },
    ]);
  });

  it('graphNotes delegates', async () => {
    const { controller, vault } = makeController();
    vault.readNotesContent.mockResolvedValue([]);
    await controller.graphNotes(USER);
    expect(vault.readNotesContent).toHaveBeenCalledWith('alice');
  });

  describe('attachment', () => {
    it('requires a path', async () => {
      const { controller } = makeController();
      await expect(controller.attachment(USER, '', makeRes())).rejects.toThrow(
        'path is required.',
      );
    });

    it('streams the file with mime + disposition headers', async () => {
      const { controller, vault } = makeController();
      const stream = Readable.from([]) as never;
      const pipe = jest.fn();
      (stream as { pipe: jest.Mock }).pipe = pipe;
      vault.resolveAttachment.mockResolvedValue({
        stream,
        size: 42,
        ext: 'png',
        name: 'bild ä.png',
      });
      const res = makeRes();

      await controller.attachment(USER, 'media/bild ä.png', res);

      expect(res.headers['Content-Type']).toBe('image/png');
      expect(res.headers['Content-Length']).toBe('42');
      expect(res.headers['Content-Disposition']).toBe(
        `inline; filename="${encodeURIComponent('bild ä.png')}"`,
      );
      expect(pipe).toHaveBeenCalledWith(res);
    });
  });
});
