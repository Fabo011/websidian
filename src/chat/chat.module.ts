import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ChatBlock } from './chat-block.entity';
import { ChatBlockService } from './chat-block.service';
import { ChatController } from './chat.controller';
import { ChatCron } from './chat.cron';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { PendingMessage } from './pending-message.entity';

/**
 * End-to-end encrypted chat. The gateway relays opaque ciphertext over
 * WebSockets, the service persists the transient offline-delivery queue, the
 * controller exposes public-key lookup, and the cron purges stale envelopes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PendingMessage, ChatBlock]),
    AuthModule,
    UsersModule,
  ],
  controllers: [ChatController],
  providers: [ChatGateway, ChatService, ChatBlockService, ChatCron],
})
export class ChatModule {}
