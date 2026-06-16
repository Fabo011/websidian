import { isAbsolute, join, resolve } from 'path';

export type DatabaseType = 'sqlite' | 'postgres';
export type StorageDriver = 'local' | 's3';

/** The storage plans a user can be on. */
export type PlanTier = 'free' | 'plus5' | 'plus20';

const GIB = 1024 * 1024 * 1024;

/** Per-plan storage allowance in bytes. */
export interface TierConfig {
  free: number;
  plus5: number;
  plus20: number;
}

/** Stripe billing configuration (all values come from the environment). */
export interface StripeConfig {
  /** Whether the billing feature is switched on (drives tiers + dashboard UI). */
  enabled: boolean;
  /** Whether Stripe is fully configured so checkout actually works. */
  ready: boolean;
  secretKey: string;
  /** Recurring (annual) price IDs for each paid plan. */
  priceId5gb: string;
  priceId20gb: string;
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

export interface AppConfig {
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  dataRoot: string;
  allowRegistration: boolean;
  cookieSecure: boolean;
  /**
   * Allowed CORS origins. Cross-origin browser requests are only accepted from
   * these origins. Empty means "same-origin only" (CORS is left disabled).
   */
  corsOrigins: string[];
  /** Per-user storage quota in bytes. 0 means unlimited. */
  storageQuotaBytes: number;
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
  storage: { driver: StorageDriver; s3: S3Config };
  /** At-rest encryption of vault contents (AES-256-GCM in Node.js). */
  encryption: { enabled: boolean; key: string };
  /** Marketing/pricing copy surfaced on the public landing page. */
  pricing: PricingConfig;
}

/** Display-only pricing shown on the landing page (set via environment). */
export interface PricingConfig {
  /** Human-readable price for the 5 GB plan, e.g. "€42 / year". */
  price5gb: string;
  /** Human-readable price for the 20 GB plan, e.g. "€72 / year". */
  price20gb: string;
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
  return v === 's3' ? 's3' : 'local';
}

export default (): { app: AppConfig } => {
  const rawDataRoot = process.env.DATA_ROOT?.trim() || './data';
  const dataRoot = isAbsolute(rawDataRoot)
    ? rawDataRoot
    : resolve(process.cwd(), rawDataRoot);

  // Quota: STORAGE_QUOTA_GB (default 8). 0 (or empty) means unlimited.
  const quotaGb = parseNumber(process.env.STORAGE_QUOTA_GB, 8);
  const storageQuotaBytes =
    quotaGb <= 0 ? 0 : Math.round(quotaGb * 1024 * 1024 * 1024);

  // Billing can be switched off entirely (self-hosting). The feature flag
  // (BILLING_ENABLED) drives the tier structure and dashboard UI. Defaults to
  // on only when a Stripe secret key is present. When billing is off,
  // STORAGE_QUOTA_GB is the allowance every account gets (free == max vault).
  const hasStripeSecret = Boolean(process.env.STRIPE_SECRET_KEY?.trim());
  const billingEnabled = parseBool(
    process.env.BILLING_ENABLED,
    hasStripeSecret,
  );

  // Public base URL of this app, used for redirects and as the default CORS
  // origin when CORS_ORIGINS is not explicitly set.
  const appUrl = (
    process.env.APP_URL?.trim() || 'http://localhost:3065'
  ).replace(/\/+$/, '');

  // Allowed cross-origin browser origins. Defaults to the app's own URL so
  // only this domain can call the backend from a browser.
  const corsOrigins = parseList(process.env.CORS_ORIGINS);
  const resolvedCorsOrigins = corsOrigins.length > 0 ? corsOrigins : [appUrl];

  return {
    app: {
      port: parseInt(process.env.PORT ?? '3065', 10),
      jwtSecret:
        process.env.JWT_SECRET?.trim() || 'insecure-dev-secret-change-me',
      jwtExpiresIn: process.env.JWT_EXPIRES_IN?.trim() || '7d',
      dataRoot,
      allowRegistration: parseBool(process.env.ALLOW_REGISTRATION, true),
      cookieSecure: parseBool(process.env.COOKIE_SECURE, false),
      corsOrigins: resolvedCorsOrigins,
      storageQuotaBytes,
      trashRetentionDays: parseNumber(process.env.TRASH_RETENTION_DAYS, 7),
      tiers: {
        // With billing on, the free tier is a fixed 1 GB and STORAGE_QUOTA_GB
        // is ignored for the free plan. With billing off, every account gets
        // STORAGE_QUOTA_GB (0 == unlimited).
        free: billingEnabled ? 1 * GIB : storageQuotaBytes,
        plus5: 5 * GIB,
        plus20: 20 * GIB,
      },
      stripe: {
        enabled: billingEnabled,
        ready: billingEnabled && hasStripeSecret,
        secretKey: process.env.STRIPE_SECRET_KEY?.trim() || '',
        priceId5gb: process.env.STRIPE_PRICE_5GB?.trim() || '',
        priceId20gb: process.env.STRIPE_PRICE_20GB?.trim() || '',
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
      storage: {
        driver: parseStorageDriver(process.env.STORAGE_DRIVER),
        s3: {
          endpoint: process.env.S3_ENDPOINT?.trim() || '',
          region: process.env.S3_REGION?.trim() || 'us-east-1',
          bucket: process.env.S3_BUCKET?.trim() || '',
          accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() || '',
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
          forcePathStyle: parseBool(process.env.S3_FORCE_PATH_STYLE, true),
          prefix: (process.env.S3_PREFIX?.trim() || '').replace(
            /^\/+|\/+$/g,
            '',
          ),
        },
      },
      pricing: {
        price5gb: process.env.PRICE_5GB?.trim() || '',
        price20gb: process.env.PRICE_20GB?.trim() || '',
        contactEmail: process.env.CONTACT_EMAIL?.trim() || '',
      },
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
