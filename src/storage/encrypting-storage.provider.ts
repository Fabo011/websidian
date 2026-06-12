import { Readable } from 'stream';
import { EncryptionService } from './encryption.service';
import {
    StorageEntry,
    StorageProvider,
    StorageReadStream,
    StorageStat,
} from './storage.interface';

/**
 * Wraps another {@link StorageProvider} and transparently encrypts file
 * payloads on the way to disk/object-storage and decrypts them on the way
 * back, using {@link EncryptionService} (AES-256-GCM).
 *
 * Only file *contents* are transformed; directory structure and names pass
 * through unchanged. Because reads decrypt automatically, callers such as the
 * vault export get plaintext for free — exports are therefore unencrypted,
 * platform-independent backups.
 */
export class EncryptingStorageProvider implements StorageProvider {
  constructor(
    private readonly base: StorageProvider,
    private readonly crypto: EncryptionService,
  ) {}

  ensureUser(username: string): Promise<void> {
    return this.base.ensureUser(username);
  }

  list(username: string, relPath: string): Promise<StorageEntry[]> {
    return this.base.list(username, relPath);
  }

  async readText(username: string, relPath: string): Promise<string> {
    const blob = await this.base.readBytes(username, relPath);
    return this.crypto.decrypt(username, blob).toString('utf8');
  }

  async readBytes(username: string, relPath: string): Promise<Buffer> {
    const blob = await this.base.readBytes(username, relPath);
    return this.crypto.decrypt(username, blob);
  }

  async openReadStream(
    username: string,
    relPath: string,
  ): Promise<StorageReadStream> {
    // GCM needs the whole payload to verify the auth tag, so decrypt fully and
    // stream from memory. Vault files (notes, attachments, PDFs) are modest in
    // size, so this is acceptable.
    const blob = await this.base.readBytes(username, relPath);
    const data = this.crypto.decrypt(username, blob);
    return { stream: Readable.from(data), size: data.length };
  }

  writeBytes(username: string, relPath: string, data: Buffer): Promise<void> {
    return this.base.writeBytes(
      username,
      relPath,
      this.crypto.encrypt(username, data),
    );
  }

  makeDir(username: string, relPath: string): Promise<void> {
    return this.base.makeDir(username, relPath);
  }

  move(username: string, from: string, to: string): Promise<void> {
    return this.base.move(username, from, to);
  }

  remove(username: string, relPath: string): Promise<void> {
    return this.base.remove(username, relPath);
  }

  statFile(username: string, relPath: string): Promise<StorageStat> {
    return this.base.statFile(username, relPath);
  }

  isFile(username: string, relPath: string): Promise<boolean> {
    return this.base.isFile(username, relPath);
  }

  isDir(username: string, relPath: string): Promise<boolean> {
    return this.base.isDir(username, relPath);
  }

  usage(username: string): Promise<number> {
    return this.base.usage(username);
  }

  removeUser(username: string): Promise<void> {
    return this.base.removeUser(username);
  }
}
