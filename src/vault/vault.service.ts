import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream, promises as fs, ReadStream, Stats } from 'fs';
import { basename, dirname, extname, join, sep } from 'path';
import { safeResolve, toRelative } from '../common/path-safety';
import { AppConfig } from '../config/configuration';
import { FileContent, SearchHit, TreeNode } from './vault.types';

/** Extensions treated as editable text (returned/saved as UTF-8 strings). */
const TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'excalidraw',
  'json',
  'csv',
  'yml',
  'yaml',
]);

/** Extensions scanned for content search. */
const SEARCHABLE_EXTENSIONS = new Set(['md', 'markdown', 'txt']);

@Injectable()
export class VaultService {
  constructor(private readonly config: ConfigService) {}

  private get dataRoot(): string {
    return this.config.get<AppConfig>('app').dataRoot;
  }

  /** Absolute path to a user's vault root. */
  userRoot(username: string): string {
    // username is already validated to be safe characters at registration.
    return join(this.dataRoot, username);
  }

  /** Create the user's vault directory if it does not yet exist. */
  async ensureUserRoot(username: string): Promise<void> {
    await fs.mkdir(this.userRoot(username), { recursive: true });
  }

  private resolve(username: string, relPath = ''): string {
    return safeResolve(this.userRoot(username), relPath);
  }

  isTextFile(relPathOrName: string): boolean {
    return TEXT_EXTENSIONS.has(this.ext(relPathOrName));
  }

  private ext(name: string): string {
    return extname(name).replace(/^\./, '').toLowerCase();
  }

  async listTree(username: string): Promise<TreeNode[]> {
    await this.ensureUserRoot(username);
    const root = this.userRoot(username);
    return this.walk(root, root);
  }

  private async walk(root: string, dir: string): Promise<TreeNode[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue; // hide dotfiles (e.g. .obsidian)
      }
      const abs = join(dir, entry.name);
      const rel = toRelative(root, abs);
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: rel,
          type: 'dir',
          children: await this.walk(root, abs),
        });
      } else if (entry.isFile()) {
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

  private async statSafe(abs: string): Promise<Stats> {
    try {
      return await fs.stat(abs);
    } catch {
      throw new NotFoundException('File or folder not found.');
    }
  }

  /** Opaque version token derived from last-modified time and size. */
  private versionOf(stat: Stats): string {
    return `${Math.round(stat.mtimeMs)}-${stat.size}`;
  }

  async readTextFile(username: string, relPath: string): Promise<FileContent> {
    const abs = this.resolve(username, relPath);
    const stat = await this.statSafe(abs);
    if (!stat.isFile()) {
      throw new BadRequestException('Not a file.');
    }
    if (!this.isTextFile(relPath)) {
      throw new BadRequestException('This file is not editable as text.');
    }
    const content = await fs.readFile(abs, 'utf8');
    return {
      path: toRelative(this.userRoot(username), abs),
      name: basename(abs),
      ext: this.ext(abs),
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
    const abs = this.resolve(username, relPath);
    // If the caller loaded a specific version, ensure the file has not changed
    // underneath them since (concurrent edit detection). An empty/undefined
    // baseVersion means "force write" (new file or explicit overwrite).
    if (baseVersion) {
      let current: Stats | null = null;
      try {
        current = await fs.stat(abs);
      } catch {
        current = null;
      }
      if (current && current.isFile() && this.versionOf(current) !== baseVersion) {
        throw new ConflictException(
          'This file was changed elsewhere since you opened it.',
        );
      }
    }
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    const stat = await fs.stat(abs);
    return {
      path: toRelative(this.userRoot(username), abs),
      name: basename(abs),
      ext: this.ext(abs),
      content,
      version: this.versionOf(stat),
    };
  }

  async createFolder(username: string, relPath: string): Promise<void> {
    if (!relPath) {
      throw new BadRequestException('A folder name is required.');
    }
    const abs = this.resolve(username, relPath);
    await fs.mkdir(abs, { recursive: true });
  }

  async rename(username: string, from: string, to: string): Promise<void> {
    const fromAbs = this.resolve(username, from);
    const toAbs = this.resolve(username, to);
    if (fromAbs === toAbs) {
      return;
    }
    // Disallow moving a directory into itself or one of its descendants.
    if (toAbs.startsWith(fromAbs + sep)) {
      throw new BadRequestException('Cannot move a folder into itself.');
    }
    await this.statSafe(fromAbs);
    await fs.mkdir(dirname(toAbs), { recursive: true });
    try {
      await fs.access(toAbs);
      throw new BadRequestException('Target already exists.');
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      // target does not exist -> proceed
    }
    await fs.rename(fromAbs, toAbs);
  }

  async deleteEntry(username: string, relPath: string): Promise<void> {
    if (!relPath) {
      throw new BadRequestException('Path is required.');
    }
    const abs = this.resolve(username, relPath);
    const stat = await this.statSafe(abs);
    if (stat.isDirectory()) {
      await fs.rm(abs, { recursive: true, force: true });
    } else {
      await fs.unlink(abs);
    }
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
    const abs = this.resolve(username, relPath);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
    return toRelative(this.userRoot(username), abs);
  }

  /** Write a file at an arbitrary relative path (used by import), preserving folders. */
  async writeAtPath(
    username: string,
    relPath: string,
    data: Buffer,
  ): Promise<string> {
    const abs = this.resolve(username, relPath);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
    return toRelative(this.userRoot(username), abs);
  }

  /** Resolve a file for streaming as an attachment. */
  async resolveAttachment(
    username: string,
    relPath: string,
  ): Promise<{ stream: ReadStream; size: number; ext: string; name: string }> {
    const abs = this.resolve(username, relPath);
    const stat = await this.statSafe(abs);
    if (!stat.isFile()) {
      throw new BadRequestException('Not a file.');
    }
    return {
      stream: createReadStream(abs),
      size: stat.size,
      ext: this.ext(abs),
      name: basename(abs),
    };
  }

  /** Collect every file in the vault as { relPath, abs } for export. */
  async listAllFiles(
    username: string,
  ): Promise<Array<{ relPath: string; abs: string }>> {
    await this.ensureUserRoot(username);
    const root = this.userRoot(username);
    const out: Array<{ relPath: string; abs: string }> = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile()) {
          out.push({ relPath: toRelative(root, abs), abs });
        }
      }
    };
    await walk(root);
    return out;
  }

  async fileExists(username: string, relPath: string): Promise<boolean> {
    try {
      const abs = this.resolve(username, relPath);
      const stat = await fs.stat(abs);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async search(username: string, query: string): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [];
    }
    await this.ensureUserRoot(username);
    const root = this.userRoot(username);
    const hits: SearchHit[] = [];
    await this.searchWalk(root, root, q, hits);
    return hits.slice(0, 100);
  }

  private async searchWalk(
    root: string,
    dir: string,
    q: string,
    hits: SearchHit[],
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.searchWalk(root, abs, q, hits);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const matchedName = entry.name.toLowerCase().includes(q);
      let matchedContent = false;
      let snippet: string | undefined;
      if (SEARCHABLE_EXTENSIONS.has(this.ext(entry.name))) {
        try {
          const content = await fs.readFile(abs, 'utf8');
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
          path: toRelative(root, abs),
          name: entry.name,
          matchedName,
          matchedContent,
          snippet,
        });
      }
    }
  }
}
