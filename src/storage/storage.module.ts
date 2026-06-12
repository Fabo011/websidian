import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { EncryptingStorageProvider } from './encrypting-storage.provider';
import { EncryptionService } from './encryption.service';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { STORAGE_PROVIDER, StorageProvider } from './storage.interface';

/**
 * Provides the active {@link StorageProvider} (local filesystem by default,
 * or S3-compatible object storage when `STORAGE_DRIVER=s3`). When encryption
 * at rest is enabled (the default), the chosen provider is wrapped so all
 * file contents are encrypted with AES-256-GCM before being stored.
 */
@Global()
@Module({
  providers: [
    LocalStorageProvider,
    S3StorageProvider,
    EncryptionService,
    {
      provide: STORAGE_PROVIDER,
      inject: [
        ConfigService,
        LocalStorageProvider,
        S3StorageProvider,
        EncryptionService,
      ],
      useFactory: (
        config: ConfigService,
        local: LocalStorageProvider,
        s3: S3StorageProvider,
        crypto: EncryptionService,
      ): StorageProvider => {
        const app = config.get<AppConfig>('app');
        const logger = new Logger('StorageModule');
        let base: StorageProvider = local;
        if (app.storage.driver === 's3') {
          logger.warn(
            'S3 storage driver selected but it is not yet implemented. ' +
              'Set STORAGE_DRIVER=local to use the built-in local storage.',
          );
          base = s3;
        }
        if (crypto.isEnabled) {
          logger.log('Vault encryption at rest is enabled (AES-256-GCM).');
          return new EncryptingStorageProvider(base, crypto);
        }
        return base;
      },
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
