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
   implementation run `npm run test` and make sure the full suite passes —
   this is the regression gate proving nothing else broke. The suite covers
   every service, storage provider, controller, and cron (`src/**/*.spec.ts`,
   ~540 tests). When you add or change behaviour, add or update the matching
   `*.spec.ts` next to the source file. During development, run a single
   suite with `npx jest src/<path>`; `npm run test:cov` reports coverage.

## Commands

```bash
npm run build:all   # build client bundles (esbuild) + server (nest)
npm test            # run the full Jest suite
npm run lint        # eslint --fix
npm install         # then verify: npm audit == 0 vulnerabilities
```

Use **Node 24** (`engines.node: ">=24"`). Regenerating `package-lock.json` on
older Node produces a lockfile that breaks CI `npm ci`.

## Checklist before finishing a change

- [ ] No file exceeds 1000 lines of code
- [ ] i18n updated (all languages) if UI text changed
- [ ] `.env.example` updated if new env var
- [ ] `docker-compose.yml` and `docker-stack.yaml` updated if new env var
- [ ] README updated if new env var
- [ ] Responsive on desktop / tablet / mobile
- [ ] Overlay z-index checked: no toast/alert/error can be hidden behind an
      overlay that may be open at the same time
- [ ] `npm install` → `npm audit` shows 0 vulnerabilities
- [ ] `npm run test` passes (full suite, after any code change)
- [ ] New/changed behaviour has a matching `*.spec.ts` test
- [ ] Client bundle rebuilt if a `client/*` or `public/js/*` source changed
