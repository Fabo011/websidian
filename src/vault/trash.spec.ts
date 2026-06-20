import { TRASH_DIR, VaultService } from './vault.service';

/**
 * Tiny in-memory storage backend (paths -> bytes) implementing just the methods
 * the trash flow touches, with real move/remove subtree semantics so the
 * delete -> list -> restore -> empty round-trip can be exercised end to end.
 */
class FakeFs {
  files = new Map<string, Buffer>();

  seed(path: string) {
    this.files.set(path, Buffer.from(path));
  }

  async isFile(_sid: string, p: string) {
    return this.files.has(p);
  }
  async isDir(_sid: string, p: string) {
    if (p === '') return true;
    for (const k of this.files.keys()) {
      if (k === p) return false;
      if (k.startsWith(`${p}/`)) return true;
    }
    return false;
  }
  async list(_sid: string, dir: string) {
    const prefix = dir ? `${dir}/` : '';
    const seen = new Map<string, { name: string; type: 'file' | 'dir' }>();
    for (const k of this.files.keys()) {
      if (prefix && !k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (!rest) continue;
      const seg = rest.split('/')[0];
      seen.set(seg, { name: seg, type: rest.includes('/') ? 'dir' : 'file' });
    }
    return [...seen.values()];
  }
  async readBytes(_sid: string, p: string) {
    return this.files.get(p) || Buffer.alloc(0);
  }
  async writeBytes(_sid: string, p: string, data: Buffer) {
    this.files.set(p, data);
  }
  async move(_sid: string, from: string, to: string) {
    for (const k of [...this.files.keys()]) {
      if (k === from) {
        this.files.set(to, this.files.get(k)!);
        this.files.delete(k);
      } else if (k.startsWith(`${from}/`)) {
        this.files.set(to + k.slice(from.length), this.files.get(k)!);
        this.files.delete(k);
      }
    }
  }
  async remove(_sid: string, p: string) {
    for (const k of [...this.files.keys()]) {
      if (k === p || k.startsWith(`${p}/`)) this.files.delete(k);
    }
  }
}

function makeService(fs: FakeFs, retentionDays = 7): VaultService {
  const config = { get: () => ({ trashRetentionDays: retentionDays }) };
  const svc = new VaultService(
    fs as never,
    {} as never,
    {} as never,
    config as never,
  );
  (svc as unknown as { storageIds: Map<string, string> }).storageIds.set(
    'alice',
    'sid',
  );
  return svc;
}

describe('trash list / restore / empty', () => {
  it('round-trips a deleted folder: delete -> list -> restore', async () => {
    const fs = new FakeFs();
    fs.seed('notes/a.md');
    fs.seed('notes/sub/b.md');
    const svc = makeService(fs);

    await svc.deleteEntryProgress('alice', 'notes', () => {});
    // The folder is gone from the vault, now under .trash.
    expect(await fs.isDir('sid', 'notes')).toBe(false);

    const items = await svc.listTrash('alice');
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe('notes');
    expect(items[0].type).toBe('dir');
    expect(items[0].deletedAt).toBeGreaterThan(0);

    const { restoredTo } = await svc.restoreFromTrash('alice', items[0].id);
    expect(restoredTo).toBe('notes');
    expect(await fs.isFile('sid', 'notes/a.md')).toBe(true);
    expect(await fs.isFile('sid', 'notes/sub/b.md')).toBe(true);
    // Trash batch cleaned up.
    expect(await svc.listTrash('alice')).toHaveLength(0);
  });

  it('restores to a de-duplicated name when the original path is taken', async () => {
    const fs = new FakeFs();
    fs.seed('x.md');
    const svc = makeService(fs);

    await svc.deleteEntryProgress('alice', 'x.md', () => {});
    fs.seed('x.md'); // a new file now occupies the original path

    const [item] = await svc.listTrash('alice');
    const { restoredTo } = await svc.restoreFromTrash('alice', item.id);
    // The suffix goes before the extension for files.
    expect(restoredTo).toBe('x (restored).md');
    expect(await fs.isFile('sid', 'x.md')).toBe(true);
    expect(await fs.isFile('sid', 'x (restored).md')).toBe(true);
  });

  it('empties the trash permanently', async () => {
    const fs = new FakeFs();
    fs.seed('notes/a.md');
    const svc = makeService(fs);

    await svc.deleteEntryProgress('alice', 'notes', () => {});
    expect(await svc.listTrash('alice')).toHaveLength(1);

    await svc.emptyTrash('alice');
    expect(await svc.listTrash('alice')).toHaveLength(0);
    expect(await fs.isDir('sid', TRASH_DIR)).toBe(false);
  });

  it('rejects an invalid trash id', async () => {
    const fs = new FakeFs();
    const svc = makeService(fs);
    await expect(svc.restoreFromTrash('alice', '../escape')).rejects.toThrow();
  });
});
