/** The interface in Japanese: see index.ts. */
export const JA_ANKI: Record<string, string> = {
  // panel.ts: the Anki settings
  'Add words to Anki': 'Ankiに単語を追加',
  'AnkiConnect address': 'AnkiConnectのアドレス',
  'only if you set one in AnkiConnect': 'AnkiConnectで設定した場合のみ',
  'AnkiConnect API key': 'AnkiConnectのAPIキー',
  'Add words to Anki with one click. This needs the Anki app running with the {addon}. Turn it on to connect; Anki asks whether to allow this site.':
    'ワンクリックで単語をAnkiに追加できます。Ankiアプリを起動し、{addon}をインストールしておく必要があります。有効にすると接続し、このサイトを許可するかAnkiで確認されます。',
  'AnkiConnect add-on': 'AnkiConnectアドオン',
  'Try again': '再試行',
  Advanced: '詳細設定',
  'API key': 'APIキー',
  'Connecting… (check Anki for a permission dialog)':
    '接続中…（Ankiに許可を求めるダイアログが出ていないか確認してください）',
  'Anki didn’t allow this site. Try again and choose Yes in Anki.':
    'Ankiがこのサイトを許可しませんでした。再試行して、Ankiで「Yes」を選んでください。',
  'Your AnkiConnect needs an API key. Enter it under Advanced.':
    'AnkiConnectにAPIキーが必要です。「詳細設定」で入力してください。',
  'Couldn’t reach Anki. Make sure Anki is running with AnkiConnect installed. If your browser asks to allow access to devices on your local network, allow it.':
    'Ankiに接続できません。AnkiConnectをインストールしたAnkiが起動しているか確認してください。ローカルネットワーク上のデバイスへのアクセスをブラウザに求められたら、許可してください。',
  'Anki: {message}': 'Anki：{message}',
  '{deck} (new)': '{deck}（新規）',
  'Fields: word, reading, furigana, meanings, part of speech, an example sentence, JMdict ID and a link back here. Cards show the word and ask for its reading and meaning.':
    'フィールド：単語、読み、ふりがな、意味、品詞、例文、JMdict ID、このサイトへのリンク。カードには単語が表示され、読みと意味を答えます。',
  'What to put in each field:': '各フィールドに入れる内容：',
  '{noteType} — recommended': '{noteType}（おすすめ）',
  'Connected. Use + on any word to add it to Anki; ✓ means it’s already there.':
    '接続済み。単語の「+」でAnkiに追加できます。「✓」は追加済みの単語です。',
  Deck: 'デッキ',
  'Note type': 'ノートタイプ',

  // note.ts: what can go in a field
  Nothing: 'なし',
  'Word (食べる)': '単語（食べる）',
  'Reading (たべる)': '読み（たべる）',
  'Word with furigana (食[た]べる)': 'ふりがな付きの単語（食[た]べる）',
  Meanings: '意味',
  'Reading and meanings': '読みと意味',
  'Part of speech': '品詞',
  'Example sentence': '例文',
  'JMdict ID': 'JMdict ID',
  'Link to g-sho': 'g-shoへのリンク',

  // controller.ts: the button on each word
  'Checking Anki…': 'Ankiを確認中…',
  'Add {word} to Anki': '{word}をAnkiに追加',
  '{word} is in Anki': '{word}はAnkiに追加済み',
  'Update in Anki': 'Ankiのノートを更新',
  'Show in Anki': 'Ankiで表示',

  // connect.ts: errors shown on the page
  "Couldn't reach Anki at {url}: {error}":
    '{url}のAnkiに接続できません：{error}',
  'Anki refused the request (this site is not allowed)':
    'Ankiがリクエストを拒否しました（このサイトは許可されていません）',

  // card-frame.ts, template.ts: showing a card
  Card: 'カード',
  'Type the answer': '答えを入力',
  'Show {field}': '{field}を表示',
  Play: '再生',

  // import/apply.ts: progress while importing
  'Linking words to the dictionary…': '単語を辞書と照合中…',
  'Linking words to the dictionary ({done} of {total})…':
    '単語を辞書と照合中…（{done}/{total}）',
  'Saving…': '保存中…',
  'Saving images and sounds…': '画像と音声を保存中…',
};
