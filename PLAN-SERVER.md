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
- `static/_headers`: content-hashed chunks and data files are cached for a
  year (immutable). Data files are requested with `?v=<their data set's
  content hash>` (`meta.json` → `versions`: ent, ja, en, kanji, strokes,
  radk, jadef), so the weekly rebuild only changes the URLs of data sets that
  changed. Kanji, strokes and radicals stay cached across JMdict updates. Everything else
  (the pages, `app.js`, the workers, `meta.json`) is revalidated on every
  load, so an `app.js` from an older deploy can't ask for chunks that are
  gone. (The first version copied GitHub Pages' 10-minute caching for
  everything, and broke the site for a while after deploys.) A page open
  across a deploy reloads once if a chunk is missing (`stale.ts`).
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

## Phase 4 — Sync — done

- `UserStore` Durable Object (SQLite; `src/server/user-store.ts`) with the
  sync logic in `user-data.ts` and per-table schemas in `schema.ts`.
  `/api/sync`; `/api/export` includes the synced data; deleting the account
  erases the Durable Object. **(done)**
- Client `src/client/sync.ts`: rounds of push + pull, triggered on start,
  after changes, on visibility, when back online, and every 5 minutes. A Web
  Lock is shared between tabs. First sign-in (or a different account) sends
  all local data. Status is shown in Settings → Account. **(done)**
- Tabs share changes through a BroadcastChannel (`Table.refresh`). **(done)**
- Tests: `test/sync.test.ts`, with server rules plus two simulated devices
  through the Worker. Checked in two browser profiles against `wrangler dev`.
  **(done)**
- Deployed. It needed the account's workers.dev subdomain (Durable Objects
  require one). The site isn't served there (`workers_dev: false`).
  **(done)**
- Still to do: an option to clear this browser's data on sign-out, and
  purging old tombstones.

## Phase 5 — Study — done

- Tables `decks`, `facts`, `cards`, `reviews` on both sides (client
  `DB_VERSION` 2; server schemas with limits; per-table row counts kept in
  the Durable Object's meta, so syncing a big review log stays fast).
  **(done)**
- `study/model.ts`: the default deck, adding and removing words, and the
  queue (learning cards due within 20 minutes, then due reviews, then new
  cards, within each deck's daily limits; days start at 4 am).
  `study/scheduler.ts`: FSRS via ts-fsrs, loaded only with the study page.
  **(done)**
- A "+ study" button on entries. The header Study button shows the number
  due. `?study` lists decks (counts, options, new deck, rename, delete, which
  deck words go to). `?study=<deck>` / `?study=all` is a session: Space shows
  the answer (the full entry), 1–4 or the buttons answer, with intervals
  shown. **(done)**
- Tests: `test/study.test.ts`. A browser run added words, studied, and
  checked the badge and stored reviews. **(done)**
- Later: undo the last answer, suspending from the session, and
  production cards (meaning → word) for dictionary words.

## Phase 6 — Export to Anki — done

- `anki/apkg.ts`: writes a legacy `.apkg` (collection.anki2, schema 11)
  with sql.js + fflate. FSRS state is mapped to Anki's type, queue, due and
  interval. The FSRS memory goes in the card's `data` (`s`, `d`, `dr`), the
  review log comes along, and note GUIDs are kept. Checked by importing into
  real Anki 26.09 (the `anki` Python package, headless): deck, note type,
  schedules, memory state, review log, and re-importing doesn't duplicate.
  **(done)**
- `study/export.ts`: a deck's words as `g-sho (Japanese)` notes with full
  dictionary fields; "Download .apkg". "Send to Anki" over AnkiConnect adds
  or updates notes (matched by JMdict ID), sets due dates on studied cards
  (`setDueDate`), and suspends suspended ones. **(done)**
- `sql-wasm.wasm` is copied into `dist/` by the build, and sql.js is loaded
  only when exporting. **(done)**
- Tests: `test/apkg.test.ts` reads the package back with node:sqlite.
  **(done)**
- Not tested here: "Send to Anki" against a running Anki (it would change
  your real collection). Dropped: the plain-text (TSV) export; the .apkg
  covers it.

## Phase 7 — Import from Anki — done

- `anki/import/read.ts`: reads `.apkg` / `.colpkg` in every format (schema
  11 `collection.anki2` / `.anki21`, and schema 18 `collection.anki21b` with
  zstd and protobuf config; JSON or protobuf media lists). It runs in a
  worker (`import-worker.ts`: sql.js + fzstd). `read-text.ts` reads Anki's
  plain-text export and plain tab / CSV lists. **(done)**
- `link.ts`: furigana parsing (`食[た]べる`), word and reading fields guessed
  from names (editable in the preview), and lookup in the Japanese index
  ("exact" when word and reading match, "word" otherwise). **(done)**
- `apply.ts`: note types (synced table `noteTypes`; the same name + fields
  give the same id), decks matched by name, facts by GUID (re-import updates
  them and never touches cards you already have), cards with their schedule
  (FSRS memory from `cards.data`, else from interval), suspension, review
  log, and media in a local IndexedDB store. Our own exports come back as
  dictionary words. **(done)**
- `template.ts`: Anki templates (fields, sections, FrontSide, special
  fields, and the text / furigana / kana / kanji / cloze / type / hint
  filters, sounds). `card-frame.ts`: cards in `sandbox="allow-scripts"`
  frames, with media as data URLs, sized to their content. **(done)**
- `?import` page: choose, drop anywhere, paste a file, or paste text; a
  preview (decks, note types with word/reading fields and an example, keep
  schedule); a summary. **(done)**
- Tests: `test/import.test.ts` against packages made by real Anki 26.09
  (`scripts/make-anki-fixtures.py`). In a browser: imported, studied all
  11 cards (image, sound, cloze, reverse cards), drop-to-import and pasted
  text. **(done)**
- Later: exporting imported note types (export reports them as left out),
  media sync (R2), and `[sound:]` autoplay.

## Phase 8 — Duplicates and known words — done

- `study/duplicates.ts`: each card's direction (recognition / production /
  listening / other), from which fields its front template shows, is stored
  on the card at import. Word cards are recognition, cloze cards "other".
  A new card duplicates a studied card with the same word and direction. A
  word marked known matches whichever way the card asks. **(done)**
- The import is now two steps (`prepareImport` links and finds duplicates
  without saving; `commitImport` saves). The second step shows the counts
  and the choices: give duplicates your schedule (default), suspend them
  (with `dupOf`), or keep them new; suspend known words (default) or keep
  them. Repeats within the deck are counted. **(done)**
- Deck options → "Find words you already know": the same for a deck's
  unstudied cards, any time. **(done)**
- New cards for words marked known are left out of study sessions.
  **(done)**
- Tests: `test/duplicates.test.ts` (checked that breaking the copy makes it
  fail). In a browser: studied 猫, marked ありがとう known, imported, and saw 1
  duplicate plus 2 known cards. **(done)**
- Not done: reading known words from your own Anki collection over
  AnkiConnect.

## Card browser and stats — built, not yet deployed

- `?study=browse` (`study/browse.ts`): every card in a virtual list, with
  search (fields and tags), deck, state (due, new, learning, review,
  suspended, duplicates) and sort. A card opens in a dialog with its fields,
  schedule, review history, and actions: move deck, suspend / unsuspend,
  forget, look up, delete. **(done)**
- `?study=stats` (`study/stats-data.ts`, `stats.ts`, `chart.ts`): tiles for
  today (reviews, minutes, new cards), streak, 30-day retention, and card
  counts (new / learning / young / mature / suspended). Column charts for
  reviews per day (30 days, 90 days, a year) and what's due in the next 30
  days, with hover/focus tooltips and a table view. All decks or one.
  **(done)**
- Tests: `test/stats.test.ts`. Checked in a browser, light and dark.
  **(done)**

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
