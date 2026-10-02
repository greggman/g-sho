# g-sho — sync server plan

The design is in [DESIGN-SERVER.md](DESIGN-SERVER.md). This is the order we build it
in. Each phase ships on its own, and the site keeps working without an account
throughout.

## What you need to do (one-time setup)

Items marked **(now)** block Phase 1. The rest can wait until the phase that
needs them.

1. **(now) A separate Cloudflare account for g-sho.** In the dashboard, use the
   account switcher → *Add account* (or sign up with a different email if
   that isn't offered). Everything below goes in this account. Billing, members,
   API tokens and resources then stay separate from any other Cloudflare
   projects.
2. **(now) Move g-sho.org's DNS to Cloudflare.** In the g-sho account: *Add a
   domain* → g-sho.org → Free plan. Cloudflare imports the existing records.
   Then change the nameservers at your registrar to the two it gives you.
   While that propagates, the GitHub Pages records keep the site up.
   (Optionally, transfer the registration to Cloudflare Registrar later. It
   sells at cost, but it's not required.)
3. **Account ID** (done): `59f65c7c3586d1a06e65104486465213`, in
   `wrangler.jsonc`. Local dev needs no Cloudflare login at all, and CI does
   the deploys. Don't keep a `wrangler login` session around, because its
   OAuth grant is broad and covers *every* account your login can reach. For
   the occasional remote command (`wrangler secret put`, remote D1
   migrations), use a scoped API token instead: put
   `CLOUDFLARE_API_TOKEN=…` in a gitignored `.env` in the repo, which wrangler
   reads.
4. **(now) CI token.** *My Profile → API Tokens → Create Token →* the
   "Edit Cloudflare Workers" template. Under *Account Resources*, include
   **only the g-sho account**. Under *Zone Resources*, pick g-sho.org. Add the
   **D1: Edit** permission. Keep only these permissions, and remove the
   template's others: Account | Workers Scripts | Edit, Account | D1 | Edit,
   Account | Account Settings | Read, and Zone | Workers Routes | Edit.
   Then in GitHub: *Settings → Environments → New environment* `production`,
   with deployment branches limited to `main`. Add the token there as the
   **environment secret** `CLOUDFLARE_API_TOKEN`. That way only deploy jobs on
   main can read it. The account ID is in `wrangler.jsonc`.
5. **Billing (before Phase 2, or at least before launch).** Subscribe the g-sho
   account to **Workers Paid ($5/month)**. Free works for Phase 1. But Free
   caps each request at 10 ms of CPU and stops serving when a daily limit
   is hit, which a big deck import can do. Paid bills small overages instead of
   failing. Also set a billing notification (*Notifications → Usage Based
   Billing*) so surprises are impossible.
6. **Phase 2: GitHub OAuth app** (sign in with GitHub). It gives you a
   **client ID** (not secret; send it to me and it goes in `wrangler.jsonc`)
   and a **client secret**. GitHub shows the secret **only once**, so copy
   it right away. Never commit it or paste it into chat.

   One OAuth app holds both redirect URIs. Go to github.com →
   your avatar → *Settings → Developer settings → OAuth Apps → New OAuth
   App*. That's an *OAuth App*, not a *GitHub App*.

   | Field | Value |
   | --- | --- |
   | Application name | `g-sho` |
   | Homepage URL | `https://g-sho.org` |
   | Application description | optional |
   | Redirect URIs | `https://g-sho.org/api/auth/github/callback` and `http://localhost:8787/api/auth/github/callback` |
   | Allow wildcard matching | off |
   | Enable Device Flow | off |
   | Expire user access tokens | off (the token is used once, to read the user's ID) |

   After *Register application*: copy the **Client ID**, then click
   *Generate a new client secret* and copy that.

   **Where the secrets go:**
   - Local: a file `.dev.vars` in the repo root (gitignored):
     ```
     GITHUB_CLIENT_SECRET=...
     ```
   - Production: after the first deploy, run
     `npx wrangler secret put GITHUB_CLIENT_SECRET --env=""` and paste the value at
     the prompt. That uses the token in `.env`.
7. **Later: Turnstile**, only if bot sign-ups appear: *Turnstile → Add widget*
   for g-sho.org. Site key → config, secret → `wrangler secret put`.
8. **At cutover (end of Phase 1): turn off GitHub Pages** in the repo settings,
   once g-sho.org is served by the Worker.

## Phase 1 — Worker hosting (no user-visible change) — done

- Add `wrangler` (dev dependency), `wrangler.jsonc`, and `src/server/worker.ts`
  with `/api/health`. Static assets are served from `dist/`, and `/api/*` goes
  to the Worker (`run_worker_first: ["/api/*"]`).
  404s fall back to the static 404 handling, matching GitHub Pages behavior.
  **(done)**, and `wrangler deploy --dry-run` bundles it with all 12,495 assets.
- `npm run dev` (`scripts/dev.ts`) runs `dev:server` (esbuild watch + serve
  on :8000) and `dev:worker` (`wrangler dev --env dev` on :8787) together. The
  Worker handles `/api` and proxies everything else to :8000, so open :8787. (Serving `dist/`
  directly from `wrangler dev` fails on macOS. It watches all ~12,500 files,
  and every later child process spawn fails with EBADF.)
  **(done)**
- Tests: server code is written against a small SQL interface. Unit tests run
  it on `node:sqlite` (built into Node 24) under `node:test`, so the test runner
  stays the same.
- CI: replace the Pages upload/deploy jobs with `wrangler deploy` on
  push to main. It needs the secrets from step 4. **(done)**
- `static/_headers` keeps GitHub Pages' `Cache-Control: max-age=600`.
  **(done)**
- Cutover: add g-sho.org as the Worker's custom domain (config `routes`
  with `custom_domain: true`), delete the GitHub Pages DNS records, deploy,
  turn off Pages, and redirect www with a Cloudflare Redirect Rule.
  **(done)**

## Phase 2 — Accounts — done

- D1 database `g-sho-accounts` (binding `DB`), `migrations/0001_accounts.sql`:
  `users`, `identities`, `sessions`. Migrations are applied by `npm run dev`
  (locally) and by CI before each deploy. **(done)**
- `src/server/auth.ts`: GitHub OAuth (state cookie, no scopes, GitHub's token
  revoked right after reading the profile), sessions (`__Host-session`
  cookie, SHA-256 stored, 90 days, extended when used after 30).
  `src/server/worker.ts`: `/api/me` (GET, DELETE), `/api/export`,
  `/api/auth/logout`, Origin checks on writes, rate limits (`AUTH_LIMIT` per
  IP, `API_LIMIT` per user). **(done)**
- Dev-only sign-in shortcut: `/api/auth/dev/start?name=amy` (only when
  `DEV_LOGIN=1`, which only `env.dev` sets). **(done)**
- Client: Account section in Settings (`account.ts`, `account-panel.ts`),
  hidden when there's no `/api`. `static/privacy.html`, linked from the
  footers. **(done)**
- Tests: `test/auth.test.ts` on `node:sqlite` (`test/d1-shim.ts`). **(done)**
- Production: D1 database created, `GITHUB_CLIENT_SECRET` set, Workers
  Paid, deployed, and sign-in tested on g-sho.org. **(done)**

## Phase 3 — Local-first store in the client — done

- `src/client/store/`: `Table` keeps rows in memory (synchronous reads) and
  writes through to IndexedDB (`idb.ts`). If IndexedDB isn't available, a
  memory backend is used and nothing is saved. Each row has `mtime`, `dirty`
  and tombstones, plus `markClean` / `applyRemote` (last change wins) ready
  for sync. **(done)**
- Tables: `history`, `settings` (display settings only; Anki settings stay
  in localStorage because they're per device), `marks` (star / known), and
  `notes`. Decks and cards are added in Phase 5 (bump `DB_VERSION`).
  **(done)**
- History and display settings are moved from localStorage once, then
  removed there; each search's time becomes its change time. **(done)**
- Per-word controls on entries and sentence cards: ☆ star, "known", and ✎
  note (saved as you type, max 2,000 characters). **(done)**
- Tests: `test/store.test.ts` (memory backend). **(done)**
- For Phase 4: other open tabs don't see changes until reloaded. Use a
  BroadcastChannel to reload tables. Tombstones are never purged yet. Purge
  synced ones, and all of them when not signed in.

## Phase 4 — Sync

- `UserStore` Durable Object (SQLite): schema versioning, apply-push /
  pull-since logic, caps, and `seq`. `/api/sync` routes there. Account
  deletion clears it.
- Client sync loop: on startup, after changes (debounced), on visibility
  change, and when back online. First sign-in merges local data. Plus a sync
  status indicator.
- Tests: two simulated devices, offline edits, deletes, clock skew, paging.

## Phase 5 — Study

- `ts-fsrs`, decks with options, the built-in `g-sho (Japanese)` note type,
  "Add to deck" on entries (next to the Anki +), and a review screen
  (show → reveal → Again/Hard/Good/Easy) that respects the display settings.
- A due count on the home page and simple deck stats.

## Phase 6 — Export to Anki

- AnkiConnect: whole-deck export (note types, notes, media, due dates),
  updating notes that are already there.
- An .apkg writer (sql.js + fflate, schema 11), plus a TSV fallback.
- Round-trip tests: our export, read back by our importer.

## Phase 7 — Import from Anki

- An import worker: detect the format, unzip, zstd-decode, then read schema
  11 and schema 18 (protobuf note type / template config).
  The media map is JSON or protobuf.
- Entry points: file picker, drop anywhere, paste a file, paste plain text.
- A preview screen: the decks and note types found, the word/reading field
  mapping per note type, link stats, and the scheduling that will be kept.
- Template renderer plus the sandboxed card frame. Media is kept locally (OPFS).
- Re-import by GUID.
- Test fixtures: small .apkg files from old and new Anki versions, checked in.

## Phase 8 — Duplicates and known words

- Card direction inference, and known-word detection (plus, optionally,
  reading known words from Anki via AnkiConnect).
- A duplicates step in the import preview (copy schedule / suspend / keep, with
  counts), and "Find duplicates" for existing decks.

## Later

- Media sync via R2 (content-addressed, quotas).
- Rebuilding a card's schedule from its merged review log after offline
  conflicts.
- Google sign-in (see the appendix), email magic-link sign-in, Turnstile,
  and a staging environment.

## Appendix: adding Google sign-in later

Not part of Phase 2. When it's wanted, the server side is one more provider
(`/api/auth/google/*`, with PKCE). The setup:

Google needs one project and one client. Its redirect URI list holds
both URLs, and Google allows `http://` for localhost.
1. [console.cloud.google.com](https://console.cloud.google.com) → project
   picker → *New project* → name `g-sho` (no organization).
2. ☰ → *APIs & Services → OAuth consent screen* (it opens *Google Auth
   Platform*) → *Get started*:
   - App name `g-sho`, user support email: yours.
   - Audience: **External**.
   - Contact email: yours. Agree to the policy, then *Create*.
3. *Branding*: application home page `https://g-sho.org`, privacy policy
   `https://g-sho.org/privacy.html` (that page is part of Phase 2),
   authorized domain `g-sho.org`. **Don't upload a logo.** A logo requires
   Google's brand verification, and without one there's no review.
4. *Data Access → Add or remove scopes*: tick `openid`,
   `.../auth/userinfo.email`, and `.../auth/userinfo.profile`, then *Update*
   and *Save*. All three are "non-sensitive", so no verification is needed.
5. *Audience*: the app starts in **Testing**, where only listed test users
   can sign in. *Add users* → your own Google address. Later, at launch,
   once `privacy.html` is live, click *Publish app*.
6. *Clients → Create client*. Application type **Web application**, name
   `g-sho`. Leave *Authorized JavaScript origins* empty (sign-in runs on the
   server). *Authorized redirect URIs*, add both:
   `https://g-sho.org/api/auth/google/callback` and
   `http://localhost:8787/api/auth/google/callback`. *Create* → copy the
   **Client ID** and **Client secret**.

Then add `GOOGLE_CLIENT_SECRET` to `.dev.vars` and to production with
`npx wrangler secret put GOOGLE_CLIENT_SECRET`.
