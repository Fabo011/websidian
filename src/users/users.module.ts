import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlacklistService } from './blacklist.service';
import { BlacklistedUser } from './blacklisted-user.entity';
import { EntitlementsService } from './entitlements.service';
import { PrivilegedUser } from './privileged-user.entity';
import { PrivilegedUsersService } from './privileged-users.service';
import { User } from './user.entity';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, PrivilegedUser, BlacklistedUser])],
  providers: [
    UsersService,
    PrivilegedUsersService,
    BlacklistService,
    EntitlementsService,
  ],
  exports: [
    UsersService,
    PrivilegedUsersService,
    BlacklistService,
    EntitlementsService,
  ],
})
export class UsersModule {}
