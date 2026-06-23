import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import * as express from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { readFileSync } from 'fs';
import helmet from 'helmet';
import { join } from 'path';
import { AppModule } from './app.module';
import { AUTH_COOKIE } from './auth/auth.constants';
import { AuthService } from './auth/auth.service';
import { AppConfig } from './config/configuration';
import { parseUploadExcludePatterns } from './common/upload-exclude';
import { registerColumnEncryptor } from './storage/encrypted-column.transformer';
import { EncryptionService } from './storage/encryption.service';
import { setupTus, TUS_HEADERS } from './upload/tus.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const config = app.get(ConfigService);
  const appConfig = config.get<AppConfig>('app');

  // Wire encrypted DB columns to the active encryption service before any
  // database read/write occurs.
  registerColumnEncryptor(app.get(EncryptionService));

  const bodyLimit = `${appConfig.maxUploadSizeMb}mb`;
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: bodyLimit }));
  app.use(cookieParser());

  // Two independent rate limiters, keyed per-user (falling back to IP for
  // anonymous callers) so one abusive client cannot lock out everyone behind a
  // NAT. The auth limiter (/auth: login, register, 2fa) throttles credential
  // guessing/enumeration. The dashboard limiter (/api) caps storage/S3 abuse +
  // reload storms. Configured via RATE_LIMIT_* and RATE_LIMIT_DASH_* env vars.
  const authService = app.get(AuthService);
  const makeRateLimiter = (cfg: AppConfig['rateLimit']) =>
    rateLimit({
      windowMs: cfg.windowMs,
      limit: cfg.max,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => {
        const token = (
          req as express.Request & { cookies?: Record<string, string> }
        ).cookies?.[AUTH_COOKIE];
        if (token) {
          try {
            return `user:${authService.verifyToken(token).sub}`;
          } catch {
            // Fall through to IP-based keying for invalid/expired tokens.
          }
        }
        return `ip:${ipKeyGenerator(req.ip ?? '')}`;
      },
      handler: (_req, res) => {
        res.status(429).json({
          statusCode: 429,
          error: 'Too Many Requests',
          message:
            'You are doing that too often. Please slow down and try again in a moment.',
        });
      },
    });

  if (appConfig.rateLimit.enabled) {
    app.use('/auth', makeRateLimiter(appConfig.rateLimit));
  }
  if (appConfig.rateLimitDash.enabled) {
    app.use('/api', makeRateLimiter(appConfig.rateLimitDash));
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  app.setBaseViewsDir(join(process.cwd(), 'views'));
  app.setViewEngine('ejs');
  // Expose to every rendered view (incl. the footer partial) so the legal-page
  // links can be hidden when their flags are off.
  const expressInstance = app.getHttpAdapter().getInstance();
  expressInstance.locals.agbEnabled = appConfig.agbEnabled;
  expressInstance.locals.imprintEnabled = appConfig.imprintEnabled;
  expressInstance.locals.privacyEnabled = appConfig.privacyEnabled;
  // App version (from package.json), surfaced to views for the footer + the
  // account dashboard. Read once at startup; failures degrade to an empty
  // string so the version line is simply omitted.
  let appVersion = '';
  try {
    appVersion =
      JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
        .version || '';
  } catch {
    appVersion = '';
  }
  expressInstance.locals.appVersion = appVersion;
  // Free-tier allowance in bytes, surfaced to the client (head partial) so the
  // UI can render the actual free quota (driven by STORAGE_QUOTA_GB) instead of
  // a hardcoded "1 GB".
  expressInstance.locals.freeBytes = appConfig.tiers.free;
  // Client-side graph cache TTL (ms), surfaced to the client so reopening the
  // wikilink graph within the window reuses the built layout instead of
  // refetching + re-simulating. Driven by GRAPH_CACHE_TTL_MS.
  expressInstance.locals.graphCacheTtlMs = appConfig.graphCacheTtlMs;
  // Max file tabs the client keeps open at once, surfaced to the client so the
  // tab bar can refuse to open more than this. Driven by MAX_OPEN_TABS.
  expressInstance.locals.maxOpenTabs = appConfig.maxOpenTabs;
  // Junk-file patterns (macOS ._*, .DS_Store, …), surfaced to the client so the
  // folder uploader can skip them before queueing instead of letting them fail
  // server-side. Mirrors the guard in tus.setup. Driven by UPLOAD_EXCLUDE_PATTERNS.
  expressInstance.locals.uploadExcludePatterns = parseUploadExcludePatterns(
    process.env.UPLOAD_EXCLUDE_PATTERNS,
  );
  // Import limits, surfaced to the client (head partial) so the Import dialog can
  // tell the user the real caps. Mirror the defaults used in VaultController.
  expressInstance.locals.maxUploadFileMb = Math.max(
    1,
    Number(process.env.MAX_UPLOAD_FILE_MB) || 2048,
  );
  expressInstance.locals.maxImportFiles = Math.max(
    1,
    Number(process.env.MAX_IMPORT_FILES) || 20000,
  );
  expressInstance.locals.maxImportTotalMb = Math.max(
    1,
    Number(process.env.MAX_IMPORT_TOTAL_MB) || 2048,
  );
  // Cache-busting token appended to static asset URLs (?v=...). Changes on every
  // boot (i.e. every deploy) unless pinned via ASSET_VERSION, so a new release is
  // never masked by a stale Cloudflare-edge / browser copy of app.js, i18n.js,
  // style.css, etc. Templates read it as `v`.
  expressInstance.locals.v =
    process.env.ASSET_VERSION?.trim() || String(Date.now());

  // Assets are versioned via the ?v= query above, so each build serves a fresh
  // URL. That lets us cache them aggressively (immutable) without risking stale
  // code after a deploy.
  app.useStaticAssets(join(process.cwd(), 'public'), {
    prefix: '/public',
    maxAge: '1y',
    immutable: true,
  });

  // Restrict cross-origin browser access to the configured origin(s). Same-origin
  // requests are unaffected; other domains cannot make credentialed calls.
  app.enableCors({
    origin: appConfig.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    // tus needs its protocol headers to pass both ways through the proxy.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      ...TUS_HEADERS,
    ],
    exposedHeaders: TUS_HEADERS,
  });

  // Security headers. CSP and COEP are disabled because the server-rendered
  // pages rely on inline scripts/styles and the editors load worker/blob
  // resources; the remaining helmet protections (nosniff, frameguard, HSTS,
  // referrer policy, etc.) are kept.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Resumable chunked upload endpoint (tus, /files). Mounted on the raw Express
  // instance so chunk bodies stay unparsed; folder uploads are encrypted in the
  // browser and streamed into the vault on completion. See src/upload/tus.setup.
  setupTus(app);

  const server = await app.listen(appConfig.port);

  // Large folder/zip imports stream thousands of files to storage within a
  // single request and can legitimately run for many minutes. Node's default
  // requestTimeout (5 min) would abort them mid-upload, so extend it. Override
  // with UPLOAD_REQUEST_TIMEOUT_MIN (minutes); default 30.
  const uploadTimeoutMs =
    Math.max(1, Number(process.env.UPLOAD_REQUEST_TIMEOUT_MIN) || 30) *
    60 *
    1000;
  server.requestTimeout = uploadTimeoutMs;
  // headersTimeout must stay >= requestTimeout or Node clamps the effective
  // body window back down to it.
  server.headersTimeout = uploadTimeoutMs + 1000;
}
bootstrap();
