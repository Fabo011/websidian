import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  findByUsername(username: string): Promise<User | null> {
    return this.users.findOne({ where: { username } });
  }

  findById(id: number): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }

  findByStorageId(storageId: string): Promise<User | null> {
    return this.users.findOne({ where: { storageId } });
  }

  /** All users (used by the nightly billing/quota job). */
  findAll(): Promise<User[]> {
    return this.users.find();
  }

  async count(): Promise<number> {
    return this.users.count();
  }

  async create(data: {
    username: string;
    passwordHash: string;
    totpSecret: string;
    kdfSalt: string;
    recoverySalt: string;
    wrappedVaultKey: string;
    recoveryWrappedVaultKey: string;
  }): Promise<User> {
    const user = this.users.create({
      username: data.username,
      storageId: this.generateStorageId(),
      passwordHash: data.passwordHash,
      totpSecret: data.totpSecret,
      kdfSalt: data.kdfSalt,
      recoverySalt: data.recoverySalt,
      wrappedVaultKey: data.wrappedVaultKey,
      recoveryWrappedVaultKey: data.recoveryWrappedVaultKey,
      totpEnabled: false,
      plan: 'free',
      subscriptionStatus: 'none',
      cancelAtPeriodEnd: false,
    });
    return this.users.save(user);
  }

  /**
   * Generate a fresh, opaque storage namespace id: the username is deliberately
   * *not* part of it so a recycled username can never collide with a previous
   * owner's folder or derived key.
   */
  private generateStorageId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Persist a user's bring-your-own storage configuration. `configJson` is the
   * serialized credentials (encrypted at rest by the column transformer);
   * `quotaBytes` of null or 0 means unlimited.
   */
  async setStorageConfig(
    user: User,
    driver: 's3' | 'webdav' | 'managed',
    configJson: string,
    quotaBytes: number | null,
  ): Promise<User> {
    user.storageDriver = driver;
    user.storageConfig = configJson;
    user.storageQuotaBytes =
      quotaBytes && quotaBytes > 0 ? String(quotaBytes) : null;
    return this.users.save(user);
  }

  /**
   * Persist a user's chat identity keypair. `chatPublicKey` is base64 SPKI
   * (plaintext, looked up by other users); `wrappedChatPrivateKey` is the
   * VK-wrapped private key (opaque to the server). Generated once by the client
   * and never overwritten unless the client explicitly rotates them.
   */
  async setChatKeys(
    user: User,
    chatPublicKey: string,
    wrappedChatPrivateKey: string,
  ): Promise<User> {
    user.chatPublicKey = chatPublicKey;
    user.wrappedChatPrivateKey = wrappedChatPrivateKey;
    return this.users.save(user);
  }

  /**
   * Look up a user's public chat key by username. Returns null when the user
   * does not exist or has not set up chat yet. Only the public key leaves this
   * boundary — never the wrapped private key of another user.
   */
  async findPublicKeyByUsername(
    username: string,
  ): Promise<{ username: string; publicKey: string } | null> {
    const user = await this.users.findOne({
      where: { username: username.toLowerCase() },
    });
    if (!user || !user.chatPublicKey) return null;
    return { username: user.username, publicKey: user.chatPublicKey };
  }

  async save(user: User): Promise<User> {
    return this.users.save(user);
  }

  async remove(user: User): Promise<void> {
    await this.users.remove(user);
  }
}
