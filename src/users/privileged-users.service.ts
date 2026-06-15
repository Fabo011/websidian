import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PrivilegedUser } from './privileged-user.entity';

/**
 * Read access to the manually-managed privileged users list. Members get the
 * top storage tier for free without any payment.
 */
@Injectable()
export class PrivilegedUsersService {
  constructor(
    @InjectRepository(PrivilegedUser)
    private readonly privileged: Repository<PrivilegedUser>,
  ) {}

  /** Whether the given username (case-insensitive) is privileged. */
  async isPrivileged(username: string): Promise<boolean> {
    const count = await this.privileged.count({
      where: { username: username.toLowerCase() },
    });
    return count > 0;
  }
}
