import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import * as express from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { join } from 'path';
import { AppModule } from './app.module';
import { AUTH_COOKIE } from './auth/auth.constants';
import { AuthService } from './auth/auth.service';
import { AppConfig } from './config/configuration';
import { registerColumnEncryptor } from './storage/encrypted-column.transformer';
import { EncryptionService } from './storage/encryption.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const config = app.get(ConfigService);
  const appConfig = config.get<AppConfig>('app');

  // Wire encrypted DB columns to the active encryption service before any
  // database read/write occurs.
  registerColumnEncryptor(app.get(EncryptionService));

  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));
  app.use(cookieParser());

  // Rate limit the data API so a single account cannot hammer the storage
  // backend (e.g. by reloading the page in a loop). This directly caps S3
  // request costs and blunts trivial DDoS attempts. Limits are configurable via
  // RATE_LIMIT_* env vars; keying is per-user (falling back to IP for anonymous
  // callers) so one abusive client cannot lock out everyone behind a NAT.
  if (appConfig.rateLimit.enabled) {
    const authService = app.get(AuthService);
    app.use(
      '/api',
      rateLimit({
        windowMs: appConfig.rateLimit.windowMs,
        limit: appConfig.rateLimit.max,
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
      }),
    );
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
  app.useStaticAssets(join(process.cwd(), 'public'), { prefix: '/public' });

  // Restrict cross-origin browser access to the configured origin(s). Same-origin
  // requests are unaffected; other domains cannot make credentialed calls.
  app.enableCors({
    origin: appConfig.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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

  await app.listen(appConfig.port);
}
bootstrap();
