import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatBlock } from './chat-block.entity';

/**
 * Per-user chat block list. A user blocks a username so that person can no
 * longer reach them: the gateway checks {@link isBlocked} before delivering or
 * queuing, and silently drops the message. Enforced entirely server-side.
 */
@Injectable()
export class ChatBlockService {
  constructor(
    @InjectRepository(ChatBlock)
    private readonly blocks: Repository<ChatBlock>,
  ) {}

  /** Usernames the owner has blocked, most recent first. */
  async list(ownerStorageId: string): Promise<string[]> {
    const rows = await this.blocks.find({
      where: { ownerStorageId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return rows.map((r) => r.blockedUsername);
  }

  /** Add a block (idempotent — a duplicate is a no-op). */
  async add(ownerStorageId: string, blockedUsername: string): Promise<void> {
    const username = blockedUsername.toLowerCase();
    const existing = await this.blocks.findOne({
      where: { ownerStorageId, blockedUsername: username },
    });
    if (existing) return;
    await this.blocks.save(
      this.blocks.create({ ownerStorageId, blockedUsername: username }),
    );
  }

  /** Remove a block (unblock). */
  async remove(ownerStorageId: string, blockedUsername: string): Promise<void> {
    await this.blocks.delete({
      ownerStorageId,
      blockedUsername: blockedUsername.toLowerCase(),
    });
  }

  /** Whether `owner` (by storage id) has blocked `senderUsername`. */
  async isBlocked(
    ownerStorageId: string,
    senderUsername: string,
  ): Promise<boolean> {
    const row = await this.blocks.findOne({
      where: {
        ownerStorageId,
        blockedUsername: senderUsername.toLowerCase(),
      },
    });
    return !!row;
  }
}
