import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { STORAGE_PROVIDER, StorageProvider } from './storage.interface';

/**
 * Provides the active {@link StorageProvider} (local filesystem by default,
 * or S3-compatible object storage when `STORAGE_DRIVER=s3`).
 */
@Global()
@Module({
  providers: [
    LocalStorageProvider,
    S3StorageProvider,
    {
      provide: STORAGE_PROVIDER,
      inject: [ConfigService, LocalStorageProvider, S3StorageProvider],
      useFactory: (
        config: ConfigService,
        local: LocalStorageProvider,
        s3: S3StorageProvider,
      ): StorageProvider => {
        const driver = config.get<AppConfig>('app').storage.driver;
        if (driver === 's3') {
          new Logger('StorageModule').warn(
            'S3 storage driver selected but it is not yet implemented. ' +
              'Set STORAGE_DRIVER=local to use the built-in local storage.',
          );
          return s3;
        }
        return local;
      },
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
