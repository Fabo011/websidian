import {
    Body,
    Controller,
    Delete,
    Get,
    Req,
    Res,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AUTH_COOKIE } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards';
import { UsersService } from '../users/users.service';
import { VaultService } from '../vault/vault.service';
import { DeleteAccountDto } from './dto/delete-account.dto';

@Controller('api/account')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly vault: VaultService,
  ) {}

  /** Current account info: username, storage usage and quota. */
  @Get()
  async account(@CurrentUser() user: AuthenticatedUser) {
    const usage = await this.vault.usage(user.username);
    return {
      username: user.username,
      usedBytes: usage.used,
      quotaBytes: usage.limit,
      unlimited: usage.unlimited,
    };
  }

  /**
   * Permanently delete the account: removes the user's vault data from storage
   * and the user row from the database, then clears the auth cookie.
   * Requires the current password as confirmation.
   */
  @Delete()
  async deleteAccount(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: DeleteAccountDto,
    @Req() _req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.users.findById(current.id);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists.');
    }
    // Re-validate the password before destroying anything.
    await this.auth.validateCredentials(user.username, dto.password);

    // Delete vault data first; if that fails we keep the account intact.
    await this.vault.deleteUserData(user.username);
    await this.users.remove(user);

    res.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  }
}
