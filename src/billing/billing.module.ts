import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { VaultModule } from '../vault/vault.module';
import { BillingController } from './billing.controller';
import { BillingCron } from './billing.cron';
import { BillingService } from './billing.service';

@Module({
  imports: [AuthModule, UsersModule, VaultModule],
  controllers: [BillingController],
  providers: [BillingService, BillingCron],
  exports: [BillingService],
})
export class BillingModule {}
