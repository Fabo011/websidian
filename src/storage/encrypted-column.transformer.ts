import { ValueTransformer } from 'typeorm';
import { EncryptionService } from './encryption.service';

/**
 * TypeORM does not support dependency injection inside column transformers, so
 * we hold the active {@link EncryptionService} in a module-level singleton that
 * is wired up once during application bootstrap (see `main.ts`).
 *
 * Until it is registered (and whenever encryption is disabled) the transformer
 * is a no-op, so values pass through unchanged.
 */
let encryptor: EncryptionService | null = null;

/** Register the encryption service used by encrypted columns. */
export function registerColumnEncryptor(service: EncryptionService): void {
  encryptor = service;
}

/**
 * A reusable TypeORM transformer that encrypts a string column on write and
 * decrypts it on read, using the server-side `ENCRYPTION_KEY`.
 *
 * Apply with `@Column({ ..., transformer: encryptedColumn })`.
 */
export const encryptedColumn: ValueTransformer = {
  to(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return (value ?? null) as null;
    }
    return encryptor ? encryptor.encryptString(value) : value;
  },
  from(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return (value ?? null) as null;
    }
    return encryptor ? encryptor.decryptString(value) : value;
  },
};
