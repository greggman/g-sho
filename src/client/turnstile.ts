/**
 * Cloudflare Turnstile (a captcha that usually asks nothing): shown when
 * making an account with only a passkey, which is otherwise free to make
 * in bulk. Its script is loaded only then.
 */

/** Public; the secret is the Worker's TURNSTILE_SECRET. */
const SITE_KEY = '0x4AAAAAAFdiirwjSoGG_SQM';
const SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(
    el: HTMLElement,
    options: {
      sitekey: string;
      theme?: 'auto' | 'light' | 'dark';
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    },
  ): string;
  reset(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

function load(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error('Turnstile didn’t start'));
    script.onerror = () => {
      loading = undefined;
      reject(new Error('Couldn’t load Turnstile'));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * A Turnstile widget in `el`. `token()` is the current token (undefined
 * until it passes); `reset()` gets a new one (each is good once).
 */
export async function turnstileWidget(
  el: HTMLElement,
  onChange: (passed: boolean) => void,
) {
  const api = await load();
  let token: string | undefined;
  const id = api.render(el, {
    sitekey: SITE_KEY,
    theme: 'auto',
    callback: t => {
      token = t;
      onChange(true);
    },
    'expired-callback': () => {
      token = undefined;
      onChange(false);
    },
    'error-callback': () => {
      token = undefined;
      onChange(false);
    },
  });
  return {
    token: () => token,
    reset() {
      token = undefined;
      onChange(false);
      api.reset(id);
    },
  };
}
