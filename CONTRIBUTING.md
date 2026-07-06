# Contributing

## Dependency notes

### `npm ci` deprecation warnings are expected — do not "fix" them

`npm ci` / `npm install` prints a handful of `npm warn deprecated` lines. These
are **cosmetic**, not security issues — `npm audit` reports **0 vulnerabilities**.
A `deprecated` notice means the maintainer prefers a newer version; it does not
mean the package is insecure. Please don't chase them: past attempts broke
working functionality.

The current warnings and why each is left alone:

| Warning | Comes from | Why it stays |
| --- | --- | --- |
| `@otplib/plugin-thirty-two`, `@otplib/plugin-crypto`, `@otplib/preset-default` (v12) | **otplib@12** (our direct 2FA dep) | Upgrading to otplib v13 is a breaking rewrite that **locks out every existing user's 2FA** — see below. |
| `@types/localforage` | transitive via **epubjs** | Dev-only type stub epubjs declares itself; only removable via a risky override. Clears when epubjs updates. |
| `node-domexception` | transitive via **webdav → node-fetch → fetch-blob** | Deep transitive polyfill. Harmless. Clears when webdav's chain updates. |

### Do NOT upgrade `otplib` to v13 (would lock out all 2FA users)

`otplib` is intentionally pinned to `^12`. **Do not bump it to v13.** Two hard
blockers, both verified:

1. **v13 rejects every existing user's TOTP secret.** v12's `generateSecret()`
   produces a 16-character base32 secret = **10 bytes (80 bits)**. v13 added a
   guardrail that refuses any secret under **16 bytes (128 bits)**:

   ```
   secret "A5QAMQYLIBWDO5KR"  ->  v13 verify() throws:
   "Secret must be at least 16 bytes (128 bits), got 10 bytes"
   ```

   These secrets live (encrypted at rest) in the `users.totpSecret` column, so a
   v13 bump makes `authenticator.verify` fail for **all** current users —
   effectively a mass 2FA lockout. Storage location is irrelevant; it's the
   secret *value length* v12 baked in.

2. **v13 is a full API rewrite.** The `authenticator` export is gone; it's
   replaced by `TOTP` / functional `generateSecret` / `generate` / `verify`, and
   `verify`/`generate` are now async. `src/auth/auth.service.ts` would need a
   rewrite on top of blocker #1.

If v13 ever becomes unavoidable, it requires a real migration: re-enrolling
every user with a fresh ≥16-byte secret (new QR + recovery flow), not just a
version bump.

## Building

The client bundles (`public/js/*-bundle.js`) are built by esbuild
(`npm run build:client`); the server by Nest (`npm run build`). `npm run
build:all` does both.

Runtime-injected bundles (epub/office/excalidraw) are cache-busted via
`window.__WO_ASSET_V__` (see `views/partials/head.ejs` + `bundleUrl()` in
`public/js/app.js`). Static assets are served `immutable` for 1 year, so any
lazy-loaded `<script>` **must** carry `?v=` or an update will never reach
browsers.

## Lockfile

Regenerate `package-lock.json` under **Node 24** (`engines.node: ">=24"`). Older
Node writes a lockfile that breaks CI `npm ci`.
