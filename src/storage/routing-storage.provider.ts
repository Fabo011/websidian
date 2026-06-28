import { Injectable } from '@nestjs/common';
import { Readable } from 'stream';
import { StorageResolver } from './storage-resolver.service';
import {
  StorageEntry,
  StorageFile,
  StorageProvider,
  StorageReadStream,
  StorageStat,
} from './storage.interface';

/**
 * The {@link StorageProvider} bound to the `STORAGE_PROVIDER` token. It owns no
 * storage itself: every call resolves the real provider for the given namespace
 * (the user's storageId) via {@link StorageResolver} and forwards to it. This
 * lets the rest of the app keep calling `storage.X(storageId, …)` unchanged
 * whether storage is the single global backend or per-user.
 */
@Injectable()
export class RoutingStorageProvider implements StorageProvider {
  constructor(private readonly resolver: StorageResolver) {}

  private provider(storageId: string): Promise<StorageProvider> {
    return this.resolver.getForStorageId(storageId);
  }

  async ensureUser(username: string): Promise<void> {
    return (await this.provider(username)).ensureUser(username);
  }

  async list(username: string, relPath: string): Promise<StorageEntry[]> {
    return (await this.provider(username)).list(username, relPath);
  }

  async readText(username: string, relPath: string): Promise<string> {
    return (await this.provider(username)).readText(username, relPath);
  }

  async readBytes(username: string, relPath: string): Promise<Buffer> {
    return (await this.provider(username)).readBytes(username, relPath);
  }

  async openReadStream(
    username: string,
    relPath: string,
  ): Promise<StorageReadStream> {
    return (await this.provider(username)).openReadStream(username, relPath);
  }

  async writeBytes(
    username: string,
    relPath: string,
    data: Buffer,
  ): Promise<void> {
    return (await this.provider(username)).writeBytes(username, relPath, data);
  }

  async writeStream(
    username: string,
    relPath: string,
    data: Readable,
    size: number,
  ): Promise<void> {
    return (await this.provider(username)).writeStream(
      username,
      relPath,
      data,
      size,
    );
  }

  async makeDir(username: string, relPath: string): Promise<void> {
    return (await this.provider(username)).makeDir(username, relPath);
  }

  async move(username: string, from: string, to: string): Promise<void> {
    return (await this.provider(username)).move(username, from, to);
  }

  async remove(username: string, relPath: string): Promise<void> {
    return (await this.provider(username)).remove(username, relPath);
  }

  async statFile(username: string, relPath: string): Promise<StorageStat> {
    return (await this.provider(username)).statFile(username, relPath);
  }

  async isFile(username: string, relPath: string): Promise<boolean> {
    return (await this.provider(username)).isFile(username, relPath);
  }

  async isDir(username: string, relPath: string): Promise<boolean> {
    return (await this.provider(username)).isDir(username, relPath);
  }

  async usage(username: string): Promise<number> {
    return (await this.provider(username)).usage(username);
  }

  async removeUser(username: string): Promise<void> {
    return (await this.provider(username)).removeUser(username);
  }

  /**
   * Forward to the delegate's fast path when it has one; otherwise return
   * undefined so callers fall back to recursive {@link list} (matching the
   * optional contract in {@link StorageProvider.walkFiles}).
   */
  async walkFiles(username: string): Promise<StorageFile[] | undefined> {
    const provider = await this.provider(username);
    return provider.walkFiles ? provider.walkFiles(username) : undefined;
  }
}
