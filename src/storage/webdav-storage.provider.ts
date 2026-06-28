import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import type {
  AuthType as WebdavAuthTypeEnum,
  FileStat,
  WebDAVClient,
} from 'webdav';
import { AppConfig, WebdavConfig } from '../config/configuration';
import {
  StorageEntry,
  StorageFile,
  StorageProvider,
  StorageReadStream,
  StorageStat,
} from './storage.interface';

/** Zero-byte folder placeholder; hidden from listings like the other backends. */
const KEEP_MARKER = '.keep';

/**
 * Hidden per-user folder holding soft-deleted items. Excluded from walkFiles so
 * trashed data never appears in the tree or exports. It still counts toward the
 * user's quota. Mirrors `TRASH_DIR` in the vault service.
 */
const TRASH_DIR = '.trash';

/** How long a computed usage total stays cached, in milliseconds. */
const USAGE_TTL_MS = 10_000;

interface UsageCacheEntry {
  value: number;
  expires: number;
}

/**
 * The `webdav` package is ESM-only (v5+) while this project compiles to
 * CommonJS. A plain `import()` would be downleveled by TypeScript to `require()`
 * and fail on the ESM module, so we load it through a `Function`-wrapped dynamic
 * import that the compiler leaves untouched.
 */
const importEsm = new Function(
  'specifier',
  'return import(specifier)',
) as <T = unknown>(specifier: string) => Promise<T>;

/**
 * WebDAV storage provider (Nextcloud, ownCloud, generic WebDAV servers).
 *
 * Unlike the object-store backend, WebDAV exposes real directories, so the
 * layout mirrors the local filesystem provider: vault data lives under
 * `${basePath}/${username}/${relPath}` on the remote server.
 *
 * The {@link WebDAVClient} is created lazily on first use (and memoized) so the
 * provider can be instantiated by Nest's DI container even when a different
 * driver is active and no WebDAV settings are configured.
 */
@Injectable()
export class WebdavStorageProvider implements StorageProvider {
  private readonly logger = new Logger(WebdavStorageProvider.name);
  private readonly webdavConfig?: WebdavConfig;
  private clientPromise?: Promise<WebDAVClient>;
  private readonly usageCache = new Map<string, UsageCacheEntry>();

  constructor(private readonly config: ConfigService) {
    const storage = this.config.get<AppConfig>('app').storage;
    // Narrow the discriminated union: `webdav` only exists on the 'webdav' variant.
    this.webdavConfig =
      storage.driver === 'webdav' ? storage.webdav : undefined;
  }

  /**
   * The active WebDAV settings. Throws if the provider was instantiated while a
   * non-WebDAV driver is selected — every real operation goes through
   * {@link client} first, so this is only hit on genuine misconfiguration.
   */
  private get cfg(): WebdavConfig {
    if (!this.webdavConfig) {
      throw new Error(
        'WebDAV storage selected but no WebDAV configuration is present. Set ' +
          'STORAGE_DRIVER=webdav and the WEBDAV_* environment variables ' +
          '(see .env.example).',
      );
    }
    return this.webdavConfig;
  }

  /** Lazily build (and memoize) the WebDAV client on first use. */
  private client(): Promise<WebDAVClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.createClient();
    }
    return this.clientPromise;
  }

  private async createClient(): Promise<WebDAVClient> {
    if (!this.cfg.url) {
      throw new Error(
        'WebDAV storage selected but WEBDAV_URL is not configured. Set the ' +
          'WEBDAV_* environment variables (see .env.example).',
      );
    }
    const { createClient, AuthType } =
      await importEsm<typeof import('webdav')>('webdav');
    const authType = this.mapAuthType(AuthType);
    const useAuth = this.cfg.authType !== 'none';
    return createClient(this.cfg.url, {
      authType,
      username: useAuth ? this.cfg.username || undefined : undefined,
      password: useAuth ? this.cfg.password || undefined : undefined,
    });
  }

  private mapAuthType(
    AuthType: typeof WebdavAuthTypeEnum,
  ): WebdavAuthTypeEnum {
    switch (this.cfg.authType) {
      case 'password':
        return AuthType.Password;
      case 'digest':
        return AuthType.Digest;
      case 'none':
        return AuthType.None;
      default:
        return AuthType.Auto;
    }
  }

  // --- path helpers --------------------------------------------------------

  /** Normalise a relative path and reject traversal / absolute segments. */
  private sanitize(relPath = ''): string {
    const clean = String(relPath)
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (!clean) {
      return '';
    }
    const segments = clean.split('/');
    if (segments.some((s) => s === '..' || s === '.')) {
      throw new BadRequestException('Invalid path.');
    }
    return segments.join('/');
  }

  /** Absolute remote path (from the server root) for a user-relative path. */
  private remotePath(username: string, relPath = ''): string {
    const clean = this.sanitize(relPath);
    const parts = [this.cfg.basePath, username, clean].filter(Boolean);
    return '/' + parts.join('/');
  }

  /** Absolute remote path of the user's vault root (always present). */
  private userRoot(username: string): string {
    const parts = [this.cfg.basePath, username].filter(Boolean);
    return '/' + parts.join('/');
  }

  /** Vault-relative path of a FileStat entry, stripped of the user root. */
  private relFromStat(username: string, stat: FileStat): string {
    const root = this.userRoot(username);
    const prefix = root.endsWith('/') ? root : root + '/';
    const full = stat.filename;
    return full.startsWith(prefix) ? full.slice(prefix.length) : stat.basename;
  }

  /** Create the parent directory of a relative path if it is nested. */
  private async ensureParent(
    client: WebDAVClient,
    username: string,
    relPath: string,
  ): Promise<void> {
    const clean = this.sanitize(relPath);
    const idx = clean.lastIndexOf('/');
    if (idx < 0) {
      // File sits directly in the user root; make sure that exists.
      await this.makeDirSafe(client, this.userRoot(username));
      return;
    }
    const parent = clean.slice(0, idx);
    await this.makeDirSafe(client, this.remotePath(username, parent));
  }

  /** Create a directory (recursively), ignoring "already exists" responses. */
  private async makeDirSafe(client: WebDAVClient, path: string): Promise<void> {
    try {
      await client.createDirectory(path, { recursive: true });
    } catch (err) {
      // 405 Method Not Allowed / 409 already-exists are fine; rethrow others.
      const status = this.statusOf(err);
      if (status !== 405 && status !== 409) {
        throw err;
      }
    }
  }

  // --- lifecycle -----------------------------------------------------------

  async ensureUser(username: string): Promise<void> {
    const client = await this.client();
    await this.makeDirSafe(client, this.userRoot(username));
  }

  // --- reads ---------------------------------------------------------------

  async list(username: string, relPath: string): Promise<StorageEntry[]> {
    const client = await this.client();
    const dir = this.remotePath(username, relPath);
    let items: FileStat[];
    try {
      items = await client.getDirectoryContents(dir);
    } catch (err) {
      if (this.statusOf(err) === 404) {
        return [];
      }
      throw this.mapError(err);
    }
    const out: StorageEntry[] = [];
    for (const item of items) {
      const name = item.basename;
      if (!name || name === KEEP_MARKER || name === TRASH_DIR) {
        continue;
      }
      out.push({
        name,
        type: item.type === 'directory' ? 'dir' : 'file',
      });
    }
    return out;
  }

  async readBytes(username: string, relPath: string): Promise<Buffer> {
    const client = await this.client();
    try {
      const data = await client.getFileContents(
        this.remotePath(username, relPath),
        { format: 'binary' },
      );
      return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async readText(username: string, relPath: string): Promise<string> {
    return (await this.readBytes(username, relPath)).toString('utf8');
  }

  async openReadStream(
    username: string,
    relPath: string,
  ): Promise<StorageReadStream> {
    const client = await this.client();
    const path = this.remotePath(username, relPath);
    const stat = await this.statFile(username, relPath);
    const stream = client.createReadStream(path);
    return { stream, size: stat.size };
  }

  // --- writes --------------------------------------------------------------

  async writeBytes(
    username: string,
    relPath: string,
    data: Buffer,
  ): Promise<void> {
    const client = await this.client();
    await this.ensureParent(client, username, relPath);
    await client.putFileContents(this.remotePath(username, relPath), data, {
      overwrite: true,
    });
    this.invalidateUsage(username);
  }

  async writeStream(
    username: string,
    relPath: string,
    data: Readable,
    size: number,
  ): Promise<void> {
    const client = await this.client();
    await this.ensureParent(client, username, relPath);
    await client.putFileContents(this.remotePath(username, relPath), data, {
      overwrite: true,
      contentLength: size,
    });
    this.invalidateUsage(username);
  }

  async makeDir(username: string, relPath: string): Promise<void> {
    const rel = this.sanitize(relPath);
    if (!rel) {
      return;
    }
    const client = await this.client();
    await this.makeDirSafe(client, this.remotePath(username, rel));
  }

  async move(username: string, from: string, to: string): Promise<void> {
    const fromRel = this.sanitize(from);
    const toRel = this.sanitize(to);
    if (!fromRel || !toRel) {
      throw new BadRequestException('A path is required.');
    }
    if (fromRel === toRel) {
      return;
    }
    if (toRel.startsWith(`${fromRel}/`)) {
      throw new BadRequestException('Cannot move a folder into itself.');
    }
    const client = await this.client();
    const fromPath = this.remotePath(username, fromRel);
    const toPath = this.remotePath(username, toRel);

    if (!(await client.exists(fromPath))) {
      throw new NotFoundException('File or folder not found.');
    }
    if (await client.exists(toPath)) {
      throw new BadRequestException('Target already exists.');
    }
    await this.ensureParent(client, username, toRel);
    try {
      await client.moveFile(fromPath, toPath, { overwrite: false });
    } catch (err) {
      throw this.mapError(err);
    }
    this.invalidateUsage(username);
  }

  async remove(username: string, relPath: string): Promise<void> {
    const rel = this.sanitize(relPath);
    if (!rel) {
      throw new BadRequestException('Path is required.');
    }
    const client = await this.client();
    const path = this.remotePath(username, rel);
    if (!(await client.exists(path))) {
      throw new NotFoundException('File or folder not found.');
    }
    // DELETE removes both files and collections on a WebDAV server.
    await client.deleteFile(path);
    this.invalidateUsage(username);
  }

  // --- metadata ------------------------------------------------------------

  async statFile(username: string, relPath: string): Promise<StorageStat> {
    const client = await this.client();
    let stat: FileStat;
    try {
      stat = (await client.stat(this.remotePath(username, relPath))) as FileStat;
    } catch (err) {
      throw this.mapError(err);
    }
    if (stat.type !== 'file') {
      throw new BadRequestException('Not a file.');
    }
    return {
      size: stat.size ?? 0,
      mtimeMs: stat.lastmod ? Date.parse(stat.lastmod) || 0 : 0,
    };
  }

  async isFile(username: string, relPath: string): Promise<boolean> {
    const client = await this.client();
    try {
      const stat = (await client.stat(
        this.remotePath(username, relPath),
      )) as FileStat;
      return stat.type === 'file';
    } catch {
      return false;
    }
  }

  async isDir(username: string, relPath: string): Promise<boolean> {
    const client = await this.client();
    try {
      const stat = (await client.stat(
        this.remotePath(username, relPath),
      )) as FileStat;
      return stat.type === 'directory';
    } catch {
      return false;
    }
  }

  async usage(username: string): Promise<number> {
    const cached = this.usageCache.get(username);
    if (cached && cached.expires > Date.now()) {
      return cached.value;
    }
    const client = await this.client();
    let total = 0;
    try {
      const items = (await client.getDirectoryContents(this.userRoot(username), {
        deep: true,
      })) as FileStat[];
      for (const item of items) {
        if (item.type === 'file') {
          total += item.size ?? 0;
        }
      }
    } catch (err) {
      if (this.statusOf(err) !== 404) {
        throw this.mapError(err);
      }
      // user root does not exist yet -> zero usage
    }
    this.usageCache.set(username, {
      value: total,
      expires: Date.now() + USAGE_TTL_MS,
    });
    return total;
  }

  async removeUser(username: string): Promise<void> {
    const client = await this.client();
    const root = this.userRoot(username);
    try {
      if (await client.exists(root)) {
        await client.deleteFile(root);
      }
    } catch (err) {
      if (this.statusOf(err) !== 404) {
        throw this.mapError(err);
      }
    }
    this.usageCache.delete(username);
  }

  async walkFiles(username: string): Promise<StorageFile[]> {
    const client = await this.client();
    let items: FileStat[];
    try {
      items = (await client.getDirectoryContents(this.userRoot(username), {
        deep: true,
      })) as FileStat[];
    } catch (err) {
      if (this.statusOf(err) === 404) {
        return [];
      }
      throw this.mapError(err);
    }
    const files: StorageFile[] = [];
    for (const item of items) {
      if (item.type !== 'file') {
        continue;
      }
      const relPath = this.relFromStat(username, item);
      if (!relPath || item.basename === KEEP_MARKER) {
        continue;
      }
      if (relPath === TRASH_DIR || relPath.startsWith(`${TRASH_DIR}/`)) {
        continue; // hide soft-deleted items from tree/export
      }
      files.push({
        relPath,
        size: item.size ?? 0,
        mtimeMs: item.lastmod ? Date.parse(item.lastmod) || 0 : 0,
      });
    }
    return files;
  }

  // --- internals -----------------------------------------------------------

  private invalidateUsage(username: string): void {
    this.usageCache.delete(username);
  }

  /** Extract the HTTP status code from a WebDAV client error, if any. */
  private statusOf(err: unknown): number | undefined {
    return (err as { status?: number })?.status;
  }

  private mapError(err: unknown): Error {
    if (this.statusOf(err) === 404) {
      return new NotFoundException('File or folder not found.');
    }
    this.logger.error(`WebDAV operation failed: ${String(err)}`);
    return err as Error;
  }
}
