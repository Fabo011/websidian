import { TRASH_DIR, VaultService } from './vault.service';

type Entry = { name: string; type: 'file' | 'dir' };

/**
 * Minimal in-memory storage stub for exercising deleteEntryProgress without a
 * real filesystem / S3. Only the methods the delete path touches are provided.
 */
function makeStorage(tree: Record<string, Entry[]>, files: Set<string>) {
  return {
    isFile: jest.fn(async (_sid: string, p: string) => files.has(p)),
    list: jest.fn(async (_sid: string, dir: string) => tree[dir] || []),
    move: jest.fn(async () => {}),
    remove: jest.fn(async () => {}),
  };
}

function makeService(storage: unknown, retentionDays: number): VaultService {
  const config = {
    get: () => ({ trashRetentionDays: retentionDays }),
  };
  const svc = new VaultService(
    storage as never,
    {} as never,
    {} as never,
    config as never,
  );
  // Seed the storageId cache so sid() doesn't hit the (unmocked) users service.
  (svc as unknown as { storageIds: Map<string, string> }).storageIds.set(
    'alice',
    'sid',
  );
  return svc;
}

describe('VaultService.deleteEntryProgress', () => {
  it('soft-deletes a folder file-by-file and reports progress', async () => {
    // folder/a.md, folder/sub/b.md
    const tree: Record<string, Entry[]> = {
      folder: [
        { name: 'a.md', type: 'file' },
        { name: 'sub', type: 'dir' },
      ],
      'folder/sub': [{ name: 'b.md', type: 'file' }],
    };
    const storage = makeStorage(tree, new Set());
    const svc = makeService(storage, 7);

    const progress: Array<[number, number]> = [];
    await svc.deleteEntryProgress('alice', 'folder', (d, t) =>
      progress.push([d, t]),
    );

    // Both files moved into one trash batch (not removed outright).
    expect(storage.move).toHaveBeenCalledTimes(2);
    for (const call of storage.move.mock.calls as unknown as unknown[][]) {
      expect(String(call[2])).toMatch(
        new RegExp(`^${TRASH_DIR}/\\d+-[0-9a-f]+/folder/`),
      );
    }
    // The emptied source folder is cleaned up afterwards.
    expect(storage.remove).toHaveBeenCalledWith('sid', 'folder');
    // Progress starts at 0/2 and finishes at 2/2.
    expect(progress[0]).toEqual([0, 2]);
    expect(progress[progress.length - 1]).toEqual([2, 2]);
  });

  it('removes outright (no trash) when retention is disabled', async () => {
    const tree: Record<string, Entry[]> = {
      folder: [{ name: 'a.md', type: 'file' }],
    };
    const storage = makeStorage(tree, new Set());
    const svc = makeService(storage, 0);

    await svc.deleteEntryProgress('alice', 'folder', () => {});

    expect(storage.move).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith('sid', 'folder/a.md');
  });

  it('handles a single file', async () => {
    const storage = makeStorage({}, new Set(['notes/one.md']));
    const svc = makeService(storage, 7);

    const progress: Array<[number, number]> = [];
    await svc.deleteEntryProgress('alice', 'notes/one.md', (d, t) =>
      progress.push([d, t]),
    );

    expect(storage.move).toHaveBeenCalledTimes(1);
    expect(progress).toContainEqual([1, 1]);
    // No folder cleanup for a single file.
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
