# g-sho

A Japanese–English dictionary website inspired by [jisho.org](https://jisho.org).
Search in English, Japanese, or romaji, paste a sentence to see its words, or
find kanji by radical.

It's a fully static site. At build time the dictionary is split into small
JSON shards; the browser fetches only the shards a search needs, so it can be
hosted on GitHub Pages or any static file server. See [PLAN.md](PLAN.md) for the
design.

## Development

Requires Node 24 or newer.

```sh
npm install
npm run download     # fetch the latest dictionary data into .cache/
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

## Deploying

`.github/workflows/deploy.yml` builds the data and the app and deploys `dist/`
to GitHub Pages on every push to `main`, and weekly to pick up dictionary
updates. In the repository settings, set **Pages → Source** to **GitHub Actions**.

## Data and licenses

Dictionary data comes from [JMdict](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project),
[KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project), and
[RADKFILE/KRADFILE](https://www.edrdg.org/krad/kradinf.html) by the
[Electronic Dictionary Research and Development Group](https://www.edrdg.org/)
(CC BY-SA 4.0), with example sentences from [Tatoeba](https://tatoeba.org/)
(CC BY 2.0 FR), via [jmdict-simplified](https://github.com/scriptin/jmdict-simplified).
The generated data files are derived works under the same licenses. The site's
about page carries the attribution.
