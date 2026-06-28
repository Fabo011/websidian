import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AppConfig } from '../config/configuration';
import { UsersService } from '../users/users.service';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { buildUserProvider, UserStorageConfig } from './storage-config';
import { StorageProvider } from './storage.interface';
import { WebdavStorageProvider } from './webdav-storage.provider';

/**
 * Resolves the {@link StorageProvider} that owns a given storage namespace.
 *
 * - Default mode (USER_STORAGE_ENABLED off): every namespace maps to the single
 *   provider built once from the global env config — the original behaviour.
 * - Bring-your-own mode (USER_STORAGE_ENABLED on): each namespace maps to a
 *   provider built from that user's saved, decrypted credentials. Built
 *   providers are cached per storageId and rebuilt when the credentials change.
 */
@Injectable()
export class StorageResolver {
  private readonly logger = new Logger(StorageResolver.name);
  private readonly enabled: boolean;
  private readonly globalProvider: StorageProvider;
  private readonly cache = new Map<
    string,
    { hash: string; provider: StorageProvider }
  >();

  constructor(
    config: ConfigService,
    private readonly users: UsersService,
    private readonly local: LocalStorageProvider,
  ) {
    const app = config.get<AppConfig>('app');
    this.enabled = app.userStorageEnabled;
    this.globalProvider = this.buildGlobal(app);
  }

  /** Build the single shared provider from the global env configuration. */
  private buildGlobal(app: AppConfig): StorageProvider {
    switch (app.storage.driver) {
      case 's3':
        return new S3StorageProvider(app.storage.s3);
      case 'webdav':
        return new WebdavStorageProvider(app.storage.webdav);
      default:
        return this.local;
    }
  }

  /** Resolve the provider for a storage namespace (the user's storageId). */
  async getForStorageId(storageId: string): Promise<StorageProvider> {
    if (!this.enabled) {
      return this.globalProvider;
    }
    const user = await this.users.findByStorageId(storageId);
    if (!user || !user.storageConfig) {
      throw new ServiceUnavailableException(
        'No storage provider is connected for this account. Connect your ' +
          'storage in the dashboard to continue.',
      );
    }
    const hash = createHash('sha1').update(user.storageConfig).digest('hex');
    const cached = this.cache.get(storageId);
    if (cached && cached.hash === hash) {
      return cached.provider;
    }
    let cfg: UserStorageConfig;
    try {
      cfg = JSON.parse(user.storageConfig) as UserStorageConfig;
    } catch {
      this.logger.error(
        `Stored storage config for namespace ${storageId} is not valid JSON.`,
      );
      throw new ServiceUnavailableException(
        'Your stored storage configuration is corrupted. Reconnect your ' +
          'storage in the dashboard.',
      );
    }
    const provider = buildUserProvider(cfg);
    this.cache.set(storageId, { hash, provider });
    return provider;
  }

  /** Drop the cached provider for a namespace after its credentials change. */
  invalidate(storageId: string): void {
    this.cache.delete(storageId);
  }
}
