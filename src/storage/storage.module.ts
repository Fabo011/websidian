import { Global, Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { EncryptionService } from './encryption.service';
import { LocalStorageProvider } from './local-storage.provider';
import { RoutingStorageProvider } from './routing-storage.provider';
import { StorageResolver } from './storage-resolver.service';
import { STORAGE_PROVIDER } from './storage.interface';

/**
 * Wires up vault storage. The {@link STORAGE_PROVIDER} token resolves to the
 * {@link RoutingStorageProvider}, which forwards each call to the right backend
 * for the namespace: the single env-configured provider in the default mode, or
 * a per-user provider built from that user's saved credentials when
 * USER_STORAGE_ENABLED is on (see {@link StorageResolver}).
 *
 * File *contents* are end-to-end encrypted on the client (zero-knowledge), so
 * the server stores opaque ciphertext blobs and performs no file encryption of
 * its own. {@link EncryptionService} is still provided here because it encrypts
 * sensitive *database columns* (TOTP secrets, Stripe ids, storage credentials)
 * at rest.
 */
@Global()
@Module({
  imports: [UsersModule],
  providers: [
    LocalStorageProvider,
    StorageResolver,
    EncryptionService,
    {
      provide: STORAGE_PROVIDER,
      useClass: RoutingStorageProvider,
    },
  ],
  exports: [STORAGE_PROVIDER, StorageResolver, EncryptionService],
})
export class StorageModule {}
