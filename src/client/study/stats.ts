/**
 * The stats page (?study=stats): today, streak and retention, card counts,
 * reviews per day, and what's coming due, for all decks or one.
 */
import {h} from '../dom.ts';
import type {Store} from '../store/store.ts';
import {columnChart} from './chart.ts';
import {computeStats, type Stats} from './stats-data.ts';

const fmtDay = (t: number) =>
  new Date(t).toLocaleDateString(undefined, {month: 'numeric', day: 'numeric'});

function tile(label: string, value: string, note?: string) {
  return h(
    'div',
    {class: 'stat-tile'},
    h('span', {class: 'stat-label'}, label),
    h('span', {class: 'stat-value'}, value),
    note ? h('span', {class: 'stat-note hint'}, note) : '',
  );
}

function body(stats: Stats, historyDays: number): HTMLElement[] {
  const {today, cards, retention} = stats;
  const pct = retention.total
    ? `${Math.round((100 * retention.passed) / retention.total)}%`
    : '—';
  // Every nth day, counting back from today (so labels never crowd).
  const every = (n: number) => (i: number, len: number) =>
    (len - 1 - i) % n === 0;
  const labelEvery = historyDays <= 30 ? 7 : historyDays <= 90 ? 14 : 60;
  return [
    h(
      'div',
      {class: 'stat-row'},
      tile('Reviews today', today.reviews.toLocaleString()),
      tile(
        'Minutes today',
        today.minutes < 1 && today.minutes > 0
          ? '<1'
          : Math.round(today.minutes).toLocaleString(),
      ),
      tile('New cards today', today.newCards.toLocaleString()),
      tile(
        'Day streak',
        stats.streak.toLocaleString(),
        stats.streak === 1 ? 'day' : 'days in a row',
      ),
      tile(
        'Retention',
        pct,
        retention.total
          ? `${retention.passed.toLocaleString()} of ${retention.total.toLocaleString()} reviews remembered (30 days)`
          : 'no reviews in 30 days',
      ),
    ),
    h('h2', {class: 'stats-heading'}, 'Cards'),
    h(
      'div',
      {class: 'stat-row'},
      tile('Total', cards.total.toLocaleString()),
      tile('New', cards.new.toLocaleString()),
      tile('Learning', cards.learning.toLocaleString()),
      tile('Young', cards.young.toLocaleString(), 'interval under 21 days'),
      tile('Mature', cards.mature.toLocaleString(), '21 days or more'),
      tile('Suspended', cards.suspended.toLocaleString()),
    ),
    columnChart(
      `Reviews per day, last ${historyDays} days`,
      stats.history.map(d => ({
        label: fmtDay(d.day),
        value: d.count,
        detail: d.count
          ? `${d.learn} learning · ${d.review} review · ${d.relearn} relearning · ${Math.max(1, Math.round(d.minutes))} min`
          : undefined,
      })),
      'reviews',
      i => every(labelEvery)(i, stats.history.length),
    ),
    columnChart(
      'Due in the next 30 days',
      stats.forecast.map((d, i) => ({
        label: i === 0 ? 'Today' : fmtDay(d.day),
        value: d.count,
        ...(i === 0 && {detail: 'includes overdue cards'}),
      })),
      'cards',
      i => i === 0 || i % 7 === 0,
    ),
  ];
}

export function renderStats(store: Store): HTMLElement {
  const deckSelect = h(
    'select',
    {'aria-label': 'Deck'},
    h('option', {value: ''}, 'All decks'),
    store.decks
      .all()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(d => h('option', {value: d.id}, d.name)),
  );
  const rangeSelect = h(
    'select',
    {'aria-label': 'History'},
    h('option', {value: '30'}, 'Last 30 days'),
    h('option', {value: '90'}, 'Last 90 days'),
    h('option', {value: '365'}, 'Last year'),
  );
  const content = h('div', {class: 'stats-body'});
  const draw = () => {
    const days = Number(rangeSelect.value);
    const stats = computeStats(
      store,
      deckSelect.value ? [deckSelect.value] : undefined,
      Date.now(),
      days,
    );
    content.replaceChildren(...body(stats, days));
  };
  deckSelect.addEventListener('change', draw);
  rangeSelect.addEventListener('change', draw);
  const page = h(
    'div',
    {class: 'study-page stats-page'},
    h(
      'div',
      {class: 'study-head'},
      h('h1', null, 'Stats'),
      h('a', {href: '?study'}, '← Decks'),
    ),
    h('div', {class: 'browse-filters'}, deckSelect, rangeSelect),
    content,
  );
  draw();
  return page;
}
