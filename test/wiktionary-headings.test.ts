import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  pageSections,
  plainWiki,
  sectionFor,
} from '../scripts/wiktionary-headings.ts';

const KAU = `=={{L|ja}}==
==={{verb}}:買う===
{{ja-verb}}【[[買]]う】
#[[代価]]を払って[[品物]]を[[手に入れる]]。
#*指輪を'''買う'''。
===={{trans}}====
*{{en}}: buy
==={{verb}}:交う===
'''かう'''【[[交]]う】
#混じる。
==={{etym}}:かう（古語）===
==={{noun}}:料理===
#食べ物。
=={{L|en}}==
==={{verb}}:Kau===
#something else`;

test('a page’s word sections: their spellings and definitions', () => {
  assert.deepEqual(pageSections(KAU, 'かう'), [
    {w: ['買う'], d: '代価を払って品物を手に入れる'},
    {w: ['交う'], d: '混じる'},
    // A field's name is kept here; the build checks it's a spelling.
    {w: ['料理'], d: '食べ物'},
  ]);
});

test('heading spellings: several, and only ones ending like the page', () => {
  const iru = `=={{L|ja}}==
==== {{verb}}:炒る／煎る ====
#火にかける。
==={{verb}}:書く===
#文字を記す。`;
  assert.deepEqual(
    pageSections(iru, 'いる').map(s => s.w),
    [['炒る', '煎る']],
  );
  const au = `=={{L|ja}}==
==={{verb}}:会う（逢う）===
#人と会う。`;
  assert.deepEqual(
    pageSections(au, 'あう').map(s => s.w),
    [['会う', '逢う']],
  );
});

test('wiki markup to plain text', () => {
  assert.equal(
    plainWiki(
      "{{タグ|ja|自動詞}}[[困る|困っ]]ている{{ruby|人|ひと}}を'''救う'''",
    ),
    '困っている人を救う',
  );
});

test('the section an entry is, by its first definition', () => {
  const sections = pageSections(KAU, 'かう');
  assert.deepEqual(sectionFor('混じる。', sections)?.w, ['交う']);
  assert.deepEqual(sectionFor('代価を払って品物を手に入れる。', sections)?.w, [
    '買う',
  ]);
  assert.equal(sectionFor('どこにもない定義。', sections), undefined);
});
