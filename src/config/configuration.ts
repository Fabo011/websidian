import { isAbsolute, join, resolve } from 'path';

export interface AppConfig {
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  dataRoot: string;
  allowRegistration: boolean;
  cookieSecure: boolean;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export default (): { app: AppConfig } => {
  const rawDataRoot = process.env.DATA_ROOT?.trim() || './data';
  const dataRoot = isAbsolute(rawDataRoot)
    ? rawDataRoot
    : resolve(process.cwd(), rawDataRoot);

  return {
    app: {
      port: parseInt(process.env.PORT ?? '3065', 10),
      jwtSecret:
        process.env.JWT_SECRET?.trim() ||
        'insecure-dev-secret-change-me',
      jwtExpiresIn: process.env.JWT_EXPIRES_IN?.trim() || '7d',
      dataRoot,
      allowRegistration: parseBool(process.env.ALLOW_REGISTRATION, true),
      cookieSecure: parseBool(process.env.COOKIE_SECURE, false),
    },
  };
};

/** Absolute path to the sqlite database file. */
export function databaseFile(dataRoot: string): string {
  return join(dataRoot, 'app.db');
}
