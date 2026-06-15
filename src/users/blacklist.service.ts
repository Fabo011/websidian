import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BlacklistedUser } from './blacklisted-user.entity';

/** Manages the blacklist of accounts slated for deletion (over-quota non-payers). */
@Injectable()
export class BlacklistService {
  constructor(
    @InjectRepository(BlacklistedUser)
    private readonly blacklist: Repository<BlacklistedUser>,
  ) {}

  async isBlacklisted(username: string): Promise<boolean> {
    const count = await this.blacklist.count({
      where: { username: username.toLowerCase() },
    });
    return count > 0;
  }

  /** Add a username to the blacklist (idempotent). */
  async add(username: string, reason: string): Promise<void> {
    const name = username.toLowerCase();
    if (await this.isBlacklisted(name)) {
      return;
    }
    await this.blacklist.save(this.blacklist.create({ username: name, reason }));
  }

  /** Remove a username from the blacklist (e.g. once they pay or shrink). */
  async remove(username: string): Promise<void> {
    await this.blacklist.delete({ username: username.toLowerCase() });
  }
}
