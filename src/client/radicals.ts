import type {RadicalData} from '../shared/types.ts';
import {h} from './dom.ts';

/** Most kanji shown at once; a big result set means more radicals are needed. */
const MAX_KANJI = 300;

/**
 * The radical picker: select radicals to find kanji that contain all of them.
 * Radicals that can't be combined with the current selection are disabled.
 */
export class RadicalPicker {
  readonly element: HTMLElement;
  private readonly kanjiByRadical: Map<string, Set<string>>;
  private readonly selected = new Set<string>();
  private readonly radicalButtons = new Map<string, HTMLButtonElement>();
  private readonly results: HTMLElement;
  private readonly data: RadicalData;
  private readonly onPick: (kanji: string) => void;

  constructor(data: RadicalData, onPick: (kanji: string) => void) {
    this.data = data;
    this.onPick = onPick;
    this.kanjiByRadical = new Map(
      Object.entries(data.kanji).map(([r, k]) => [r, new Set(Array.from(k))]),
    );
    this.results = h('div', {class: 'radical-results', lang: 'ja'});

    const grid = h('div', {class: 'radical-grid', lang: 'ja'});
    let strokes = 0;
    for (const [radical, count] of data.radicals) {
      if (count !== strokes) {
        strokes = count;
        grid.append(h('span', {class: 'stroke-count'}, String(count)));
      }
      const button = h(
        'button',
        {
          type: 'button',
          class: 'radical',
          'aria-pressed': 'false',
          onclick: () => this.toggle(radical),
        },
        radical,
      );
      this.radicalButtons.set(radical, button);
      grid.append(button);
    }

    this.element = h(
      'div',
      {class: 'radical-picker'},
      h(
        'div',
        {class: 'radical-toolbar'},
        h('span', null, 'Select radicals to find kanji'),
        h(
          'button',
          {type: 'button', class: 'reset', onclick: () => this.reset()},
          'Reset',
        ),
      ),
      this.results,
      grid,
    );
    this.update();
  }

  private toggle(radical: string) {
    if (this.selected.has(radical)) {
      this.selected.delete(radical);
    } else {
      this.selected.add(radical);
    }
    this.update();
  }

  private reset() {
    this.selected.clear();
    this.update();
  }

  private matches(): Set<string> | undefined {
    let result: Set<string> | undefined;
    for (const r of this.selected) {
      const kanji = this.kanjiByRadical.get(r)!;
      result = result
        ? new Set([...result].filter(k => kanji.has(k)))
        : new Set(kanji);
    }
    return result;
  }

  private canCombine(matches: Set<string>, kanji: Set<string>): boolean {
    for (const k of matches) {
      if (kanji.has(k)) return true;
    }
    return false;
  }

  private update() {
    const matches = this.matches();
    for (const [radical, button] of this.radicalButtons) {
      const selected = this.selected.has(radical);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled =
        !selected &&
        matches !== undefined &&
        !this.canCombine(matches, this.kanjiByRadical.get(radical)!);
    }

    this.results.replaceChildren();
    if (!matches) return;
    const byStrokes = [...matches].sort(
      (a, b) => (this.data.strokes[a] ?? 99) - (this.data.strokes[b] ?? 99),
    );
    let strokes = 0;
    for (const k of byStrokes.slice(0, MAX_KANJI)) {
      const count = this.data.strokes[k] ?? 0;
      if (count !== strokes) {
        strokes = count;
        this.results.append(h('span', {class: 'stroke-count'}, String(count)));
      }
      this.results.append(
        h(
          'button',
          {type: 'button', class: 'kanji', onclick: () => this.onPick(k)},
          k,
        ),
      );
    }
    if (byStrokes.length > MAX_KANJI) {
      this.results.append(
        h('span', {class: 'more'}, `…and ${byStrokes.length - MAX_KANJI} more`),
      );
    }
  }
}
