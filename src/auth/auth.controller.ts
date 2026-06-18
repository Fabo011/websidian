import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CookieOptions, Request, Response } from 'express';
import { AppConfig } from '../config/configuration';
import { AUTH_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';
import { AuthenticatedUser } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TotpDto } from './dto/totp.dto';
import { PendingAuthGuard } from './guards';

const TEN_MINUTES_MS = 10 * 60 * 1000;

function parseDurationMs(value: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!match) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const factor = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return amount * factor;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private get app(): AppConfig {
    return this.config.get<AppConfig>('app');
  }

  private cookieOptions(maxAge: number): CookieOptions {
    return {
      httpOnly: true,
      secure: this.app.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge,
    };
  }

  private setPendingCookie(res: Response, token: string): void {
    res.cookie(AUTH_COOKIE, token, this.cookieOptions(TEN_MINUTES_MS));
  }

  private setAuthCookie(res: Response, token: string): void {
    res.cookie(
      AUTH_COOKIE,
      token,
      this.cookieOptions(parseDurationMs(this.app.jwtExpiresIn)),
    );
  }

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.app.allowRegistration) {
      throw new ForbiddenException('Registration is disabled.');
    }
    const { user, secret, otpauthUrl, qrDataUrl } = await this.auth.register(
      dto.username,
      dto.password,
      {
        kdfSalt: dto.kdfSalt,
        recoverySalt: dto.recoverySalt,
        wrappedVaultKey: dto.wrappedVaultKey,
        recoveryWrappedVaultKey: dto.recoveryWrappedVaultKey,
      },
    );
    const pending = this.auth.signToken(user, 'pending');
    this.setPendingCookie(res, pending);
    return { secret, otpauthUrl, qrDataUrl };
  }

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.validateCredentials(
      dto.username,
      dto.password,
    );
    const pending = this.auth.signToken(user, 'pending');
    this.setPendingCookie(res, pending);
    return { needTotp: true };
  }

  @Post('2fa')
  @UseGuards(PendingAuthGuard)
  async verify2fa(
    @Body() dto: TotpDto,
    @CurrentUser() current: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.confirmTotp(current.id, dto.code);
    const token = this.auth.signToken(user, 'auth');
    this.setAuthCookie(res, token);
    // Hand back the (server-opaque) wrapped vault key + KDF salt so the client
    // can derive its wrapping key from the password it still holds in memory
    // and unwrap the vault key locally. The server never sees the vault key.
    return {
      ok: true,
      kdfSalt: user.kdfSalt,
      wrappedVaultKey: user.wrappedVaultKey,
    };
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  }
}
