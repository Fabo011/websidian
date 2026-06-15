import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Users flagged by the nightly job for being over the free 1 GB allowance
 * without an active paid plan. Their account is slated for deletion unless they
 * either pay or reduce their vault back to 1 GB.
 */
@Entity('blacklisted_users')
export class BlacklistedUser {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', unique: true })
  username: string;

  @Column({ type: 'varchar', nullable: true })
  reason: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
