import { isAbsolute, join, resolve } from 'path';

export type DatabaseType = 'sqlite' | 'postgres';
export type StorageDriver = 'local' | 's3';

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
  /** Per-user storage quota in bytes. 0 means unlimited. */
  storageQuotaBytes: number;
  database: { type: DatabaseType; postgres: PostgresConfig };
  storage: { driver: StorageDriver; s3: S3Config };
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

  return {
    app: {
      port: parseInt(process.env.PORT ?? '3065', 10),
      jwtSecret:
        process.env.JWT_SECRET?.trim() || 'insecure-dev-secret-change-me',
      jwtExpiresIn: process.env.JWT_EXPIRES_IN?.trim() || '7d',
      dataRoot,
      allowRegistration: parseBool(process.env.ALLOW_REGISTRATION, true),
      cookieSecure: parseBool(process.env.COOKIE_SECURE, false),
      storageQuotaBytes,
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
    },
  };
};

/** Absolute path to the sqlite database file. */
export function databaseFile(dataRoot: string): string {
  return join(dataRoot, 'app.db');
}
