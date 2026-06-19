import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfig } from '../config/configuration';
import { PrivilegedUser } from './privileged-user.entity';

/**
 * Read access to the privileged users list. Members get the top storage tier
 * for free without any payment. The list combines two sources: the
 * PRIVILEGED_USERS env var (comma-separated usernames) and the manually-managed
 * privileged_users DB table.
 */
@Injectable()
export class PrivilegedUsersService {
  constructor(
    @InjectRepository(PrivilegedUser)
    private readonly privileged: Repository<PrivilegedUser>,
    private readonly config: ConfigService,
  ) {}

  /** Usernames (lowercased) configured via the PRIVILEGED_USERS env var. */
  private get envUsers(): string[] {
    return this.config.get<AppConfig>('app').privilegedUsers;
  }

  /** Whether the given username (case-insensitive) is privileged. */
  async isPrivileged(username: string): Promise<boolean> {
    const name = username.toLowerCase();
    if (this.envUsers.includes(name)) {
      return true;
    }
    const count = await this.privileged.count({
      where: { username: name },
    });
    return count > 0;
  }
}
