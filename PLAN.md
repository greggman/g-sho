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

Attribution for all of them is shown on an About page in the site, as the
licenses require. Later phases may add JMnedict (names) and JLPT word lists.

## Tooling

- TypeScript (6.0.x — typescript-eslint, used by gts, does not support 7 yet)
- [gts](https://github.com/google/gts) for lint + formatting
- esbuild to bundle the client
- Node 24 runs the build scripts `.ts` directly (native type stripping) and
  runs the tests with `node --test`
- GitHub Actions: lint, test, download data, build shards, bundle, deploy to
  GitHub Pages. The dictionary files are generated in CI and are not committed.

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

## History, settings, undo

- **History**: every search is kept in localStorage (newest first, repeats
  move to the top, up to 10,000) with a snapshot of its top result, and
  listed on the home page: the word with furigana, then its meaning. The
  list is virtual (only the rows in view exist), so thousands scroll
  smoothly. Rows can be removed one by one or all at once.
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
