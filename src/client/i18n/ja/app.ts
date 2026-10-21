/** The interface in Japanese: see index.ts. */
export const JA_APP: Record<string, string> = {
  // Home page (main.ts).
  'a word': '単語',
  romaji: 'ローマ字',
  English: '英語',
  'an inflected word': '活用形',
  'a sentence': '文',
  'the start of a word': '単語の始め',
  'Search in English, Japanese, or romaji. Paste a sentence to see its words.':
    '日本語・英語・ローマ字で検索できます。文を貼り付けると、含まれる単語が表示されます。',

  // Results (main.ts).
  "Sorry, couldn't find anything matching {query}.":
    '「{query}」に一致するものは見つかりませんでした。',
  'More words': 'さらに表示',
  Kanji: '漢字',
  '{n} found': '{n}件',
  'You’re offline, and this part of the dictionary isn’t saved on this device yet. Words you’ve looked up before work offline.':
    'オフラインです。辞書のこの部分はまだこの端末に保存されていません。以前に調べた単語はオフラインでも使えます。',
  'Something went wrong loading the dictionary. Try again.':
    '辞書の読み込み中に問題が発生しました。もう一度お試しください。',
  "Couldn't load the dictionary data.": '辞書データを読み込めませんでした。',
  Reload: '再読み込み',

  // Page titles.
  '{query} - g-sho': '{query} - g-sho',
  'g-sho — Japanese dictionary': 'g-sho — 和英・英和辞書',
  'Import - g-sho': 'インポート - g-sho',
  'Study - g-sho': '学習 - g-sho',

  // Panels, notices, the header and footer (main.ts).
  'Loading…': '読み込み中…',
  'Couldn’t load this panel.': 'このパネルを読み込めませんでした。',
  'Anki isn’t reachable, so words can’t be added. Is Anki running?':
    'Anki に接続できないため、単語を追加できません。Anki は起動していますか？',
  Retry: '再試行',
  'Turn off Anki': 'Anki をオフにする',
  'Study: {n} card to review now': '学習：今すぐ復習するカード{n}枚',
  'Study: {n} cards to review now': '学習：今すぐ復習するカード{n}枚',
  'JMdict {date} · {words} words · {kanji} kanji':
    'JMdict {date} · 単語{words}語 · 漢字{kanji}字',
  'New version: tap to update': '新しいバージョンがあります：タップして更新',
  'Updating…': '更新中…',

  // Settings → display (settings.ts, settings-panel.ts).
  'English meanings': '英語の意味',
  'When off, meanings are blurred; tap one to see it.':
    'オフにすると意味がぼかされます。タップすると表示されます。',
  'Japanese definitions (国語)': '日本語の定義（国語）',
  'From the Japanese Wiktionary. Every word in them links to its entry. To study in Japanese only, also turn off English meanings.':
    '日本語版ウィクショナリーより。定義中の各単語から、その項目に移動できます。日本語だけで学習したい場合は、「英語の意味」もオフにしてください。',
  'Japanese meanings (英和)': '日本語の意味（英和）',
  'When you search in English: the word explained in Japanese, above the Japanese words. From the Japanese Wiktionary.':
    '英語で検索したとき、その単語の日本語での説明を日本語の単語の上に表示します。日本語版ウィクショナリーより。',
  'English definitions': '英語の定義（英英）',
  'When you search in English: the word defined in English, with synonyms. From Open English WordNet.':
    '英語で検索したとき、その単語の英語での定義を類義語とともに表示します。Open English WordNet より。',
  Furigana: 'ふりがな',
  'When off, readings show when you hover over a word.':
    'オフにすると、単語にカーソルを合わせたときに読みが表示されます。',
  'Example sentences': '例文',
  'Kanji details': '漢字の詳細',
  'The panel with each kanji’s readings and meanings.':
    '各漢字の読みと意味を表示するパネルです。',
  'Stroke order': '筆順',
  History: '履歴',
  'The words you’ve looked up.': '調べた単語です。',
  'Japanese words': '日本語の単語',
  'English words': '英語の単語',
  Show: '表示',
  'Couldn’t load the Anki settings.': 'Anki の設定を読み込めませんでした。',

  // Settings → Account (account-panel.ts, account.ts, passkey.ts).
  'Something went wrong with the passkey. Please try again.':
    'パスキーで問題が発生しました。もう一度お試しください。',
  'Syncing…': '同期中…',
  'Your history, marks, notes and settings sync to this account. Last synced at {time}.':
    '履歴、スター・覚えた単語、メモ、設定はこのアカウントに同期されます。最終同期：{time}',
  'Offline. Changes will sync when you’re back online.':
    'オフラインです。オンラインに戻ると変更が同期されます。',
  'Couldn’t sync ({error}). It will try again.':
    '同期できませんでした（{error}）。あとで再試行します。',
  'unknown error': '不明なエラー',
  'Account: signed in': 'アカウント：ログイン中',
  Account: 'アカウント',
  'Optional. Sign in to keep your history, starred and known words, notes and settings in sync across your devices.':
    '任意です。ログインすると、履歴、スター・覚えた単語、メモ、設定をお使いの端末間で同期できます。',
  'Sign in with {provider}': '{provider} でログイン',
  'Sign in with a passkey': 'パスキーでログイン',
  'We store only your user ID and name there (and your GitHub username), not your email address. With a passkey, only its public key.':
    '保存するのは各サービスでのユーザー ID と名前（GitHub の場合はユーザー名も）だけで、メールアドレスは保存しません。パスキーの場合は公開鍵のみです。',
  'Your name (optional)': '名前（任意）',
  'Your name': '名前',
  'Make a passkey': 'パスキーを作成',
  'Make one with a passkey': 'パスキーで作成',
  'No account?': 'アカウントをお持ちでない場合：',
  'Couldn’t sign out. Try again.':
    'ログアウトできませんでした。もう一度お試しください。',
  'Sign out': 'ログアウト',
  'Download my data': 'データをダウンロード',
  'Delete your g-sho account and everything stored with it? This can’t be undone. (What’s saved in this browser stays.)':
    'g-sho のアカウントと、保存されているすべてのデータを削除しますか？この操作は取り消せません。（このブラウザに保存されているデータは残ります。）',
  'Couldn’t delete the account. Try again.':
    'アカウントを削除できませんでした。もう一度お試しください。',
  'Delete account': 'アカウントを削除',
  'Added {date}': '{date} に追加',
  'Couldn’t add the passkey. Try again.':
    'パスキーを追加できませんでした。もう一度お試しください。',
  Add: '追加',
  Link: '連携',
  'Stop signing in with {provider}?': '{provider} でのログインを解除しますか？',
  'Couldn’t remove {provider}. Try again.':
    '{provider} を解除できませんでした。もう一度お試しください。',
  Remove: '解除',
  'Link more than one, in case you lose access to one.':
    'どれかが使えなくなったときのために、複数のログイン方法を連携しておきましょう。',
  Passkey: 'パスキー',
  'Something went wrong ({status}).': '問題が発生しました（{status}）。',
  'This device already has a passkey for your account.':
    'この端末にはすでにこのアカウントのパスキーがあります。',
  'This passkey uses a kind of key g-sho doesn’t support.':
    'このパスキーは g-sho が対応していない種類の鍵を使っています。',

  // Settings → Version (version-panel.ts, versions.ts).
  'Check for update': '更新を確認',
  Version: 'バージョン',
  'not running': '実行されていません',
  'saved copy {build}': '保存済み {build}',
  'different build': 'ビルドが異なります',
  'No service worker or workers running.':
    'Service Worker もワーカーも実行されていません。',
  'Checking…': '確認中…',
  'Couldn’t reach g-sho to check. Are you offline?':
    'g-sho に接続できず、確認できませんでした。オフラインではありませんか？',
  'You have the latest version.': '最新バージョンです。',
  Update: '更新',
  'A new version is available: {version}.':
    '新しいバージョンがあります：{version}',
  'Service worker (offline copy)': 'Service Worker（オフライン用）',
  'Update being installed': 'インストール中の更新',
  'Update waiting': '待機中の更新',

  // Settings → Offline (offline/offline.ts).
  'Offline download': 'オフライン用ダウンロード',
  'has finished': '完了',
  'stopped (see Offline)': '停止（「オフライン」を参照）',
  'This browser can’t save the dictionary for offline use.':
    'このブラウザでは、辞書をオフライン用に保存できません。',
  'Off: only words you look up are saved on this device.':
    'オフ：調べた単語だけがこの端末に保存されます。',
  'Will download in the background shortly.':
    'まもなくバックグラウンドでダウンロードします。',
  'Waiting: you’re on mobile data or saving data. Start it now if you like (about a 35 MB download).':
    '待機中：モバイルデータ通信中か、データセーバーがオンです。今すぐ始めることもできます（約 35 MB のダウンロード）。',
  'Downloading in the background… {percent}%':
    'バックグラウンドでダウンロード中…{percent}%',
  'Downloading in the background…': 'バックグラウンドでダウンロード中…',
  'Saved on this device: every word works offline.':
    'この端末に保存済み：すべての単語をオフラインで使えます。',
  'Not enough storage on this device to save the whole dictionary.':
    'この端末の空き容量が足りないため、辞書全体を保存できません。',
  'The download stopped ({error}). It will try again next time.':
    'ダウンロードが停止しました（{error}）。次回また試します。',
  'Download now': '今すぐダウンロード',
  Offline: 'オフライン',
  'Keep the whole dictionary on this device': '辞書全体をこの端末に保存',
  'about 120 MB, so every word works offline.':
    '約 120 MB。すべての単語をオフラインで使えます。',
};
