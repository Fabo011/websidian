import {
    CopyObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
    _Object,
} from '@aws-sdk/client-s3';
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { AppConfig, S3Config } from '../config/configuration';
import {
    StorageEntry,
    StorageFile,
    StorageProvider,
    StorageReadStream,
    StorageStat,
} from './storage.interface';

/** Zero-byte marker object that keeps an otherwise-empty "folder" listable. */
const KEEP_MARKER = '.keep';

/**
 * Hidden per-user folder holding soft-deleted items. Excluded from walkFiles so
 * trashed data never appears in the tree or exports. It still counts toward the
 * user's quota. Mirrors `TRASH_DIR` in the vault service.
 */
const TRASH_DIR = '.trash';

/** How long a computed usage total stays cached, in milliseconds. */
const USAGE_TTL_MS = 10_000;

/** Max keys deletable in a single DeleteObjects request (S3 hard limit). */
const DELETE_BATCH = 1000;

interface UsageCacheEntry {
  value: number;
  expires: number;
}

/**
 * S3-compatible object storage provider (MEGA S4, AWS S3, MinIO, …).
 *
 * Vault data is stored under the key layout `${prefix}/${username}/${relPath}`.
 * Object stores have no real directories, so folders are virtual: they are
 * derived from key prefixes, and empty folders are preserved with a zero-byte
 * `.keep` marker object.
 *
 * Performance notes:
 *  - A single {@link S3Client} is reused for the process (HTTP keep-alive).
 *  - {@link walkFiles} lets the vault build the whole tree / export listing in
 *    one paginated request instead of one request per directory.
 *  - {@link usage} is cached briefly so repeated saves do not each trigger a
 *    full prefix scan.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly cfg: S3Config;
  private _client?: S3Client;
  private readonly usageCache = new Map<string, UsageCacheEntry>();

  constructor(private readonly config: ConfigService) {
    this.cfg = this.config.get<AppConfig>('app').storage.s3;
  }

  /**
   * Lazily build the S3 client on first use. This keeps construction side-effect
   * free so the provider can be instantiated by Nest's DI container even when
   * the active driver is `local` and no S3 settings are configured.
   */
  private get client(): S3Client {
    if (!this._client) {
      if (!this.cfg.bucket) {
        throw new Error(
          'S3 storage selected but S3_BUCKET is not configured. Set the S3_* ' +
            'environment variables (see .env.example).',
        );
      }
      this._client = new S3Client({
        region: this.cfg.region,
        endpoint: this.cfg.endpoint || undefined,
        forcePathStyle: this.cfg.forcePathStyle,
        credentials:
          this.cfg.accessKeyId && this.cfg.secretAccessKey
            ? {
                accessKeyId: this.cfg.accessKeyId,
                secretAccessKey: this.cfg.secretAccessKey,
              }
            : undefined,
      });
    }
    return this._client;
  }

  // --- key helpers ---------------------------------------------------------

  /** Build (and validate) the object key for a user-relative path. */
  protected keyFor(username: string, relPath: string): string {
    const clean = this.sanitize(relPath);
    const parts = [this.cfg.prefix, username, clean].filter(Boolean);
    return parts.join('/');
  }

  /** Prefix (always ending in '/') under which a user's objects live. */
  private userPrefix(username: string): string {
    const parts = [this.cfg.prefix, username].filter(Boolean);
    return parts.join('/') + '/';
  }

  /** Normalise a relative path and reject traversal / absolute segments. */
  private sanitize(relPath = ''): string {
    const clean = String(relPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!clean) {
      return '';
    }
    const segments = clean.split('/');
    if (segments.some((s) => s === '..' || s === '.')) {
      throw new BadRequestException('Invalid path.');
    }
    return segments.join('/');
  }

  /** Strip the user prefix from a full object key to a vault-relative path. */
  private relFromKey(username: string, key: string): string {
    const prefix = this.userPrefix(username);
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  // --- lifecycle -----------------------------------------------------------

  async ensureUser(_username: string): Promise<void> {
    // Object stores have no directories to pre-create.
  }

  // --- reads ---------------------------------------------------------------

  async list(username: string, relPath: string): Promise<StorageEntry[]> {
    const rel = this.sanitize(relPath);
    const prefix = rel
      ? `${this.userPrefix(username)}${rel}/`
      : this.userPrefix(username);

    const dirs = new Set<string>();
    const files = new Set<string>();
    let token: string | undefined;

    do {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: prefix,
          Delimiter: '/',
          ContinuationToken: token,
        }),
      );
      for (const cp of out.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue;
        const name = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
        if (name && !name.startsWith('.')) {
          dirs.add(name);
        }
      }
      for (const obj of out.Contents ?? []) {
        if (!obj.Key) continue;
        const name = obj.Key.slice(prefix.length);
        // Skip the folder placeholder, nested keys, and hidden dotfiles.
        if (!name || name.includes('/') || name.startsWith('.')) {
          continue;
        }
        files.add(name);
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);

    const entries: StorageEntry[] = [];
    for (const name of dirs) {
      entries.push({ name, type: 'dir' });
    }
    for (const name of files) {
      entries.push({ name, type: 'file' });
    }
    return entries;
  }

  async readBytes(username: string, relPath: string): Promise<Buffer> {
    const key = this.keyFor(username, relPath);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      return await this.bodyToBuffer(out.Body as Readable);
    } catch (err) {
      throw this.mapNotFound(err);
    }
  }

  async readText(username: string, relPath: string): Promise<string> {
    return (await this.readBytes(username, relPath)).toString('utf8');
  }

  async openReadStream(
    username: string,
    relPath: string,
  ): Promise<StorageReadStream> {
    const key = this.keyFor(username, relPath);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      return {
        stream: out.Body as Readable,
        size: out.ContentLength ?? 0,
      };
    } catch (err) {
      throw this.mapNotFound(err);
    }
  }

  // --- writes --------------------------------------------------------------

  async writeBytes(
    username: string,
    relPath: string,
    data: Buffer,
  ): Promise<void> {
    const key = this.keyFor(username, relPath);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: data }),
    );
    this.invalidateUsage(username);
  }

  async makeDir(username: string, relPath: string): Promise<void> {
    const rel = this.sanitize(relPath);
    if (!rel) {
      return;
    }
    const key = `${this.userPrefix(username)}${rel}/${KEEP_MARKER}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: Buffer.alloc(0),
      }),
    );
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

    const base = this.userPrefix(username);
    const fileKey = `${base}${fromRel}`;
    const dirPrefix = `${base}${fromRel}/`;
    const sources = await this.listKeys(dirPrefix);
    if (await this.objectExists(fileKey)) {
      sources.push({ Key: fileKey } as _Object);
    }
    if (sources.length === 0) {
      throw new NotFoundException('File or folder not found.');
    }
    if (await this.objectExists(`${base}${toRel}`)) {
      throw new BadRequestException('Target already exists.');
    }

    await this.mapWithConcurrency(sources, 16, async (obj) => {
      if (!obj.Key) return;
      const suffix = obj.Key === fileKey ? '' : obj.Key.slice(dirPrefix.length);
      const destKey = suffix ? `${base}${toRel}/${suffix}` : `${base}${toRel}`;
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.cfg.bucket,
          CopySource: `${this.cfg.bucket}/${this.encodeKey(obj.Key)}`,
          Key: destKey,
        }),
      );
    });

    await this.deleteKeys(sources.map((o) => o.Key).filter(Boolean) as string[]);
    this.invalidateUsage(username);
  }

  async remove(username: string, relPath: string): Promise<void> {
    const rel = this.sanitize(relPath);
    if (!rel) {
      throw new BadRequestException('Path is required.');
    }
    const base = this.userPrefix(username);
    const fileKey = `${base}${rel}`;
    const keys = (await this.listKeys(`${base}${rel}/`)).map((o) => o.Key!);
    if (await this.objectExists(fileKey)) {
      keys.push(fileKey);
    }
    if (keys.length === 0) {
      throw new NotFoundException('File or folder not found.');
    }
    await this.deleteKeys(keys);
    this.invalidateUsage(username);
  }

  // --- metadata ------------------------------------------------------------

  async statFile(username: string, relPath: string): Promise<StorageStat> {
    const key = this.keyFor(username, relPath);
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      return {
        size: out.ContentLength ?? 0,
        mtimeMs: out.LastModified ? out.LastModified.getTime() : 0,
      };
    } catch (err) {
      throw this.mapNotFound(err);
    }
  }

  async isFile(username: string, relPath: string): Promise<boolean> {
    return this.objectExists(this.keyFor(username, relPath));
  }

  async isDir(username: string, relPath: string): Promise<boolean> {
    const rel = this.sanitize(relPath);
    const prefix = rel
      ? `${this.userPrefix(username)}${rel}/`
      : this.userPrefix(username);
    const out = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.cfg.bucket,
        Prefix: prefix,
        MaxKeys: 1,
      }),
    );
    return (out.KeyCount ?? 0) > 0;
  }

  async usage(username: string): Promise<number> {
    const cached = this.usageCache.get(username);
    if (cached && cached.expires > Date.now()) {
      return cached.value;
    }
    let total = 0;
    let token: string | undefined;
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: this.userPrefix(username),
          ContinuationToken: token,
        }),
      );
      for (const obj of out.Contents ?? []) {
        total += obj.Size ?? 0;
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    this.usageCache.set(username, {
      value: total,
      expires: Date.now() + USAGE_TTL_MS,
    });
    return total;
  }

  async removeUser(username: string): Promise<void> {
    const keys = (await this.listKeys(this.userPrefix(username))).map(
      (o) => o.Key!,
    );
    if (keys.length > 0) {
      await this.deleteKeys(keys);
    }
    this.usageCache.delete(username);
  }

  async walkFiles(username: string): Promise<StorageFile[]> {
    const objects = await this.listKeys(this.userPrefix(username));
    const files: StorageFile[] = [];
    for (const obj of objects) {
      if (!obj.Key) continue;
      const relPath = this.relFromKey(username, obj.Key);
      if (!relPath) continue;
      if (relPath === TRASH_DIR || relPath.startsWith(`${TRASH_DIR}/`)) {
        continue; // hide soft-deleted items from tree/export
      }
      files.push({
        relPath,
        size: obj.Size ?? 0,
        mtimeMs: obj.LastModified ? obj.LastModified.getTime() : 0,
      });
    }
    return files;
  }

  // --- internals -----------------------------------------------------------

  /** List every object under a prefix, following pagination. */
  private async listKeys(prefix: string): Promise<_Object[]> {
    const out: _Object[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      if (res.Contents) {
        out.push(...res.Contents);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** Delete keys in batches of {@link DELETE_BATCH}. */
  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.cfg.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  private async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private invalidateUsage(username: string): void {
    this.usageCache.delete(username);
  }

  private encodeKey(key: string): string {
    return key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  }

  private async bodyToBuffer(body: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private mapNotFound(err: unknown): Error {
    const name = (err as { name?: string })?.name;
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) {
      return new NotFoundException('File or folder not found.');
    }
    this.logger.error(`S3 operation failed: ${String(err)}`);
    return err as Error;
  }

  /** Run an async mapper over items with bounded concurrency. */
  private async mapWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (cursor < items.length) {
          const index = cursor++;
          await fn(items[index]);
        }
      },
    );
    await Promise.all(workers);
  }
}
