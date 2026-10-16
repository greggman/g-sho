/**
 * The camera's recent frames, each scored for sharpness as it arrives, so
 * Freeze can hold a clear one: the tap on the button often shakes the
 * phone, and a frame from just before is better. Only frames that could
 * still be chosen are kept: an older frame no sharper than a newer one
 * never is.
 */

/** How far back (ms) Freeze looks for a sharp frame. */
const WINDOW = 700;
/** The newest frame at least this sharp, relative to the sharpest, wins. */
const NEAR = 0.8;
/** Frames are scored at this width. */
const SCORE_WIDTH = 320;
/**
 * At most this many frames are kept, and this many spare canvases: each is
 * up to 2048 px a side (~10 MB), and iOS Safari caps all canvases together;
 * past that, drawing silently gives blank pictures.
 */
const MAX_KEPT = 4;
const MAX_SPARE = 2;

/** The part of the video to keep, and the size to keep it at. */
export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  width: number;
  height: number;
}

interface Frame {
  canvas: HTMLCanvasElement;
  /** when it arrived (performance.now()) */
  t: number;
  score: number;
}

export class RecentFrames {
  /** oldest first; scores decrease towards the newest */
  private frames: Frame[] = [];
  private pool: HTMLCanvasElement[] = [];
  private readonly small = document.createElement('canvas');
  private running = false;
  private readonly video: HTMLVideoElement;
  private readonly crop: () => Crop;
  /** Called with each frame as it's kept (e.g. to show it). */
  onFrame: (canvas: HTMLCanvasElement) => void = () => {};

  constructor(video: HTMLVideoElement, crop: () => Crop) {
    this.video = video;
    this.crop = crop;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.next();
  }

  /** Stops and forgets the frames. */
  stop() {
    this.running = false;
    for (const f of this.frames) free(f.canvas);
    for (const c of this.pool) free(c);
    this.frames = [];
    this.pool = [];
  }

  /**
   * The newest recent frame nearly as sharp as the sharpest (see NEAR), as
   * a canvas the caller now owns; undefined if none was kept.
   */
  take(): HTMLCanvasElement | undefined {
    const recent = this.frames.filter(f => f.t >= performance.now() - WINDOW);
    if (!recent.length) return undefined;
    const best = Math.max(...recent.map(f => f.score));
    const pick = recent.findLast(f => f.score >= best * NEAR)!;
    this.frames = this.frames.filter(f => f !== pick);
    return pick.canvas;
  }

  private next() {
    if (!this.running) return;
    const v = this.video;
    if ('requestVideoFrameCallback' in v) {
      v.requestVideoFrameCallback(() => this.add());
    } else {
      requestAnimationFrame(() => this.add());
    }
  }

  private add() {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && v.videoWidth) {
      const c = this.crop();
      const canvas = this.pool.pop() ?? document.createElement('canvas');
      canvas.width = c.width;
      canvas.height = c.height;
      canvas
        .getContext('2d')!
        .drawImage(v, c.sx, c.sy, c.sw, c.sh, 0, 0, c.width, c.height);
      this.onFrame(canvas);
      const frame = {canvas, t: performance.now(), score: this.score(canvas)};
      while (this.frames.length && this.frames.at(-1)!.score <= frame.score) {
        this.spare(this.frames.pop()!.canvas);
      }
      this.frames.push(frame);
      // Too old to be chosen (the newest always stays), or too many.
      while (
        this.frames.length > MAX_KEPT ||
        (this.frames.length > 1 && this.frames[0].t < frame.t - WINDOW)
      ) {
        this.spare(this.frames.shift()!.canvas);
      }
    }
    this.next();
  }

  /** Keeps a canvas for reuse, or frees it. */
  private spare(canvas: HTMLCanvasElement) {
    if (this.pool.length < MAX_SPARE) this.pool.push(canvas);
    else free(canvas);
  }

  private score(canvas: HTMLCanvasElement): number {
    const w = SCORE_WIDTH;
    const h = Math.max(1, Math.round((canvas.height * w) / canvas.width));
    const s = this.small;
    s.width = w;
    s.height = h;
    const ctx = s.getContext('2d', {willReadFrequently: true})!;
    ctx.drawImage(canvas, 0, 0, w, h);
    return sharpness(ctx.getImageData(0, 0, w, h).data, w, h);
  }
}

/**
 * Gives a canvas's memory back now (iOS counts it until it's collected).
 */
export function free(canvas: HTMLCanvasElement) {
  canvas.width = canvas.height = 0;
}

/**
 * How sharp an image is: the variance of its Laplacian (on brightness),
 * which blur from shake or focus lowers. RGBA pixels, w × h.
 */
export function sharpness(px: Uint8ClampedArray, w: number, h: number) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  return n ? sum2 / n - (sum / n) ** 2 : 0;
}
