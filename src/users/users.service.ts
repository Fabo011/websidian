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
    driver: 's3' | 'webdav',
    configJson: string,
    quotaBytes: number | null,
  ): Promise<User> {
    user.storageDriver = driver;
    user.storageConfig = configJson;
    user.storageQuotaBytes =
      quotaBytes && quotaBytes > 0 ? String(quotaBytes) : null;
    return this.users.save(user);
  }

  async save(user: User): Promise<User> {
    return this.users.save(user);
  }

  async remove(user: User): Promise<void> {
    await this.users.remove(user);
  }
}
