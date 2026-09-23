type Child = Node | string | false | null | undefined | Child[];
type Attrs = Record<
  string,
  string | number | boolean | EventListener | undefined
>;

/**
 * Creates an element. Attributes starting with "on" are event listeners;
 * `false`/`undefined` attributes and children are skipped.
 *
 *   h('a', {href: '?q=猫', class: 'link'}, '猫')
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') {
      el.addEventListener(name.slice(2), value);
    } else {
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue;
    if (Array.isArray(c)) {
      append(el, c);
    } else {
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
}

/** Joins nodes with a separator: join([a, b], '、') → [a, '、', b] */
export function join(items: Child[], separator: Child): Child[] {
  return items.flatMap((item, i) => (i === 0 ? [item] : [separator, item]));
}

/** A link to a search, handled by the app's router. */
export function searchLink(
  query: string,
  ...children: Child[]
): HTMLAnchorElement {
  return h(
    'a',
    {href: `?q=${encodeURIComponent(query)}`},
    ...(children.length ? children : [query]),
  );
}
