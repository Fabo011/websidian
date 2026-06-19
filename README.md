# websidian

A small, self-hosted Obsidian-like markdown knowledge app.

- **Backend:** NestJS 11 (Express), server-rendered EJS — runs on **Node.js 24 LTS**
- **User store:** SQLite (TypeORM `sql.js` driver) at `data/app.db` by default,
  or **PostgreSQL** (`DB_TYPE=postgres`)
- **Vaults:** stored on the server's disk under `data/<storageId>/` by default,
  or in **S3-compatible object storage** (`STORAGE_DRIVER=s3`)
- **Auth:** username + password with **mandatory TOTP 2FA**, JWT in an httpOnly cookie
- **Zero-knowledge end-to-end encryption:** vault contents (notes, drawings,
  attachments) are encrypted **in your browser** with **AES-256-GCM**; the
  server only ever stores ciphertext it cannot read. A one-time **recovery key**
  is issued at registration to restore access if you forget your password
- **Account dashboard:** click your username to see storage usage against your
  quota and to delete your account (and all its data)
- **Features:** create/edit/delete markdown notes, nested folders, attachments
  (PDF/jpg/png), inline `.excalidraw` editing, Obsidian `[[wikilinks]]`,
  filename + client-side content search, folder/`.zip` import &amp; decrypted
  export, light/dark theme, responsive UI

## Configuration

Copy `.env.example` to `.env` and adjust:

**Core**

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `PORT`               | `3065`               | HTTP port                                        |
| `JWT_SECRET`         | _(insecure default)_ | Secret for signing JWTs — set a strong value. Create with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`     |
| `JWT_EXPIRES_IN`     | `7d`                 | Authenticated session lifetime                   |
| `DATA_ROOT`          | `./data`             | Where the DB and local vaults live               |
| `APP_URL`            | `http://localhost:3065` | Public base URL (Stripe redirects, default CORS origin) |
| `ALLOW_REGISTRATION` | `true`               | Set `false` to disable self-service registration |
| `MAX_REGISTRATIONS`  | `0`                  | Cap registered users (`0` = unlimited)           |
| `COOKIE_SECURE`      | `false`              | Set `true` when served over HTTPS                |
| `CORS_ORIGINS`       | _(=`APP_URL`)_       | Comma-separated browser origins allowed to call the backend |

**Storage & quota**

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `STORAGE_QUOTA_GB`   | `8`                  | Per-user storage limit in GB (`0` = unlimited)   |
| `MAX_UPLOAD_SIZE_MB` | `25`                 | Max JSON/urlencoded request body (caps a single note upload) |
| `MAX_UPLOAD_FILE_MB` | `2048`               | Max size of a single uploaded/imported file (MB) |
| `MAX_IMPORT_FILES`   | `20000`              | Max files accepted in one folder/zip import      |
| `MAX_IMPORT_TOTAL_MB`| `2048`               | Max total size of a single import (MB)           |
| `UPLOAD_REQUEST_TIMEOUT_MIN` | `30`         | How long (min) the server keeps an upload request open |
| `TRASH_RETENTION_DAYS` | `7`                | Days deleted items stay in trash (`0` = immediate delete) |

**Rate limiting**

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `RATE_LIMIT_ENABLED` | `true`               | Throttle the `/api` data routes per user (`false` to disable) |
| `RATE_LIMIT_WINDOW_SECONDS` | `60`          | Length of the rate-limit window in seconds       |
| `RATE_LIMIT_MAX`     | `60`                 | Max API requests per window, per user/IP         |

**Encryption (DB columns at rest)**

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `ENCRYPTION_ENABLED` | `true`               | Encrypt sensitive DB columns at rest (TOTP/Stripe) |
| `ENCRYPTION_KEY`     | _(from JWT_SECRET)_  | Master key for the DB-column encryption — keep stable |

**Database** (see [Database backend](#database-backend))

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `DB_TYPE`            | `sqlite`             | `sqlite` or `postgres`                           |
| `DB_HOST`            | `localhost`          | Postgres host (when `DB_TYPE=postgres`)          |
| `DB_PORT`            | `5432`               | Postgres port                                    |
| `DB_USERNAME`        | `postgres`           | Postgres user                                    |
| `DB_PASSWORD`        | _(empty)_            | Postgres password                                |
| `DB_DATABASE`        | `web_obsidian`       | Postgres database name                           |
| `DB_SSL`             | `false`              | `true` to connect over TLS                       |

**Vault storage backend** (see [Vault storage backend](#vault-storage-backend))

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `STORAGE_DRIVER`     | `local`              | `local` (filesystem) or `s3`                     |
| `S3_ENDPOINT`        | _(empty)_            | S3 endpoint (when `STORAGE_DRIVER=s3`)           |
| `S3_REGION`          | `us-east-1`          | S3 region                                        |
| `S3_BUCKET`          | _(empty)_            | S3 bucket name                                   |
| `S3_ACCESS_KEY_ID`   | _(empty)_            | S3 access key                                    |
| `S3_SECRET_ACCESS_KEY` | _(empty)_          | S3 secret key                                    |
| `S3_FORCE_PATH_STYLE`| `true`               | Path-style addressing (MinIO/some S3-compatibles) |
| `S3_PREFIX`          | _(empty)_            | Optional key prefix so multiple apps share one bucket |

**Billing / subscriptions (Stripe)** — optional

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `BILLING_ENABLED`    | _(on if `STRIPE_SECRET_KEY` set)_ | Switch the payment feature on/off   |
| `STRIPE_SECRET_KEY`  | _(empty)_            | Stripe secret key (enables checkout)             |
| `STRIPE_PRICE_PLUS`  | _(empty)_            | Recurring (annual) price ID for the paid plan (`STRIPE_PRICE_5GB` read as fallback) |
| `STORAGE_PLUS_GB`    | `3`                  | Storage size of the paid plan, in whole GB       |
| `PRICE_PLUS`         | _(empty)_            | Display-only suggested donation (e.g. `€10 / year`); `PRICE_5GB` fallback |
| `CONTACT_EMAIL`      | _(empty)_            | Contact shown for custom/larger storage requests |
| `PRIVILEGED_USERS`   | _(empty)_            | Comma-separated usernames (e.g. `userA,userB`) granted free dedicated storage; excluded from billing, no upgrade button. Independent of `STORAGE_QUOTA_GB`/`STORAGE_PLUS_GB`. Unioned with the `privileged_users` DB table |
| `STORAGE_PRIVILEGED_USERS_GB` | `20`       | Storage allowance for privileged users, in whole GB                |

**Legal pages** (opt-in — hidden unless set to `true`)

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `AGB`                | `false`              | Show AGB (German terms & conditions) page        |
| `IMPRINT`            | `false`              | Show Imprint page                                |
| `LEGAL_NOTICE`       | `false`              | Show Privacy policy page                         |

**Self-hosting**

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `CLOUDFLARE_TOKEN`   | _(empty)_            | Cloudflare Tunnel token (HTTPS without opening ports) |

Generate a secret with `openssl rand -hex 32`.

### Database backend

`DB_TYPE` selects the database (default `sqlite`). For PostgreSQL set
`DB_TYPE=postgres` and configure `DB_HOST`, `DB_PORT`, `DB_USERNAME`,
`DB_PASSWORD`, `DB_DATABASE`, and `DB_SSL`. See `.env.example` for the full list.

### Vault storage backend

`STORAGE_DRIVER` selects where vault files are stored (default `local`, the
server's filesystem). An `s3` driver targeting S3-compatible object storage
(AWS S3, MinIO, Mega S3, etc.) is available with full configuration
(`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX`). Either way the
backend is a **blind blob store**: files are stored under an immutable random
`storageId` per account (never the username) and their contents are already
end-to-end encrypted ciphertext.

### Storage quota

Each account is limited to `STORAGE_QUOTA_GB` (default **8 GB**). Writes,
uploads and imports that would exceed the quota are rejected. Set
`STORAGE_QUOTA_GB=0` for unlimited storage. (Paid upgrades for more storage are
planned.)

### API rate limiting

The data API (`/api/*`) is rate limited **per user** (per IP for anonymous
callers) so a single account cannot hammer the storage backend — for example by
reloading the page in a loop. This directly caps S3/Mega S3 request costs and
blunts trivial DDoS attempts. When the limit is exceeded the API responds with
HTTP `429` and the UI shows a clear toast asking the user to slow down.

Tune it with `RATE_LIMIT_WINDOW_SECONDS` (default **60s** = "per minute") and
`RATE_LIMIT_MAX` (default **60** requests per window). Set
`RATE_LIMIT_ENABLED=false` to turn it off. Note that one page load fires several
API calls (file tree + the opened note, etc.), so keep `RATE_LIMIT_MAX`
comfortably above the number of page reloads per minute you want to allow.

### Zero-knowledge end-to-end encryption

Vault contents are **end-to-end encrypted in your browser** — the server never
sees your password or any plaintext, and stores only opaque ciphertext.

- At registration the browser generates a random 256-bit **vault key (VK)** and
  encrypts every note, drawing and attachment with **AES-256-GCM** under it.
- The VK is wrapped twice: once with a key derived from your **password**
  (PBKDF2-SHA256, 600,000 iterations) and once with a key derived from a
  one-time **recovery key**. Only these two wrapped blobs are stored on the
  server; the VK itself never leaves your device.
- Because the server cannot read your files, **markdown rendering, full-text
  content search, and `.zip` export all run in your browser**. Filenames and
  folder names stay in plaintext so the vault tree still works server-side; only
  file *contents* are encrypted.

Encrypted blobs use the format `MAGIC("WOE1") | iv(12) | ciphertext+tag`.

> **Keep your recovery key.** It is shown **once** during sign-up and is the
> only way back in if you forget your password. If you lose **both** your
> password and your recovery key, your data is unrecoverable — by design,
> nobody (including the operator) can decrypt it for you.

The separate server-side `ENCRYPTION_KEY` (`ENCRYPTION_ENABLED=true`) is used
only to encrypt sensitive **database columns** (TOTP secrets, Stripe IDs), not
vault content. Set a dedicated, stable value (`openssl rand -hex 32`) and back
it up.

The **Export** feature decrypts your vault in the browser and produces a
**decrypted** `.zip`, so you always keep a portable, platform-independent
backup.

## Run locally

Requires **Node.js 24+**.

```bash
npm install
npm run build:client   # bundles the in-browser editors, crypto, markdown & zip
npm run start:dev      # or: npm run build && npm run start:prod
```

Open http://localhost:3065, register an account, scan the QR code (or type the
shown secret) into an authenticator app, and confirm the 6-digit code. During
sign-up you are shown a **one-time recovery key** — save it before continuing;
it is the only way to regain access if you forget your password.

## Run with Docker

The published image targets **ARM (linux/arm64)** for Raspberry Pi and other
ARM Linux servers.

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

Application data is persisted in `./data` (mounted into the container at
`/app/data`). Back up that folder on the host. To disable registration after
creating your account, set `ALLOW_REGISTRATION=false` and restart.

## Account & storage dashboard

Click your username in the top-right to open the **account dashboard**. It shows
your current storage consumption against your quota and lets you **delete your
account**. Deletion is permanent: it removes all your notes and files from
storage and your account record from the database (you must re-enter your
password to confirm).

## Importing an existing Obsidian vault

Use the **Import** button in the sidebar:

- **Desktop:** pick a folder; its structure is preserved.
- **Mobile:** select multiple files or upload a `.zip`.

Imports are expanded and encrypted **in your browser** before upload, so the
server only ever receives ciphertext.

## Continuous delivery

Pushing to `main` triggers the Forgejo Actions pipeline
(`.forgejo/workflows/release.yml`) which builds and tests the project, creates a
git tag, and builds & pushes a `linux/arm64` Docker image to the Github
container registry. Configure a `PACKAGE_TOKEN` secret (Github access token
with package read/write scopes) in the repository's Actions settings.

## License

websidian is **source-available** under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

You may self-host it for your own personal, noncommercial use, study it, and
modify it; you may also use the official hosted version or deploy the official
Docker image on your own server. You may **not** use it for any commercial
purpose, including offering it to others as a hosted service. The `LICENSE` file
governs in case of any conflict with this summary.


---

### Generate encryption key and jwt secret
run the following command twice
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

### Stripe testing
https://docs.stripe.com/testing