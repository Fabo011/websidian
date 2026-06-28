import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { EncryptionService } from './encryption.service';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { WebdavStorageProvider } from './webdav-storage.provider'
import { STORAGE_PROVIDER, StorageProvider } from './storage.interface';

/**
 * Provides the active {@link StorageProvider} (local filesystem by default,
 * or S3-compatible object storage when `STORAGE_DRIVER=s3`).
 *
 * File *contents* are end-to-end encrypted on the client (zero-knowledge), so
 * the server stores opaque ciphertext blobs and performs no file encryption of
 * its own. {@link EncryptionService} is still provided here because it encrypts
 * sensitive *database columns* (TOTP secrets, Stripe ids) at rest.
 */
@Global()
@Module({
  providers: [
    LocalStorageProvider,
    S3StorageProvider,
    WebdavStorageProvider,
    EncryptionService,
    {
      provide: STORAGE_PROVIDER,
      inject: [
        ConfigService,
        LocalStorageProvider,
        S3StorageProvider,
        WebdavStorageProvider,
      ],
      useFactory: (
        config: ConfigService,
        local: LocalStorageProvider,
        s3: S3StorageProvider,
        webdav: WebdavStorageProvider
      ): StorageProvider => {
        const app = config.get<AppConfig>('app');
        const logger = new Logger('StorageModule');
        switch (app.storage.driver) {
          case 's3':
            logger.log(
              `Using S3 object storage (bucket "${app.storage.s3.bucket}"` +
                `${app.storage.s3.endpoint ? `, endpoint ${app.storage.s3.endpoint}` : ''}).`,
            );
            return s3;
          case 'webdav':
            logger.log(
              `Using WebDAV storage (endpoint "${app.storage.webdav.url}")`,
            )
            return webdav;
          default:
            return local;
        } 
      },
    },
  ],
  exports: [STORAGE_PROVIDER, EncryptionService],
})
export class StorageModule {}
