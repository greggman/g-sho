/** The interface in Japanese: see index.ts. */
export const JA_STUDY: Record<string, string> = {
  // ---- deck list (study/view.ts) ----
  'New · learning · to review': '新規・学習中・復習',
  Study: '学習',
  Cards: 'カード',
  Stats: '統計',
  Import: 'インポート',
  'Study all': 'すべて学習',
  'Add words with the “study” button on any entry, or import an Anki deck.':
    '各項目の「学習」ボタンで単語を追加するか、Anki のデッキをインポートしてください。',
  'Cards are scheduled with FSRS, the algorithm modern Anki uses.':
    'カードは、最近の Anki と同じアルゴリズム FSRS でスケジュールされます。',
  'Add new words to ': '新しい単語の追加先：',
  'Name of the new deck?': '新しいデッキの名前は？',
  'New deck': '新規デッキ',
  '{n} card': '{n}枚',
  '{n} cards': '{n}枚',
  'Options and export': 'オプションとエクスポート',
  'New cards per day ': '1日あたりの新規カード ',
  'Most reviews per day ': '1日あたりの最大復習数 ',
  'Desired retention ': '目標定着率 ',
  ' How likely you are to remember a card when it comes up. Higher means more reviews.':
    ' カードが出たときに思い出せる確率です。高くするほど復習が増えます。',
  'Rename the deck': 'デッキの名前を変更',
  Rename: '名前を変更',
  'Delete “{name}” and its {n} cards? Their review history is kept.':
    '「{name}」とそのカード{n}枚を削除しますか？復習履歴は残ります。',
  'Delete deck': 'デッキを削除',

  // ---- duplicates in a deck ----
  Duplicates: '重複',
  'Find words you already know': '覚えている単語を探す',
  'None of this deck’s new cards are words you already study or marked known.':
    'このデッキの新規カードに、すでに学習している単語や「覚えた」にした単語はありません。',
  '{studied} new card is a word you study in other cards, and {known} is a word you marked known.':
    '新規カードのうち{studied}枚は他のカードで学習している単語、{known}枚は「覚えた」にした単語です。',
  '{studied} new card is a word you study in other cards, and {known} are words you marked known.':
    '新規カードのうち{studied}枚は他のカードで学習している単語、{known}枚は「覚えた」にした単語です。',
  '{studied} new cards are words you study in other cards, and {known} is a word you marked known.':
    '新規カードのうち{studied}枚は他のカードで学習している単語、{known}枚は「覚えた」にした単語です。',
  '{studied} new cards are words you study in other cards, and {known} are words you marked known.':
    '新規カードのうち{studied}枚は他のカードで学習している単語、{known}枚は「覚えた」にした単語です。',
  '{n} new card is a word you study in other cards.':
    '新規カードのうち{n}枚は他のカードで学習している単語です。',
  '{n} new cards are words you study in other cards.':
    '新規カードのうち{n}枚は他のカードで学習している単語です。',
  '{n} is a word you marked known.':
    '新規カードのうち{n}枚は「覚えた」にした単語です。',
  '{n} are words you marked known.':
    '新規カードのうち{n}枚は「覚えた」にした単語です。',
  'Give them your schedule for the word': 'その単語のスケジュールを引き継ぐ',
  'Suspend them': '保留にする',
  'Words marked known are suspended.': '「覚えた」にした単語は保留になります。',
  Apply: '適用',
  'Done: {n} card changed.': '完了：{n}枚のカードを変更しました。',
  'Done: {n} cards changed.': '完了：{n}枚のカードを変更しました。',

  // ---- export ----
  'Export to Anki': 'Anki へエクスポート',
  'Download .apkg': '.apkg をダウンロード',
  'Send to Anki': 'Anki に送る',
  'The file keeps each card’s schedule and review history. Sending through AnkiConnect adds the words and their due dates.':
    'ファイルには各カードのスケジュールと復習履歴が含まれます。AnkiConnect で送ると、単語とその期限が追加されます。',
  'Making the file…': 'ファイルを作成中…',
  'Saved {file}. Open it with Anki (File → Import) to add the deck, with its schedule and review history.':
    '{file} を保存しました。Anki で開くと（ファイル → インポート）、スケジュールと復習履歴ごとデッキが追加されます。',
  '{n} note from imported decks was left out: exporting those isn’t supported yet.':
    'インポートしたデッキのノート{n}件は含まれていません（まだエクスポートに対応していません）。',
  '{n} notes from imported decks were left out: exporting those isn’t supported yet.':
    'インポートしたデッキのノート{n}件は含まれていません（まだエクスポートに対応していません）。',
  "Done: {added} added and {updated} updated in Anki's “{deck}” deck.":
    '完了：Anki の「{deck}」デッキに{added}件追加し、{updated}件更新しました。',
  "Done: {added} added and {updated} updated in Anki's “{deck}” deck, {failed} couldn't be added.":
    '完了：Anki の「{deck}」デッキに{added}件追加し、{updated}件更新しました。{failed}件は追加できませんでした。',
  'Couldn’t reach Anki. Open Anki (with the AnkiConnect add-on), and connect it in Settings → Anki.':
    'Anki に接続できませんでした。AnkiConnect アドオンを入れた Anki を起動し、設定 → Anki で接続してください。',
  'Connecting to Anki…': 'Anki に接続中…',
  'Looking for words already in Anki…': 'Anki にすでにある単語を探しています…',
  'Adding words ({done} of {total})…': '単語を追加中（{done} / {total}）…',
  'Setting due dates…': '期限を設定中…',

  // ---- a session ----
  'All decks': 'すべてのデッキ',
  Deck: 'デッキ',
  '← Decks': '← デッキ',
  'Look up {word}': '{word} を調べる',
  'In the dictionary: ': '辞書で：',
  'Show answer': '答えを表示',
  'All done for now': '今のところ、すべて終わりました',
  'The next card is due in {time}.': '次のカードは {time}後です。',
  'Back to decks': 'デッキに戻る',
  'My words': 'マイ単語',

  // ---- answers and intervals (study/scheduler.ts) ----
  Again: 'もう一度',
  Hard: '難しい',
  Good: '正解',
  Easy: '簡単',
  '{n}m': '{n}分',
  '{n}h': '{n}時間',
  '{n}d': '{n}日',
  '{n}mo': '{n}か月',
  '{n}y': '{n}年',

  // ---- the card browser (study/browse.ts) ----
  duplicate: '重複',
  suspended: '保留中',
  new: '新規',
  due: '期限',
  'due ({time} late)': '期限（{time}超過）',
  'in {time}': '{time}後',
  'Search cards': 'カードを検索',
  State: '状態',
  'All cards': 'すべてのカード',
  'Due now': '期限が来たカード',
  New: '新規',
  Learning: '学習中',
  Review: '復習',
  Suspended: '保留中',
  'Suspended as duplicates': '重複として保留中',
  'Sort by': '並べ替え',
  'Sort: due': '並べ替え：期限',
  'Sort: newest': '並べ替え：新しい順',
  'Sort: word': '並べ替え：単語',
  'Sort: most forgotten': '並べ替え：忘れた回数',
  'Sort: longest interval': '並べ替え：間隔の長い順',
  '{shown} of {total} cards': '{total}枚中{shown}枚',
  Word: '単語',
  Reading: '読み',
  Meaning: '意味',
  'Move to deck': 'デッキを移動',
  Due: '期限',
  Interval: '間隔',
  '{n} days': '{n}日',
  Stability: '安定度',
  Difficulty: '難易度',
  Reviews: '復習回数',
  Forgotten: '忘れた回数',
  Added: '追加日',
  'Last review': '最終復習日',
  Card: 'カード',
  Close: '閉じる',
  'Field {n}': 'フィールド{n}',
  Tags: 'タグ',
  'Review history ({n})': '復習履歴（{n}）',
  Date: '日時',
  Answer: '回答',
  Time: '時間',
  '{n}s': '{n}秒',
  Unsuspend: '保留を解除',
  Suspend: '保留',
  'Forget this card? It will be new again (its review history is kept).':
    'このカードをリセットしますか？新規カードに戻ります（復習履歴は残ります）。',
  Forget: 'リセット',
  'Look up': '調べる',
  'Delete this note and its {n} cards? Their review history is kept.':
    'このノートとそのカード{n}枚を削除しますか？復習履歴は残ります。',
  'Delete this card? Their review history is kept.':
    'このカードを削除しますか？復習履歴は残ります。',
  Delete: '削除',

  // ---- stats (study/stats.ts, study/chart.ts) ----
  'Reviews today': '今日の復習',
  'Minutes today': '今日の学習時間（分）',
  'New cards today': '今日の新規カード',
  'Day streak': '連続学習日数',
  day: '日',
  'days in a row': '日連続',
  Retention: '定着率',
  '{passed} of {total} reviews remembered (30 days)':
    '{total}回中{passed}回正解（30日間）',
  'no reviews in 30 days': '30日間の復習はありません',
  Total: '合計',
  Young: '未熟',
  'interval under 21 days': '間隔が21日未満',
  Mature: '成熟',
  '21 days or more': '間隔が21日以上',
  'Reviews per day, last {n} days': '1日あたりの復習数（過去{n}日間）',
  '{learn} learning · {review} review · {relearn} relearning · {minutes} min':
    '学習中{learn}・復習{review}・再学習{relearn}・{minutes}分',
  '{n} reviews': '{n}回',
  'Due in the next 30 days': '今後30日間の期限',
  Today: '今日',
  'includes overdue cards': '期限切れのカードを含む',
  Period: '期間',
  'Last 30 days': '過去30日間',
  'Last 90 days': '過去90日間',
  'Last year': '過去1年間',
  '{title}. Use the table below for the numbers.':
    '{title}。数値は下の表をご覧ください。',
  '{label}: {amount}': '{label}：{amount}',
  'Show as a table': '表で表示',

  // ---- import (study/import-view.ts) ----
  'Couldn’t read the file.': 'ファイルを読み込めませんでした。',
  'Or paste Anki’s plain-text export, or lines of “word<Tab>meaning”':
    'または、Anki のテキスト形式のエクスポートや「単語<Tab>意味」の行を貼り付けてください',
  'Bring in an Anki deck: one you exported, or a shared deck from ':
    'Anki のデッキを取り込めます。自分でエクスポートしたデッキや、',
  '. Choose the .apkg file, drop it anywhere on this site, or paste a copied file.':
    ' の共有デッキなどです。.apkg ファイルを選ぶか、このサイトのどこかにドロップするか、コピーしたファイルを貼り付けてください。',
  'Choose a file…': 'ファイルを選択…',
  'Pasted text': '貼り付けたテキスト',
  'Import the text': 'テキストをインポート',
  'Reading {file}…': '{file} を読み込み中…',
  'Couldn’t read {file}: {error}': '{file} を読み込めませんでした：{error}',
  '{name} has no notes in it.': '{name} にはノートがありません。',
  ' e.g. {word} ({reading})': ' 例：{word}（{reading}）',
  ' e.g. {word}': ' 例：{word}',
  '(none)': '（なし）',
  ' ({n} notes)': '（ノート{n}件）',
  'Word ': '単語 ',
  'Reading ': '読み ',
  Cancel: 'キャンセル',
  ': {notes} notes, {cards} cards, {media} images and sounds.':
    '：ノート{notes}件、カード{cards}枚、画像と音声{media}件。',
  ': {notes} notes, {cards} cards.': '：ノート{notes}件、カード{cards}枚。',
  Decks: 'デッキ',
  '{name} — {n} cards': '{name} — {n}枚',
  'Which fields hold the word?': '単語はどのフィールドにありますか？',
  'Each note is linked to its dictionary entry, so you can look it up and later skip words you already know.':
    '各ノートは辞書の項目にリンクされるので、辞書で調べたり、覚えている単語を後で飛ばしたりできます。',
  'Keep the schedule and review history ({n} cards have been studied)':
    'スケジュールと復習履歴を残す（学習済みのカード{n}枚）',
  'Images and sounds are kept on this device only (they don’t sync yet).':
    '画像と音声はこの端末にのみ保存されます（まだ同期されません）。',
  'Notes you imported before are updated, and your progress on them is kept.':
    '以前インポートしたノートは更新され、学習の進み具合はそのまま残ります。',
  Continue: '続ける',
  'The import failed: {error}': 'インポートに失敗しました：{error}',
  '{added} new notes and {updated} already here (they’ll be updated), {cards} new cards. {linked} of {total} notes are linked to dictionary words.':
    '新規ノート{added}件と既存のノート{updated}件（更新されます）、新規カード{cards}枚。{total}件中{linked}件のノートが辞書の単語にリンクされています。',
  '{added} new notes, {cards} new cards. {linked} of {total} notes are linked to dictionary words.':
    '新規ノート{added}件、新規カード{cards}枚。{total}件中{linked}件のノートが辞書の単語にリンクされています。',
  'Words you already know': '覚えている単語',
  'None of the new cards are words you already study or marked known.':
    '新規カードに、すでに学習している単語や「覚えた」にした単語はありません。',
  '{n} new card is a word you already study (asked the same way):':
    '新規カードのうち{n}枚は、すでに同じ出題形式で学習している単語です：',
  '{n} new cards are words you already study (asked the same way):':
    '新規カードのうち{n}枚は、すでに同じ出題形式で学習している単語です：',
  'Give them your schedule for the word, so they come up when you’d review it anyway':
    'その単語のスケジュールを引き継ぎ、もともと復習する時期に出るようにする',
  'Suspend them (you can unsuspend later)': '保留にする（後で解除できます）',
  'Study them as new': '新規として学習する',
  '{n} new card is a word you marked known:':
    '新規カードのうち{n}枚は「覚えた」にした単語です：',
  '{n} new cards are words you marked known:':
    '新規カードのうち{n}枚は「覚えた」にした単語です：',
  'Study them anyway': 'それでも学習する',
  '{n} card repeats a word that come earlier in this deck.':
    '{n}枚のカードは、このデッキ内で先に出てくる単語と重複しています。',
  '{n} cards repeat words that come earlier in this deck.':
    '{n}枚のカードは、このデッキ内で先に出てくる単語と重複しています。',
  Imported: 'インポートしました',
  '{added} new notes, {cards} new cards, in {decks}.':
    '{decks} に新規ノート{added}件、新規カード{cards}枚を追加しました。',
  '{added} new notes and {updated} updated, {cards} new cards, in {decks}.':
    '{decks} に新規ノート{added}件（更新{updated}件）、新規カード{cards}枚を追加しました。',
  '{n} card was a word you already know.':
    '{n}枚のカードは覚えている単語でした。',
  '{n} cards were words you already know.':
    '{n}枚のカードは覚えている単語でした。',
  'Study it': '学習する',
  'Import another': '別のファイルをインポート',
  'Anki import': 'Anki インポート',
  'This isn’t an Anki package (no collection inside).':
    'Anki のパッケージではありません（コレクションが含まれていません）。',
};
