/**
 * A column chart for one series (reviews per day, cards coming due), as
 * inline SVG in the site's colors: columns up to 24px wide with 2px gaps and
 * rounded tops, hairline gridlines, clean y ticks. Each column has a
 * hover/focus tooltip, and the numbers are also in a table underneath.
 */
import {h} from '../dom.ts';

export interface Column {
  label: string;
  value: number;
  /** the tooltip's line under the value */
  detail?: string;
}

const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 180;
const LEFT = 36;
const BOTTOM = 22;
const TOP = 8;

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A round top value and 3-5 ticks up to it. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  // Counts are whole numbers: never a step under 1.
  const step = Math.max(
    1,
    [1, 2, 5, 10].map(m => m * mag).find(s => s >= rough)!,
  );
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(v);
  return ticks;
}

/** A column with a rounded top and a square base. */
function columnPath(x: number, y: number, w: number, base: number) {
  const r = Math.min(4, w / 2, base - y);
  return (
    `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}` +
    `H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`
  );
}

export function columnChart(
  title: string,
  columns: Column[],
  unit: string,
  /** which column labels to show on the x axis */
  showLabel: (i: number) => boolean,
): HTMLElement {
  const plot = h('div', {class: 'chart-plot'});
  const tip = h('div', {class: 'chart-tip', role: 'status'});
  tip.hidden = true;

  const draw = () => {
    const width = Math.max(240, plot.clientWidth);
    const max = Math.max(0, ...columns.map(c => c.value));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1];
    const base = HEIGHT - BOTTOM;
    const y = (v: number) => base - ((base - TOP) * v) / top;
    const slot = (width - LEFT) / columns.length;
    const barW = Math.max(2, Math.min(24, slot - 2));
    const root = svg('svg', {
      width,
      height: HEIGHT,
      viewBox: `0 0 ${width} ${HEIGHT}`,
      role: 'img',
      'aria-label': `${title}. Use the table below for the numbers.`,
    });
    for (const t of ticks) {
      root.append(
        svg('line', {
          class: 'chart-grid',
          x1: LEFT,
          x2: width,
          y1: y(t),
          y2: y(t),
        }),
      );
      const label = svg('text', {
        class: 'chart-tick',
        x: LEFT - 6,
        y: y(t) + 4,
        'text-anchor': 'end',
      });
      label.textContent = t.toLocaleString();
      root.append(label);
    }
    columns.forEach((c, i) => {
      const x = LEFT + i * slot + (slot - barW) / 2;
      const g = svg('g', {
        class: 'chart-col',
        tabindex: 0,
        'aria-label': `${c.label}: ${c.value} ${unit}`,
      });
      // The hit target is the whole slot, not just the column.
      g.append(
        svg('rect', {
          class: 'chart-hit',
          x: LEFT + i * slot,
          y: TOP,
          width: slot,
          height: base - TOP,
        }),
      );
      if (c.value > 0)
        g.append(
          svg('path', {
            class: 'chart-bar',
            d: columnPath(x, y(c.value), barW, base),
          }),
        );
      const show = () => {
        tip.replaceChildren(
          h('strong', null, `${c.value.toLocaleString()} ${unit}`),
          h('span', null, c.label),
          c.detail ? h('span', {class: 'hint'}, c.detail) : '',
        );
        tip.hidden = false;
        const left = Math.min(Math.max(0, x + barW / 2 - 70), width - 140);
        tip.style.left = `${left}px`;
        tip.style.top = `${Math.max(0, y(c.value) - 64)}px`;
      };
      g.addEventListener('pointerenter', show);
      g.addEventListener('focus', show);
      g.addEventListener('pointerleave', () => (tip.hidden = true));
      g.addEventListener('blur', () => (tip.hidden = true));
      root.append(g);
      if (showLabel(i)) {
        const label = svg('text', {
          class: 'chart-tick',
          x: x + barW / 2,
          y: HEIGHT - 6,
          'text-anchor': 'middle',
        });
        label.textContent = c.label;
        root.append(label);
      }
    });
    root.append(
      svg('line', {
        class: 'chart-axis',
        x1: LEFT,
        x2: width,
        y1: base,
        y2: base,
      }),
    );
    plot.replaceChildren(root, tip);
  };

  let lastWidth = 0;
  new ResizeObserver(() => {
    if (plot.clientWidth !== lastWidth) {
      lastWidth = plot.clientWidth;
      draw();
    }
  }).observe(plot);

  return h(
    'figure',
    {class: 'chart'},
    h('figcaption', null, title),
    plot,
    h(
      'details',
      {class: 'chart-table'},
      h('summary', null, 'Show as a table'),
      h(
        'table',
        null,
        h(
          'tbody',
          null,
          columns.map(c =>
            h(
              'tr',
              null,
              h('td', null, c.label),
              h('td', null, c.value.toLocaleString()),
            ),
          ),
        ),
      ),
    ),
  );
}
