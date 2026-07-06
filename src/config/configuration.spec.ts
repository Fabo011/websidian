import { resolve } from 'path';
import configuration, { bytesForTier, databaseFile } from './configuration';

const GIB = 1024 * 1024 * 1024;

/**
 * The configuration factory reads process.env at call time, so each test sets
 * only the variables it cares about and the suite restores the original
 * environment afterwards.
 */
describe('configuration', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    // Clear every variable the factory reads so tests start from defaults.
    for (const key of [
      'PORT',
      'JWT_SECRET',
      'JWT_EXPIRES_IN',
      'DATA_ROOT',
      'ALLOW_REGISTRATION',
      'MAX_REGISTRATIONS',
      'COOKIE_SECURE',
      'CORS_ORIGINS',
      'APP_URL',
      'STORAGE_QUOTA_GB',
      'PRIVILEGED_USERS',
      'STORAGE_PRIVILEGED_USERS_GB',
      'MAX_UPLOAD_SIZE_MB',
      'TRASH_RETENTION_DAYS',
      'STORAGE_PLUS_GB',
      'PRICE_PLUS',
      'PRICE_5GB',
      'STRIPE_SECRET_KEY',
      'STRIPE_PRICE_PLUS',
      'STRIPE_PRICE_5GB',
      'BILLING_ENABLED',
      'DB_TYPE',
      'DB_HOST',
      'DB_PORT',
      'DB_USERNAME',
      'DB_PASSWORD',
      'DB_DATABASE',
      'DB_SSL',
      'ENCRYPTION_ENABLED',
      'ENCRYPTION_KEY',
      'STORAGE_DRIVER',
      'USER_STORAGE_ENABLED',
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_FORCE_PATH_STYLE',
      'S3_PREFIX',
      'WEBDAV_URL',
      'WEBDAV_USERNAME',
      'WEBDAV_PASSWORD',
      'WEBDAV_AUTH_TYPE',
      'WEBDAV_BASE_PATH',
      'RATE_LIMIT_ENABLED',
      'RATE_LIMIT_WINDOW_SECONDS',
      'RATE_LIMIT_MAX',
      'RATE_LIMIT_DASH_ENABLED',
      'RATE_LIMIT_DASH_WINDOW_SECONDS',
      'RATE_LIMIT_DASH_MAX',
      'SEARCH_CACHE_TTL_MS',
      'GRAPH_CACHE_TTL_MS',
      'MAX_OPEN_TABS',
      'CONTACT_EMAIL',
      'DONATION_LINK',
      'AGB',
      'IMPRINT',
      'LEGAL_NOTICE',
    ]) {
      delete process.env[key];
    }
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('defaults', () => {
    it('produces sane defaults with an empty environment', () => {
      const { app } = configuration();
      expect(app.port).toBe(3065);
      expect(app.jwtSecret).toBe('insecure-dev-secret-change-me');
      expect(app.jwtExpiresIn).toBe('7d');
      expect(app.allowRegistration).toBe(true);
      expect(app.maxRegistrations).toBe(0);
      expect(app.cookieSecure).toBe(false);
      expect(app.storageQuotaBytes).toBe(8 * GIB);
      expect(app.privilegedUsers).toEqual([]);
      expect(app.privilegedQuotaBytes).toBe(20 * GIB);
      expect(app.maxUploadSizeMb).toBe(25);
      expect(app.trashRetentionDays).toBe(7);
      expect(app.database.type).toBe('sqlite');
      expect(app.storage).toEqual({ driver: 'local' });
      expect(app.userStorageEnabled).toBe(false);
      expect(app.managedStorageAvailable).toBe(false);
      expect(app.encryption.enabled).toBe(true);
      expect(app.encryption.key).toBe('');
      expect(app.rateLimit).toEqual({
        enabled: true,
        windowMs: 60_000,
        max: 60,
      });
      expect(app.rateLimitDash).toEqual({
        enabled: false,
        windowMs: 60_000,
        max: 60,
      });
      expect(app.searchCacheTtlMs).toBe(15_000);
      expect(app.graphCacheTtlMs).toBe(300_000);
      expect(app.maxOpenTabs).toBe(8);
      expect(app.agbEnabled).toBe(false);
      expect(app.imprintEnabled).toBe(false);
      expect(app.privacyEnabled).toBe(false);
    });

    it('resolves a relative DATA_ROOT against cwd', () => {
      process.env.DATA_ROOT = './my-data';
      const { app } = configuration();
      expect(app.dataRoot).toBe(resolve(process.cwd(), './my-data'));
    });

    it('keeps an absolute DATA_ROOT unchanged', () => {
      process.env.DATA_ROOT = '/var/lib/websidian';
      const { app } = configuration();
      expect(app.dataRoot).toBe('/var/lib/websidian');
    });
  });

  describe('boolean parsing', () => {
    it.each(['1', 'true', 'yes', 'on', 'TRUE', ' Yes '])(
      'treats %j as true',
      (value) => {
        process.env.COOKIE_SECURE = value;
        expect(configuration().app.cookieSecure).toBe(true);
      },
    );

    it.each(['0', 'false', 'no', 'off', 'nonsense', ''])(
      'treats %j as false',
      (value) => {
        process.env.COOKIE_SECURE = value;
        expect(configuration().app.cookieSecure).toBe(false);
      },
    );
  });

  describe('number parsing', () => {
    it('falls back on non-numeric values', () => {
      process.env.MAX_REGISTRATIONS = 'many';
      expect(configuration().app.maxRegistrations).toBe(0);
    });

    it('parses valid numbers', () => {
      process.env.MAX_REGISTRATIONS = '42';
      expect(configuration().app.maxRegistrations).toBe(42);
    });

    it('falls back on empty string', () => {
      process.env.TRASH_RETENTION_DAYS = '  ';
      expect(configuration().app.trashRetentionDays).toBe(7);
    });
  });

  describe('quota and tiers', () => {
    it('treats STORAGE_QUOTA_GB=0 as unlimited', () => {
      process.env.STORAGE_QUOTA_GB = '0';
      expect(configuration().app.storageQuotaBytes).toBe(0);
    });

    it('supports fractional quotas', () => {
      process.env.STORAGE_QUOTA_GB = '0.5';
      expect(configuration().app.storageQuotaBytes).toBe(Math.round(0.5 * GIB));
    });

    it('defaults the free tier to the quota when billing is off', () => {
      const { app } = configuration();
      expect(app.tiers.free).toBe(8 * GIB);
    });

    it('defaults the free tier to 1 GiB when billing is on and no quota set', () => {
      process.env.BILLING_ENABLED = 'true';
      const { app } = configuration();
      expect(app.tiers.free).toBe(1 * GIB);
    });

    it('lets an explicit quota override the free tier under billing', () => {
      process.env.BILLING_ENABLED = 'true';
      process.env.STORAGE_QUOTA_GB = '0.5';
      const { app } = configuration();
      expect(app.tiers.free).toBe(Math.round(0.5 * GIB));
    });

    it('sizes the plus tier from STORAGE_PLUS_GB with a floor of 1', () => {
      process.env.STORAGE_PLUS_GB = '0';
      expect(configuration().app.tiers.plus).toBe(1 * GIB);
      process.env.STORAGE_PLUS_GB = '5';
      expect(configuration().app.tiers.plus).toBe(5 * GIB);
    });
  });

  describe('stripe / billing', () => {
    it('is disabled without a secret key', () => {
      const { app } = configuration();
      expect(app.stripe.enabled).toBe(false);
      expect(app.stripe.ready).toBe(false);
    });

    it('auto-enables when a secret key is present', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      const { app } = configuration();
      expect(app.stripe.enabled).toBe(true);
      expect(app.stripe.ready).toBe(true);
      expect(app.stripe.secretKey).toBe('sk_test_123');
    });

    it('can be enabled without a key (enabled but not ready)', () => {
      process.env.BILLING_ENABLED = 'true';
      const { app } = configuration();
      expect(app.stripe.enabled).toBe(true);
      expect(app.stripe.ready).toBe(false);
    });

    it('prefers STRIPE_PRICE_PLUS over the legacy STRIPE_PRICE_5GB', () => {
      process.env.STRIPE_PRICE_PLUS = 'price_new';
      process.env.STRIPE_PRICE_5GB = 'price_old';
      expect(configuration().app.stripe.priceIdPlus).toBe('price_new');
    });

    it('falls back to STRIPE_PRICE_5GB', () => {
      process.env.STRIPE_PRICE_5GB = 'price_old';
      expect(configuration().app.stripe.priceIdPlus).toBe('price_old');
    });

    it('strips trailing slashes from APP_URL', () => {
      process.env.APP_URL = 'https://example.com///';
      expect(configuration().app.stripe.appUrl).toBe('https://example.com');
    });
  });

  describe('CORS origins', () => {
    it('defaults to the app URL', () => {
      process.env.APP_URL = 'https://vault.example.com';
      expect(configuration().app.corsOrigins).toEqual([
        'https://vault.example.com',
      ]);
    });

    it('parses a comma-separated list and trims trailing slashes', () => {
      process.env.CORS_ORIGINS = 'https://a.com/, https://b.com , ,';
      expect(configuration().app.corsOrigins).toEqual([
        'https://a.com',
        'https://b.com',
      ]);
    });
  });

  describe('privileged users', () => {
    it('lowercases the configured usernames', () => {
      process.env.PRIVILEGED_USERS = 'Alice, BOB';
      expect(configuration().app.privilegedUsers).toEqual(['alice', 'bob']);
    });

    it('clamps a negative privileged quota to 0', () => {
      process.env.STORAGE_PRIVILEGED_USERS_GB = '-5';
      expect(configuration().app.privilegedQuotaBytes).toBe(0);
    });
  });

  describe('database', () => {
    it.each([
      ['postgres', 'postgres'],
      ['postgresql', 'postgres'],
      ['pg', 'postgres'],
      ['PG', 'postgres'],
      ['sqlite', 'sqlite'],
      ['weird', 'sqlite'],
    ])('maps DB_TYPE=%j to %j', (input, expected) => {
      process.env.DB_TYPE = input;
      expect(configuration().app.database.type).toBe(expected);
    });

    it('reads postgres connection settings', () => {
      process.env.DB_HOST = 'db.internal';
      process.env.DB_PORT = '15432';
      process.env.DB_USERNAME = 'app';
      process.env.DB_PASSWORD = 'pw';
      process.env.DB_DATABASE = 'vault';
      process.env.DB_SSL = 'true';
      expect(configuration().app.database.postgres).toEqual({
        host: 'db.internal',
        port: 15432,
        username: 'app',
        password: 'pw',
        database: 'vault',
        ssl: true,
      });
    });
  });

  describe('storage driver', () => {
    it('falls back to local on unknown drivers', () => {
      process.env.STORAGE_DRIVER = 'ftp';
      expect(configuration().app.storage).toEqual({ driver: 'local' });
    });

    it('builds the s3 config with prefix trimming', () => {
      process.env.STORAGE_DRIVER = 's3';
      process.env.S3_ENDPOINT = 'https://minio.local ';
      process.env.S3_BUCKET = 'vault';
      process.env.S3_ACCESS_KEY_ID = 'key';
      process.env.S3_SECRET_ACCESS_KEY = 'secret';
      process.env.S3_PREFIX = '/apps/websidian/';
      const { app } = configuration();
      expect(app.storage).toEqual({
        driver: 's3',
        s3: {
          endpoint: 'https://minio.local',
          region: 'us-east-1',
          bucket: 'vault',
          accessKeyId: 'key',
          secretAccessKey: 'secret',
          forcePathStyle: true,
          prefix: 'apps/websidian',
        },
      });
    });

    it('builds the webdav config with auth type validation', () => {
      process.env.STORAGE_DRIVER = 'webdav';
      process.env.WEBDAV_URL = 'https://dav.example.com';
      process.env.WEBDAV_USERNAME = 'user';
      process.env.WEBDAV_PASSWORD = 'pw';
      process.env.WEBDAV_AUTH_TYPE = 'digest';
      process.env.WEBDAV_BASE_PATH = '/websidian/';
      const { app } = configuration();
      expect(app.storage).toEqual({
        driver: 'webdav',
        webdav: {
          url: 'https://dav.example.com',
          username: 'user',
          password: 'pw',
          authType: 'digest',
          basePath: 'websidian',
        },
      });
    });

    it('falls back to auto for unknown webdav auth types', () => {
      process.env.STORAGE_DRIVER = 'webdav';
      process.env.WEBDAV_AUTH_TYPE = 'kerberos';
      const { app } = configuration();
      expect(
        app.storage.driver === 'webdav' && app.storage.webdav.authType,
      ).toBe('auto');
    });

    it('offers managed storage only with user storage + s3 backend', () => {
      process.env.USER_STORAGE_ENABLED = 'true';
      process.env.STORAGE_DRIVER = 's3';
      expect(configuration().app.managedStorageAvailable).toBe(true);

      process.env.STORAGE_DRIVER = 'local';
      expect(configuration().app.managedStorageAvailable).toBe(false);

      process.env.USER_STORAGE_ENABLED = 'false';
      process.env.STORAGE_DRIVER = 's3';
      expect(configuration().app.managedStorageAvailable).toBe(false);
    });
  });

  describe('rate limits', () => {
    it('converts window seconds to milliseconds with a floor of 1s', () => {
      process.env.RATE_LIMIT_WINDOW_SECONDS = '0';
      process.env.RATE_LIMIT_MAX = '0';
      const { app } = configuration();
      expect(app.rateLimit.windowMs).toBe(1000);
      expect(app.rateLimit.max).toBe(1);
    });
  });

  describe('caches and tabs', () => {
    it('clamps negative TTLs to 0 and tabs to at least 1', () => {
      process.env.SEARCH_CACHE_TTL_MS = '-1';
      process.env.GRAPH_CACHE_TTL_MS = '-1';
      process.env.MAX_OPEN_TABS = '0';
      const { app } = configuration();
      expect(app.searchCacheTtlMs).toBe(0);
      expect(app.graphCacheTtlMs).toBe(0);
      expect(app.maxOpenTabs).toBe(1);
    });
  });

  describe('pricing', () => {
    it('prefers PRICE_PLUS over the legacy PRICE_5GB', () => {
      process.env.PRICE_PLUS = '€10 / year';
      process.env.PRICE_5GB = '€5 / year';
      expect(configuration().app.pricing.pricePlus).toBe('€10 / year');
    });

    it('falls back to PRICE_5GB', () => {
      process.env.PRICE_5GB = '€5 / year';
      expect(configuration().app.pricing.pricePlus).toBe('€5 / year');
    });
  });

  describe('legal pages', () => {
    it('turns on each page via its flag', () => {
      process.env.AGB = 'true';
      process.env.IMPRINT = 'true';
      process.env.LEGAL_NOTICE = 'true';
      const { app } = configuration();
      expect(app.agbEnabled).toBe(true);
      expect(app.imprintEnabled).toBe(true);
      expect(app.privacyEnabled).toBe(true);
    });
  });
});

describe('databaseFile', () => {
  it('joins the data root with app.db', () => {
    expect(databaseFile('/data')).toBe('/data/app.db');
  });
});

describe('bytesForTier', () => {
  const tiers = { free: 100, plus: 500 };

  it('returns the tier allowance', () => {
    expect(bytesForTier(tiers, 'free')).toBe(100);
    expect(bytesForTier(tiers, 'plus')).toBe(500);
  });

  it('falls back to free for unknown tiers', () => {
    expect(bytesForTier(tiers, 'gold' as never)).toBe(100);
  });
});
