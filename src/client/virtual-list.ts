import {h} from './dom.ts';

/** Rows drawn above and below the visible ones, so fast scrolling stays filled. */
const OVERSCAN = 8;

/**
 * A scrolling list that only creates the rows currently in view, so it
 * stays fast with thousands of items. Every row has the same height.
 */
export class VirtualList<T> {
  readonly element: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly rowHeight: number;
  private readonly renderRow: (item: T, index: number) => HTMLElement;
  private items: T[] = [];
  private drawn = '';

  constructor(
    rowHeight: number,
    renderRow: (item: T, index: number) => HTMLElement,
    className = '',
  ) {
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.spacer = h('div', {class: 'virtual-spacer'});
    this.element = h(
      'div',
      {class: `virtual-list ${className}`, role: 'list'},
      this.spacer,
    );
    this.element.addEventListener('scroll', () => this.draw(), {
      passive: true,
    });
    new ResizeObserver(() => this.draw()).observe(this.element);
  }

  setItems(items: T[]) {
    this.items = items;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    this.drawn = '';
    this.draw();
  }

  private draw() {
    const {scrollTop, clientHeight} = this.element;
    const first = Math.max(
      0,
      Math.floor(scrollTop / this.rowHeight) - OVERSCAN,
    );
    const last = Math.min(
      this.items.length,
      Math.ceil((scrollTop + clientHeight) / this.rowHeight) + OVERSCAN,
    );
    const key = `${first}:${last}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const rows: HTMLElement[] = [];
    for (let i = first; i < last; i++) {
      const row = this.renderRow(this.items[i], i);
      row.style.top = `${i * this.rowHeight}px`;
      row.style.height = `${this.rowHeight}px`;
      row.classList.add('virtual-row');
      row.setAttribute('role', 'listitem');
      rows.push(row);
    }
    this.spacer.replaceChildren(...rows);
  }
}
