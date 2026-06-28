import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { PlanTier } from '../config/configuration';
import { encryptedColumn } from '../storage/encrypted-column.transformer';

/** Stripe-mirrored subscription lifecycle state. */
export type SubscriptionStatus =
  | 'none'
  | 'active'
  | 'canceled'
  | 'past_due'
  | 'incomplete';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Lookup key for login — kept in plaintext so it remains queryable. All
   * other sensitive columns are encrypted at rest with `ENCRYPTION_KEY`.
   */
  @Column({ type: 'varchar', unique: true })
  username: string;

  /**
   * Stable, random, opaque identifier that owns the user's storage namespace
   * (S3 prefix / on-disk folder) and the client-side key derivation salt.
   *
   * This is the anchor that fixes account-recycling: it is generated once at
   * registration and never reused, so a new account that happens to pick a
   * freed username gets a *different* storage folder and can never derive a
   * key that matches the previous owner's data. Stored in plaintext because it
   * is a non-secret handle (it must appear in storage keys).
   */
  @Index({ unique: true })
  @Column({ type: 'varchar' })
  storageId: string;

  @Column({ type: 'varchar', transformer: encryptedColumn })
  passwordHash: string;

  // --- End-to-end encryption (zero-knowledge) key material ------------------
  // The vault key (VK) never reaches the server. The client derives a wrapping
  // key from the password (Argon2id + kdfSalt) and stores only the *wrapped*
  // VK here. A second copy is wrapped with a recovery key so the user can
  // recover if they forget the password. All values are opaque base64 strings;
  // the server cannot unwrap any of them.

  /** Base64 salt for the Argon2id password-derived wrapping key. */
  @Column({ type: 'varchar', nullable: true })
  kdfSalt: string | null;

  /** Base64 salt for the Argon2id recovery-key-derived wrapping key. */
  @Column({ type: 'varchar', nullable: true })
  recoverySalt: string | null;

  /** Vault key wrapped (AES-GCM) with the password-derived key. */
  @Column({ type: 'varchar', nullable: true })
  wrappedVaultKey: string | null;

  /** Vault key wrapped (AES-GCM) with the recovery-key-derived key. */
  @Column({ type: 'varchar', nullable: true })
  recoveryWrappedVaultKey: string | null;

  /** Base32 TOTP secret, encrypted at rest. */
  @Column({ type: 'varchar', transformer: encryptedColumn })
  totpSecret: string;

  /**
   * A newly generated TOTP secret awaiting confirmation while the user resets
   * their authenticator from the dashboard. Encrypted at rest, cleared once the
   * new secret is confirmed and promoted to `totpSecret`.
   */
  @Column({ type: 'varchar', nullable: true, transformer: encryptedColumn })
  pendingTotpSecret: string | null;

  /** Becomes true once the user has confirmed a TOTP code during registration. */
  @Column({ type: 'boolean', default: false })
  totpEnabled: boolean;

  // --- Bring-your-own storage (USER_STORAGE_ENABLED) ------------------------
  // When the server hosts no default storage, each account connects its own
  // S3-compatible or WebDAV backend. These columns are unused (null) in the
  // default single-backend mode.

  /** Selected storage driver, or null when the user has not connected one. */
  @Column({ type: 'varchar', nullable: true })
  storageDriver: 's3' | 'webdav' | null;

  /**
   * The user's storage credentials, stored as encrypted JSON at rest (the
   * decrypted value is a {@link UserStorageConfig}). Null until connected.
   */
  @Column({ type: 'varchar', nullable: true, transformer: encryptedColumn })
  storageConfig: string | null;

  /**
   * Self-imposed storage quota in bytes for bring-your-own storage. Null or 0
   * means unlimited (it is the user's own storage). TypeORM returns bigint as a
   * string, so callers parse it with Number().
   */
  @Column({ type: 'bigint', nullable: true })
  storageQuotaBytes: string | null;

  /** The storage plan the user has paid for (independent of privileged status). */
  @Column({ type: 'varchar', default: 'free' })
  plan: PlanTier;

  /** Mirror of the Stripe subscription status. */
  @Column({ type: 'varchar', default: 'none' })
  subscriptionStatus: SubscriptionStatus;

  /** Stripe customer id, encrypted at rest. */
  @Column({ type: 'varchar', nullable: true, transformer: encryptedColumn })
  stripeCustomerId: string | null;

  /** Stripe subscription id, encrypted at rest. */
  @Column({ type: 'varchar', nullable: true, transformer: encryptedColumn })
  stripeSubscriptionId: string | null;

  /**
   * The date the currently paid-for period ends. The plan stays in effect
   * until this moment even if the user cancels earlier (they paid for the year).
   */
  @Column({ nullable: true })
  currentPeriodEnd: Date | null;

  /** True when the subscription will not auto-renew at the period end. */
  @Column({ type: 'boolean', default: false })
  cancelAtPeriodEnd: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
