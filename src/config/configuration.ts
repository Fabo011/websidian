import { isAbsolute, join, resolve } from 'path';

const DRIVERS = ['local', 's3', 'webdav'] as const;
const WEBDAV_AUTH_TYPES = ['auto', 'password', 'digest', 'none'] as const;

export type DatabaseType = 'sqlite' | 'postgres';
export type StorageDriver = typeof DRIVERS[number];

/**
 * The storage plans a user can be on. There is a single paid tier ("plus")
 * on top of the free allowance. Its size and price are configurable via the
 * environment (STORAGE_PLUS_GB / PRICE_PLUS).
 */
export type PlanTier = 'free' | 'plus';

const GIB = 1024 * 1024 * 1024;

/** Per-plan storage allowance in bytes. */
export interface TierConfig {
  free: number;
  plus: number;
}

/** Stripe billing configuration (all values come from the environment). */
export interface StripeConfig {
  /** Whether the billing feature is switched on (drives tiers + dashboard UI). */
  enabled: boolean;
  /** Whether Stripe is fully configured so checkout actually works. */
  ready: boolean;
  secretKey: string;
  /** Recurring (annual) price id for the single paid plan. */
  priceIdPlus: string;
  /** Absolute base URL of this app, used to build redirect URLs. */
  appUrl: string;
}

export interface PostgresConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  ssl: boolean;
}

export type StorageConfig = 
  | { driver: 'local' } 
  | { driver: 's3'; s3: S3Config }
  | { driver: 'webdav'; webdav: WebdavConfig };

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Use path-style addressing (required by MinIO and some S3-compatibles). */
  forcePathStyle: boolean;
  /** Optional key prefix so multiple apps can share one bucket. */
  prefix: string;
}

/** WebDAV auth scheme, mirrors the lib's AuthType (token/ha1 left out for now). */
export type WebdavAuthType = 'auto' | 'password' | 'digest' | 'none';

export interface WebdavConfig {
  /** Server base URL — passed as createClient(remoteURL). */
  url: string;
  /** Basic/Digest username. Empty = unauthenticated connection. */
  username: string;
  /** Basic/Digest password. */
  password: string;
  /**
   * Authentication scheme. The client auto-detects None vs Password when
   * 'auto'; 'digest' must be explicit. Maps to the lib's AuthType.
   */
  authType: WebdavAuthType;
  /**
   * Optional path prefix under the server root for namespacing, so multiple
   * apps can share one WebDAV account. Analogous to S3Config.prefix.
   */
  basePath: string;
}

export interface AppConfig {
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  dataRoot: string;
  allowRegistration: boolean;
  /**
   * Maximum number of registered users. 0 means unlimited.
   * Set MAX_REGISTRATIONS to cap sign-ups while the server is still small;
   * raise it or leave it unset as capacity grows.
   */
  maxRegistrations: number;
  cookieSecure: boolean;
  /**
   * Allowed CORS origins. Cross-origin browser requests are only accepted from
   * these origins. Empty means "same-origin only" (CORS is left disabled).
   */
  corsOrigins: string[];
  /** Per-user storage quota in bytes. 0 means unlimited. */
  storageQuotaBytes: number;
  /**
   * Usernames (lowercased) granted the top ("plus") storage tier for free,
   * configured via the PRIVILEGED_USERS env var (comma-separated). These are
   * unioned with the privileged_users DB table. Members are excluded from
   * billing and never see the upgrade button.
   */
  privilegedUsers: string[];
  /**
   * Storage allowance in bytes for privileged users, independent of the free
   * and paid tiers. Configured via STORAGE_PRIVILEGED_USERS_GB (default 20 GB).
   */
  privilegedQuotaBytes: number;
  /**
   * Maximum accepted request body size in megabytes (JSON + urlencoded). This
   * caps the size of a single uploaded file/note since vault content is sent as
   * a base64 JSON payload. Configurable via MAX_UPLOAD_SIZE_MB.
   */
  maxUploadSizeMb: number;
  /**
   * Days a deleted item stays in the per-user trash before it is permanently
   * removed by the purge cron. 0 (or less) disables soft-delete so deletions
   * are immediate.
   */
  trashRetentionDays: number;
  /** Storage allowance for each plan tier. */
  tiers: TierConfig;
  /** Stripe billing settings. */
  stripe: StripeConfig;
  database: { type: DatabaseType; postgres: PostgresConfig };
  storage: StorageConfig;
  /** At-rest encryption of vault contents (AES-256-GCM in Node.js). */
  encryption: { enabled: boolean; key: string };
  /**
   * Auth-endpoint rate limiting (`/auth/*`: login, register, 2fa). Throttles
   * credential-guessing / enumeration attempts. Enabled by default.
   */
  rateLimit: RateLimitConfig;
  /**
   * Dashboard data-API rate limiting (`/api/*`: protects storage/S3 from abuse
   * + reload storms). Disabled by default.
   */
  rateLimitDash: RateLimitConfig;
  /**
   * How long (ms) the server caches a user's flat file list to answer repeated
   * name searches without re-listing the whole vault from storage. 0 disables
   * the cache. Configured via SEARCH_CACHE_TTL_MS.
   */
  searchCacheTtlMs: number;
  /**
   * How long (ms) the client reuses an already-built wikilink graph before
   * rebuilding it from the vault. Lets the user open a note from the graph and
   * return without the whole graph reloading. 0 disables the cache (every open
   * rebuilds). Configured via GRAPH_CACHE_TTL_MS.
   */
  graphCacheTtlMs: number;
  /**
   * Maximum number of file tabs the client keeps open at once. Opening more is
   * refused until a tab is closed. Open tabs are held in the browser's memory so
   * switching between them does not refetch/re-decrypt. Configured via
   * MAX_OPEN_TABS. Default 8.
   */
  maxOpenTabs: number;
  /** Marketing/pricing copy surfaced on the public landing page. */
  pricing: PricingConfig;
  /** Whether the AGB (terms) page and its footer link are shown. */
  agbEnabled: boolean;
  /** Whether the Imprint page and its footer link are shown. */
  imprintEnabled: boolean;
  /** Whether the Privacy policy page and its footer link are shown. */
  privacyEnabled: boolean;
}

/**
 * Per-user (or per-IP for anonymous callers) rate limit. Two independent
 * instances exist: one for the auth endpoints (`/auth/*`) and one for the
 * dashboard data API (`/api/*`). Keys per-user so one abusive client cannot
 * lock out everyone behind a NAT.
 */
export interface RateLimitConfig {
  /** Whether the limiter is active. */
  enabled: boolean;
  /** Length of the rolling window in milliseconds. */
  windowMs: number;
  /** Maximum allowed requests per window, per user/IP. */
  max: number;
}

/** Display-only pricing shown on the landing page (set via environment). */
export interface PricingConfig {
  /**
   * Human-readable suggested donation for the paid plan, e.g. "€10 / year".
   * Framed as a voluntary contribution towards storage/server costs, not a
   * commercial price (the project is non-profit).
   */
  pricePlus: string;
  /** Storage size of the paid plan, in whole GB (set via STORAGE_PLUS_GB). */
  planGb: number;
  /** Contact address shown for custom / larger storage requests. */
  contactEmail: string;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a comma-separated list into trimmed, non-empty entries. */
function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((v) => v.trim().replace(/\/+$/, ''))
    .filter((v) => v.length > 0);
}

function parseDatabaseType(value: string | undefined): DatabaseType {
  const v = (value ?? 'sqlite').trim().toLowerCase();
  if (v === 'postgres' || v === 'postgresql' || v === 'pg') {
    return 'postgres';
  }
  return 'sqlite';
}

function parseStorageDriver(value: string | undefined): StorageDriver {
  const v = (value ?? 'local').trim().toLowerCase();
  return (DRIVERS as readonly string[]).includes(v)
    ? (v as StorageDriver)
    : 'local';
}

function parseWebdavAuthType(value: string | undefined): WebdavAuthType {
  const v = (value ?? 'auto').trim().toLowerCase();
  return (WEBDAV_AUTH_TYPES as readonly string[]).includes(v)
    ? (v as WebdavAuthType)
    : 'auto';
}

/** Strip leading/trailing slashes from a path prefix (S3 prefix / WebDAV base). */
function trimPrefix(value: string | undefined): string {
  return (value?.trim() || '').replace(/^\/+|\/+$/g, '');
}

/**
 * Build the active storage configuration as a discriminated union keyed on the
 * driver. Only the selected driver's settings are read from the environment, so
 * e.g. an S3 deployment never needs WEBDAV_* set and vice versa.
 */
function buildStorageConfig(driver: StorageDriver): StorageConfig {
  if (driver === 's3') {
    return {
      driver,
      s3: {
        endpoint: process.env.S3_ENDPOINT?.trim() || '',
        region: process.env.S3_REGION?.trim() || 'us-east-1',
        bucket: process.env.S3_BUCKET?.trim() || '',
        accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
        forcePathStyle: parseBool(process.env.S3_FORCE_PATH_STYLE, true),
        prefix: trimPrefix(process.env.S3_PREFIX),
      },
    };
  }
  if (driver === 'webdav') {
    return {
      driver,
      webdav: {
        url: process.env.WEBDAV_URL?.trim() || '',
        username: process.env.WEBDAV_USERNAME?.trim() || '',
        password: process.env.WEBDAV_PASSWORD ?? '',
        authType: parseWebdavAuthType(process.env.WEBDAV_AUTH_TYPE),
        basePath: trimPrefix(process.env.WEBDAV_BASE_PATH),
      },
    };
  }
  return { driver: 'local' };
}

export default (): { app: AppConfig } => {
  const rawDataRoot = process.env.DATA_ROOT?.trim() || './data';
  const dataRoot = isAbsolute(rawDataRoot)
    ? rawDataRoot
    : resolve(process.cwd(), rawDataRoot);

  // Quota: STORAGE_QUOTA_GB (default 8). 0 (or empty) means unlimited.
  // Fractional values are allowed, e.g. 0.5 = 512 MB, 0.8 ≈ 819 MB.
  const quotaGb = parseNumber(process.env.STORAGE_QUOTA_GB, 8);
  const storageQuotaBytes =
    quotaGb <= 0 ? 0 : Math.round(quotaGb * 1024 * 1024 * 1024);
  // Whether STORAGE_QUOTA_GB was explicitly provided. When set it also defines
  // the free tier under billing (otherwise the free tier defaults to 1 GB).
  const quotaEnvSet = (process.env.STORAGE_QUOTA_GB ?? '').trim() !== '';

  // Legal pages are opt-in: each is hidden unless its flag is explicitly turned
  // on. When a page is disabled, its route redirects home and the footer link
  // is hidden.
  //   AGB=true           -> AGB (terms) page
  //   IMPRINT=true       -> Imprint page
  //   LEGAL_NOTICE=true  -> Privacy policy page
  const agbEnabled = parseBool(process.env.AGB, false);
  const imprintEnabled = parseBool(process.env.IMPRINT, false);
  const privacyEnabled = parseBool(process.env.LEGAL_NOTICE, false);

  // Billing can be switched off entirely (self-hosting). The feature flag
  // (BILLING_ENABLED) drives the tier structure and dashboard UI. Defaults to
  // on only when a Stripe secret key is present. When billing is off,
  // STORAGE_QUOTA_GB is the allowance every account gets (free == max vault).
  const hasStripeSecret = Boolean(process.env.STRIPE_SECRET_KEY?.trim());
  const billingEnabled = parseBool(
    process.env.BILLING_ENABLED,
    hasStripeSecret,
  );

  // Single paid plan ("plus"): its size (GB) and suggested donation are
  // configurable. STORAGE_PLUS_GB defaults to 3 GB. The donation is a voluntary
  // contribution towards storage/server costs (non-profit), shown as-is.
  const planGb = Math.max(1, parseNumber(process.env.STORAGE_PLUS_GB, 3));
  const plusBytes = Math.round(planGb * GIB);

  // Public base URL of this app, used for redirects and as the default CORS
  // origin when CORS_ORIGINS is not explicitly set.
  const appUrl = (
    process.env.APP_URL?.trim() || 'http://localhost:3065'
  ).replace(/\/+$/, '');

  // Allowed cross-origin browser origins. Defaults to the app's own URL so
  // only this domain can call the backend from a browser.
  const corsOrigins = parseList(process.env.CORS_ORIGINS);
  const resolvedCorsOrigins = corsOrigins.length > 0 ? corsOrigins : [appUrl];

  const storageDriver = parseStorageDriver(process.env.STORAGE_DRIVER);

  return {
    app: {
      port: parseInt(process.env.PORT ?? '3065', 10),
      jwtSecret:
        process.env.JWT_SECRET?.trim() || 'insecure-dev-secret-change-me',
      jwtExpiresIn: process.env.JWT_EXPIRES_IN?.trim() || '7d',
      dataRoot,
      allowRegistration: parseBool(process.env.ALLOW_REGISTRATION, true),
      maxRegistrations: parseNumber(process.env.MAX_REGISTRATIONS, 0),
      cookieSecure: parseBool(process.env.COOKIE_SECURE, false),
      corsOrigins: resolvedCorsOrigins,
      storageQuotaBytes,
      privilegedUsers: parseList(process.env.PRIVILEGED_USERS).map((u) =>
        u.toLowerCase(),
      ),
      privilegedQuotaBytes: Math.round(
        Math.max(0, parseNumber(process.env.STORAGE_PRIVILEGED_USERS_GB, 20)) *
          GIB,
      ),
      maxUploadSizeMb: Math.max(
        1,
        parseNumber(process.env.MAX_UPLOAD_SIZE_MB, 25),
      ),
      trashRetentionDays: parseNumber(process.env.TRASH_RETENTION_DAYS, 7),
      tiers: {
        // Free tier allowance. With billing off, every account gets
        // STORAGE_QUOTA_GB (0 == unlimited). With billing on it defaults to a
        // fixed 1 GB, but an explicit STORAGE_QUOTA_GB still overrides it so the
        // operator can offer a smaller (or larger) free plan, e.g. 0.5 GB.
        free: quotaEnvSet
          ? storageQuotaBytes
          : billingEnabled
            ? 1 * GIB
            : storageQuotaBytes,
        plus: plusBytes,
      },
      stripe: {
        enabled: billingEnabled,
        ready: billingEnabled && hasStripeSecret,
        secretKey: process.env.STRIPE_SECRET_KEY?.trim() || '',
        priceIdPlus:
          process.env.STRIPE_PRICE_PLUS?.trim() ||
          process.env.STRIPE_PRICE_5GB?.trim() ||
          '',
        appUrl,
      },
      database: {
        type: parseDatabaseType(process.env.DB_TYPE),
        postgres: {
          host: process.env.DB_HOST?.trim() || 'localhost',
          port: parseInt(process.env.DB_PORT ?? '5432', 10),
          username: process.env.DB_USERNAME?.trim() || 'postgres',
          password: process.env.DB_PASSWORD ?? '',
          database: process.env.DB_DATABASE?.trim() || 'web_obsidian',
          ssl: parseBool(process.env.DB_SSL, false),
        },
      },
      encryption: {
        enabled: parseBool(process.env.ENCRYPTION_ENABLED, true),
        key: process.env.ENCRYPTION_KEY?.trim() || '',
      },
      storage: buildStorageConfig(storageDriver),
      rateLimit: {
        enabled: parseBool(process.env.RATE_LIMIT_ENABLED, true),
        // Window length in seconds (default 60s = "per minute").
        windowMs:
          Math.max(1, parseNumber(process.env.RATE_LIMIT_WINDOW_SECONDS, 60)) *
          1000,
        // Max requests per window, per user (default 60/min ≈ 1 req/sec).
        max: Math.max(1, parseNumber(process.env.RATE_LIMIT_MAX, 60)),
      },
      rateLimitDash: {
        // Disabled by default; opt in via RATE_LIMIT_DASH_ENABLED.
        enabled: parseBool(process.env.RATE_LIMIT_DASH_ENABLED, false),
        // Window length in seconds (default 60s = "per minute").
        windowMs:
          Math.max(
            1,
            parseNumber(process.env.RATE_LIMIT_DASH_WINDOW_SECONDS, 60),
          ) * 1000,
        // Max requests per window, per user (default 60/min ≈ 1 req/sec).
        max: Math.max(1, parseNumber(process.env.RATE_LIMIT_DASH_MAX, 60)),
      },
      // Server-side flat file-list cache TTL for name search. Default 15s; set
      // to 0 to disable (every search re-lists the vault from storage).
      searchCacheTtlMs: Math.max(
        0,
        parseNumber(process.env.SEARCH_CACHE_TTL_MS, 15000),
      ),
      // Client-side wikilink-graph reuse window. Default 5 min; set to 0 to
      // rebuild on every open.
      graphCacheTtlMs: Math.max(
        0,
        parseNumber(process.env.GRAPH_CACHE_TTL_MS, 300000),
      ),
      // Max file tabs the client keeps open at once. Default 8; floor of 1.
      maxOpenTabs: Math.max(1, parseNumber(process.env.MAX_OPEN_TABS, 8)),
      pricing: {
        pricePlus:
          process.env.PRICE_PLUS?.trim() || process.env.PRICE_5GB?.trim() || '',
        planGb,
        contactEmail: process.env.CONTACT_EMAIL?.trim() || '',
      },
      agbEnabled,
      imprintEnabled,
      privacyEnabled,
    },
  };
};

/** Absolute path to the sqlite database file. */
export function databaseFile(dataRoot: string): string {
  return join(dataRoot, 'app.db');
}

/** Resolve the storage allowance (bytes) for a plan tier. */
export function bytesForTier(tiers: TierConfig, tier: PlanTier): number {
  return tiers[tier] ?? tiers.free;
}
