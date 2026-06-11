import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { VaultModule } from '../vault/vault.module';
import { AccountController } from './account.controller';

@Module({
  imports: [AuthModule, UsersModule, VaultModule],
  controllers: [AccountController],
})
export class AccountModule {}
