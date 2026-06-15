import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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
  }): Promise<User> {
    const user = this.users.create({
      username: data.username,
      passwordHash: data.passwordHash,
      totpSecret: data.totpSecret,
      totpEnabled: false,
      plan: 'free',
      subscriptionStatus: 'none',
      cancelAtPeriodEnd: false,
    });
    return this.users.save(user);
  }

  async save(user: User): Promise<User> {
    return this.users.save(user);
  }

  async remove(user: User): Promise<void> {
    await this.users.remove(user);
  }
}
