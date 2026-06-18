import {
  Body,
  Controller,
  Get,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards';
import { EntitlementsService } from '../users/entitlements.service';
import { UsersService } from '../users/users.service';
import { BillingService } from './billing.service';
import { CheckoutDto } from './dto/checkout.dto';
import { SyncDto } from './dto/sync.dto';

@Controller('api/billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly users: UsersService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Whether paid upgrades are available (Stripe configured) + the plans. */
  @Get('config')
  config() {
    return { enabled: this.billing.enabled, ready: this.billing.ready };
  }

  /** Start a Stripe Checkout session for a paid annual plan. */
  @Post('checkout')
  @UseGuards(JwtAuthGuard)
  async checkout(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: CheckoutDto,
  ) {
    const user = await this.users.findById(current.id);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists.');
    }
    const url = await this.billing.createCheckoutSession(user, dto.plan);
    return { url };
  }

  /** Open the Stripe Billing Portal to manage / cancel the subscription. */
  @Post('portal')
  @UseGuards(JwtAuthGuard)
  async portal(@CurrentUser() current: AuthenticatedUser) {
    const user = await this.users.findById(current.id);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists.');
    }
    const url = await this.billing.createPortalSession(user);
    return { url };
  }

  /**
   * Sync the account from Stripe after a checkout redirect. The dashboard calls
   * this with the `session_id` from the success URL so the new plan is applied
   * immediately, without needing webhooks.
   */
  @Post('sync')
  @UseGuards(JwtAuthGuard)
  async sync(@CurrentUser() current: AuthenticatedUser, @Body() dto: SyncDto) {
    if (!this.billing.ready) {
      return { synced: false };
    }
    const user = await this.users.findById(current.id);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists.');
    }
    if (dto.sessionId) {
      const synced = await this.billing.syncFromCheckoutSession(
        dto.sessionId,
        user.id,
      );
      return { synced };
    }
    await this.billing.syncUser(user);
    return { synced: true };
  }
}
