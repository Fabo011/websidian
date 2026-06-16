import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { MarkdownService } from './markdown.service';
import { VaultController } from './vault.controller';
import { TrashCron } from './vault.cron';
import { VaultService } from './vault.service';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [VaultController],
  providers: [VaultService, MarkdownService, TrashCron],
  exports: [VaultService, MarkdownService],
})
export class VaultModule {}
