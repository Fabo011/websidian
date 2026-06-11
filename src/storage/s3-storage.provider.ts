import { Injectable, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, S3Config } from '../config/configuration';
import {
    StorageEntry,
    StorageProvider,
    StorageReadStream,
    StorageStat,
} from './storage.interface';

/**
 * S3-compatible object storage provider (AWS S3, MinIO, Mega S3, Azure Blob via
 * S3 gateway, etc.).
 *
 * NOTE: This is a stub. The storage abstraction and configuration are in place
 * so that switching `STORAGE_DRIVER=s3` becomes a drop-in change once the AWS
 * SDK (`@aws-sdk/client-s3`) is added and the methods below are implemented.
 * Until then, selecting the S3 driver fails fast with a clear message rather
 * than silently losing data.
 *
 * Implementation outline (for whoever completes this):
 *   - Object key = `${prefix}/${username}/${relPath}` (prefix optional).
 *   - "Directories" are virtual: derive them from key prefixes. Optionally
 *     write zero-byte `.keep` markers so empty folders survive.
 *   - `list`  -> ListObjectsV2 with Delimiter '/' (CommonPrefixes = subdirs).
 *   - read*   -> GetObject (stream the Body for openReadStream).
 *   - write   -> PutObject.
 *   - move    -> CopyObject + DeleteObject for each affected key (recurse).
 *   - remove  -> DeleteObjects for the key or all keys under the prefix.
 *   - statFile-> HeadObject (ContentLength + LastModified).
 *   - usage   -> sum ContentLength over ListObjectsV2 pages for the user.
 *   - removeUser -> delete every object under `${prefix}/${username}/`.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly s3: S3Config;

  constructor(private readonly config: ConfigService) {
    this.s3 = this.config.get<AppConfig>('app').storage.s3;
  }

  private notImplemented(): never {
    throw new NotImplementedException(
      'The S3 storage driver is not implemented yet. Use STORAGE_DRIVER=local.',
    );
  }

  // The S3 key prefix a finished implementation would build paths from.
  protected keyFor(username: string, relPath: string): string {
    const clean = relPath.replace(/^\/+/, '');
    const parts = [this.s3.prefix, username, clean].filter(Boolean);
    return parts.join('/');
  }

  async ensureUser(_username: string): Promise<void> {
    // Object stores have no directories to create; no-op once implemented.
    this.notImplemented();
  }

  async list(_username: string, _relPath: string): Promise<StorageEntry[]> {
    this.notImplemented();
  }

  async readText(_username: string, _relPath: string): Promise<string> {
    this.notImplemented();
  }

  async readBytes(_username: string, _relPath: string): Promise<Buffer> {
    this.notImplemented();
  }

  async openReadStream(
    _username: string,
    _relPath: string,
  ): Promise<StorageReadStream> {
    this.notImplemented();
  }

  async writeBytes(
    _username: string,
    _relPath: string,
    _data: Buffer,
  ): Promise<void> {
    this.notImplemented();
  }

  async makeDir(_username: string, _relPath: string): Promise<void> {
    this.notImplemented();
  }

  async move(_username: string, _from: string, _to: string): Promise<void> {
    this.notImplemented();
  }

  async remove(_username: string, _relPath: string): Promise<void> {
    this.notImplemented();
  }

  async statFile(_username: string, _relPath: string): Promise<StorageStat> {
    this.notImplemented();
  }

  async isFile(_username: string, _relPath: string): Promise<boolean> {
    this.notImplemented();
  }

  async isDir(_username: string, _relPath: string): Promise<boolean> {
    this.notImplemented();
  }

  async usage(_username: string): Promise<number> {
    this.notImplemented();
  }

  async removeUser(_username: string): Promise<void> {
    this.notImplemented();
  }
}
