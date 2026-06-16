import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Post,
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
import { BillingService } from '../billing/billing.service';
import { BlacklistService } from '../users/blacklist.service';
import { EntitlementsService } from '../users/entitlements.service';
import { UsersService } from '../users/users.service';
import { VaultService } from '../vault/vault.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';

@Controller('api/account')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly vault: VaultService,
    private readonly entitlements: EntitlementsService,
    private readonly blacklist: BlacklistService,
    private readonly billing: BillingService,
  ) {}

  /** Current account info: username, storage usage, plan and billing status. */
  @Get()
  async account(@CurrentUser() user: AuthenticatedUser) {
    const usage = await this.vault.usage(user.username);
    let dbUser = await this.users.findByUsername(user.username);
    // Pull the latest subscription state from Stripe (no webhooks). Best-effort
    // and only when the user actually has a subscription to refresh.
    if (this.billing.ready && dbUser?.stripeSubscriptionId) {
      await this.billing.syncUser(dbUser);
      dbUser = await this.users.findByUsername(user.username);
    }
    const ent = dbUser ? await this.entitlements.forUser(dbUser) : null;
    const blacklisted = await this.blacklist.isBlacklisted(user.username);
    return {
      username: user.username,
      usedBytes: usage.used,
      quotaBytes: usage.limit,
      unlimited: usage.unlimited,
      plan: ent?.plan ?? 'free',
      effectiveTier: ent?.effectiveTier ?? 'free',
      privileged: ent?.privileged ?? false,
      subscriptionStatus: ent?.subscriptionStatus ?? 'none',
      currentPeriodEnd: ent?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: ent?.cancelAtPeriodEnd ?? false,
      paidActive: ent?.paidActive ?? false,
      daysUntilExpiry: ent?.daysUntilExpiry ?? null,
      warnExpiringSoon: ent?.warnExpiringSoon ?? false,
      blacklisted,
    };
  }

  /**
   * Change the account password. Requires the current password and a valid
   * TOTP code as a second factor.
   */
  @Post('password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.auth.changePassword(
      current.id,
      dto.currentPassword,
      dto.newPassword,
      dto.code,
    );
    return { ok: true };
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
