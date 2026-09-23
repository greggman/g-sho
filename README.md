# g-sho

A Japanese–English dictionary website inspired by [jisho.org](https://jisho.org).
Search in English, Japanese, or romaji, paste a sentence to see its words, or
find kanji by radical.

It's a fully static site. At build time the dictionary is split into small
JSON shards; the browser fetches only the shards a search needs, so it can be
hosted on GitHub Pages or any static file server. See [PLAN.md](PLAN.md) for the
design.

## Development

Requires Node 24 or newer, and Rust with the WebAssembly target for the
handwriting recognizer's kernels (`rustup target add wasm32-unknown-unknown`).

```sh
npm install
npm run download     # fetch the dictionary data and handwriting model into .cache/
npm run build:data   # build the data shards into dist/data/
npm run dev          # build the app, watch for changes, serve at http://localhost:8000
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run build` | Production build of the app into `dist/` |
| `npm run serve` | Build once and serve `dist/` |
| `npm test` | Unit tests, plus end-to-end search tests if `dist/data` is built |
| `npm run lint` / `npm run fix` | gts lint / auto-fix |
| `npm run check` | Typecheck, lint, and test |

## Handwriting recognition

Drawn characters are recognized by a neural network that runs in the browser
on our own inference code (no ML runtime library):

- `scripts/onnx.ts` / `scripts/convert-onnx.ts` convert the ONNX model to our
  format (`model.json` + fp16 `weights.bin`) at build time.
- `src/client/nn/` runs it: WebGPU compute shaders (`webgpu.ts`), with a
  WebAssembly SIMD fallback (`wasm.ts` + `src/wasm/nn.rs`) and a plain
  JavaScript reference (`cpu.ts`), all in a worker.
- `ml/` holds the Python tools used to check our implementation against ONNX
  Runtime (`lt8_reference.py` writes `test/fixtures/lt8-vectors.json`).
  Set it up with `uv venv ml/.venv && uv pip install --python ml/.venv/bin/python onnx onnxruntime numpy pillow svgpathtools`.

Add `?engine=wasm` or `?engine=js` to the URL to force an engine.

## Anki

Click **Anki** in the header and connect: with the Anki app running and the
[AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on installed,
Anki asks whether to allow the site. Then every entry has a [+] to add it.
See PLAN.md for details.

## Deploying

`.github/workflows/deploy.yml` builds the data and the app and deploys `dist/`
to GitHub Pages on every push to `main`, and weekly to pick up dictionary
updates. In the repository settings, set **Pages → Source** to **GitHub Actions**.

## Data and licenses

Dictionary data comes from [JMdict](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project),
[KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project), and
[RADKFILE/KRADFILE](https://www.edrdg.org/krad/kradinf.html) by the
[Electronic Dictionary Research and Development Group](https://www.edrdg.org/)
(CC BY-SA 4.0), stroke order from [KanjiVG](https://kanjivg.tagaini.net/)
(CC BY-SA 3.0), word frequencies from [wordfreq](https://github.com/rspeer/wordfreq)
(CC BY-SA 4.0), with example sentences from [Tatoeba](https://tatoeba.org/)
(CC BY 2.0 FR), via [jmdict-simplified](https://github.com/scriptin/jmdict-simplified).
The handwriting model is [LT8/japanese-handwriting-onnx](https://huggingface.co/LT8/japanese-handwriting-onnx),
trained on the [ETL Character Database](https://etlcdb.db.aist.go.jp/?lang=en)
and subject to its terms; it is downloaded at build time, not stored in this repository.
The generated data files are derived works under the same licenses. The site's
about page carries the attribution.
