# g-sho — sync server design

Optional accounts that sync study data (marked words, notes, decks, cards,
reviews, history, settings) between a person's devices. Study happens in the
browser with FSRS. Anki decks can be imported and exported.

The dictionary itself stays static. Without an account (or if the server is
down) the site works as it does today, and the data is kept only in that
browser.

## Goals and non-goals

- **Local-first.** Everything is stored in the browser (IndexedDB) and works
  offline. The server is a sync target and never the only copy.
- **Anki-shaped data.** Internally, study data uses Anki's model of note
  types, notes, cards, decks and a review log. Our own "add word" notes are
  just notes of a built-in note type. So importing an Anki deck loses nothing,
  and exporting one back is close to lossless.
- **Cheap and hard to abuse.** No passwords, strict schemas, per-user caps,
  rate limits.
- **Not a goal:** syncing with AnkiWeb. It has no public API. We exchange
  data with Anki through files (.apkg) and through AnkiConnect instead.

## Hosting

g-sho.org is currently served by GitHub Pages. Its DNS moves to Cloudflare, and
one Worker serves everything:

- the static site (`dist/`, ~12,500 files and ~125 MB) as Workers Static
  Assets. Static asset requests are free and don't run the Worker.
  The file-count limits are 20,000 files on Free and 100,000 on Paid.
- `/api/*`, handled by the Worker.

Same origin means no CORS, first-party cookies (Safari and Firefox block
third-party ones), and OAuth redirects back to g-sho.org itself.

Everything lives in its own Cloudflare account ("g-sho"), so billing, API
tokens and resources are separate from any other projects. Environments:
`production` (g-sho.org) and local (`wrangler dev`, with local storage
simulated by Miniflare). A `staging` environment on workers.dev can be added
later if it's needed.

**Deploys stay push-to-main.** The GitHub Actions workflow builds and tests as it
does now, then runs `wrangler deploy` in place of the Pages upload. That one
command uploads the changed static files and the Worker together (and D1
migrations run first). Pull requests only build and test. The weekly
scheduled rebuild for new dictionary data keeps working unchanged. GitHub Pages is
turned off once g-sho.org points at the Worker.

The client checks `/api/me`. If that isn't there (a plain static host), the
Sign in button is hidden and the app stays local-only.

## Storage: D1 for accounts, one Durable Object per user for data

- **D1** (a shared SQLite database) holds only the small, global tables:
  users, the sign-in identities linked to them, and sessions.
- **A Durable Object per user** (`UserStore`, with SQLite storage) holds that
  user's study data. Requests are routed to it by user ID.

Why not put everything in D1, as the first notes suggested: imported decks make
the data much larger. Core 6k with its example sentences is several MB per user,
and one D1 database tops out at 10 GB. A per-user Durable Object has its own
10 GB and handles one request at a time. That makes the sync sequence counter
trivially correct (no races between a user's devices). It also makes account
deletion a single `deleteAll()` and puts each user's data near where they use it.
The cost is that schema migrations are run in code when the object starts,
using a version number kept in its storage.

Media files (images and audio from imported decks) go in **R2**, in a later
phase (see Media).

## Accounts and abuse protection

- **Sign in with GitHub (OAuth).** We never store passwords. Google sign-in
  and email magic links can come later (magic links need an email sender).
- Identities (`provider`, `subject`) map to a user. Accounts are never
  auto-linked by email address, because that allows account takeover.
  A signed-in user can link a second provider.
- **Sessions** are a random 256-bit token in an `HttpOnly; Secure;
  SameSite=Lax` cookie. D1 stores only its SHA-256, with an expiry. Requests
  that change something must also have a matching `Origin` and a JSON body.
- **Cloudflare Turnstile** (a free captcha) on first sign-up, if bot accounts
  show up. OAuth already filters most of them.
- **Strict schemas and limits.** Only known fields are accepted. Caps (these
  are starting values):

  | What | Cap |
  | --- | --- |
  | Notes per user | 100,000 |
  | Cards per user | 200,000 |
  | One note's fields, total | 32 KB |
  | Word note text | 2,000 characters |
  | Note type templates + CSS | 64 KB |
  | Review log rows | 2,000,000 |
  | History items | 10,000 |
  | Sync request body | 5 MB |
  | Media (later) | 500 MB per user, images and audio only |

- **Rate limits** use Cloudflare's rate-limiting binding. They're keyed by user
  for the API and by IP for the sign-in endpoints.
- **Account deletion and data export** (`DELETE /api/me`, `GET /api/export`
  as JSON). Plus a privacy page.

## Data model

Every synced table has these columns:

| Column | Meaning |
| --- | --- |
| `id` | Generated by the client (random, base64url), so rows can be created offline |
| `mtime` | Client time (ms) of the last change; used for last-write-wins |
| `seq` | Server sequence number assigned when the row is stored; used as the pull cursor |
| `deleted` | Tombstone flag; deleted rows are kept so deletions sync |

Tables (per user, in the UserStore):

- **word_marks**: `word_id` (JMdict entry sequence number, which is stable),
  `kind` (`star`, `known`, …). "Known" is how you say "don't make me study
  this".
- **word_notes**: `word_id`, `text`.
- **history**: `q`, time, and a snapshot of the top result (the same fields as
  today's localStorage history).
- **settings**: one row per settings group (display, Anki, study), as JSON.
- **note_types**: `name`, `fields` (names, in order), `templates` (name,
  front, back), `css`, `kind` (standard/cloze), `anki_id` (the Anki model ID it
  came from, if any). Built in: `g-sho (Japanese)`, the same note type the
  AnkiConnect integration already creates.
- **decks**: `name` (Anki style, `::` for subdecks), `options` (new cards per
  day, review limit, desired retention, FSRS parameters), `source`
  (where it was imported from and when).
- **notes**: `note_type_id`, `fields` (array of strings, HTML), `tags`,
  `guid` (Anki's note GUID; kept so re-importing an updated deck updates notes
  instead of duplicating them, and exported notes update in Anki),
  `word_id` (link to the dictionary entry, may be empty), `link_confidence`.
- **cards**: `note_id`, `deck_id`, `ord` (which template), `direction` (see
  duplicates), FSRS state (`due`, `stability`, `difficulty`, `reps`, `lapses`,
  `state`, `last_review`), `queue` flags (suspended, buried), `dup_of`.
- **reviews** (append-only): `card_id`, time, rating, duration, and the state
  before and after. Rows are never changed, so syncing is a set union, and
  any card's schedule can be rebuilt from its reviews.

## Sync protocol

`POST /api/sync` with `{since, push: {table: rows[]}}` returns
`{rows: {table: rows[]}, cursor, more}`.

1. The server applies the pushed rows. A row replaces the stored one if its
   `mtime` is newer (ties go to the larger client ID). Reviews are
   insert-if-missing. Every stored row gets the next `seq`. Times more than a
   minute in the future are clamped to now.
2. It returns the rows with `seq > since`, in pages of about 2,000.
   The client repeats until `more` is false, then saves `cursor`.
3. The client tracks which rows are dirty. It syncs on startup, after changes
   (debounced), on `visibilitychange`, and when it comes back online.

Cards get special treatment. If two devices reviewed the same card offline,
the one with the later `last_review` wins, and both reviews are kept. Rebuilding
the card from its merged review log is a later improvement.

On first sign-in, the data already in the browser is pushed into the account,
so nothing is lost. Signing out keeps the local copy, and the user can choose
to clear it.

## Scheduling

FSRS via [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (MIT),
run in the browser. FSRS is what modern Anki uses, so the card state maps onto
Anki's directly. The server only stores the state and never schedules.
Days roll over at 4 am local time, like Anki, for the daily new/review limits.

## Studying and card rendering

- Cards of our built-in note type are drawn by our own code, with the
  display settings (furigana on/off, …) applied.
- Imported note types are Anki templates: `{{Field}}`, `{{#F}}…{{/F}}`,
  `{{^F}}`, `{{FrontSide}}`, `{{furigana:F}}`, `{{kana:F}}`, `{{kanji:F}}`,
  `{{text:F}}`, `{{cloze:F}}`, `{{type:F}}`, `{{hint:F}}`, `{{tts …}}`, and
  `[sound:x.mp3]`. Deck templates are someone else's HTML and often include
  scripts. So they're rendered in a **sandboxed iframe** (`sandbox=
  "allow-scripts"`, no same-origin), which can't read our cookies or storage.
  Media is passed into the frame rather than loaded from our origin.

## Anki import

What can be imported:

- **.apkg** (a deck) and **.colpkg** (a whole collection), from a file picker,
  drag and drop anywhere on the page, or pasting a copied file.
- **Plain text** exported from Anki ("Notes in Plain Text"), pasted or dropped.
  Its `#separator:`, `#html:`, `#columns:`, `#notetype column:`, … headers are
  read.

All parsing is done in the browser, in a Web Worker, so the server never
accepts uploaded deck files. The worker loads the libraries only when needed:
fflate (zip), fzstd (zstd), and sql.js (SQLite in WebAssembly, ~1 MB).
Anki has several package formats, and we read all of them:

| Inside the .apkg | Anki version | Notes |
| --- | --- | --- |
| `collection.anki2` | old | Schema 11; note types and decks are JSON in the `col` table |
| `collection.anki21` | 2.1.x | Same schema, newer features |
| `collection.anki21b` | 23.10+ | zstd-compressed, schema 18; note types, fields, templates and decks are in their own tables, with protobuf `config` blobs (a small protobuf reader is needed) |

When `anki21b` or `anki21` exists, it wins over the `anki2` file next to it.
That `anki2` file is a placeholder that says "please update Anki".
The `media` map is JSON in the old format, and zstd-compressed protobuf in the
new one.

What's imported: note types, notes (with GUIDs), cards, decks (the hierarchy
flattened or kept), tags, and, when the export included scheduling, card state
and review log. Shared decks from AnkiWeb normally have no scheduling, so
their cards come in as new. When scheduling is present:

- if a card has FSRS memory state (`cards.data` holds `s` and `d`, Anki
  23.10+), use it;
- otherwise, if there are reviews, replay them with ts-fsrs;
- otherwise, convert the SM-2 interval and ease to an approximate FSRS state.

**Linking notes to the dictionary.** For each note type, pick the word field and the
reading field. The guesses reuse the AnkiConnect field-name heuristics
(`guessSource`), and the user can change them in the import preview. Then
normalize the values: strip HTML, turn `食[た]べる` furigana into text plus a
reading, and remove spaces. Look them up in the Japanese index, and prefer the
entry that matches both word and reading, then common entries. Store `word_id`
with a confidence: exact, word only, or none. Notes that don't match are still
imported, just unlinked.

Re-importing a deck matches notes by GUID. It updates their fields and keeps
the user's review progress.

## Duplicates and known words

There's nothing worse than a deck that wastes your time on words you already
know. A card's **direction** says what it tests. It's inferred from the template:
the word on the front is `recognition`, the meaning on the front is
`production`, and only audio on the front is `listening`. Two cards are
duplicates when they have the same `word_id` and the same direction.

A word counts as **known** if it's marked known, or if one of its cards in
that direction is mature (stability of 21 days or more, which is Anki's
"mature"). Optionally, known words can also be read from the user's own
Anki collection over AnkiConnect (`findCards` + `cardsInfo`).

At import, and on demand for any deck ("Find duplicates"), each duplicate
gets one of these, chosen per import with a preview of the counts:

- **Copy schedule** (the default): the new card takes the existing card's
  FSRS state and due date. So a word you know doesn't show up for a long time,
  but you still study it in the new deck's format.
- **Suspend**: `dup_of` points at the existing card and the new card is
  suspended. This saves the most time and can be undone.
- **Keep as new**: do nothing.

Words marked known with no card get "suspend" or "keep".
Duplicates *within* one deck (the same word twice) are listed for review.

## Anki export

- **AnkiConnect** (extends the existing integration): create the deck and the
  note types (`createModel` with their templates and CSS), `addNotes` in
  batches, upload media with `storeMediaFile`, and set due dates with
  `setDueDate`. Notes that are already there (found by GUID, or by JMdict ID
  for our note type) are updated, not duplicated. AnkiConnect can't set FSRS
  memory state, so full schedules go through .apkg.
- **.apkg file**: written in the browser with sql.js and fflate, in the legacy
  `collection.anki2` format (schema 11), which every Anki version imports.
  It includes GUIDs, card state, the review log (Anki recomputes FSRS memory
  state from it), and media.
- **Plain text** (TSV with Anki's headers) as a simple fallback.

## Media (later phase)

At first, media from imported decks is kept only in the browser (OPFS) and
isn't synced. On another device those cards show a "media not on this device"
placeholder. Later:

- Media is stored in R2 by SHA-256, so the same file from a popular deck is
  stored once. There's a per-user reference table and quota. Only image and
  audio types are accepted, with a size cap per file.
- It's served by the Worker only to users who reference it, with long cache
  headers because the content never changes.

## API summary

| Method | Path | |
| --- | --- | --- |
| GET | `/api/health` | liveness |
| GET | `/api/auth/github/start` | redirect to GitHub (state cookie) |
| GET | `/api/auth/github/callback` | create or find the user, set the session cookie |
| POST | `/api/auth/logout` | |
| GET | `/api/me` | current user or 401 |
| DELETE | `/api/me` | delete the account and all its data |
| GET | `/api/export` | all data as JSON |
| POST | `/api/sync` | push + pull |
| PUT/GET | `/api/media/:sha256` | later |
