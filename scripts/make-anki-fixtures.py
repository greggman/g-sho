"""
Makes the Anki packages the import tests use (test/fixtures/anki/), with
Anki's own library, so they're exactly what real Anki writes:

  python3 -m venv .venv-anki && .venv-anki/bin/pip install anki
  .venv-anki/bin/python scripts/make-anki-fixtures.py

The output is checked in; rerun only to change it or to test a new Anki.
"""
import os
import sys
import tempfile

from anki.collection import Collection, ExportAnkiPackageOptions
from anki.decks import DeckId
from anki.import_export_pb2 import ExportLimit

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures', 'anki')
os.makedirs(OUT, exist_ok=True)

# A 1x1 PNG and a few bytes standing in for an MP3 (Anki doesn't look inside).
PNG = bytes.fromhex(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
    '1f15c4890000000d49444154789c6360f8cfc0f00f0004fe02fea7b4a2'
    'a40000000049454e44ae426082')
MP3 = b'ID3\x03\x00\x00\x00\x00\x00\x00fake mp3'

col = Collection(os.path.join(tempfile.mkdtemp(), 'collection.anki2'))
col.set_config('fsrs', True)

# A note type like the popular Japanese decks': furigana in Reading.
mm = col.models
jp = mm.new('Japanese (recognition)')
for name in ['Expression', 'Reading', 'Meaning', 'Audio', 'Picture']:
    mm.add_field(jp, mm.new_field(name))
t = mm.new_template('Recognition')
t['qfmt'] = '<div class="expr">{{Expression}}</div>'
t['afmt'] = ('{{FrontSide}}<hr id=answer>'
             '<div class="reading">{{furigana:Reading}}</div>'
             '<div>{{Meaning}}</div>{{Audio}}'
             '{{#Picture}}<div>{{Picture}}</div>{{/Picture}}')
mm.add_template(jp, t)
t = mm.new_template('Production')
t['qfmt'] = '{{Meaning}}'
t['afmt'] = '{{FrontSide}}<hr id=answer>{{Expression}}<br>{{kana:Reading}}'
mm.add_template(jp, t)
jp['css'] = '.card { font-size: 24px; } .expr { font-size: 48px; }'
mm.add(jp)

deck = col.decks.id('Japanese::Core')
col.media.write_data('neko.mp3', MP3)
col.media.write_data('neko.png', PNG)

def add(model, deck_id, **fields):
    note = col.new_note(model)
    for k, v in fields.items():
        note[k] = v
    note.tags = ['jp', 'fixture']
    col.add_note(note, DeckId(deck_id))
    return note

add(jp, deck, Expression='食べる', Reading='食[た]べる', Meaning='to eat')
add(jp, deck, Expression='猫', Reading='猫[ねこ]', Meaning='<b>cat</b>',
    Audio='[sound:neko.mp3]', Picture='<img src="neko.png">')
add(jp, deck, Expression='ありがとう', Reading='ありがとう', Meaning='thank you')
add(jp, deck, Expression='日本語', Reading='日本語[にほんご]', Meaning='Japanese (language)')

basic = mm.by_name('Basic')
add(basic, col.decks.id('Japanese'), Front='犬', Back='dog')
cloze = mm.by_name('Cloze')
add(cloze, col.decks.id('Japanese'), Text='{{c1::猫}}が{{c2::好き}}です', **{'Back Extra': 'I like cats'})

# Study a little, so there's scheduling and a review log.
col.decks.select(deck)
for ease in [3, 3, 4, 1]:
    card = col.sched.getCard()
    if not card:
        break
    card.start_timer()
    col.sched.answerCard(card, ease)
# Suspend 日本語's cards.
col.sched.suspend_cards(col.find_cards('Expression:日本語'))

def export(name, legacy, scheduling):
    path = os.path.join(OUT, name)
    col.export_anki_package(
        out_path=path,
        options=ExportAnkiPackageOptions(
            with_scheduling=scheduling, with_deck_configs=scheduling,
            with_media=True, legacy=legacy),
        limit=ExportLimit())
    print('wrote', name, os.path.getsize(path), 'bytes')

export('legacy.apkg', True, True)
export('modern.apkg', False, True)
export('shared-deck.apkg', False, False)

with open(os.path.join(OUT, 'notes.txt'), 'w') as f:
    pass
col.export_note_csv(
    out_path=os.path.join(OUT, 'notes.txt'), limit=ExportLimit(),
    with_html=True, with_tags=True, with_deck=True, with_notetype=True,
    with_guid=True)
print('wrote notes.txt')
col.close()
