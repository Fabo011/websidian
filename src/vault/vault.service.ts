import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { ReadStream } from 'fs';
import { basename, extname } from 'path';
import { Readable } from 'stream';
import { AppConfig } from '../config/configuration';
import {
  STORAGE_PROVIDER,
  StorageProvider,
  StorageStat,
} from '../storage/storage.interface';
import { EntitlementsService } from '../users/entitlements.service';
import { UsersService } from '../users/users.service';
import { FileContent, SearchHit, TreeNode } from './vault.types';

/** Extensions treated as editable text (returned/saved as UTF-8 strings). */
const TEXT_EXTENSIONS = new Set([
  // notes & data
  'md',
  'markdown',
  'txt',
  'excalidraw',
  'json',
  'csv',
  'tsv',
  'yml',
  'yaml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'env',
  'properties',
  'xml',
  'log',
  // web
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  // scripting & programming
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'php',
  'java',
  'kt',
  'kts',
  'go',
  'rs',
  'c',
  'h',
  'cpp',
  'cc',
  'hpp',
  'cs',
  'swift',
  'scala',
  'lua',
  'pl',
  'r',
  'sql',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'dockerfile',
  'gradle',
  'tex',
]);

export interface QuotaUsage {
  /** Bytes currently used. */
  used: number;
  /** Quota limit in bytes. 0 means unlimited. */
  limit: number;
  /** Whether a quota limit is in effect. */
  unlimited: boolean;
}

/**
 * Hidden per-user folder that holds soft-deleted items until the purge cron
 * permanently removes them. Items live under
 * `.trash/<deletedAtMs>-<rand>/<original relative path>`. The leading dot keeps
 * the whole tree out of listings, search, quota and exports (object-storage
 * providers exclude it explicitly).
 */
export const TRASH_DIR = '.trash';

/**
 * Zero-byte folder placeholder written by object stores to keep an empty folder
 * listable. Hidden from the tree (its parent folder is materialised anyway), but
 * unlike other dotfiles it is the only one we hide — real junk files (macOS
 * `._*` / `.DS_Store`, `.obsidian`, …) stay visible so the user can delete them.
 */
export const KEEP_MARKER = '.keep';

// Marker file written inside each trash batch (`.trash/<stamp>/.origin`) holding
// the deleted entry's original path + type, so the trash UI can list and restore
// it unambiguously. Batches created before this existed fall back to inferring
// the original path by walking the batch's single-child directory chain.
const TRASH_ORIGIN = '.origin';

/** One restorable entry shown in the trash view. */
export interface TrashItem {
  /** Batch id (the `<deletedAtMs>-<rand>` folder name). */
  id: string;
  /** Original vault-relative path the entry will be restored to. */
  path: string;
  /** Leaf name for display. */
  name: string;
  type: 'file' | 'dir';
  /** Epoch ms the entry was deleted. */
  deletedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class VaultService {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly users: UsersService,
    private readonly entitlements: EntitlementsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Short-lived per-user cache of the flat vault file list, used to answer
   * repeated name searches without re-enumerating storage each time. Keyed by
   * lowercased username. TTL comes from SEARCH_CACHE_TTL_MS (0 disables).
   */
  private readonly searchCache = new Map<
    string,
    { expires: number; files: Array<{ relPath: string }> }
  >();

  /** Days a deleted item stays in the trash before permanent removal. */
  private get trashRetentionDays(): number {
    return this.config.get<AppConfig>('app')?.trashRetentionDays ?? 0;
  }

  /** TTL (ms) for the flat file-list search cache. 0 disables caching. */
  private get searchCacheTtlMs(): number {
    return this.config.get<AppConfig>('app')?.searchCacheTtlMs ?? 0;
  }

  /**
   * Resolve the effective storage quota (bytes) for a user, combining their
   * plan, Stripe subscription window and privileged status. Falls back to the
   * free allowance when the user record cannot be found.
   */
  private async quotaBytesFor(username: string): Promise<number> {
    const user = await this.users.findByUsername(username.toLowerCase());
    if (!user) {
      return this.entitlements.freeBytes;
    }
    const ent = await this.entitlements.forUser(user);
    return ent.quotaBytes;
  }

  /**
   * Resolve a username to its immutable, opaque storage namespace id. All
   * storage-provider calls go through this so a recycled username can never
   * reach a previous owner's folder. Cached because storageId never changes.
   */
  private readonly storageIds = new Map<string, string>();
  private async sid(username: string): Promise<string> {
    const key = username.toLowerCase();
    let id = this.storageIds.get(key);
    if (!id) {
      const user = await this.users.findByUsername(key);
      if (!user) {
        throw new BadRequestException('Unknown user.');
      }
      id = user.storageId;
      this.storageIds.set(key, id);
    }
    return id;
  }

  /** Raw bytes consumed by a user's vault (no quota involved). */
  async usedBytes(username: string): Promise<number> {
    return this.storage.usage(await this.sid(username));
  }

  /** Create the user's vault namespace if it does not yet exist. */
  async ensureUserRoot(username: string): Promise<void> {
    await this.storage.ensureUser(await this.sid(username));
  }

  isTextFile(relPathOrName: string): boolean {
    return TEXT_EXTENSIONS.has(this.ext(relPathOrName));
  }

  private ext(name: string): string {
    return extname(name).replace(/^\./, '').toLowerCase();
  }

  /** Current storage usage and the configured quota for a user. */
  async usage(username: string): Promise<QuotaUsage> {
    const used = await this.storage.usage(await this.sid(username));
    const limit = await this.quotaBytesFor(username);
    return { used, limit, unlimited: limit === 0 };
  }

  /**
   * Ensure adding `incomingBytes` (minus `freedBytes` being overwritten) keeps
   * the user within their quota. Throws 413-style error when exceeded.
   */
  private async assertWithinQuota(
    username: string,
    incomingBytes: number,
    freedBytes = 0,
  ): Promise<void> {
    const limit = await this.quotaBytesFor(username);
    if (limit === 0) {
      return; // unlimited
    }
    const used = await this.storage.usage(await this.sid(username));
    const projected = used - freedBytes + incomingBytes;
    if (projected > limit) {
      throw new BadRequestException(
        `Storage quota exceeded. This change needs ${this.formatBytes(
          projected,
        )} but your limit is ${this.formatBytes(limit)}.`,
      );
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
  }

  async listTree(username: string): Promise<TreeNode[]> {
    await this.ensureUserRoot(username);
    const storageId = await this.sid(username);
    // Fast path: object-storage providers can enumerate the whole vault in a
    // single request, avoiding one network round-trip per directory.
    const flat = await this.storage.walkFiles?.(storageId);
    if (flat) {
      return this.buildTreeFromFlat(flat);
    }
    return this.walk(storageId, '');
  }

  /**
   * Build the sorted directory tree from a flat list of file paths. Only the
   * internal '.keep' folder markers are hidden (they still materialise their
   * parent folders); every other file — including OS junk dotfiles — is shown so
   * the user can see and delete anything occupying their vault.
   */
  private buildTreeFromFlat(files: Array<{ relPath: string }>): TreeNode[] {
    const root: TreeNode[] = [];
    const dirIndex = new Map<string, TreeNode[]>();
    dirIndex.set('', root);

    const ensureDir = (dirPath: string): TreeNode[] => {
      const existing = dirIndex.get(dirPath);
      if (existing) {
        return existing;
      }
      const slash = dirPath.lastIndexOf('/');
      const parentPath = slash >= 0 ? dirPath.slice(0, slash) : '';
      const name = slash >= 0 ? dirPath.slice(slash + 1) : dirPath;
      const siblings = ensureDir(parentPath);
      const children: TreeNode[] = [];
      siblings.push({ name, path: dirPath, type: 'dir', children });
      dirIndex.set(dirPath, children);
      return children;
    };

    for (const { relPath } of files) {
      const segments = relPath.split('/').filter(Boolean);
      if (segments.length === 0) {
        continue;
      }
      if (segments[0] === TRASH_DIR) {
        continue; // soft-deleted items are hidden from the tree
      }
      const leaf = segments[segments.length - 1];
      const dirPath = segments.slice(0, -1).join('/');
      const parent = ensureDir(dirPath);
      if (leaf === KEEP_MARKER) {
        continue; // folder placeholder — its parent dir is already materialised
      }
      parent.push({
        name: leaf,
        path: relPath,
        type: 'file',
        ext: this.ext(leaf),
      });
    }

    const sortRecursive = (nodes: TreeNode[]): TreeNode[] => {
      for (const node of nodes) {
        if (node.children) {
          node.children = sortRecursive(node.children);
        }
      }
      return this.sortNodes(nodes);
    };
    return sortRecursive(root);
  }

  private async walk(storageId: string, relDir: string): Promise<TreeNode[]> {
    const entries = await this.storage.list(storageId, relDir);
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.type === 'dir') {
        nodes.push({
          name: entry.name,
          path: rel,
          type: 'dir',
          children: await this.walk(storageId, rel),
        });
      } else {
        nodes.push({
          name: entry.name,
          path: rel,
          type: 'file',
          ext: this.ext(entry.name),
        });
      }
    }
    return this.sortNodes(nodes);
  }

  private sortNodes(nodes: TreeNode[]): TreeNode[] {
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  /** Opaque version token derived from last-modified time and size. */
  private versionOf(stat: StorageStat): string {
    return `${Math.round(stat.mtimeMs)}-${stat.size}`;
  }

  async readTextFile(username: string, relPath: string): Promise<FileContent> {
    if (!this.isTextFile(relPath)) {
      throw new BadRequestException('This file is not editable as text.');
    }
    const storageId = await this.sid(username);
    const stat = await this.storage.statFile(storageId, relPath);
    // Contents are end-to-end encrypted: we return the opaque ciphertext as
    // base64 and the client decrypts it locally with the vault key.
    const blob = await this.storage.readBytes(storageId, relPath);
    return {
      path: relPath,
      name: basename(relPath),
      ext: this.ext(relPath),
      content: blob.toString('base64'),
      version: this.versionOf(stat),
    };
  }

  async writeTextFile(
    username: string,
    relPath: string,
    content: string,
    baseVersion?: string,
  ): Promise<FileContent> {
    if (!relPath || relPath.endsWith('/')) {
      throw new BadRequestException('A file name is required.');
    }
    const storageId = await this.sid(username);
    // If the caller loaded a specific version, ensure the file has not changed
    // underneath them since (concurrent edit detection). An empty/undefined
    // baseVersion means "force write" (new file or explicit overwrite).
    let existingSize = 0;
    if (await this.storage.isFile(storageId, relPath)) {
      const current = await this.storage.statFile(storageId, relPath);
      existingSize = current.size;
      if (baseVersion && this.versionOf(current) !== baseVersion) {
        throw new ConflictException(
          'This file was changed elsewhere since you opened it.',
        );
      }
    }
    // `content` is base64-encoded ciphertext produced by the client; store the
    // raw bytes verbatim (the server cannot read them).
    const data = Buffer.from(content, 'base64');
    await this.assertWithinQuota(username, data.length, existingSize);
    await this.storage.writeBytes(storageId, relPath, data);
    const stat = await this.storage.statFile(storageId, relPath);
    return {
      path: relPath,
      name: basename(relPath),
      ext: this.ext(relPath),
      content,
      version: this.versionOf(stat),
    };
  }

  async createFolder(username: string, relPath: string): Promise<void> {
    if (!relPath) {
      throw new BadRequestException('A folder name is required.');
    }
    await this.storage.makeDir(await this.sid(username), relPath);
  }

  async rename(username: string, from: string, to: string): Promise<void> {
    await this.storage.move(await this.sid(username), from, to);
  }

  async deleteEntry(username: string, relPath: string): Promise<void> {
    if (!relPath) {
      throw new BadRequestException('Path is required.');
    }
    const storageId = await this.sid(username);
    const clean = relPath.replace(/^\/+|\/+$/g, '');
    // Soft-delete: move the entry into the user's hidden trash so it can be
    // recovered until the purge cron permanently removes it. Items already in
    // the trash (or the trash folder itself) are removed for good, and when
    // retention is disabled deletions are immediate.
    const inTrash = clean === TRASH_DIR || clean.startsWith(`${TRASH_DIR}/`);
    if (this.trashRetentionDays <= 0 || inTrash) {
      await this.storage.remove(storageId, clean);
      return;
    }
    const isFile = await this.storage.isFile(storageId, clean);
    const stamp = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    await this.storage.move(storageId, clean, `${TRASH_DIR}/${stamp}/${clean}`);
    await this.writeTrashOrigin(
      storageId,
      stamp,
      clean,
      isFile ? 'file' : 'dir',
    );
  }

  /**
   * Like {@link deleteEntry} but processes the entry file-by-file and reports
   * progress, so the client can show a real progress bar instead of a spinner
   * for a large folder (whose move/remove on S3 can take minutes). Files are
   * still soft-deleted into a single trash batch (or removed for good when
   * retention is off / the path is already in the trash). `onProgress(done,
   * total)` is invoked before the first file and after each one.
   */
  async deleteEntryProgress(
    username: string,
    relPath: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<void> {
    if (!relPath) {
      throw new BadRequestException('Path is required.');
    }
    const storageId = await this.sid(username);
    const clean = relPath.replace(/^\/+|\/+$/g, '');
    const inTrash = clean === TRASH_DIR || clean.startsWith(`${TRASH_DIR}/`);
    const immediate = this.trashRetentionDays <= 0 || inTrash;

    const isFile = await this.storage.isFile(storageId, clean);
    const files = isFile
      ? [clean]
      : await this.collectFilesUnder(storageId, clean);
    const total = files.length;
    let done = 0;
    onProgress(done, total);

    const stamp = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    if (!immediate) {
      // Record what was deleted so the trash UI can restore it as one entry.
      await this.writeTrashOrigin(
        storageId,
        stamp,
        clean,
        isFile ? 'file' : 'dir',
      );
    }
    for (const file of files) {
      if (immediate) {
        await this.storage.remove(storageId, file);
      } else {
        await this.storage.move(
          storageId,
          file,
          `${TRASH_DIR}/${stamp}/${file}`,
        );
      }
      done += 1;
      onProgress(done, total);
    }

    // Moving/removing files individually can leave the now-empty source folder
    // (and any directory markers) behind, so clear it. Skip for a single file —
    // it was already handled above.
    if (!isFile) {
      await this.storage.remove(storageId, clean).catch(() => {});
      onProgress(total, total);
    }
  }

  /** Recursively collect every file path under a folder (forward-slash rel). */
  private async collectFilesUnder(
    storageId: string,
    relDir: string,
  ): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await this.storage.list(storageId, dir);
      for (const entry of entries) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.type === 'dir') {
          await walk(rel);
        } else {
          out.push(rel);
        }
      }
    };
    await walk(relDir);
    return out;
  }

  /**
   * Permanently remove trashed batches older than the retention window for a
   * single user. Each batch folder is named `<deletedAtMs>-<rand>`; the leading
   * timestamp decides expiry. Returns the number of batches purged.
   */
  async purgeExpiredTrash(username: string): Promise<number> {
    if (this.trashRetentionDays <= 0) {
      return 0;
    }
    const storageId = await this.sid(username);
    if (!(await this.storage.isDir(storageId, TRASH_DIR))) {
      return 0;
    }
    const cutoff = Date.now() - this.trashRetentionDays * DAY_MS;
    const batches = await this.storage.list(storageId, TRASH_DIR);
    let purged = 0;
    for (const entry of batches) {
      if (entry.type !== 'dir') {
        continue;
      }
      const dash = entry.name.indexOf('-');
      const ts = Number(dash > 0 ? entry.name.slice(0, dash) : entry.name);
      if (!Number.isFinite(ts) || ts > cutoff) {
        continue;
      }
      await this.storage.remove(storageId, `${TRASH_DIR}/${entry.name}`);
      purged++;
    }
    return purged;
  }

  /* ----------------------------- trash UI ------------------------------ */

  /** Validate a trash batch id (the `<ms>-<rand>` folder name). */
  private assertTrashId(id: string): void {
    if (!/^\d+-[0-9a-zA-Z]+$/.test(id)) {
      throw new BadRequestException('Invalid trash id.');
    }
  }

  /** Write the origin marker for a trash batch. */
  private async writeTrashOrigin(
    storageId: string,
    stamp: string,
    originalPath: string,
    type: 'file' | 'dir',
  ): Promise<void> {
    const data = Buffer.from(
      JSON.stringify({ path: originalPath, type }),
      'utf8',
    );
    await this.storage.writeBytes(
      storageId,
      `${TRASH_DIR}/${stamp}/${TRASH_ORIGIN}`,
      data,
    );
  }

  /** Read a batch's origin marker, or null if absent/corrupt (legacy batch). */
  private async readTrashOrigin(
    storageId: string,
    base: string,
  ): Promise<{ path: string; type: 'file' | 'dir' } | null> {
    const marker = `${base}/${TRASH_ORIGIN}`;
    if (!(await this.storage.isFile(storageId, marker))) {
      return null;
    }
    try {
      const raw = (await this.storage.readBytes(storageId, marker)).toString(
        'utf8',
      );
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.path === 'string') {
        return {
          path: parsed.path.replace(/^\/+|\/+$/g, ''),
          type: parsed.type === 'file' ? 'file' : 'dir',
        };
      }
    } catch {
      /* fall through to null */
    }
    return null;
  }

  /**
   * Best-effort recovery of a legacy trash batch's original path (no marker):
   * walk the single-child directory chain down from the batch root, which
   * reconstructs the deleted entry's path because each batch only holds that one
   * entry's tree.
   */
  private async deriveTrashEntry(
    storageId: string,
    base: string,
  ): Promise<{ path: string; type: 'file' | 'dir' } | null> {
    let rel = '';
    for (let i = 0; i < 4096; i++) {
      const dir = rel ? `${base}/${rel}` : base;
      const entries = (await this.storage.list(storageId, dir)).filter(
        (e) => e.name !== TRASH_ORIGIN,
      );
      if (entries.length === 1) {
        const child = entries[0];
        rel = rel ? `${rel}/${child.name}` : child.name;
        if (child.type === 'file') {
          return { path: rel, type: 'file' };
        }
        continue; // single sub-dir: keep descending
      }
      // Zero or many children: the current rel is the deleted entry (a folder).
      return rel ? { path: rel, type: 'dir' } : null;
    }
    return null;
  }

  /** List restorable entries in the trash, newest first. */
  async listTrash(username: string): Promise<TrashItem[]> {
    const storageId = await this.sid(username);
    if (!(await this.storage.isDir(storageId, TRASH_DIR))) {
      return [];
    }
    const batches = await this.storage.list(storageId, TRASH_DIR);
    const items: TrashItem[] = [];
    for (const entry of batches) {
      if (entry.type !== 'dir') {
        continue;
      }
      const id = entry.name;
      const base = `${TRASH_DIR}/${id}`;
      const dash = id.indexOf('-');
      const deletedAt = Number(dash > 0 ? id.slice(0, dash) : id) || 0;
      const origin =
        (await this.readTrashOrigin(storageId, base)) ||
        (await this.deriveTrashEntry(storageId, base));
      if (!origin || !origin.path) {
        continue;
      }
      items.push({
        id,
        path: origin.path,
        name: basename(origin.path),
        type: origin.type,
        deletedAt,
      });
    }
    items.sort((a, b) => b.deletedAt - a.deletedAt);
    return items;
  }

  /** Restore one trash batch to its original path (de-duplicating on conflict). */
  async restoreFromTrash(
    username: string,
    id: string,
  ): Promise<{ restoredTo: string }> {
    this.assertTrashId(id);
    const storageId = await this.sid(username);
    const base = `${TRASH_DIR}/${id}`;
    if (!(await this.storage.isDir(storageId, base))) {
      throw new NotFoundException('Trash entry not found.');
    }
    const origin =
      (await this.readTrashOrigin(storageId, base)) ||
      (await this.deriveTrashEntry(storageId, base));
    if (!origin || !origin.path) {
      throw new BadRequestException('Trash entry is empty.');
    }
    const target = await this.freeRestorePath(storageId, origin.path);
    await this.storage.move(storageId, `${base}/${origin.path}`, target);
    // Drop the now-empty batch (including the .origin marker).
    await this.storage.remove(storageId, base).catch(() => {});
    return { restoredTo: target };
  }

  /** Permanently delete the entire trash. */
  async emptyTrash(username: string): Promise<void> {
    const storageId = await this.sid(username);
    if (await this.storage.isDir(storageId, TRASH_DIR)) {
      await this.storage.remove(storageId, TRASH_DIR);
    }
  }

  /** Find a non-colliding restore path, appending " (restored[ N])" if needed. */
  private async freeRestorePath(
    storageId: string,
    path: string,
  ): Promise<string> {
    const exists = async (p: string) =>
      (await this.storage.isFile(storageId, p)) ||
      (await this.storage.isDir(storageId, p));
    if (!(await exists(path))) {
      return path;
    }
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : '';
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; i < 1000; i++) {
      const suffix = i > 1 ? ` (restored ${i})` : ' (restored)';
      const candidate = `${dir ? `${dir}/` : ''}${stem}${suffix}${ext}`;
      if (!(await exists(candidate))) {
        return candidate;
      }
    }
    throw new ConflictException('Could not find a free name to restore to.');
  }

  /**
   * Stream an uploaded file into the user's vault under `destFolder`, returning
   * its relative path. `size` (from multer) drives the quota check and content
   * length so the file is never buffered fully in memory.
   */
  async saveUploadStream(
    username: string,
    destFolder: string,
    originalName: string,
    data: Readable,
    size: number,
  ): Promise<string> {
    const safeName = basename(originalName);
    if (!safeName) {
      throw new BadRequestException('Invalid file name.');
    }
    const relPath = destFolder ? `${destFolder}/${safeName}` : safeName;
    return this.writeStreamAtPath(username, relPath, data, size);
  }

  /** Streaming variant of writeAtPath (used by import). */
  async writeStreamAtPath(
    username: string,
    relPath: string,
    data: Readable,
    size: number,
  ): Promise<string> {
    const storageId = await this.sid(username);
    let existingSize = 0;
    if (await this.storage.isFile(storageId, relPath)) {
      existingSize = (await this.storage.statFile(storageId, relPath)).size;
    }
    await this.assertWithinQuota(username, size, existingSize);
    await this.storage.writeStream(storageId, relPath, data, size);
    return relPath;
  }

  /** Resolve a file for streaming as an attachment (opaque ciphertext bytes). */
  async resolveAttachment(
    username: string,
    relPath: string,
  ): Promise<{ stream: ReadStream; size: number; ext: string; name: string }> {
    const { stream, size } = await this.storage.openReadStream(
      await this.sid(username),
      relPath,
    );
    return {
      stream: stream as ReadStream,
      size,
      ext: this.ext(relPath),
      name: basename(relPath),
    };
  }

  /** Collect every file in the vault as relative paths for export. */
  async listAllFiles(
    username: string,
  ): Promise<Array<{ relPath: string; version: string }>> {
    await this.ensureUserRoot(username);
    const storageId = await this.sid(username);
    // Fast path: enumerate the whole vault in one request when supported,
    // skipping hidden dotfiles / folder markers to mirror the recursive walk.
    const flat = await this.storage.walkFiles?.(storageId);
    if (flat) {
      return flat
        .filter((f) => !f.relPath.split('/').some((seg) => seg.startsWith('.')))
        .map((f) => ({
          relPath: f.relPath,
          version: this.versionOf({ size: f.size, mtimeMs: f.mtimeMs }),
        }));
    }
    const out: Array<{ relPath: string; version: string }> = [];
    const walk = async (relDir: string): Promise<void> => {
      const entries = await this.storage.list(storageId, relDir);
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.type === 'dir') {
          await walk(rel);
        } else {
          const stat = await this.storage.statFile(storageId, rel);
          out.push({ relPath: rel, version: this.versionOf(stat) });
        }
      }
    };
    await walk('');
    return out;
  }

  /** Read a file's raw (still-encrypted) bytes (used by export to build a zip). */
  async readBytes(username: string, relPath: string): Promise<Buffer> {
    return this.storage.readBytes(await this.sid(username), relPath);
  }

  async fileExists(username: string, relPath: string): Promise<boolean> {
    return this.storage.isFile(await this.sid(username), relPath);
  }

  /** Delete all of a user's vault data (used by account deletion). */
  async deleteUserData(username: string): Promise<void> {
    const storageId = await this.sid(username);
    await this.storage.removeUser(storageId);
    this.storageIds.delete(username.toLowerCase());
  }

  /**
   * Filename-only search performed server-side. File *contents* are end-to-end
   * encrypted and unreadable here, so content matching is handled entirely by
   * the client against its local encrypted search index. This endpoint covers
   * the cheap path-name case (and is a useful fallback if the client index is
   * still warming up).
   */
  async search(username: string, query: string): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [];
    }
    const files = await this.searchFileList(username);
    const hits: SearchHit[] = [];
    for (const { relPath } of files) {
      // Soft-deleted items live under .trash and are hidden from search.
      if (relPath.split('/')[0] === TRASH_DIR) {
        continue;
      }
      const name = basename(relPath);
      // Content is opaque ciphertext on the server; only names are searchable.
      if (name.toLowerCase().includes(q)) {
        hits.push({
          path: relPath,
          name,
          matchedName: true,
          matchedContent: false,
        });
        if (hits.length >= 100) {
          break;
        }
      }
    }
    return hits;
  }

  /**
   * Read every markdown note's (encrypted) content in a single request so the
   * client can build the wikilink graph without making one `GET /api/file`
   * call per note (which is slow and trips the rate limiter on large vaults).
   * Contents stay end-to-end encrypted — the client decrypts and parses them.
   */
  async readNotesContent(
    username: string,
  ): Promise<Array<{ path: string; content: string }>> {
    const storageId = await this.sid(username);
    const files = await this.searchFileList(username);
    const notes = files
      .map((f) => f.relPath)
      .filter(
        (p) => p.split('/')[0] !== TRASH_DIR && /\.(md|markdown)$/i.test(p),
      );
    const out: Array<{ path: string; content: string }> = [];
    let i = 0;
    const worker = async () => {
      while (i < notes.length) {
        const p = notes[i++];
        try {
          const blob = await this.storage.readBytes(storageId, p);
          out.push({ path: p, content: blob.toString('base64') });
        } catch {
          /* skip unreadable note */
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(16, notes.length || 1) }, worker),
    );
    return out;
  }

  /**
   * Flat list of every vault file, enumerated in a single storage pass (one S3
   * `ListObjectsV2` walk rather than one request per directory). Results are
   * cached per user for {@link searchCacheTtlMs} so a burst of searches reuses
   * the same listing.
   */
  private async searchFileList(
    username: string,
  ): Promise<Array<{ relPath: string }>> {
    const ttl = this.searchCacheTtlMs;
    const cacheKey = username.toLowerCase();
    if (ttl > 0) {
      const cached = this.searchCache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        return cached.files;
      }
    }
    await this.ensureUserRoot(username);
    const storageId = await this.sid(username);
    const flat = await this.storage.walkFiles?.(storageId);
    const files = flat
      ? flat.map((f) => ({ relPath: f.relPath }))
      : await this.searchWalk(storageId, '');
    if (ttl > 0) {
      this.searchCache.set(cacheKey, { expires: Date.now() + ttl, files });
    }
    return files;
  }

  /**
   * Recursive fallback enumeration for storage backends without a flat
   * {@link StorageProvider.walkFiles} (e.g. the local filesystem provider).
   */
  private async searchWalk(
    storageId: string,
    relDir: string,
  ): Promise<Array<{ relPath: string }>> {
    const out: Array<{ relPath: string }> = [];
    const entries = await this.storage.list(storageId, relDir);
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.type === 'dir') {
        out.push(...(await this.searchWalk(storageId, rel)));
      } else {
        out.push({ relPath: rel });
      }
    }
    return out;
  }
}
