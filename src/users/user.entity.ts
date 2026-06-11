import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', unique: true })
  username: string;

  @Column({ type: 'varchar' })
  passwordHash: string;

  /** Base32 TOTP secret. Set at registration. */
  @Column({ type: 'varchar' })
  totpSecret: string;

  /** Becomes true once the user has confirmed a TOTP code during registration. */
  @Column({ type: 'boolean', default: false })
  totpEnabled: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
