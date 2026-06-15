import {
    Column,
    CreateDateColumn,
    Entity,
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

  @Column({ type: 'varchar', transformer: encryptedColumn })
  passwordHash: string;

  /** Base32 TOTP secret, encrypted at rest. */
  @Column({ type: 'varchar', transformer: encryptedColumn })
  totpSecret: string;

  /** Becomes true once the user has confirmed a TOTP code during registration. */
  @Column({ type: 'boolean', default: false })
  totpEnabled: boolean;

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
