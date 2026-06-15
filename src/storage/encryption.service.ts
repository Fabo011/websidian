import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scryptSync,
} from 'crypto';
import { AppConfig } from '../config/configuration';

/** Magic prefix identifying a web-obsidian encrypted blob (version 1). */
const MAGIC = Buffer.from('WOE1');
const IV_LEN = 12; // AES-GCM standard nonce length
const TAG_LEN = 16; // AES-GCM authentication tag length
const KEY_LEN = 32; // AES-256
const HEADER_LEN = MAGIC.length + IV_LEN + TAG_LEN;

/**
 * Encrypts and decrypts vault payloads at rest using AES-256-GCM (Node.js
 * `crypto`). A single server-side master key (from `ENCRYPTION_KEY`, or
 * derived from `JWT_SECRET` as a fallback) is stretched with scrypt; each
 * user then gets a distinct sub-key derived with HKDF so users are
 * cryptographically isolated.
 *
 * This is encryption *at rest*: it protects the data folder / object-storage
 * bucket if it is stolen or accessed directly. It is not zero-knowledge E2EE
 * — the running server holds the key in memory to serve requests.
 */
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger('EncryptionService');
  private readonly enabled: boolean;
  private readonly masterKey: Buffer | null;
  private readonly userKeys = new Map<string, Buffer>();
  /** Dedicated key for encrypting database column values. */
  private readonly dbKey: Buffer | null;

  constructor(config: ConfigService) {
    const app = config.get<AppConfig>('app');
    this.enabled = app.encryption.enabled;
    if (!this.enabled) {
      this.masterKey = null;
      this.dbKey = null;
      this.logger.warn(
        'Vault encryption at rest is DISABLED (ENCRYPTION_ENABLED=false). ' +
          'Files will be stored in plaintext.',
      );
      return;
    }
    let secret = app.encryption.key;
    if (!secret) {
      secret = app.jwtSecret;
      this.logger.warn(
        'ENCRYPTION_KEY is not set; deriving the at-rest encryption key from ' +
          'JWT_SECRET. Set a dedicated, stable ENCRYPTION_KEY — if JWT_SECRET ' +
          'changes, previously stored data will become unreadable.',
      );
    }
    // Stretch the (possibly low-entropy) secret into a 32-byte master key.
    this.masterKey = scryptSync(secret, 'web-obsidian:master-v1', KEY_LEN);
    // Derive a separate key for database columns so file and DB ciphertexts
    // never share key material.
    this.dbKey = Buffer.from(
      hkdfSync(
        'sha256',
        this.masterKey,
        Buffer.from('web-obsidian:db', 'utf8'),
        Buffer.from('web-obsidian:db-v1'),
        KEY_LEN,
      ),
    );
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Derive (and cache) a per-user 32-byte key from the master key. */
  private userKey(username: string): Buffer {
    let key = this.userKeys.get(username);
    if (!key) {
      const derived = hkdfSync(
        'sha256',
        this.masterKey,
        Buffer.from(username, 'utf8'),
        Buffer.from('web-obsidian:file-v1'),
        KEY_LEN,
      );
      key = Buffer.from(derived);
      this.userKeys.set(username, key);
    }
    return key;
  }

  /** Encrypt a payload. Returns `MAGIC | iv | tag | ciphertext`. */
  encrypt(username: string, plaintext: Buffer): Buffer {
    if (!this.enabled) {
      return plaintext;
    }
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.userKey(username), iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, iv, tag, ciphertext]);
  }

  /**
   * Decrypt a payload. If the blob is not in our encrypted format (e.g. a file
   * written in plaintext before encryption was enabled), it is returned as-is.
   */
  decrypt(username: string, blob: Buffer): Buffer {
    if (!this.enabled) {
      return blob;
    }
    if (
      blob.length < HEADER_LEN ||
      !blob.subarray(0, MAGIC.length).equals(MAGIC)
    ) {
      return blob; // legacy plaintext
    }
    const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = blob.subarray(MAGIC.length + IV_LEN, HEADER_LEN);
    const ciphertext = blob.subarray(HEADER_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.userKey(username), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /**
   * Encrypt a short database column value (e.g. a TOTP secret or Stripe id).
   * Returns a base64 string of `MAGIC | iv | tag | ciphertext`, or the value
   * unchanged when encryption is disabled / the value is null/empty.
   */
  encryptString(plaintext: string | null | undefined): string | null {
    if (plaintext === null || plaintext === undefined) {
      return (plaintext ?? null) as null;
    }
    if (!this.enabled || plaintext === '') {
      return plaintext;
    }
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.dbKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, iv, tag, ciphertext]).toString('base64');
  }

  /**
   * Decrypt a value produced by {@link encryptString}. Values that are not in
   * our encrypted format (e.g. written before encryption was enabled) are
   * returned unchanged.
   */
  decryptString(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return (value ?? null) as null;
    }
    if (!this.enabled || value === '') {
      return value;
    }
    let blob: Buffer;
    try {
      blob = Buffer.from(value, 'base64');
    } catch {
      return value; // not base64; treat as legacy plaintext
    }
    if (
      blob.length < HEADER_LEN ||
      !blob.subarray(0, MAGIC.length).equals(MAGIC)
    ) {
      return value; // legacy plaintext
    }
    const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = blob.subarray(MAGIC.length + IV_LEN, HEADER_LEN);
    const ciphertext = blob.subarray(HEADER_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.dbKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}
