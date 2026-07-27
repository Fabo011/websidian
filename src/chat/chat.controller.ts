import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards';
import { AppConfig } from '../config/configuration';
import { UsersService } from '../users/users.service';
import { ChatBlockService } from './chat-block.service';
import { BlockDto } from './dto/block.dto';

/**
 * REST surface for chat that is not real-time. Today it only exposes the public
 * key lookup a client needs before it can derive a shared conversation key with
 * a partner. Only public key material ever leaves this boundary.
 */
@Controller('api/chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly users: UsersService,
    private readonly config: ConfigService,
    private readonly blocks: ChatBlockService,
  ) {}

  private get app(): AppConfig {
    return this.config.get<AppConfig>('app');
  }

  /**
   * Look up a user's public chat identity key by username. Used by the client
   * to start a conversation (derive the shared ECDH key) and to verify a
   * partner actually exists and has enabled chat. Returns 404 when the user is
   * unknown or has not set up chat yet.
   */
  @Get('pubkey/:username')
  async pubkey(@Param('username') username: string) {
    if (!this.app.chatEnabled) {
      throw new ForbiddenException('Chat is disabled on this instance.');
    }
    const found = await this.users.findPublicKeyByUsername(username);
    if (!found) {
      throw new NotFoundException('No such user, or chat not set up.');
    }
    return found;
  }

  /** The usernames the current user has blocked. */
  @Get('blocks')
  async listBlocks(@CurrentUser() user: AuthenticatedUser) {
    return { blocked: await this.blocks.list(user.storageId) };
  }

  /** Block a username so they can no longer reach the current user. */
  @Post('blocks')
  @HttpCode(200)
  async addBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BlockDto,
  ) {
    const target = dto.username.toLowerCase();
    if (target === user.username.toLowerCase()) {
      throw new BadRequestException('You cannot block yourself.');
    }
    await this.blocks.add(user.storageId, target);
    return { ok: true };
  }

  /** Unblock a previously blocked username. */
  @Delete('blocks/:username')
  async removeBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('username') username: string,
  ) {
    await this.blocks.remove(user.storageId, username);
    return { ok: true };
  }
}
