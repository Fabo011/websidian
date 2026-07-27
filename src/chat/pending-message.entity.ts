import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A single end-to-end encrypted chat envelope queued for a recipient who was
 * offline when it was sent. The server holds **only ciphertext it cannot
 * decrypt** — there is no plaintext, no key, and no way to read the message.
 * The row is deleted the moment it is delivered, and a nightly cron purges any
 * that outlive CHAT_PENDING_TTL_DAYS (recipient never came back).
 *
 * This is a transient relay buffer, not chat history: the real, decryptable
 * history lives in each user's own vault storage, encrypted with their vault
 * key. Nothing here is a persistent record of a conversation.
 */
@Entity('pending_messages')
export class PendingMessage {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Storage namespace id of the intended recipient (the stable, opaque handle
   * from {@link User.storageId}). Indexed so a reconnecting user's queue is a
   * single fast lookup. Never the username, which can be recycled.
   */
  @Index()
  @Column({ type: 'varchar' })
  toStorageId: string;

  /** Username of the sender, so the client can attribute the message. */
  @Column({ type: 'varchar' })
  fromUsername: string;

  /**
   * The opaque, base64 chat envelope: ciphertext derived from the sender's and
   * recipient's ECDH keys. The server never interprets it.
   */
  @Column({ type: 'text' })
  envelope: string;

  @CreateDateColumn()
  createdAt: Date;
}
