import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdirSync } from 'fs';
import { AccountModule } from './account/account.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { ChatBlock } from './chat/chat-block.entity';
import { ChatModule } from './chat/chat.module';
import { PendingMessage } from './chat/pending-message.entity';
import configuration, { AppConfig, databaseFile } from './config/configuration';
import { StorageModule } from './storage/storage.module';
import { BlacklistedUser } from './users/blacklisted-user.entity';
import { PrivilegedUser } from './users/privileged-user.entity';
import { User } from './users/user.entity';
import { UsersModule } from './users/users.module';
import { VaultModule } from './vault/vault.module';
import { ViewsModule } from './views/views.module';

const ENTITIES = [
  User,
  PrivilegedUser,
  BlacklistedUser,
  PendingMessage,
  ChatBlock,
];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = config.get<AppConfig>('app');
        if (app.database.type === 'postgres') {
          const pg = app.database.postgres;
          return {
            type: 'postgres' as const,
            host: pg.host,
            port: pg.port,
            username: pg.username,
            password: pg.password,
            database: pg.database,
            ssl: pg.ssl ? { rejectUnauthorized: false } : false,
            entities: ENTITIES,
            synchronize: true,
          };
        }
        mkdirSync(app.dataRoot, { recursive: true });
        return {
          type: 'sqljs' as const,
          location: databaseFile(app.dataRoot),
          autoSave: true,
          entities: ENTITIES,
          synchronize: true,
        };
      },
    }),
    UsersModule,
    AuthModule,
    StorageModule,
    VaultModule,
    AccountModule,
    BillingModule,
    ChatModule,
    ViewsModule,
  ],
})
export class AppModule {}
