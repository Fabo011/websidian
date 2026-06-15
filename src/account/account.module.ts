import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { UsersModule } from '../users/users.module';
import { VaultModule } from '../vault/vault.module';
import { AccountController } from './account.controller';

@Module({
  imports: [AuthModule, UsersModule, VaultModule, BillingModule],
  controllers: [AccountController],
})
export class AccountModule {}
