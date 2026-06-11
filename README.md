# web-obsidian

A small, self-hosted Obsidian-like markdown knowledge app.

- **Backend:** NestJS 11 (Express), server-rendered EJS — runs on **Node.js 24 LTS**
- **User store:** SQLite (TypeORM `sql.js` driver) at `data/app.db` by default,
  or **PostgreSQL** (`DB_TYPE=postgres`)
- **Vaults:** stored on the server's disk under `data/<username>/` by default
  (an S3-compatible storage backend is scaffolded but not yet implemented)
- **Auth:** username + password with **mandatory TOTP 2FA**, JWT in an httpOnly cookie
- **Account dashboard:** click your username to see storage usage against your
  quota and to delete your account (and all its data)
- **Features:** create/edit/delete markdown notes, nested folders, attachments
  (PDF/jpg/png), inline `.excalidraw` editing, Obsidian `[[wikilinks]]`,
  filename + content search, folder/`.zip` import & export, light/dark theme,
  responsive UI

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `PORT`               | `3065`               | HTTP port                                        |
| `JWT_SECRET`         | _(insecure default)_ | Secret for signing JWTs — set a strong value     |
| `JWT_EXPIRES_IN`     | `7d`                 | Authenticated session lifetime                   |
| `DATA_ROOT`          | `./data`             | Where the DB and local vaults live               |
| `ALLOW_REGISTRATION` | `true`               | Set `false` to disable self-service registration |
| `COOKIE_SECURE`      | `false`              | Set `true` when served over HTTPS                |
| `STORAGE_QUOTA_GB`   | `8`                  | Per-user storage limit in GB (`0` = unlimited)   |

Generate a secret with `openssl rand -hex 32`.

### Database backend

`DB_TYPE` selects the database (default `sqlite`). For PostgreSQL set
`DB_TYPE=postgres` and configure `DB_HOST`, `DB_PORT`, `DB_USERNAME`,
`DB_PASSWORD`, `DB_DATABASE`, and `DB_SSL`. See `.env.example` for the full list.

### Vault storage backend

`STORAGE_DRIVER` selects where vault files are stored (default `local`, the
server's filesystem). An `s3` driver targeting S3-compatible object storage
(AWS S3, MinIO, Mega S3, etc.) is scaffolded with full configuration
(`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX`) but is **not yet
implemented** — selecting it currently fails fast.

### Storage quota

Each account is limited to `STORAGE_QUOTA_GB` (default **8 GB**). Writes,
uploads and imports that would exceed the quota are rejected. Set
`STORAGE_QUOTA_GB=0` for unlimited storage. (Paid upgrades for more storage are
planned.)

## Run locally

Requires **Node.js 24+**.

```bash
npm install
npm run build:client   # bundles the Excalidraw editor + copies its assets
npm run start:dev      # or: npm run build && npm run start:prod
```

Open http://localhost:3065, register an account, scan the QR code (or type the
shown secret) into an authenticator app, and confirm the 6-digit code.

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
- **Mobile:** select multiple files or upload a `.zip` (unpacked server-side).

## Continuous delivery

Pushing to `main` triggers the Forgejo Actions pipeline
(`.forgejo/workflows/release.yml`) which builds and tests the project, creates a
git tag, and builds & pushes a `linux/arm64` Docker image to the Codeberg
container registry. Configure a `PACKAGE_TOKEN` secret (Codeberg access token
with package read/write scopes) in the repository's Actions settings.

## License

web-obsidian is **source-available** under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

You may self-host it for your own personal, noncommercial use, study it, and
modify it; you may also use the official hosted version or deploy the official
Docker image on your own server. You may **not** use it for any commercial
purpose, including offering it to others as a hosted service. The `LICENSE` file
governs in case of any conflict with this summary.

