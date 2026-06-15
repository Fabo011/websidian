import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Usernames added here (manually, by the operator) are entitled to the top
 * (20 GB) storage tier for free, with no payment required. This is checked at
 * register and login time and whenever a user's effective quota is computed.
 */
@Entity('privileged_users')
export class PrivilegedUser {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', unique: true })
  username: string;
}
