# web-obsidian

A small, self-hosted Obsidian-like markdown knowledge app.

- **Backend:** NestJS 11 (Express), server-rendered EJS
- **User store:** SQLite (TypeORM `sql.js` driver) at `data/app.db`
- **Vaults:** stored on disk under `data/<username>/`
- **Auth:** username + password with **mandatory TOTP 2FA**, JWT in an httpOnly cookie
- **Features:** create/edit/delete markdown notes, nested folders, attachments
  (PDF/jpg/png), inline `.excalidraw` editing, Obsidian `[[wikilinks]]`,
  filename + content search, folder/`.zip` import, light/dark theme, responsive UI

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable             | Default              | Purpose                                          |
| -------------------- | -------------------- | ------------------------------------------------ |
| `PORT`               | `3065`               | HTTP port                                        |
| `JWT_SECRET`         | _(insecure default)_ | Secret for signing JWTs — set a strong value     |
| `JWT_EXPIRES_IN`     | `7d`                 | Authenticated session lifetime                   |
| `DATA_ROOT`          | `./data`             | Where the DB and user vaults live                |
| `ALLOW_REGISTRATION` | `true`               | Set `false` to disable self-service registration |
| `COOKIE_SECURE`      | `false`              | Set `true` when served over HTTPS                |

Generate a secret with `openssl rand -hex 32`.

## Run locally

```bash
npm install
npm run build:client   # bundles the Excalidraw editor + copies its assets
npm run start:dev      # or: npm run build && npm run start:prod
```

Open http://localhost:3065, register an account, scan the QR code (or type the
shown secret) into an authenticator app, and confirm the 6-digit code.

## Run with Docker

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

Application data is persisted in `./data` (mounted into the container at
`/app/data`). Back up that folder on the host. To disable registration after
creating your account, set `ALLOW_REGISTRATION=false` and restart.

## Importing an existing Obsidian vault

Use the **Import** button in the sidebar:

- **Desktop:** pick a folder; its structure is preserved.
- **Mobile:** select multiple files or upload a `.zip` (unpacked server-side).
