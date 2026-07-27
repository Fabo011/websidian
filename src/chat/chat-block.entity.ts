import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One "user A has blocked username B" relationship. Enforced server-side so a
 * blocked sender cannot bypass it by spoofing the client: the gateway silently
 * drops (and never queues) any message addressed to an owner who has blocked the
 * sender. The owner is keyed by their stable storage id (never a recyclable
 * username); the blocked party is stored as a lowercased username.
 */
@Entity('chat_blocks')
@Index(['ownerStorageId', 'blockedUsername'], { unique: true })
export class ChatBlock {
  @PrimaryGeneratedColumn()
  id: number;

  /** Storage id of the user who created the block (the blocker). */
  @Index()
  @Column({ type: 'varchar' })
  ownerStorageId: string;

  /** Lowercased username the owner blocked. */
  @Column({ type: 'varchar' })
  blockedUsername: string;

  @CreateDateColumn()
  createdAt: Date;
}
