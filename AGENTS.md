# AGENTS.md

Guidance for AI agents working in this repo. Always follow these rules when
implementing changes. See [CONTRIBUTING.md](./CONTRIBUTING.md) for
dependency-specific gotchas (otplib pin, cache-busting, lockfile/Node version).

## Rules — always consider for every implementation

1. **Keep files small.** Do not overload a single file. **Max 1000 lines of code
   per file.** Split by responsibility to keep code maintainable and readable.
2. **Update i18n** (`public/js/i18n.js`) whenever you add or change UI text.
   Every user-facing string must exist in **all** supported languages
   (currently `en` and `de`).
3. **Update `.env.example`** whenever you add a new environment variable
   (with a comment explaining it).
4. **Update `docker-compose.yml` AND `docker-stack.yaml`** whenever you add a
   new environment variable.
5. **Update the README** with any newly added environment variables.
6. **Responsive design.** Every UI change must work on **all screen sizes —
   desktop, tablet, and mobile.** Verify layouts (flex/grid, breakpoints) at
   narrow widths.
7. **No vulnerable packages.** After all code changes run `npm install` and
   confirm **0 vulnerabilities** (`npm audit`). Deprecation *warnings* are not
   vulnerabilities — see CONTRIBUTING.md before "fixing" them.
8. **Never bump the version manually.** Versions live in git tags, not
   `package.json` (its `version` field is untouched by releases). The release
   pipeline derives the next tag from the latest `v*` tag, bumped by the
   merged PR title: `MAJOR` → major, `FEATURE` → minor, `FIX` → patch (also
   the fallback). Name PRs accordingly.
9. **Overlay/z-index discipline.** Any full-screen overlay (dialog, panel,
   modal) can hide user feedback painted underneath it. When adding or changing
   an overlay, check the whole z-index stack in `public/css/style.css` and make
   sure **user-facing feedback always sits on top of any overlay that can be
   open at the same time.** Known layers (high → low): `.flash` toast **1100**,
   `.wo-up-overlay` upload panel **1000**, `.flash` was **200** and rendered
   *behind* the upload panel — the exact bug class to avoid. `#*-overlay`
   modals **100–110**, `.loading-overlay` spinner **90**. Never introduce an
   error/success/toast/alert whose z-index is below an overlay it can coexist
   with, and prefer surfacing an error where the user is looking (e.g. inline in
   the open panel) over a toast that a higher overlay could cover.
10. **Run all tests.** After every code change, bug fix, or feature
   implementation run `npm run test` and make sure **both** suites pass — this
   is the regression gate proving nothing else broke. `npm test` runs
   `test:backend` then `test:frontend`; CI (`ci.yml`) runs the same two.
   - **Backend** (`npm run test:backend`, ts-jest, node env): covers every
     service, storage provider, controller, and cron (`src/**/*.spec.ts`,
     ~540 tests). Add/update the matching `*.spec.ts` next to the source file.
     Run a single suite with `npx jest src/<path>`; `npm run test:cov` reports
     coverage.
   - **Frontend** (`npm run test:frontend`, jsdom env, config
     `jest.frontend.config.js`): covers the browser code in
     `test-frontend/**/*.spec.js`. Frontend logic must be **testable without a
     DOM** — put pure helpers (formatting, validation, parsing, CSV, URL
     sanitizing, etc.) in `public/js/wo-util.js` (dual-mode: `window.WOUtil`
     in the browser, `module.exports` under Jest) rather than burying them in
     `public/js/app.js`, which runs DOM side-effects on load and cannot be
     `require`d. When you add or change frontend behaviour, add or update the
     matching `test-frontend/*.spec.js` — tests are part of the feature, not a
     follow-up.

## Commands

```bash
npm run build:all      # build client bundles (esbuild) + server (nest)
npm test               # backend + frontend Jest suites (runs both)
npm run test:backend   # ts-jest, node env — src/**/*.spec.ts
npm run test:frontend  # jsdom env — test-frontend/**/*.spec.js
npm run lint           # eslint --fix
npm install            # then verify: npm audit == 0 vulnerabilities
```

### Run the CI quality gates locally before finishing — every feature or bug fix

**Non-negotiable: after ANY feature or bug fix, run the full quality gate locally
and make it green before you consider the work done.** CI (`.github/workflows/ci.yml`)
fails the whole build on the first gate that fails, and we have shipped breakages
that a 30-second local run would have caught (e.g. a `prettier/prettier` lint
error, a lockfile out of sync). Run the **exact** gates CI runs, in this order,
on **Node 24**:

```bash
npm run lint                                  # 1. auto-fix formatting first, THEN:
npx eslint "{src,apps,libs,test}/**/*.ts"     #    CI runs eslint WITHOUT --fix — must be clean (exit 0)
npm audit --audit-level=critical              # 2. no CRITICAL vulnerabilities
npm run build:all                             # 3. client bundles + server build must succeed
npm run test:backend                          # 4. backend Jest
npm run test:frontend                         # 5. frontend Jest
# 6. if any dependency changed, also the linux/amd64 `npm ci` check below
```

Key trap: CI's lint step is `npx eslint …` with **no `--fix`**, so a formatting
issue that `npm run lint` would auto-fix still **fails CI** unless you actually
ran the fix and committed it. Always run the bare `eslint` command above and see
exit 0 before finishing. Do not rely on "it looks fine" — run the gates.

### Keep `package-lock.json` in sync (CI runs `npm ci`)

CI installs with **`npm ci`**, which does a strict lockfile check and **fails the
whole build** the moment `package.json` and `package-lock.json` disagree
(`npm error code EUSAGE … can only install packages when your package.json and
package-lock.json … are in sync`). This has broken CI repeatedly. Whenever you
add, remove, or change a dependency (or its version):

1. Use **Node 24** (`engines.node: ">=24"`). Regenerating the lock on an older
   Node produces a lockfile that CI `npm ci` rejects.
2. Do a **clean, full regenerate** so transitive and cross-platform optional
   deps are all recorded (a partial install can leave the lock missing packages
   like the `@emnapi/*` / `@napi-rs/*` optional deps, which fails `npm ci` on the
   CI platform even if `npm install` looked fine locally):
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```
3. **Verify on the CI platform (linux/amd64), not just locally.** CI runs
   linux/amd64; this Mac is darwin/arm64. A lock regenerated on arm64 can omit
   amd64-only optional deps (e.g. `@emnapi/*` pulled via
   `@unrs/resolver-binding-linux-x64-*`), so **local `npm ci` passing is NOT
   proof** — it must pass under Docker linux/amd64:
   ```bash
   docker run --rm --platform=linux/amd64 -v "$PWD":/app -w /app -v /app/node_modules \
     node:24-bookworm sh -c "npm ci --ignore-scripts"   # must exit 0, no EUSAGE
   ```
   The `-v /app/node_modules` anonymous volume keeps linux binaries out of your
   darwin `node_modules`. If it fails, regenerate the lock **inside** that same
   image (`rm -f package-lock.json && npm install --ignore-scripts`) rather than
   with a local `npm install` (which rewrites the lock back to arm64).
4. **Commit `package-lock.json` together with `package.json`.** Never commit one
   without the other. (`npm install` succeeding is NOT proof of sync — only
   `npm ci` validates it.)

## Checklist before finishing a change

- [ ] **Ran the full CI quality gate locally and it is green** (lint with no
      `--fix` → `npm audit --audit-level=critical` → `npm run build:all` →
      `test:backend` → `test:frontend`) — see "Run the CI quality gates locally"
- [ ] No file exceeds 1000 lines of code
- [ ] i18n updated (all languages) if UI text changed
- [ ] `.env.example` updated if new env var
- [ ] `docker-compose.yml` and `docker-stack.yaml` updated if new env var
- [ ] README updated if new env var
- [ ] Responsive on desktop / tablet / mobile
- [ ] Overlay z-index checked: no toast/alert/error can be hidden behind an
      overlay that may be open at the same time
- [ ] `npm install` → `npm audit` shows 0 vulnerabilities
- [ ] If any dependency changed: lock regenerated on **Node 24** via a clean
      `rm -rf node_modules package-lock.json && npm install`, then verified with
      **Docker linux/amd64 `npm ci --ignore-scripts` (exit 0, no EUSAGE)** — not
      just local `npm ci`; commit `package-lock.json` with `package.json`
- [ ] `npm run test` passes — **both** backend and frontend suites
- [ ] New/changed backend behaviour has a matching `*.spec.ts` test
- [ ] New/changed frontend behaviour has a matching `test-frontend/*.spec.js`
      test; pure logic lives in `public/js/wo-util.js` so it is testable
- [ ] Client bundle rebuilt if a `client/*` or `public/js/*` source changed
