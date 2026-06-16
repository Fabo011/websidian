import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { AppConfig } from '../config/configuration';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { JwtPayload } from './auth.types';

const TOTP_ISSUER = 'web-obsidian';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private get app(): AppConfig {
    return this.config.get<AppConfig>('app');
  }

  /**
   * Create a new account (TOTP not yet confirmed) and return the enrolment
   * details so the UI can show a QR code and the plaintext secret.
   */
  async register(
    username: string,
    password: string,
  ): Promise<{ user: User; secret: string; otpauthUrl: string; qrDataUrl: string }> {
    if (!this.app.allowRegistration) {
      throw new ForbiddenException('Registration is disabled.');
    }

    const normalized = username.toLowerCase();
    const existing = await this.users.findByUsername(normalized);
    if (existing) {
      throw new ConflictException('That username is already taken.');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const secret = authenticator.generateSecret();
    const user = await this.users.create({
      username: normalized,
      passwordHash,
      totpSecret: secret,
    });

    const otpauthUrl = authenticator.keyuri(normalized, TOTP_ISSUER, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    return { user, secret, otpauthUrl, qrDataUrl };
  }

  /** Validate username + password, returning the user on success. */
  async validateCredentials(username: string, password: string): Promise<User> {
    const user = await this.users.findByUsername(username.toLowerCase());
    if (!user) {
      throw new UnauthorizedException('Invalid username or password.');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid username or password.');
    }
    return user;
  }

  /** Verify a 6-digit TOTP code against the user's secret. */
  verifyTotp(user: User, code: string): boolean {
    return authenticator.verify({ token: code, secret: user.totpSecret });
  }

  /**
   * Change a user's password. Requires the current password and a valid TOTP
   * code as a second factor before the new password is stored.
   */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    code: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists.');
    }

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Current password is incorrect.');
    }

    if (!this.verifyTotp(user, code)) {
      throw new BadRequestException('Incorrect code. Please try again.');
    }

    const same = await bcrypt.compare(newPassword, user.passwordHash);
    if (same) {
      throw new BadRequestException(
        'The new password must be different from the current one.',
      );
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    await this.users.save(user);
  }

  /**
   * Begin resetting the user's authenticator (TOTP). Requires the current
   * password and a valid code from the *existing* authenticator, then generates
   * a fresh secret that is stored as pending until confirmed. Returns the
   * enrolment details so the UI can show a QR code and the plaintext secret.
   */
  async beginTotpReset(
    userId: number,
    currentPassword: string,
    code: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists.');
    }

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Current password is incorrect.');
    }

    if (!this.verifyTotp(user, code)) {
      throw new BadRequestException('Incorrect code. Please try again.');
    }

    const secret = authenticator.generateSecret();
    user.pendingTotpSecret = secret;
    await this.users.save(user);

    const otpauthUrl = authenticator.keyuri(user.username, TOTP_ISSUER, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    return { secret, otpauthUrl, qrDataUrl };
  }

  /**
   * Confirm a pending authenticator reset: verify a code from the *new* secret
   * and promote it to the active TOTP secret, clearing the pending value.
   */
  async confirmTotpReset(userId: number, code: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists.');
    }
    if (!user.pendingTotpSecret) {
      throw new BadRequestException(
        'No authenticator reset in progress. Please start again.',
      );
    }
    if (!authenticator.verify({ token: code, secret: user.pendingTotpSecret })) {
      throw new BadRequestException('Incorrect code. Please try again.');
    }

    user.totpSecret = user.pendingTotpSecret;
    user.pendingTotpSecret = null;
    user.totpEnabled = true;
    await this.users.save(user);
  }

  /** Confirm the second factor and mark TOTP as enabled (idempotent). */
  async confirmTotp(userId: number, code: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists.');
    }
    if (!this.verifyTotp(user, code)) {
      throw new BadRequestException('Incorrect code. Please try again.');
    }
    if (!user.totpEnabled) {
      user.totpEnabled = true;
      await this.users.save(user);
    }
    return user;
  }

  signToken(user: Pick<User, 'id' | 'username'>, purpose: 'auth' | 'pending'): string {
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      purpose,
    };
    const expiresIn = purpose === 'auth' ? this.app.jwtExpiresIn : '10m';
    return this.jwt.sign(payload, {
      secret: this.app.jwtSecret,
      expiresIn: expiresIn as unknown as number,
    });
  }

  verifyToken(token: string): JwtPayload {
    return this.jwt.verify<JwtPayload>(token, { secret: this.app.jwtSecret });
  }
}
