# Secrets & Configuration (Docker Swarm)

How the server separates **secrets** from **configuration**, and where each value lives.

## The rule

> Migrate the things that grant access if stolen. Leave the settings.

- **Secret** = a credential. If it leaks, an attacker gains access (logs into the DB, forges
  tokens, decrypts data, drains S3). → stored as a **Docker secret**.
- **Config** = a setting (flag, URL, size, timeout, identifier). If it leaks, nothing is
  gained; some are even sent to the browser. → stays a **plain env var** in `.env`.

Putting config into Docker secrets buys zero security and adds pain (you'd have to recreate a
secret just to change a quota).

## Where each value lives

```
.env  ──────────────►  ${VAR} interpolation  ──►  config vars (plain env in container)
docker secret ──────►  /run/secrets/<name>   ──►  the 5 secrets (readSecret reads the file)
```

The app's config loader (`src/config/configuration.ts` → `readSecret()`) reads
`${NAME}_FILE` (the mounted Docker secret) when present, otherwise falls back to the plain
`${NAME}` env var. This means **production uses Docker secrets while local development keeps a
plain `.env` with no container required.**

## Secrets → Docker secrets (3, as used in production)

Created once on the manager with `docker secret create` and referenced by the stack
(`external: true`). **Not** present in `.env`.

| Secret | Consumed by | If leaked |
|--------|-------------|-----------|
| `jwt_secret` | websidian (`JWT_SECRET_FILE`) | forge any user's session |
| `encryption_key` | websidian (`ENCRYPTION_KEY_FILE`) | decrypt stored vault data / TOTP / Stripe ids |
| `db_password` | websidian (`DB_PASSWORD_FILE`) **and** postgres (`POSTGRES_PASSWORD_FILE`) | full DB access |

Note: `db_password` is a **single** secret read by **both** the app and Postgres — the password
is not duplicated anywhere and is removed from `.env`. (Postgres only applies
`POSTGRES_PASSWORD*` when initialising a fresh data volume; on the existing
`server_postgres-data` volume the password is already baked in, so the `db_password` secret
value MUST equal the password currently in the DB.)

The app config loader also supports `STRIPE_SECRET_KEY_FILE` and `S3_SECRET_ACCESS_KEY_FILE`
via the same `readSecret()` mechanism, but the current production stack does not use S3 or
Stripe, so no such secrets are created. If those features are enabled later, add them as
Docker secrets the same way.

## Config → plain env (`.env`), never secrets

Non-sensitive settings and identifiers used by the production stack. Some (`APP_URL`,
`DONATION_LINK`, `CONTACT_EMAIL`) are shown on the public website. `DB_USERNAME` is the
"username" half of the DB credential pair — an identifier, useless without `db_password`.

`USER_STORAGE_ENABLED`, `ALLOW_REGISTRATION`, `MAX_REGISTRATIONS`, `PORT`,
`ENCRYPTION_ENABLED`, `JWT_EXPIRES_IN`, `APP_URL`, `CONTACT_EMAIL`, `DONATION_LINK`,
`CORS_ORIGINS`, `DB_TYPE`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_DATABASE`, `DB_SSL`,
`TRASH_RETENTION_DAYS`, all `RATE_LIMIT_*` / `RATE_LIMIT_DASH_*`, `VAULT_TREE_CACHE_SECONDS`,
`MAX_UPLOAD_SIZE_MB`, `IMPRINT`, `MAX_UPLOAD_FILE_MB`, `MAX_IMPORT_FILES`,
`MAX_IMPORT_TOTAL_MB`, `UPLOAD_REQUEST_TIMEOUT_MIN`, `SEARCH_CACHE_TTL_MS`,
`UPLOAD_EXCLUDE_PATTERNS`, `MAX_OPEN_TABS`.


## Why Docker secrets over plain env

- `docker inspect` no longer leaks the value — shows only the secret name.
- No subprocess/crash leak — the value is a tmpfs file, not an inherited env var, so an RCE,
  dependency, crash dump, or APM logger can't scrape it from `process.env`.
- Encrypted at rest (Swarm Raft) and in transit (mutual-TLS to nodes); mounted only in RAM
  (tmpfs) on workers, never written to worker disk.
- Dropping the weak `DB_PASSWORD` / `DB_USERNAME` defaults makes the stack fail closed if a
  value is missing, instead of silently running a known password.

See `security/audits/2026-07-23/` (INFRA-3) for the audit finding and `todo.md` for the
server deployment steps.
