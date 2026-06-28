import {
  S3Config,
  WebdavAuthType,
  WebdavConfig,
} from '../config/configuration';
import { S3StorageProvider } from './s3-storage.provider';
import { StorageProvider } from './storage.interface';
import { WebdavStorageProvider } from './webdav-storage.provider';

/** Storage drivers a user can bring themselves. */
export type UserStorageDriver = 's3' | 'webdav';

/** S3 credentials as entered/stored for a single user. */
export interface UserS3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

/** WebDAV credentials as entered/stored for a single user. */
export interface UserWebdavConfig {
  url: string;
  username: string;
  password: string;
  authType?: WebdavAuthType;
  basePath?: string;
}

/**
 * A user's saved storage configuration — the decrypted shape of the
 * `User.storageConfig` JSON column. Discriminated on the driver so only the
 * relevant credentials are present.
 */
export type UserStorageConfig =
  | { driver: 's3'; s3: UserS3Config }
  | { driver: 'webdav'; webdav: UserWebdavConfig };

/** Strip leading/trailing slashes from a path prefix. */
function trimPrefix(value: string | undefined): string {
  return (value?.trim() || '').replace(/^\/+|\/+$/g, '');
}

/** Fill a user S3 config into the full {@link S3Config} the provider expects. */
function normalizeS3(c: UserS3Config): S3Config {
  return {
    endpoint: c.endpoint?.trim() || '',
    region: c.region?.trim() || 'us-east-1',
    bucket: c.bucket?.trim() || '',
    accessKeyId: c.accessKeyId?.trim() || '',
    secretAccessKey: c.secretAccessKey ?? '',
    forcePathStyle: c.forcePathStyle ?? true,
    prefix: trimPrefix(c.prefix),
  };
}

/** Fill a user WebDAV config into the full {@link WebdavConfig}. */
function normalizeWebdav(c: UserWebdavConfig): WebdavConfig {
  return {
    url: c.url?.trim() || '',
    username: c.username?.trim() || '',
    password: c.password ?? '',
    authType: c.authType ?? 'auto',
    basePath: trimPrefix(c.basePath),
  };
}

/** Build a live {@link StorageProvider} from a user's saved configuration. */
export function buildUserProvider(cfg: UserStorageConfig): StorageProvider {
  if (cfg.driver === 's3') {
    return new S3StorageProvider(normalizeS3(cfg.s3));
  }
  return new WebdavStorageProvider(normalizeWebdav(cfg.webdav));
}

/**
 * Stable, i18n-friendly codes describing why a storage connection failed. The
 * client maps each to a localized message (see public/js/i18n.js) and appends
 * the support contact.
 */
export type StorageErrorCode =
  | 'auth'
  | 'unreachable'
  | 'notfound'
  | 'tls'
  | 'config'
  | 'unknown';

/** Classify a connection error into a short, user-facing {@link StorageErrorCode}. */
export function mapStorageError(err: unknown): StorageErrorCode {
  const e = err as {
    name?: string;
    code?: string;
    status?: number;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = e?.status ?? e?.$metadata?.httpStatusCode;
  const code = (e?.code || '').toUpperCase();
  const name = e?.name || '';
  const msg = (e?.message || '').toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    name === 'AccessDenied' ||
    code === 'ACCESSDENIED' ||
    /invalidaccesskey|signaturedoesnotmatch/.test(msg)
  ) {
    return 'auth';
  }
  if (
    status === 404 ||
    name === 'NoSuchBucket' ||
    /nosuchbucket|not\s*found/.test(msg)
  ) {
    return 'notfound';
  }
  if (
    /cert|tls|ssl/.test(code.toLowerCase()) ||
    /cert|self.signed|tls|ssl/.test(msg)
  ) {
    return 'tls';
  }
  if (
    [
      'ENOTFOUND',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ECONNRESET',
      'EHOSTUNREACH',
    ].includes(code) ||
    /timeout|network|getaddrinfo|econnrefused/.test(msg)
  ) {
    return 'unreachable';
  }
  return 'unknown';
}

/** Marker object written then removed to prove a storage backend is reachable. */
const CONNTEST_FILE = '.wo-conntest';

/**
 * Round-trip a tiny object through a freshly built provider to confirm the
 * credentials work end to end (namespace create + write + read-back + delete).
 * Throws the underlying error on failure so the caller can {@link mapStorageError}.
 */
export async function probeProvider(
  provider: StorageProvider,
  storageId: string,
): Promise<void> {
  await provider.ensureUser(storageId);
  const payload = Buffer.from(`websidian connection test ${Date.now()}`);
  await provider.writeBytes(storageId, CONNTEST_FILE, payload);
  try {
    await provider.readBytes(storageId, CONNTEST_FILE);
  } finally {
    await provider.remove(storageId, CONNTEST_FILE).catch(() => {});
  }
}
