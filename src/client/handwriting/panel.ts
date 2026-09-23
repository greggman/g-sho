import {h} from '../dom.ts';
import {drawStroke, drawStrokes} from './raster.ts';
import type {Candidate, Point, Stroke} from './types.ts';
import {WorkerRecognizer} from './worker-recognizer.ts';

/** Candidates shown per recognizer. */
const CANDIDATES = 10;
/** Pen width as a fraction of the pad, matching what the model sees (14 / 320). */
const PEN_WIDTH = 14 / 320;

/**
 * The handwriting panel: a drawing pad, Undo/Clear, and candidate
 * characters from each recognizer. Picking a candidate calls onPick.
 */
export class HandwritingPanel {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly status: HTMLElement;
  private readonly results: HTMLElement;
  private readonly recognizers: WorkerRecognizer[];
  private readonly onPick: (char: string) => void;
  private strokes: Stroke[] = [];
  private current: Stroke | undefined;
  /** a recognition is running; another is needed when it finishes */
  private busy = false;
  private again = false;

  constructor(recognizers: WorkerRecognizer[], onPick: (char: string) => void) {
    this.recognizers = recognizers;
    this.onPick = onPick;
    this.canvas = h('canvas', {
      class: 'handwriting-pad',
      'aria-label': 'Draw a character',
      role: 'img',
    });
    this.ctx = this.canvas.getContext('2d')!;
    this.status = h(
      'p',
      {class: 'handwriting-status'},
      'Loading handwriting model…',
    );
    this.results = h('div', {class: 'handwriting-results', lang: 'ja'});
    this.element = h(
      'div',
      {class: 'handwriting-panel'},
      h(
        'div',
        {class: 'handwriting-left'},
        h('div', {class: 'handwriting-pad-frame'}, this.canvas),
        h(
          'div',
          {class: 'handwriting-buttons'},
          h('button', {type: 'button', onclick: () => this.undo()}, 'Undo'),
          h('button', {type: 'button', onclick: () => this.clear()}, 'Clear'),
        ),
      ),
      h(
        'div',
        {class: 'handwriting-right'},
        h(
          'p',
          {class: 'handwriting-hint'},
          'Draw a character. Stroke order and direction don’t matter.',
        ),
        this.results,
        this.status,
      ),
    );

    this.canvas.addEventListener('pointerdown', e => this.down(e));
    this.canvas.addEventListener('pointermove', e => this.move(e));
    this.canvas.addEventListener('pointerup', () => this.up());
    this.canvas.addEventListener('pointercancel', () => this.up());
    new ResizeObserver(() => this.resize()).observe(this.canvas);

    void Promise.all(recognizers.map(r => r.ready)).then(
      () => this.showStatus(),
      (e: Error) => {
        this.status.textContent = `Couldn’t load handwriting recognition: ${e.message}`;
      },
    );
  }

  /**
   * Clears the status line (it's only for loading and errors). Which engine
   * is running is kept out of sight, in data-engine, for debugging.
   */
  private showStatus() {
    this.status.textContent = '';
    this.element.dataset.engine = this.recognizers.map(r => r.engine).join(',');
  }

  private resize() {
    const size = Math.round(this.canvas.clientWidth * devicePixelRatio);
    if (size === this.canvas.width) return;
    this.canvas.width = this.canvas.height = size;
    this.redraw();
  }

  private point(e: PointerEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  private setPen() {
    const style = getComputedStyle(this.canvas);
    this.ctx.strokeStyle = this.ctx.fillStyle = style.color;
    this.ctx.lineWidth = PEN_WIDTH * this.canvas.width;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
  }

  private redraw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.setPen();
    drawStrokes(
      this.ctx,
      this.strokes,
      this.canvas.width,
      PEN_WIDTH * this.canvas.width,
    );
  }

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.current = [this.point(e)];
    this.strokes.push(this.current);
    this.setPen();
    drawStroke(this.ctx, this.current, this.canvas.width, this.ctx.lineWidth);
  }

  private move(e: PointerEvent) {
    if (!this.current) return;
    const coalesced = e.getCoalescedEvents?.() ?? [];
    const points = (coalesced.length ? coalesced : [e]).map(ev =>
      this.point(ev),
    );
    const last = this.current[this.current.length - 1];
    this.current.push(...points);
    // Draw just the new segment.
    this.setPen();
    drawStroke(
      this.ctx,
      [last, ...points],
      this.canvas.width,
      this.ctx.lineWidth,
    );
  }

  private up() {
    if (!this.current) return;
    this.current = undefined;
    void this.recognize();
  }

  private undo() {
    this.strokes.pop();
    this.redraw();
    void this.recognize();
  }

  clear() {
    this.strokes = [];
    this.redraw();
    this.results.replaceChildren();
  }

  private async recognize() {
    if (this.busy) {
      this.again = true;
      return;
    }
    if (this.strokes.length === 0) {
      this.results.replaceChildren();
      return;
    }
    this.busy = true;
    try {
      const strokes = this.strokes.map(s => [...s]);
      const lists = await Promise.all(
        this.recognizers.map(r => r.recognize(strokes, CANDIDATES)),
      );
      this.showResults(lists);
      this.showStatus();
    } catch (e) {
      this.status.textContent = `Recognition failed: ${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
    if (this.again) {
      this.again = false;
      void this.recognize();
    }
  }

  private showResults(lists: Candidate[][]) {
    this.results.replaceChildren(
      ...lists.map((candidates, i) =>
        h(
          'div',
          {class: 'candidate-row'},
          lists.length > 1 &&
            h('span', {class: 'candidate-source'}, this.recognizers[i].name),
          candidates.map(c =>
            h(
              'button',
              {
                type: 'button',
                class: 'candidate',
                title: `${(c.score * 100).toFixed(1)}%`,
                onclick: () => this.onPick(c.char),
              },
              c.char,
            ),
          ),
        ),
      ),
    );
  }
}

/** Creates the panel with the recognizers that are available. */
export function createHandwritingPanel(
  onPick: (char: string) => void,
): HandwritingPanel {
  const base = new URL('handwriting/', document.baseURI);
  return new HandwritingPanel(
    [new WorkerRecognizer('LT8 (ETL)', new URL('lt8/', base))],
    onPick,
  );
}
