/**
 * Reads Anki's plain-text export ("Notes in Plain Text") or any tab / CSV
 * list into the same shape as an .apkg. Anki's export starts with headers:
 *
 *   #separator:tab   #html:true   #tags:a b   #columns:Front\tBack
 *   #notetype:Basic  #deck:Name   #notetype column:2   #deck column:3
 *   #tags column:9   #guid column:1
 *
 * Without headers, each line is a note: the first column the front, the
 * second the back (a Basic note type), the rest more fields.
 */
import type {AnkiCollection, AnkiNoteType} from './read.ts';

const SEPARATORS: Record<string, string> = {
  tab: '\t',
  comma: ',',
  semicolon: ';',
  space: ' ',
  pipe: '|',
  colon: ':',
};

const BASIC_CSS = `.card {
  font-family: arial;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}`;

/** Splits a line on `sep`, honoring "quoted ""fields""". */
export function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          value += line[i++];
        }
      }
      out.push(value);
      // Skip to the separator.
      const next = line.indexOf(sep, i);
      i = next === -1 ? line.length + 1 : next + sep.length;
    } else {
      const next = line.indexOf(sep, i);
      out.push(line.slice(i, next === -1 ? undefined : next));
      i = next === -1 ? line.length + 1 : next + sep.length;
    }
  }
  return out;
}

/** Lines, joining quoted fields that span lines. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quotes = 0;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    current = current ? `${current}\n${line}` : line;
    quotes += (line.match(/"/g) ?? []).length;
    if (quotes % 2 === 0) {
      out.push(current);
      current = '';
      quotes = 0;
    }
  }
  if (current) out.push(current);
  return out;
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>]/g,
    c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]!,
  );
}

/** A stable id for a note without a GUID, from its content. */
function contentGuid(fields: string[]): string {
  let h = 2166136261;
  for (const c of fields.join('\x1f')) {
    h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
  }
  return `txt${(h >>> 0).toString(36)}${fields.join('').length.toString(36)}`;
}

function noteType(
  name: string,
  fieldCount: number,
  ankiId: number,
  columnNames?: string[],
): AnkiNoteType {
  if (/^cloze$/i.test(name)) {
    return {
      ankiId,
      name: 'Cloze',
      kind: 'cloze',
      fields: ['Text', 'Back Extra'],
      templates: [
        {
          name: 'Cloze',
          front: '{{cloze:Text}}',
          back: '{{cloze:Text}}<br>\n{{Back Extra}}',
        },
      ],
      css: `${BASIC_CSS}\n.cloze { font-weight: bold; color: blue; }`,
    };
  }
  const fields =
    columnNames && columnNames.length >= fieldCount
      ? columnNames.slice(0, fieldCount)
      : /^basic$/i.test(name) && fieldCount <= 2
        ? ['Front', 'Back']
        : Array.from({length: fieldCount}, (_, i) => `Field ${i + 1}`);
  return {
    ankiId,
    name,
    kind: 'standard',
    fields,
    templates: [
      {
        name: 'Card 1',
        front: `{{${fields[0]}}}`,
        back:
          '{{FrontSide}}\n\n<hr id=answer>\n\n' +
          fields
            .slice(1)
            .map(f => `{{${f}}}`)
            .join('<br>\n'),
      },
    ],
    css: BASIC_CSS,
  };
}

export function readAnkiText(
  text: string,
  defaultDeck = 'Imported',
): AnkiCollection {
  const lines = logicalLines(text.replace(/^\uFEFF/, ''));
  const headers = new Map<string, string>();
  while (lines.length && lines[0].startsWith('#')) {
    const m = /^#([^:]+):(.*)$/.exec(lines.shift()!);
    if (m) headers.set(m[1].trim().toLowerCase(), m[2]);
  }
  const first = lines.find(l => l.trim()) ?? '';
  const sepName = headers.get('separator');
  const sep = sepName
    ? (SEPARATORS[sepName.toLowerCase()] ?? sepName)
    : first.includes('\t')
      ? '\t'
      : first.includes(';')
        ? ';'
        : ',';
  const html = headers.get('html')?.toLowerCase() !== 'false';
  const column = (key: string) => {
    const n = Number(headers.get(`${key} column`));
    return n > 0 ? n - 1 : -1;
  };
  const guidCol = column('guid');
  const typeCol = column('notetype');
  const deckCol = column('deck');
  const tagsCol = column('tags');
  const meta = new Set(
    [guidCol, typeCol, deckCol, tagsCol].filter(c => c >= 0),
  );
  const columnNames = headers.has('columns')
    ? splitLine(headers.get('columns')!, sep).filter((_, i) => !meta.has(i))
    : undefined;
  const allTags = (headers.get('tags') ?? '').split(' ').filter(Boolean);

  const collection: AnkiCollection = {
    crt: 0,
    noteTypes: [],
    decks: [],
    notes: [],
    cards: [],
    reviews: [],
    media: [],
  };
  const rowsByType = new Map<string, string[][]>();
  const parsed = lines
    .filter(l => l.trim())
    .map(l => {
      const cols = splitLine(l, sep);
      const type =
        (typeCol >= 0 && cols[typeCol]) || headers.get('notetype') || 'Basic';
      const fields = cols.filter((_, i) => !meta.has(i));
      let list = rowsByType.get(type);
      if (!list) rowsByType.set(type, (list = []));
      list.push(fields);
      return {cols, type, fields};
    });

  let nextId = 1;
  const types = new Map<string, AnkiNoteType>();
  for (const [name, rows] of rowsByType) {
    // Trailing empty columns belong to wider note types sharing the file.
    const count = Math.max(
      1,
      ...rows.map(r => r.length - [...r].reverse().findIndex(f => f !== '')),
    );
    const t = noteType(
      name,
      Math.min(count, rows[0]?.length ?? 1),
      nextId++,
      columnNames,
    );
    types.set(name, t);
    collection.noteTypes.push(t);
  }

  const decks = new Map<string, number>();
  for (const {cols, type, fields} of parsed) {
    const t = types.get(type)!;
    const deckName =
      (deckCol >= 0 && cols[deckCol]) || headers.get('deck') || defaultDeck;
    let deckId = decks.get(deckName);
    if (deckId === undefined) {
      decks.set(deckName, (deckId = nextId++));
      collection.decks.push({ankiId: deckId, name: deckName});
    }
    const values = t.fields.map((_, i) => {
      const v = fields[i] ?? '';
      return html ? v : escapeHtml(v);
    });
    const noteId = nextId++;
    collection.notes.push({
      ankiId: noteId,
      guid: (guidCol >= 0 && cols[guidCol]) || contentGuid(values),
      noteTypeId: t.ankiId,
      fields: values,
      tags: [
        ...allTags,
        ...(tagsCol >= 0
          ? (cols[tagsCol] ?? '').split(' ').filter(Boolean)
          : []),
      ],
      mtime: 0,
    });
    const ords =
      t.kind === 'cloze'
        ? [
            ...new Set(
              [...values[0].matchAll(/\{\{c(\d+)::/g)].map(
                m => Number(m[1]) - 1,
              ),
            ),
          ]
        : [0];
    for (const ord of ords.length ? ords : [0]) {
      collection.cards.push({
        ankiId: nextId++,
        noteId,
        deckId,
        ord,
        type: 0,
        queue: 0,
        due: collection.cards.length,
        ivl: 0,
        reps: 0,
        lapses: 0,
      });
    }
  }
  return collection;
}
