import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdirSync } from 'fs';
import { AuthModule } from './auth/auth.module';
import configuration, { AppConfig, databaseFile } from './config/configuration';
import { User } from './users/user.entity';
import { UsersModule } from './users/users.module';
import { VaultModule } from './vault/vault.module';
import { ViewsModule } from './views/views.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = config.get<AppConfig>('app');
        mkdirSync(app.dataRoot, { recursive: true });
        return {
          type: 'sqljs' as const,
          location: databaseFile(app.dataRoot),
          autoSave: true,
          entities: [User],
          synchronize: true,
        };
      },
    }),
    UsersModule,
    AuthModule,
    VaultModule,
    ViewsModule,
  ],
})
export class AppModule {}
