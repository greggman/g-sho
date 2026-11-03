/**
 * Saying a word aloud: a speaker button, and a little popup saying what was
 * played (and crediting a recording).
 *
 * English words play a person's recording when there is one (Wikimedia
 * Commons, via Wiktionary): right by definition. Each is fetched (Commons
 * allows it), saved in the browser's cache, and played from there, so a word
 * heard once can be heard again offline. If a recording hasn't arrived
 * within a second (offline, or a slow connection) the browser's voice says
 * the word instead (the Web Speech API), and a late recording is dropped.
 *
 * Japanese words are said by the browser's Japanese voice: from their
 * spelling when that's read only one common way (so 雨 and 飴 get their own
 * accents), else from their kana reading, so kanji with several readings
 * are read right.
 *
 * Offline, a voice that needs the network (Chrome's "Google …" voices) is
 * passed over for one on the device. A button whose word can only be heard
 * from a recording (no voice for its language) is crossed out while offline
 * (html.offline).
 */
import {h} from './dom.ts';
import {t} from './i18n.ts';

const COMMONS = 'https://upload.wikimedia.org/wikipedia/commons/';
const CACHE = 'g-sho-recordings';
/** How long a recording may take to arrive before the voice says it. */
const RECORDING_WAIT_MS = 1000;
/** How long to wait for the voices to be listed, or for speech to start. */
const VOICE_WAIT_MS = 1000;
/** How long the popup stays. */
const POPUP_MS = 6000;

const synth = (): SpeechSynthesis | undefined =>
  typeof speechSynthesis === 'undefined' ? undefined : speechSynthesis;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The voices, which some browsers only list after a moment. */
function voices(): SpeechSynthesisVoice[] {
  return synth()?.getVoices() ?? [];
}

/** The voices, waiting a moment for them if they aren't listed yet. */
async function loadedVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s || voices().length) return voices();
  await Promise.race([
    new Promise(r => s.addEventListener('voiceschanged', r, {once: true})),
    sleep(VOICE_WAIT_MS),
  ]);
  return voices();
}

/** Whether a voice can speak `lang` ("en", "ja"), once voices have loaded. */
export function hasVoice(lang: string): boolean {
  return voices().some(v => v.lang.toLowerCase().startsWith(lang));
}

/**
 * Voices that say words clearly, best first, by name: Apple's, Google's,
 * Microsoft's. Each is used only if the browser has it.
 */
const GOOD_VOICES = [
  // English
  'Samantha',
  'Ava',
  'Allison',
  'Alex',
  'Google US English',
  'Microsoft Aria',
  'Microsoft Jenny',
  'Microsoft Guy',
  'Microsoft Zira',
  'Daniel',
  'Karen',
  // Japanese
  'Kyoko',
  'O-ren',
  'Otoya',
  'Google 日本語',
  'Microsoft Nanami',
  'Microsoft Haruka',
  'Microsoft Ayumi',
];

/** macOS's novelty voices, listed as English: never for saying a word. */
const NOVELTY = new Set(
  'Albert,Bad News,Bahh,Bells,Boing,Bubbles,Cellos,Good News,Jester,Organ,Superstar,Trinoids,Whisper,Wobble,Zarvox,Deranged,Hysterical,Pipe Organ,Fred,Junior,Kathy,Ralph,Princess'.split(
    ',',
  ),
);

/**
 * The voice to speak `lang` with: a well-known good one, else the
 * language's default, else one on the device (American English first, as
 * the recordings are). Offline, only voices on the device.
 */
function voiceFor(
  all: SpeechSynthesisVoice[],
  lang: string,
): SpeechSynthesisVoice | undefined {
  const offline = navigator.onLine === false;
  const fits = all.filter(
    v =>
      v.lang.toLowerCase().startsWith(lang) &&
      (!offline || v.localService) &&
      !NOVELTY.has(v.name.replace(/\s*\(.*\)$/, '')),
  );
  const rank = (v: SpeechSynthesisVoice) => {
    const i = GOOD_VOICES.findIndex(name => v.name.startsWith(name));
    return i < 0 ? GOOD_VOICES.length : i;
  };
  const region = lang === 'en' ? 'en-us' : lang;
  return [...fits].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(b.default) - Number(a.default) ||
      Number(b.lang.toLowerCase() === region) -
        Number(a.lang.toLowerCase() === region),
  )[0];
}

/** What a press of the speaker did, for its popup. */
type Said =
  | {kind: 'recording'; path: string}
  | {kind: 'voice'; voice: string}
  | {kind: 'none'; lang: string; voice?: string; reason?: string};

/** Kept so the browser doesn't drop it before it's spoken (Chrome). */
let utterance: SpeechSynthesisUtterance | undefined;

/**
 * Says `text` with the browser's voice for `lang`. Browsers only let a page
 * speak in answer to a click (Safari strictly: in the click's own call), so
 * when the voices are already listed this calls speak() straight away, with
 * nothing awaited first; only when they aren't is there a wait for them.
 */
function sayWithVoice(text: string, lang: string): Promise<Said> {
  return voices().length
    ? speakNow(text, lang, voices())
    : loadedVoices().then(all => speakNow(text, lang, all));
}

/** Calls speak() now; resolves once speech starts (or doesn't). */
function speakNow(
  text: string,
  lang: string,
  all: SpeechSynthesisVoice[],
): Promise<Said> {
  const s = synth();
  if (!s) return Promise.resolve({kind: 'none', lang});
  const voice = voiceFor(all, lang);
  if (!voice && navigator.onLine === false) {
    return Promise.resolve({kind: 'none', lang});
  }
  const u = new SpeechSynthesisUtterance(text);
  // Without a voice listed for it, the browser may still have one.
  u.lang = voice?.lang ?? (lang === 'ja' ? 'ja-JP' : 'en-US');
  if (voice) u.voice = voice;
  // A little slower than usual, for learners.
  u.rate = 0.9;
  utterance = u;
  u.onend = () => {
    if (utterance === u) utterance = undefined;
  };
  // Why it didn't speak, as Chrome says (not-allowed, synthesis-failed, …).
  let reason: string | undefined;
  const started = new Promise<boolean>(resolve => {
    u.onstart = () => resolve(true);
    u.onerror = e => {
      reason = e.error;
      resolve(false);
    };
    setTimeout(() => {
      if (!s.speaking) reason ??= 'no-start';
      resolve(s.speaking);
    }, VOICE_WAIT_MS);
  });
  if (s.speaking || s.pending) s.cancel();
  // Chrome can be left paused (after a page load, or a tab in the
  // background), and then says nothing until resumed.
  s.resume();
  s.speak(u);
  return started.then(ok =>
    ok
      ? {kind: 'voice', voice: voice?.name ?? t('your browser’s voice')}
      : {kind: 'none', lang, voice: voice?.name, reason},
  );
}

let playing: HTMLAudioElement | undefined;

/** A recording from the cache, else fetched (and cached) within `ms`. */
async function recording(path: string, ms: number): Promise<Blob | undefined> {
  const url = COMMONS + path;
  const cache = await caches?.open(CACHE).catch(() => undefined);
  const saved = await cache?.match(url);
  if (saved) return saved.blob();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    const res = await fetch(url, {signal: abort.signal});
    if (!res.ok) return undefined;
    await cache?.put(url, res.clone()).catch(() => {});
    return await res.blob();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Plays a recording; false if it didn't arrive in time or can't play. */
async function playRecording(path: string): Promise<boolean> {
  const blob = await recording(path, RECORDING_WAIT_MS);
  if (!blob) return false;
  const audio = new Audio(URL.createObjectURL(blob));
  playing = audio;
  audio.addEventListener('ended', () => URL.revokeObjectURL(audio.src));
  try {
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

function stop() {
  playing?.pause();
  const s = synth();
  if (s?.speaking || s?.pending) s.cancel();
}

/**
 * Says an English word: its recording if one arrives in time, else the
 * browser's voice.
 */
async function sayEnglish(word: string, paths: string[]): Promise<Said> {
  stop();
  if (paths.length && (await playRecording(paths[0]))) {
    return {kind: 'recording', path: paths[0]};
  }
  return sayWithVoice(word, 'en');
}

/** The Commons page of a recording, for its credit. */
export function commonsPage(path: string): string {
  const file = decodeURIComponent(
    path
      .split('/')
      .at(-1)!
      .replace(/\.mp3$/, ''),
  );
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`;
}

/** A recording's accent, from its file name (En-us-go.ogg); '' if unknown. */
export function accentOf(path: string): string {
  const file = path.split('/').at(-1)!.toLowerCase();
  if (/^en-us/.test(file)) return t('US');
  if (/^en-(uk|gb)/.test(file)) return t('UK');
  if (/^en-au/.test(file)) return t('Australia');
  if (/^en-ca/.test(file)) return t('Canada');
  return '';
}

// ---- the popup ----

let popup: HTMLElement | undefined;
let popupTimer: ReturnType<typeof setTimeout> | undefined;

function closePopup() {
  popup?.remove();
  popup = undefined;
  clearTimeout(popupTimer);
}

/** Shows what was played, under the button, until a click elsewhere. */
function showPopup(
  anchor: HTMLElement,
  said: Said,
  paths: string[],
  replay: (path: string) => void,
) {
  closePopup();
  const body: (Node | string | false)[] = [];
  if (said.kind === 'recording') {
    const accent = accentOf(said.path);
    body.push(
      h(
        'p',
        null,
        accent ? t('Recording ({accent})', {accent}) : t('Recording'),
        ' · ',
        h(
          'a',
          {href: commonsPage(said.path), target: '_blank', rel: 'noopener'},
          t('Wikimedia Commons'),
        ),
      ),
    );
    const others = paths.filter(p => p !== said.path && accentOf(p));
    if (others.length) {
      body.push(
        h(
          'p',
          {class: 'speak-others'},
          t('Also:'),
          ...others.map(p =>
            h(
              'button',
              {type: 'button', onclick: () => replay(p)},
              accentOf(p),
            ),
          ),
        ),
      );
    }
  } else if (said.kind === 'voice') {
    body.push(
      h('p', null, t('Your browser’s voice: {voice}', {voice: said.voice})),
    );
  } else if (said.voice || said.reason) {
    // A voice was tried and didn't speak: say what the browser said.
    body.push(
      h(
        'p',
        null,
        t('Couldn’t speak with {voice} ({reason}).', {
          voice: said.voice ?? t('your browser’s voice'),
          reason: said.reason ?? '?',
        }),
      ),
    );
  } else {
    body.push(
      h(
        'p',
        null,
        said.lang === 'ja'
          ? t('This device has no Japanese voice.')
          : t('Offline, and this device has no English voice.'),
      ),
    );
  }
  popup = h('div', {class: 'speak-popup', role: 'status'}, ...body);
  document.body.append(popup);
  const r = anchor.getBoundingClientRect();
  const width = popup.offsetWidth;
  const left = Math.max(
    8,
    Math.min(r.right - width, document.documentElement.clientWidth - width - 8),
  );
  popup.style.left = `${left + scrollX}px`;
  popup.style.top = `${r.bottom + 6 + scrollY}px`;
  popupTimer = setTimeout(closePopup, POPUP_MS);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', e => {
    if (popup && !popup.contains(e.target as Node)) closePopup();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closePopup();
  });
}

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
  '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/>' +
  '<path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" ' +
  'stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '<path class="speak-cross" d="M3 3l18 18" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round"/></svg>';

function button(
  lang: string,
  say: () => Promise<Said>,
  paths: () => string[] = () => [],
  replay: (path: string) => Promise<Said> = say,
) {
  const b = h('button', {
    type: 'button',
    class: 'speak',
    'data-lang': lang,
    title: t('Listen'),
    'aria-label': t('Listen'),
  });
  const run = async (doSay: () => Promise<Said>) => {
    b.classList.add('speaking');
    const said = await doSay();
    b.classList.remove('speaking');
    b.classList.toggle('unavailable', said.kind === 'none');
    showPopup(b, said, paths(), p => void run(() => replay(p)));
  };
  b.addEventListener('click', e => {
    e.preventDefault();
    // Not the click that would close a popup it opens.
    e.stopPropagation();
    void run(say);
  });
  b.innerHTML = ICON;
  if (paths().length) b.dataset.recording = '';
  return b;
}

/**
 * A speaker for an English word, with its recordings (enw `au`), or a way
 * to look them up (said by the voice until they're found); undefined when
 * nothing could say it.
 */
export function speakEnglishButton(
  word: string,
  recordings: string[] | (() => Promise<string[] | undefined>) = [],
): HTMLElement | undefined {
  let paths = Array.isArray(recordings) ? recordings : [];
  if (!paths.length && !synth()) return undefined;
  if (!Array.isArray(recordings)) {
    recordings().then(
      p => {
        if (!p?.length) return;
        paths = p;
        b.dataset.recording = '';
      },
      () => {},
    );
  }
  const b = button(
    'en',
    () => sayEnglish(word, paths),
    () => paths,
    async p => {
      stop();
      return (await playRecording(p))
        ? {kind: 'recording', path: p}
        : sayWithVoice(word, 'en');
    },
  );
  markRecordingOnly(b);
  return b;
}

/**
 * A speaker for a Japanese word, said from its kana reading until `spoken`
 * (what to give the voice instead, like its spelling) is known.
 */
export function speakJapaneseButton(
  reading: string,
  spoken?: Promise<string>,
): HTMLElement | undefined {
  if (!synth()) return undefined;
  let text = reading;
  spoken?.then(
    s => (text = s),
    () => {},
  );
  // Not async: speak() is called in the click itself (sayWithVoice).
  const b = button('ja', () => {
    playing?.pause();
    return sayWithVoice(text, 'ja');
  });
  markRecordingOnly(b);
  return b;
}

/**
 * A button that can only play a recording (no voice for its language) is
 * crossed out offline (CSS: html.offline .speak.recording-only).
 */
function markRecordingOnly(b: HTMLElement) {
  if (!voices().length) return; // not loaded yet: updated when they are
  b.classList.toggle('recording-only', !hasVoice(b.dataset.lang!));
}

if (typeof window !== 'undefined') {
  const online = () =>
    document.documentElement.classList.toggle(
      'offline',
      navigator.onLine === false,
    );
  online();
  window.addEventListener('online', online);
  window.addEventListener('offline', online);
  synth()?.addEventListener?.('voiceschanged', () => {
    for (const b of document.querySelectorAll<HTMLElement>('.speak')) {
      markRecordingOnly(b);
    }
  });
}
