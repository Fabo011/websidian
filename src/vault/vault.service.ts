import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { ReadStream } from 'fs';
import { basename, extname } from 'path';
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

/** Extensions scanned for content search. */
const SEARCHABLE_EXTENSIONS = new Set(['md', 'markdown', 'txt']);

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

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class VaultService {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly users: UsersService,
    private readonly entitlements: EntitlementsService,
    private readonly config: ConfigService,
  ) {}

  /** Days a deleted item stays in the trash before permanent removal. */
  private get trashRetentionDays(): number {
    return this.config.get<AppConfig>('app')?.trashRetentionDays ?? 0;
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

  /** Raw bytes consumed by a user's vault (no quota involved). */
  usedBytes(username: string): Promise<number> {
    return this.storage.usage(username);
  }

  /** Create the user's vault namespace if it does not yet exist. */
  async ensureUserRoot(username: string): Promise<void> {
    await this.storage.ensureUser(username);
  }

  isTextFile(relPathOrName: string): boolean {
    return TEXT_EXTENSIONS.has(this.ext(relPathOrName));
  }

  private ext(name: string): string {
    return extname(name).replace(/^\./, '').toLowerCase();
  }

  /** Current storage usage and the configured quota for a user. */
  async usage(username: string): Promise<QuotaUsage> {
    const used = await this.storage.usage(username);
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
    const used = await this.storage.usage(username);
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
    // Fast path: object-storage providers can enumerate the whole vault in a
    // single request, avoiding one network round-trip per directory.
    const flat = await this.storage.walkFiles?.(username);
    if (flat) {
      return this.buildTreeFromFlat(flat);
    }
    return this.walk(username, '');
  }

  /**
   * Build the sorted directory tree from a flat list of file paths. Dotfiles
   * (including '.keep' folder markers) are hidden but still materialise their
   * parent folders, matching the recursive {@link walk} behaviour.
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
      if (leaf.startsWith('.')) {
        continue; // hidden dotfile / folder marker — folder already created
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

  private async walk(username: string, relDir: string): Promise<TreeNode[]> {
    const entries = await this.storage.list(username, relDir);
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.type === 'dir') {
        nodes.push({
          name: entry.name,
          path: rel,
          type: 'dir',
          children: await this.walk(username, rel),
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
    const stat = await this.storage.statFile(username, relPath);
    const content = await this.storage.readText(username, relPath);
    return {
      path: relPath,
      name: basename(relPath),
      ext: this.ext(relPath),
      content,
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
    // If the caller loaded a specific version, ensure the file has not changed
    // underneath them since (concurrent edit detection). An empty/undefined
    // baseVersion means "force write" (new file or explicit overwrite).
    let existingSize = 0;
    if (await this.storage.isFile(username, relPath)) {
      const current = await this.storage.statFile(username, relPath);
      existingSize = current.size;
      if (baseVersion && this.versionOf(current) !== baseVersion) {
        throw new ConflictException(
          'This file was changed elsewhere since you opened it.',
        );
      }
    }
    const data = Buffer.from(content, 'utf8');
    await this.assertWithinQuota(username, data.length, existingSize);
    await this.storage.writeBytes(username, relPath, data);
    const stat = await this.storage.statFile(username, relPath);
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
    await this.storage.makeDir(username, relPath);
  }

  async rename(username: string, from: string, to: string): Promise<void> {
    await this.storage.move(username, from, to);
  }

  async deleteEntry(username: string, relPath: string): Promise<void> {
    if (!relPath) {
      throw new BadRequestException('Path is required.');
    }
    const clean = relPath.replace(/^\/+|\/+$/g, '');
    // Soft-delete: move the entry into the user's hidden trash so it can be
    // recovered until the purge cron permanently removes it. Items already in
    // the trash (or the trash folder itself) are removed for good, and when
    // retention is disabled deletions are immediate.
    const inTrash = clean === TRASH_DIR || clean.startsWith(`${TRASH_DIR}/`);
    if (this.trashRetentionDays <= 0 || inTrash) {
      await this.storage.remove(username, clean);
      return;
    }
    const stamp = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    await this.storage.move(username, clean, `${TRASH_DIR}/${stamp}/${clean}`);
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
    if (!(await this.storage.isDir(username, TRASH_DIR))) {
      return 0;
    }
    const cutoff = Date.now() - this.trashRetentionDays * DAY_MS;
    const batches = await this.storage.list(username, TRASH_DIR);
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
      await this.storage.remove(username, `${TRASH_DIR}/${entry.name}`);
      purged++;
    }
    return purged;
  }

  /** Persist an uploaded binary/file into the given folder, returning its relative path. */
  async saveUpload(
    username: string,
    destFolder: string,
    originalName: string,
    data: Buffer,
  ): Promise<string> {
    const safeName = basename(originalName);
    if (!safeName) {
      throw new BadRequestException('Invalid file name.');
    }
    const relPath = destFolder ? `${destFolder}/${safeName}` : safeName;
    let existingSize = 0;
    if (await this.storage.isFile(username, relPath)) {
      existingSize = (await this.storage.statFile(username, relPath)).size;
    }
    await this.assertWithinQuota(username, data.length, existingSize);
    await this.storage.writeBytes(username, relPath, data);
    return relPath;
  }

  /** Write a file at an arbitrary relative path (used by import), preserving folders. */
  async writeAtPath(
    username: string,
    relPath: string,
    data: Buffer,
  ): Promise<string> {
    let existingSize = 0;
    if (await this.storage.isFile(username, relPath)) {
      existingSize = (await this.storage.statFile(username, relPath)).size;
    }
    await this.assertWithinQuota(username, data.length, existingSize);
    await this.storage.writeBytes(username, relPath, data);
    return relPath;
  }

  /** Resolve a file for streaming as an attachment. */
  async resolveAttachment(
    username: string,
    relPath: string,
  ): Promise<{ stream: ReadStream; size: number; ext: string; name: string }> {
    const { stream, size } = await this.storage.openReadStream(
      username,
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
  async listAllFiles(username: string): Promise<Array<{ relPath: string }>> {
    await this.ensureUserRoot(username);
    // Fast path: enumerate the whole vault in one request when supported,
    // skipping hidden dotfiles / folder markers to mirror the recursive walk.
    const flat = await this.storage.walkFiles?.(username);
    if (flat) {
      return flat
        .filter((f) => !f.relPath.split('/').some((seg) => seg.startsWith('.')))
        .map((f) => ({ relPath: f.relPath }));
    }
    const out: Array<{ relPath: string }> = [];
    const walk = async (relDir: string): Promise<void> => {
      const entries = await this.storage.list(username, relDir);
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.type === 'dir') {
          await walk(rel);
        } else {
          out.push({ relPath: rel });
        }
      }
    };
    await walk('');
    return out;
  }

  /** Read a file's raw bytes (used by export to build a zip). */
  async readBytes(username: string, relPath: string): Promise<Buffer> {
    return this.storage.readBytes(username, relPath);
  }

  async fileExists(username: string, relPath: string): Promise<boolean> {
    return this.storage.isFile(username, relPath);
  }

  /** Delete all of a user's vault data (used by account deletion). */
  async deleteUserData(username: string): Promise<void> {
    await this.storage.removeUser(username);
  }


  async search(username: string, query: string): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [];
    }
    await this.ensureUserRoot(username);
    const hits: SearchHit[] = [];
    await this.searchWalk(username, '', q, hits);
    return hits.slice(0, 100);
  }

  private async searchWalk(
    username: string,
    relDir: string,
    q: string,
    hits: SearchHit[],
  ): Promise<void> {
    const entries = await this.storage.list(username, relDir);
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.type === 'dir') {
        await this.searchWalk(username, rel, q, hits);
        continue;
      }
      const matchedName = entry.name.toLowerCase().includes(q);
      let matchedContent = false;
      let snippet: string | undefined;
      if (SEARCHABLE_EXTENSIONS.has(this.ext(entry.name))) {
        try {
          const content = await this.storage.readText(username, rel);
          const idx = content.toLowerCase().indexOf(q);
          if (idx >= 0) {
            matchedContent = true;
            const start = Math.max(0, idx - 30);
            snippet = content
              .slice(start, idx + q.length + 30)
              .replace(/\s+/g, ' ')
              .trim();
          }
        } catch {
          // ignore unreadable files
        }
      }
      if (matchedName || matchedContent) {
        hits.push({
          path: rel,
          name: entry.name,
          matchedName,
          matchedContent,
          snippet,
        });
      }
    }
  }
}
