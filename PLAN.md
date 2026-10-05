# g-sho — plan

A Japanese–English dictionary website inspired by [jisho.org](https://jisho.org).
Fully static: the dictionary data is preprocessed at build time into many small
JSON shards, and the browser fetches only the shards needed for a query. There is
no server-side code and no database, so it can be hosted anywhere (GitHub Pages).

## Data sources

All sources are the same ones jisho.org credits, consumed through the
[jmdict-simplified](https://github.com/scriptin/jmdict-simplified) JSON builds
(CC BY-SA 4.0), which are regenerated weekly from the upstream files.

| Data | Upstream | License |
| --- | --- | --- |
| Words (JMdict, English glosses) | EDRDG | CC BY-SA 4.0 |
| Kanji (KANJIDIC2) | EDRDG | CC BY-SA 4.0 |
| Radical decomposition (RADKFILE / KRADFILE) | EDRDG | CC BY-SA 4.0 |
| Example sentences linked to word senses | Tatoeba (via JMdict) | CC BY 2.0 FR |
| Stroke order | KanjiVG | CC BY-SA 3.0 |
| Word frequencies (ranking) | wordfreq (Robyn Speer) | CC BY-SA 4.0 |
| Japanese definitions (国語) | Japanese Wiktionary, via wiktextract / kaikki.org | CC BY-SA 4.0 + GFDL |
| More example sentences | Tatoeba word index (jpn_indices) with its Japanese and English sentences | CC BY 2.0 FR |

Attribution for all of them is shown on an About page in the site, as the
licenses require. Later phases may add JMnedict (names) and JLPT word lists.

## Tooling

- TypeScript (6.0.x — typescript-eslint, used by gts, does not support 7 yet)
- [gts](https://github.com/google/gts) for lint + formatting
- esbuild to bundle the client
- Node 24 runs the build scripts `.ts` directly (native type stripping) and
  runs the tests with `node --test`
- GitHub Actions: lint, test, download data, build shards, bundle, deploy to
  Cloudflare (originally GitHub Pages; see PLAN-SERVER.md). The dictionary
  files are generated in CI and are not committed.

## Layout

```
src/shared/     code used by both the data builder and the browser
                (hash, text normalization, kana helpers, data types)
src/client/     browser app (search, romaji→kana, deinflection, sentence
                segmentation, rendering)
scripts/        download.ts, build-data.ts, build.ts (esbuild; --watch/--serve)
static/         index.html, about.html, style.css
test/           node:test unit tests
.github/workflows/deploy.yml
```

## Static data format

Everything under `dist/data/`, produced by `scripts/build-data.ts`.

- **Entries** `ent/NNNN.json` — compact JMdict entries (short keys, empty fields
  dropped), sharded by `id % 8192` (~4 KB each).
- **Japanese index** `ja/NNNN.json` — `{ key: [entryId, ...] }`. An id is stored
  negated when the matched form is marked common, so results can be ranked
  before any entries are fetched. Keys are every
  kanji and kana form, normalized (katakana→hiragana, full-width→half-width,
  lowercase). The shard is `fnv1a(bucket) % JA_SHARDS`, where `bucket` is the
  first two characters of the key (or the one character for one-character keys).
  So a shard holds every key that starts with the same two characters, which
  gives prefix search ("たべ" → たべる, たべもの, …) from a single fetch.
- **English index** `en/NNN.json` — `{ word: [[entryId, score], ...] }` built
  from gloss tokens (stop words dropped), sharded by `fnv1a(word)`. Scores favor
  a gloss that is exactly the word, common entries, and early senses. Lists are
  capped so shards stay small.
- **Kanji** `kanji/NNN.json` — KANJIDIC2 details sharded by code point.
- **Stroke order** `strokes/NNNN.json` — KanjiVG stroke paths per character,
  in stroke order, sharded by code point. Each kanji card draws them as a row
  of frames like jisho: earlier strokes gray, the new one highlighted with a
  dot where it starts.
- **Radicals** `radk.json` — radical → kanji list plus stroke counts, loaded only
  when the radical picker is opened.
- `meta.json` — shard counts, data version and date. The client reads the shard
  counts from here, so they can be tuned without changing code.

Shard counts are chosen so a typical shard is 4–16 KB before gzip. The full
build is ~11,400 files, ~60 MB. A word lookup fetches about 5–10 files, and a
sentence about 20.

## Search behavior (like jisho)

One search box, `?q=` in the URL (history and shareable links).

1. **Japanese input** (kana/kanji): exact matches first, then prefix matches.
   Ranked by exact/prefix, common flag, whether the matched form is the
   entry's main spelling, and word frequency. Frequency is mainly
   wordfreq's Japanese data (subtitles, Wikipedia, web text; pinned to a
   commit), which counts spellings: when entries share one (上 is うえ, かみ,
   じょう), its owner — the entry whose main spelling it is, with the best
   JMdict priority — gets full credit and the others much less. JMdict's
   priority tags (from the original XML, since the JSON build keeps only a
   common flag) add to it, with sense count as a tie-breaker.
2. **Romaji input**: converted to kana (Hepburn + wāpuro spellings) and searched
   as Japanese, *and* searched as English. The better exact hit set is shown first.
3. **English input**: each word is looked up in the English index. Short glosses
   are also indexed as whole phrases, so a multi-word query first finds exact
   phrase matches ("ice cream"), then entries ranked by how many of the words
   they contain.
4. **Inflected words**: a rule-based deinflector (Yomichan-style suffix rules
   with part-of-speech checks) maps 食べました → 食べる, 高かった → 高い, etc.
   Results show a note like "食べました is an inflection of 食べる: 食べる →
   polite → past".
5. **Sentences**: Japanese input that isn't a single word is segmented by
   greedy longest match against the index (with deinflection at each
   position). Unlike jisho, where you click each word in turn, every word is
   shown at once: the sentence with furigana at the top, then a compact card
   per word (furigana, dictionary form and inflection, first meanings) with
   the full entry and other possible matches in a `<details>`. Words written
   in kana prefer entries usually written in kana (は → the particle, not 歯).
6. **Kanji panel**: kanji in the query and in the results show a side panel
   with meanings, on/kun readings, stroke count, grade, JLPT level, frequency
   and components (from KRADFILE).
7. **Radical picker**: pick radicals to narrow down kanji; clicking a kanji
   adds it to the search box.
8. Each entry shows readings (furigana over the primary form), common tag,
   senses with part of speech, tags/notes, other forms, and Tatoeba example
   sentences where JMdict links them.

## Handwriting input

Draw a character to look it up. Recognition is image-based: the strokes are
rasterized and a neural network classifies the picture, so stroke count, order
and direction don't matter (unlike stroke-matching recognizers such as the one
jisho.org uses).

- **Recognizer interface** (`src/client/handwriting/`): the drawing pad records
  strokes as point lists in normalized [0, 1] coordinates and hands them to a
  `Recognizer`, which returns ranked candidate characters. Recognizers are
  swappable, so different models can be compared on the same drawing.
- **Model A — LT8/japanese-handwriting-onnx** (Hugging Face): a ResNet trained
  on the ETL Character Database (real handwriting from ~4,000 writers). It covers
  3,082 classes: JIS level 1 kanji, hiragana and katakana. It reports 99.7% top-1
  on canvas drawings. We use the fp16 weights; the int8 weights misrank
  confusable pairs on hand-drawn input. They are downloaded in CI, pinned to a
  Hugging Face revision, and not committed.
  License caveat: ETL's terms require citation and forbid redistributing the
  data; they don't address trained models.
- **Our own inference, no runtime library**: at build time a small TypeScript
  ONNX reader converts the network (Conv, ReLU, Add, BatchNorm, global average
  pool, Gemm) to `model.json` plus fp16 `weights.bin` (15 MB). The graph's
  preprocessing (contrast stretch, ink bounding box, square crop, bilinear
  resize to 96×96) is reimplemented in `lt8-preprocess.ts`. Engines, all in a
  worker:
  - WebGPU compute shaders: ~20 ms per recognition.
  - WebAssembly SIMD kernels written in Rust (a 4 KB module): ~50 ms.
  - Plain JavaScript reference: seconds; used for testing.
  All three are tested against ONNX Runtime's output on the real model
  (`ml/lt8_reference.py` → `test/fixtures/lt8-vectors.json`).
- **Model B — our own, license-clean** (next): a CNN trained on synthetic
  handwriting. Strokes from KanjiVG (CC BY-SA 3.0) are rendered with random
  per-stroke jitter, slant, thickness, and occasionally joined strokes, mixed
  with glyphs from OFL-licensed handwriting fonts. It is trained locally with
  PyTorch (MPS) and covers ~6,400 kanji plus kana. The two models are then
  compared side by side on real drawings before choosing one.
- **Loading**: nothing handwriting-related loads until the panel is opened;
  then the worker, the 4 KB WASM module (if needed) and the 15 MB model load.
- **UI**: a pad with Undo and Clear. It recognizes after each stroke and shows
  candidates as buttons; picking one inserts it into the search box, the same
  way the radical picker does.

## Home-screen app (PWA)

- `static/manifest.webmanifest` (name, standalone display, theme colors, a
  Study shortcut) and PNG icons in `static/icons/` (the green 書: 180 px for
  iOS's apple-touch-icon, 192 and 512 px, and a 512 px maskable one with the
  glyph inside the safe zone). iOS ignores SVG icons, so the PNGs are drawn
  from the same design and committed.
- Every page has the manifest, the apple-touch-icon, `apple-mobile-web-app-*`
  tags and light/dark `theme-color`. The viewport is `viewport-fit=cover`,
  with padding from `env(safe-area-inset-*)` for the notch and home
  indicator.
- A home-screen app has no browser back button, so in `display-mode:
  standalone` a ‹ button shows before the logo whenever there's an earlier
  g-sho page (history state carries the depth).
- **Offline** (`src/client/sw.ts`, a service worker; `scripts/build.ts`
  builds `sw.js` with the build's id and file list from esbuild's metafile,
  so every deploy changes it):
  - At install, it saves the whole current build: the pages, app.js, CSS,
    workers, icons and every chunk. So every screen opens offline.
  - App files and pages are network first: online you always get the
    current deploy (no stale app.js); the saved copy only when offline. A
    search URL (`/?q=…`) offline is the saved app page.
  - Chunks: saved copy first. Old builds' chunks are kept for a week, so a
    page opened before a deploy still loads them (and stale.ts reloads it if
    one is missing anyway).
  - Data: saved copy first (versioned URLs). When `meta.json` lists new
    versions, saved files of other versions are deleted. So words you've
    looked up work offline. The handwriting model and sql.js's wasm: saved,
    refreshed in the background. `/api/` is never cached.
  - It takes over at once (skipWaiting + clients.claim). Old caches are
    deleted on activation.
  - Not registered in local dev (it would get in the way of rebuilds)
    unless turned on with `?sw` (`?sw=0` turns it off).
  - Offline, a search that needs data not yet saved says so.
- **The whole dictionary offline** (`src/client/offline/`): once the
  service worker is running, a background worker downloads every data set
  as "packs" (`data/pack/<set>-<i>.txt`, ~4 MB each, 28 in all; format in
  `src/shared/pack.ts`; counts in `meta.json` → `packs`). It unpacks each
  into the service worker's data cache under the exact URLs the app asks
  for. That's about 34 MB to download (Brotli; 49 MB if fetched file by
  file) and ~120 MB stored. It goes one pack at a time at low fetch
  priority, so the user's own lookups go first, in the order search indexes,
  entries, kanji, strokes, Japanese definitions, examples. Finished packs
  are recorded, so it resumes. It starts automatically, except with Data
  Saver on or on a connection the browser reports as cellular. Settings →
  Offline shows progress, has "Download now", and an off switch that frees
  the space.
- Data sets whose version changes (most do weekly) download again in
  full. Per-file updates would make that smaller; maybe later.

## More example sentences

JMdict links Tatoeba sentences to only about 29,000 of its 218,000 entries.
Tatoeba's word index (`jpn_indices.csv`, Tanaka-corpus "B lines") tags
~150,000 Japanese sentences, each with an English translation, with the
dictionary words in them: `word(reading)[sense]{form}~`, where ~ marks a
checked example. `scripts/build-examples.ts` matches each word to its JMdict
entry (by spelling, the reading choosing between homographs), and keeps up to
10 sentences per entry. Checked sentences come first, then shorter ones, and
ones JMdict already shows are skipped. Furigana comes from Tatoeba's
transcriptions. That adds 97,000 sentences for 18,000 entries (half the
common words), in `tex/NNNN.json` (4,096 shards by entry id, ~13 MB).

Each entry records how many more it has (`mx`, Tatoeba plus the Japanese
Wiktionary's examples), and shows "N more example sentences", which loads
them when opened. Wiktionary's are Japanese only, with every word linked.

## Japanese definitions (国語)

For learners moving on to a Japanese–Japanese dictionary: a display setting
("Japanese definitions") shows definitions in Japanese above the English
ones. Turning off English meanings then gives a Japanese-only dictionary.

- **Source**: the Japanese Wiktionary, as extracted to JSON by wiktextract
  (kaikki.org, ~65 MB, CC BY-SA + GFDL), downloaded by `npm run download`.
  The commercial 国語辞典 (大辞林, 大辞泉, 明鏡, …) can't be redistributed.
- **Matching** (`scripts/build-jawiktionary.ts`): a JMdict entry gets a
  Wiktionary entry through a kanji spelling (following "〜の漢字表記"
  pointers to the kana word with the same reading, or an entry listing one
  of its readings), or else its reading (only if the Wiktionary entry lists
  one of its kanji spellings, or the word is written in kana, so homophones
  stay apart). Senses marked for particular readings (【うえ、かみ】, （セイ）)
  go only to those readings. About 69,000 entries get definitions, including
  84% of common words. Shards: `jadef/NNNN.json` (2,048 by entry id, ~6 MB).
- **Display** (`src/client/japanese.ts`): definitions with labels and example
  sentences, shown as text first, then split into words like a pasted
  sentence. Each word links to its entry, with furigana over its kanji
  (Wiktionary's own furigana hints first). Sentence cards show the first two
  senses.

## History, settings, undo

- **History**: every search is kept in localStorage (newest first, repeats
  move to the top, up to 10,000) with a snapshot of its top result: the word
  with furigana, then its meaning. On wide screens (≥1180px) it's a sticky
  column beside every page, with the word on screen highlighted, so earlier
  lookups are one click away while reading; picking one doesn't move it to
  the top, so the list doesn't reshuffle. On narrower screens it's on the
  home page. The list is virtual (only the rows in view exist), so thousands
  scroll smoothly. Rows can be removed one by one or all at once.
- **Settings** (gear button): turn off English meanings (blurred; tap one to
  reveal it, for practice), furigana (shown on hover), example sentences,
  kanji details, stroke order, and the home-page history. Applied as
  `hide-*` classes on `<html>`, so no re-render. The Anki settings are here
  too.
- **Undo** for the search box: our own undo history covers what the
  browser's misses (text inserted by the handwriting and radical pickers,
  the query replaced when a search loads). Typing and deleting group into
  steps like an editor; handles Ctrl/Cmd+Z, redo, and the browser's own
  undo commands (historyUndo input events, e.g. shake to undo).

## Anki

Connect from the Anki section of Settings. A [+] on every entry then adds
the word to Anki; ✓ means it's already there and
opens "Update in Anki" (overwrite the note) and "Show in Anki".

- **Transport**: the page talks directly to the AnkiConnect add-on on
  `http://127.0.0.1:8765`; no browser extension needed. AnkiConnect's
  `requestPermission` accepts any origin and shows a dialog in Anki; saying
  yes adds our origin to its allow list. It also answers Private/Local Network
  Access preflights. Browsers may additionally ask the user to allow access to
  local network devices.
- **Nothing contacts Anki until the user clicks Connect** in Settings,
  so visitors without Anki never see a prompt.
- **Defaults that just work**: a `g-sho` deck and a `g-sho (Japanese)` note
  type (Word, Reading, Furigana, Meaning, PartOfSpeech, Example, JMdictId,
  Link; one recognition card using Anki's furigana filter), both created on
  the first add.
- **Options**: any existing deck; any existing note type, with a per-field
  choice of what to put in it (guessed from field names: Front/Back,
  Expression/Reading/Meaning, …). Settings are kept in localStorage.
- **Duplicates**: found by the JMdict ID field when the note type has one,
  otherwise by the word field; all entries on a page are checked in one
  `multi` request.

## Phases

**Phase 1 (done)**: scaffolding (package.json, gts, tsconfig, esbuild),
download + data build pipeline, shard format, client search (Japanese,
romaji, English, deinflection, sentence segmentation), entry rendering with
examples, kanji panel, radical picker, About/attribution page, unit tests,
GitHub Actions deploy.

**Later**:
- Full Tatoeba sentence search (not just sentences linked to senses)
- JMnedict name search
- JLPT tags on words
- Wildcard search (`*`, `?`) and `#tag` filters
- Better segmentation (a kuromoji/MeCab-style morphological analyzer) if greedy
  matching proves too weak
- Offline use (service worker cache of fetched shards)
