/**
 * The stats page (?study=stats): today, streak and retention, card counts,
 * reviews per day, and what's coming due, for all decks or one.
 */
import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import type {Store} from '../store/store.ts';
import {columnChart} from './chart.ts';
import {computeStats, type Stats} from './stats-data.ts';

const fmtDay = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
  });

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
      tile(t('Reviews today'), today.reviews.toLocaleString()),
      tile(
        t('Minutes today'),
        today.minutes < 1 && today.minutes > 0
          ? '<1'
          : Math.round(today.minutes).toLocaleString(),
      ),
      tile(t('New cards today'), today.newCards.toLocaleString()),
      tile(
        t('Day streak'),
        stats.streak.toLocaleString(),
        stats.streak === 1 ? t('day') : t('days in a row'),
      ),
      tile(
        t('Retention'),
        pct,
        retention.total
          ? t('{passed} of {total} reviews remembered (30 days)', {
              passed: retention.passed.toLocaleString(),
              total: retention.total.toLocaleString(),
            })
          : t('no reviews in 30 days'),
      ),
    ),
    h('h2', {class: 'stats-heading'}, t('Cards')),
    h(
      'div',
      {class: 'stat-row'},
      tile(t('Total'), cards.total.toLocaleString()),
      tile(t('New'), cards.new.toLocaleString()),
      tile(t('Learning'), cards.learning.toLocaleString()),
      tile(
        t('Young'),
        cards.young.toLocaleString(),
        t('interval under 21 days'),
      ),
      tile(t('Mature'), cards.mature.toLocaleString(), t('21 days or more')),
      tile(t('Suspended'), cards.suspended.toLocaleString()),
    ),
    columnChart(
      t('Reviews per day, last {n} days', {n: historyDays}),
      stats.history.map(d => ({
        label: fmtDay(d.day),
        value: d.count,
        detail: d.count
          ? t(
              '{learn} learning · {review} review · {relearn} relearning · {minutes} min',
              {
                learn: d.learn,
                review: d.review,
                relearn: d.relearn,
                minutes: Math.max(1, Math.round(d.minutes)),
              },
            )
          : undefined,
      })),
      n => t('{n} reviews', {n: n.toLocaleString()}),
      i => every(labelEvery)(i, stats.history.length),
    ),
    columnChart(
      t('Due in the next 30 days'),
      stats.forecast.map((d, i) => ({
        label: i === 0 ? t('Today') : fmtDay(d.day),
        value: d.count,
        ...(i === 0 && {detail: t('includes overdue cards')}),
      })),
      n => t('{n} cards', {n: n.toLocaleString()}),
      i => i === 0 || i % 7 === 0,
    ),
  ];
}

export function renderStats(store: Store): HTMLElement {
  const deckSelect = h(
    'select',
    {'aria-label': t('Deck')},
    h('option', {value: ''}, t('All decks')),
    store.decks
      .all()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(d => h('option', {value: d.id}, d.name)),
  );
  const rangeSelect = h(
    'select',
    {'aria-label': t('Period')},
    h('option', {value: '30'}, t('Last 30 days')),
    h('option', {value: '90'}, t('Last 90 days')),
    h('option', {value: '365'}, t('Last year')),
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
      h('h1', null, t('Stats')),
      h('a', {href: '?study'}, t('← Decks')),
    ),
    h('div', {class: 'browse-filters'}, deckSelect, rangeSelect),
    content,
  );
  draw();
  return page;
}
