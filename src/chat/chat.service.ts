import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { PendingMessage } from './pending-message.entity';

/** A queued envelope as handed to the gateway for delivery. */
export interface QueuedEnvelope {
  id: number;
  fromUsername: string;
  envelope: string;
  createdAt: Date;
}

/**
 * Persistence for the transient offline-delivery queue. Stores and returns only
 * opaque ciphertext envelopes — it has no knowledge of message contents and no
 * key to read them. Rows are short-lived: enqueued only when the recipient is
 * offline, drained and deleted on their next connection, and purged by cron if
 * they overstay the retention window.
 */
@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(PendingMessage)
    private readonly pending: Repository<PendingMessage>,
  ) {}

  /** Queue an encrypted envelope for an offline recipient (by storage id). */
  async enqueue(
    toStorageId: string,
    fromUsername: string,
    envelope: string,
  ): Promise<void> {
    const row = this.pending.create({ toStorageId, fromUsername, envelope });
    await this.pending.save(row);
  }

  /** All envelopes queued for a recipient, oldest first. */
  async drain(toStorageId: string): Promise<QueuedEnvelope[]> {
    const rows = await this.pending.find({
      where: { toStorageId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return rows.map((r) => ({
      id: r.id,
      fromUsername: r.fromUsername,
      envelope: r.envelope,
      createdAt: r.createdAt,
    }));
  }

  /** Delete queued envelopes by id (after they are delivered). */
  async deleteByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pending.delete(ids);
  }

  /**
   * Purge envelopes older than `ttlDays`. Returns how many were removed. Used by
   * the nightly cron so a recipient who never reconnects cannot leave ciphertext
   * queued forever.
   */
  async purgeOlderThan(ttlDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
    const res = await this.pending.delete({ createdAt: LessThan(cutoff) });
    return res.affected ?? 0;
  }
}
