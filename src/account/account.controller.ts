import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AUTH_COOKIE } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards';
import { BillingService } from '../billing/billing.service';
import { AppConfig } from '../config/configuration';
import { StorageConfigDto } from '../storage/dto/storage-config.dto';
import {
  buildUserProvider,
  mapStorageError,
  probeProvider,
  UserStorageConfig,
} from '../storage/storage-config';
import { StorageResolver } from '../storage/storage-resolver.service';
import { BlacklistService } from '../users/blacklist.service';
import { EntitlementsService } from '../users/entitlements.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { VaultService } from '../vault/vault.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChatKeysDto } from './dto/chat-keys.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { BeginResetTotpDto, ConfirmResetTotpDto } from './dto/reset-totp.dto';

const GIB = 1024 * 1024 * 1024;

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
    private readonly config: ConfigService,
    private readonly storageResolver: StorageResolver,
  ) {}

  private get app(): AppConfig {
    return this.config.get<AppConfig>('app');
  }

  /** Current account info: username, storage usage, plan and billing status. */
  @Get()
  async account(@CurrentUser() user: AuthenticatedUser) {
    const userStorage = this.app.userStorageEnabled;
    let dbUser = await this.users.findByUsername(user.username);
    const storageConfigured = Boolean(dbUser?.storageConfig);
    // Managed users store on the app's own S3 backend, so they are billed and
    // quota-limited exactly like a normal hosted account — unlike bring-your-own
    // (s3/webdav) users, who manage their own storage with a self-set cap.
    const isManaged = dbUser?.storageDriver === 'managed';

    // Bring-your-own storage (own s3/webdav): no hosted plan/billing. Usage is
    // still reported, but the quota is the user's own (self-set or unlimited)
    // and the billing fields collapse to the free/none defaults. We also avoid
    // hitting storage for usage before a provider is connected.
    if (userStorage && !isManaged) {
      const usage = !storageConfigured
        ? { used: 0, limit: this.userQuotaBytes(dbUser), unlimited: true }
        : await this.vault.usage(user.username);
      const blacklisted = await this.blacklist.isBlacklisted(user.username);
      return {
        username: user.username,
        usedBytes: usage.used,
        quotaBytes: usage.limit,
        unlimited: usage.unlimited,
        plan: 'free',
        effectiveTier: 'free',
        privileged: false,
        subscriptionStatus: 'none',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        paidActive: false,
        daysUntilExpiry: null,
        warnExpiringSoon: false,
        blacklisted,
        userStorageEnabled: true,
        managed: false,
        storageConfigured,
        storageDriver: dbUser?.storageDriver ?? null,
      };
    }

    // Hosted mode OR a managed user: the tier quota + Stripe billing apply.
    const usage = await this.vault.usage(user.username);
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
      userStorageEnabled: userStorage,
      managed: isManaged,
      storageConfigured: userStorage ? storageConfigured : true,
      storageDriver: isManaged ? 'managed' : null,
    };
  }

  /** Parse a user's self-set quota (bytes). 0/null means unlimited. */
  private userQuotaBytes(user: User | null): number {
    const raw = user?.storageQuotaBytes;
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Return the (server-opaque) wrapped vault key and KDF salt for the
   * authenticated user. The client uses these to re-derive its wrapping key
   * from the password and unlock the vault key locally — e.g. after a page
   * reload in a fresh tab where the in-memory key was lost. The server never
   * sees the vault key itself.
   */
  @Get('keys')
  async keys(@CurrentUser() user: AuthenticatedUser) {
    const dbUser = await this.users.findByUsername(user.username);
    if (!dbUser) {
      throw new UnauthorizedException('Account no longer exists.');
    }
    return {
      kdfSalt: dbUser.kdfSalt,
      wrappedVaultKey: dbUser.wrappedVaultKey,
      // Chat identity keypair (null until the client bootstraps it). The client
      // unwraps the private key locally with the vault key; the server never
      // sees it in the clear.
      chatPublicKey: dbUser.chatPublicKey ?? null,
      wrappedChatPrivateKey: dbUser.wrappedChatPrivateKey ?? null,
    };
  }

  /**
   * Persist the client-generated chat identity keypair (lazy bootstrap on first
   * chat use). The private key arrives already wrapped with the vault key, so
   * the server only ever stores opaque material it cannot unwrap. Idempotent:
   * clients only call it when they find no keypair yet.
   */
  @Post('chat-keys')
  @HttpCode(200)
  async setChatKeys(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChatKeysDto,
  ) {
    const dbUser = await this.users.findByUsername(user.username);
    if (!dbUser) {
      throw new UnauthorizedException('Account no longer exists.');
    }
    await this.users.setChatKeys(
      dbUser,
      dto.chatPublicKey,
      dto.wrappedChatPrivateKey,
    );
    return { ok: true };
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
      { kdfSalt: dto.newKdfSalt, wrappedVaultKey: dto.newWrappedVaultKey },
    );
    return { ok: true };
  }

  /**
   * Begin resetting the authenticator (2FA). Requires the current password and
   * a code from the existing authenticator, then returns a fresh QR code and
   * secret to enrol the new device. The change only takes effect once confirmed.
   */
  @Post('totp/init')
  @HttpCode(200)
  async beginTotpReset(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: BeginResetTotpDto,
  ) {
    return this.auth.beginTotpReset(current.id, dto.currentPassword, dto.code);
  }

  /**
   * Confirm the authenticator reset with a code from the newly added device,
   * promoting the pending secret to the active one.
   */
  @Post('totp')
  @HttpCode(200)
  async confirmTotpReset(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: ConfirmResetTotpDto,
  ) {
    await this.auth.confirmTotpReset(current.id, dto.code);
    return { ok: true };
  }

  // --- Bring-your-own storage ----------------------------------------------

  /**
   * Current storage configuration for the account (secrets stripped). Used by
   * the dashboard to prefill the change form and decide whether to nudge the
   * user to connect a provider.
   */
  @Get('storage')
  async getStorage(@CurrentUser() user: AuthenticatedUser) {
    const dbUser = await this.users.findByUsername(user.username);
    const base = {
      enabled: this.app.userStorageEnabled,
      configured: Boolean(dbUser?.storageConfig),
      contactEmail: this.app.pricing.contactEmail || '',
      quotaGb: this.bytesToGb(this.userQuotaBytes(dbUser ?? null)),
      // Whether the managed (app-hosted S3) option may be offered to this user.
      managedAvailable: this.app.managedStorageAvailable,
    };
    if (!dbUser?.storageConfig) {
      return { ...base, driver: null };
    }
    let cfg: UserStorageConfig;
    try {
      cfg = JSON.parse(dbUser.storageConfig) as UserStorageConfig;
    } catch {
      return { ...base, driver: null };
    }
    if (cfg.driver === 'managed') {
      return { ...base, driver: 'managed' as const };
    }
    if (cfg.driver === 's3') {
      const { secretAccessKey, ...rest } = cfg.s3;
      return {
        ...base,
        driver: 's3' as const,
        s3: { ...rest, hasSecret: Boolean(secretAccessKey) },
      };
    }
    const { password, ...rest } = cfg.webdav;
    return {
      ...base,
      driver: 'webdav' as const,
      webdav: { ...rest, hasPassword: Boolean(password) },
    };
  }

  /**
   * Test a set of storage credentials by round-tripping a marker object.
   * Returns `{ ok: true }` or `{ ok: false, code }` (a {@link StorageErrorCode})
   * — never throws on a connection failure so the UI can show a clear message.
   */
  @Post('storage/test')
  @HttpCode(200)
  async testStorage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StorageConfigDto,
  ) {
    this.assertManagedAllowed(dto);
    const dbUser = await this.users.findByUsername(user.username);
    if (!dbUser) {
      throw new UnauthorizedException('Account no longer exists.');
    }
    return this.probe(
      dbUser,
      this.mergeSecrets(dbUser, this.toUserConfig(dto)),
    );
  }

  /**
   * Save (and first re-test) the account's storage credentials and self-set
   * quota. On a failed connection the credentials are NOT persisted and the
   * mapped error code is returned.
   */
  @Put('storage')
  @HttpCode(200)
  async saveStorage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StorageConfigDto,
  ) {
    this.assertManagedAllowed(dto);
    const dbUser = await this.users.findByUsername(user.username);
    if (!dbUser) {
      throw new UnauthorizedException('Account no longer exists.');
    }
    const cfg = this.mergeSecrets(dbUser, this.toUserConfig(dto));
    const result = await this.probe(dbUser, cfg);
    if (!result.ok) {
      return result;
    }
    // Managed storage is billed/quota-limited by the plan tier, so a self-set
    // cap does not apply — the entitlement decides the quota. Own storage keeps
    // the user's optional self-imposed cap.
    const quotaBytes =
      cfg.driver === 'managed'
        ? null
        : dto.quotaGb && dto.quotaGb > 0
          ? Math.round(dto.quotaGb * GIB)
          : null;
    await this.users.setStorageConfig(
      dbUser,
      cfg.driver,
      JSON.stringify(cfg),
      quotaBytes,
    );
    this.storageResolver.invalidate(dbUser.storageId);
    return { ok: true };
  }

  /** Map the validated DTO into the internal {@link UserStorageConfig}. */
  private toUserConfig(dto: StorageConfigDto): UserStorageConfig {
    if (dto.driver === 'managed') {
      return { driver: 'managed' };
    }
    if (dto.driver === 's3') {
      const s = dto.s3!;
      return {
        driver: 's3',
        s3: {
          endpoint: s.endpoint,
          region: s.region,
          bucket: s.bucket,
          accessKeyId: s.accessKeyId,
          secretAccessKey: s.secretAccessKey,
          forcePathStyle: s.forcePathStyle ?? true,
          prefix: s.prefix,
        },
      };
    }
    const w = dto.webdav!;
    return {
      driver: 'webdav',
      webdav: {
        url: w.url,
        username: w.username ?? '',
        password: w.password ?? '',
        authType: w.authType ?? 'auto',
        basePath: w.basePath,
      },
    };
  }

  /**
   * Carry over the stored secret when the user submits the change form without
   * re-typing it (the GET endpoint never returns secrets, so a blank field on a
   * same-driver edit means "keep the existing one").
   */
  private mergeSecrets(user: User, cfg: UserStorageConfig): UserStorageConfig {
    if (!user.storageConfig) {
      return cfg;
    }
    let existing: UserStorageConfig;
    try {
      existing = JSON.parse(user.storageConfig) as UserStorageConfig;
    } catch {
      return cfg;
    }
    if (
      cfg.driver === 's3' &&
      existing.driver === 's3' &&
      !cfg.s3.secretAccessKey
    ) {
      cfg.s3.secretAccessKey = existing.s3.secretAccessKey;
    }
    if (
      cfg.driver === 'webdav' &&
      existing.driver === 'webdav' &&
      !cfg.webdav.password
    ) {
      cfg.webdav.password = existing.webdav.password;
    }
    return cfg;
  }

  private async probe(
    user: User,
    cfg: UserStorageConfig,
  ): Promise<{ ok: boolean; code?: string }> {
    try {
      // Managed users have no own credentials — probe the app's global backend.
      const provider =
        cfg.driver === 'managed'
          ? this.storageResolver.globalStorageProvider
          : buildUserProvider(cfg);
      await probeProvider(provider, user.storageId);
      return { ok: true };
    } catch (err) {
      // A rejected URL (SSRF guard) is a client error — surface it as a clear
      // 400 rather than folding it into a generic connection-failure code.
      if (err instanceof HttpException) {
        throw err;
      }
      return { ok: false, code: mapStorageError(err) };
    }
  }

  /**
   * Reject a managed selection when the operator has not enabled it (no global
   * S3 backend). Guards both the test and save endpoints.
   */
  private assertManagedAllowed(dto: StorageConfigDto): void {
    if (dto.driver === 'managed' && !this.app.managedStorageAvailable) {
      throw new BadRequestException(
        'Managed storage is not available on this instance.',
      );
    }
  }

  /** Bytes → whole-or-fractional GB for display. 0 stays 0 (unlimited). */
  private bytesToGb(bytes: number): number {
    return bytes > 0 ? Math.round((bytes / GIB) * 100) / 100 : 0;
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

    // Delete vault data first; if that fails we keep the account intact. In
    // bring-your-own-storage mode there is nothing on our side to delete when no
    // provider was ever connected, so skip the (failing) storage call.
    if (!this.app.userStorageEnabled || user.storageConfig) {
      await this.vault.deleteUserData(user.username);
    }
    await this.users.remove(user);

    res.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  }
}
