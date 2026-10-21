/**
 * The interface in Japanese: English text → Japanese, by part of the app.
 * Keys are the exact English passed to t() (with its {placeholders});
 * "html:<name>" entries are HTML for data-t-html in index.html.
 */
import {JA_ANKI} from './anki.ts';
import {JA_APP} from './app.ts';
import {JA_CORE} from './core.ts';
import {JA_RESULTS} from './results.ts';
import {JA_STUDY} from './study.ts';

export const JA: Record<string, string> = {
  ...JA_CORE,
  ...JA_APP,
  ...JA_RESULTS,
  ...JA_STUDY,
  ...JA_ANKI,
};
