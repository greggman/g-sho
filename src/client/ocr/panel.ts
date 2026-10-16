/**
 * The photo panel: reads text through the camera, a picture at a time, with
 * a box on every line of text found and a list of what each says. Freeze
 * holds the picture; tap a box or a line to search it, and pinch to zoom in.
 * A photo chosen from files is read the same way.
 */
import {h} from '../dom.ts';
import type {Point, Quad} from './pipeline.ts';
import type {FromWorker, ToWorker} from './protocol.ts';
import {trackWorker} from '../versions.ts';
import {free, RecentFrames, type Crop} from './frames.ts';

const SVG = 'http://www.w3.org/2000/svg';
/** Photos are scaled down to this (long side) before reading. */
const MAX_SIDE = 2048;
/** Pointer movement (CSS px) that makes a drag rather than a tap. */
const TAP_SLOP = 8;
/** How far the picture can be pinched in. */
const MAX_ZOOM = 6;
/** The camera's pictures are read at most this often (ms). */
const PERIOD = 500;

interface Found {
  box: Quad;
  text?: string;
  shape: SVGPolygonElement;
  item: HTMLLIElement;
}

/** A picture: being read, or on screen with what was found in it. */
interface Photo {
  id: number;
  media: HTMLImageElement | HTMLCanvasElement;
  width: number;
  height: number;
  found: Found[];
  lines: number;
  done: boolean;
  /** when reading it started (performance.now()) */
  started: number;
}

export class PhotoPanel {
  readonly element: HTMLElement;
  private readonly status: HTMLElement;
  private readonly cameraButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly stage: HTMLElement;
  private readonly video: HTMLVideoElement;
  /**
   * The live view: each camera frame drawn by the same code that keeps the
   * frames, so a held picture is exactly what was on screen (the video
   * itself, scaled by CSS, needn't show the same part).
   */
  private readonly live: HTMLCanvasElement;
  private readonly frames: RecentFrames;
  private readonly svg: SVGSVGElement;
  private readonly list: HTMLOListElement;
  private readonly worker: Worker;
  private readonly ready: Promise<string>;
  private loaded = false;
  private nextId = 1;
  /** the picture on screen */
  private shown?: Photo;
  /** with the camera on: the newer picture being read behind it */
  private next?: Photo;
  private stream?: MediaStream;
  /** bumped by every new photo or camera start, to drop older ones */
  private session = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private url = '';
  /** Pinch zoom: scale, and offset as a fraction of the picture's size. */
  private zoom = {z: 1, x: 0, y: 0};
  /** The camera's video size (e.g. "1920x1080"), for saved pictures. */
  private streamSize = '';

  private readonly onPick: (text: string) => void;

  constructor(onPick: (text: string) => void, choosePhoto: () => void) {
    this.onPick = onPick;
    this.status = h('p', {class: 'photo-status', role: 'status'});
    this.cameraButton = h('button', {
      type: 'button',
      // Under the picture, in reach of a thumb.
      class: 'photo-shutter',
      hidden: !navigator.mediaDevices?.getUserMedia,
      onclick: () => (this.stream ? this.freeze(true) : this.startCamera()),
    });
    // A held camera picture can be saved, e.g. to report text not found.
    this.saveButton = h(
      'button',
      {type: 'button', class: 'photo-new', onclick: () => this.save()},
      'Save picture',
    );
    // Only a source of frames: in the page (iOS may not play it otherwise)
    // but unseen.
    this.video = h('video', {class: 'photo-source'});
    // iOS plays camera video inline only with these.
    this.video.muted = true;
    this.video.playsInline = true;
    this.live = h('canvas', {class: 'photo-image'});
    this.frames = new RecentFrames(this.video, () => this.crop());
    this.frames.onFrame = frame => this.showLive(frame);
    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.classList.add('photo-overlay');
    this.stage = h('div', {class: 'photo-stage'}, this.svg);
    this.list = h('ol', {class: 'photo-lines', lang: 'ja'});
    this.element = h(
      'div',
      {class: 'photo-panel'},
      h(
        'div',
        {class: 'photo-toolbar'},
        h(
          'button',
          {type: 'button', class: 'photo-new', onclick: () => choosePhoto()},
          'Choose photo',
        ),
        this.status,
      ),
      this.stage,
      h(
        'div',
        {class: 'photo-bottom'},
        h(
          'div',
          {class: 'photo-shutter-row'},
          this.cameraButton,
          this.saveButton,
        ),
        this.list,
      ),
    );
    this.setButtons();
    this.setupGestures();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.freeze();
    });

    this.worker = new Worker(new URL('ocr-worker.js', document.baseURI), {
      type: 'module',
    });
    trackWorker('Photo reading (OCR)', this.worker);
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data;
        if (msg.type === 'ready') resolve(msg.engine);
        else if (msg.type === 'error' && msg.id === undefined) {
          reject(new Error(msg.message));
        } else this.onMessage(msg);
      };
      this.worker.onerror = e => reject(new Error(e.message));
    });
    this.ready.then(
      () => {
        this.loaded = true;
        this.update();
      },
      e => {
        this.stopCamera();
        this.status.textContent = `Couldn’t load the text reader: ${(e as Error).message}`;
      },
    );
    this.send({
      type: 'init',
      baseUrl: new URL('ocr/', document.baseURI).href,
      wasmUrl: new URL('nn.wasm', document.baseURI).href,
      engine: new URLSearchParams(location.search).get('engine') ?? undefined,
    });
  }

  private send(msg: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }

  /** Turns on the camera and reads what it sees until frozen. */
  async startCamera() {
    this.reset();
    const session = this.session;
    // The camera's box at its size from the start (it never changes).
    this.live.width = this.live.height = 0;
    this.stage.replaceChildren(this.live, this.svg);
    this.stage.classList.add('camera');
    this.status.textContent = 'Starting the camera…';
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: {ideal: 'environment'},
          width: {ideal: 3840},
          height: {ideal: 2160},
        },
      });
    } catch (e) {
      if (session !== this.session) return;
      const name = (e as Error).name;
      this.status.textContent =
        name === 'NotAllowedError'
          ? 'The camera isn’t allowed here. Choose a photo instead.'
          : name === 'NotFoundError'
            ? 'No camera found. Choose a photo instead.'
            : `Couldn’t start the camera: ${(e as Error).message}`;
      this.stage.replaceChildren(this.svg);
      this.stage.classList.remove('camera');
      return;
    }
    if (session !== this.session) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    this.video.srcObject = stream;
    this.stage.replaceChildren(this.video, this.live, this.svg);
    this.setButtons();
    this.update();
    try {
      await this.video.play();
    } catch {
      // Autoplay of muted inline video is allowed; if not, frames still come.
    }
    if (session !== this.session || !this.stream) return;
    this.frames.start();
    this.tick();
  }

  /**
   * Stops the camera and holds a picture: with `now` (the Freeze button)
   * what's on screen, a sharp frame from the last moment, which is then
   * read; otherwise (a box or line tapped) the last picture read, which the
   * boxes belong to (or, if none was yet, the one being read).
   */
  freeze(now = false) {
    if (!this.stream) return;
    const held = now ? this.frames.take() : undefined;
    if (held) {
      this.stopCamera();
      // Whatever is being read is of an older frame.
      this.send({type: 'cancel'});
      this.discard(this.next);
      this.discard(this.shown);
      this.next = undefined;
      held.className = 'photo-image';
      const photo = this.newPhoto(held, held.width, held.height);
      this.shown = photo;
      this.draw();
      this.update();
      void this.read(photo, held);
      return;
    }
    if (!this.shown && !this.next && this.video.videoWidth) {
      const photo = this.capture();
      this.shown = photo;
      void this.read(photo, photo.media as HTMLCanvasElement);
    }
    this.stopCamera();
    if (this.next) {
      if (this.shown) {
        this.send({type: 'cancel'});
        this.discard(this.next);
      } else {
        this.shown = this.next;
      }
      this.next = undefined;
    }
    this.draw();
    this.update();
  }

  /** Shows a photo and reads it. */
  async show(file: Blob) {
    this.reset();
    const session = this.session;
    URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    const img = h('img', {class: 'photo-image', alt: '', src: this.url});
    this.status.textContent = 'Opening the photo…';
    let image: ImageBitmap;
    try {
      image = await createImageBitmap(file);
      const scale = MAX_SIDE / Math.max(image.width, image.height);
      if (scale < 1) {
        const full = image;
        image = await createImageBitmap(full, {
          resizeWidth: Math.round(full.width * scale),
          resizeHeight: Math.round(full.height * scale),
          resizeQuality: 'high',
        });
        full.close();
      }
    } catch {
      if (session === this.session) {
        this.status.textContent = 'Couldn’t open that image.';
      }
      return;
    }
    if (session !== this.session) {
      image.close();
      return;
    }
    const photo = this.newPhoto(img, image.width, image.height);
    this.shown = photo;
    this.draw();
    this.update();
    await this.read(photo, image);
  }

  /** Forgets the photo on screen, and stops the camera. */
  private reset() {
    this.session++;
    this.setZoom(1, 0, 0);
    this.dock(false);
    this.stopCamera();
    if (this.shown || this.next) this.send({type: 'cancel'});
    this.discard(this.shown);
    this.discard(this.next);
    this.shown = this.next = undefined;
    this.stage.replaceChildren(this.svg);
    this.stage.classList.remove('camera');
    this.svg.replaceChildren();
    this.list.replaceChildren();
    this.setButtons();
  }

  private stopCamera() {
    clearTimeout(this.timer);
    this.frames.stop();
    if (!this.stream) return;
    const {videoWidth: vw, videoHeight: vh} = this.video;
    this.streamSize = vw ? `${vw}x${vh}` : '';
    for (const t of this.stream.getTracks()) t.stop();
    this.stream = undefined;
    this.video.srcObject = null;
    this.setButtons();
  }

  private setButtons() {
    this.cameraButton.textContent = this.stream ? 'Freeze' : 'Camera';
    this.saveButton.hidden =
      !!this.stream || !(this.shown?.media instanceof HTMLCanvasElement);
  }

  /** Downloads the held camera picture as a PNG. */
  private save() {
    const media = this.shown?.media;
    if (!(media instanceof HTMLCanvasElement)) return;
    media.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      // The camera's own size too: is a blurry picture a small stream?
      const size = this.streamSize ? `-${this.streamSize}` : '';
      h('a', {href: url, download: `g-sho-${stamp}${size}.png`}).click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }, 'image/png');
  }

  private newPhoto(
    media: Photo['media'],
    width: number,
    height: number,
  ): Photo {
    return {
      id: this.nextId++,
      media,
      width,
      height,
      found: [],
      lines: 0,
      done: false,
      started: performance.now(),
    };
  }

  /**
   * The part of the video on screen: it fills a box of the panel's own
   * shape (style.css), showing its middle. Kept at up to MAX_SIDE.
   */
  private crop(): Crop {
    const {videoWidth: vw, videoHeight: vh} = this.video;
    const box = this.stage.getBoundingClientRect();
    const k = Math.max(box.width / vw, box.height / vh) || 1;
    const sw = Math.min(vw, box.width / k || vw);
    const sh = Math.min(vh, box.height / k || vh);
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    return {
      sx: (vw - sw) / 2,
      sy: (vh - sh) / 2,
      sw,
      sh,
      width: Math.round(sw * scale),
      height: Math.round(sh * scale),
    };
  }

  /** Puts a camera frame in the live view, at the screen's resolution. */
  private showLive(frame: HTMLCanvasElement) {
    const box = this.stage.getBoundingClientRect();
    const scale = Math.min(
      1,
      (box.width * devicePixelRatio) / frame.width || 1,
    );
    const w = Math.round(frame.width * scale);
    const h = Math.round(frame.height * scale);
    if (this.live.width !== w || this.live.height !== h) {
      this.live.width = w;
      this.live.height = h;
    }
    this.live.getContext('2d')!.drawImage(frame, 0, 0, w, h);
  }

  /** The camera's current picture, for reading. */
  private capture(): Photo {
    const c = this.crop();
    const canvas = document.createElement('canvas');
    canvas.className = 'photo-image';
    canvas.width = c.width;
    canvas.height = c.height;
    canvas
      .getContext('2d')!
      .drawImage(this.video, c.sx, c.sy, c.sw, c.sh, 0, 0, c.width, c.height);
    return this.newPhoto(canvas, canvas.width, canvas.height);
  }

  /** With the camera on: reads its next picture, unless one is being read. */
  private tick() {
    clearTimeout(this.timer);
    if (!this.stream || this.next) return;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.timer = setTimeout(() => this.tick(), 100);
      return;
    }
    const photo = this.capture();
    this.next = photo;
    void this.read(photo, photo.media as HTMLCanvasElement);
  }

  /** After a camera picture is read, the next one, at most every PERIOD. */
  private later(photo: Photo) {
    const wait = PERIOD - (performance.now() - photo.started);
    this.timer = setTimeout(() => this.tick(), Math.max(0, wait));
  }

  /** Frees a camera picture that's done with (see frames.ts MAX_KEPT). */
  private discard(photo: Photo | undefined) {
    if (photo?.media instanceof HTMLCanvasElement) free(photo.media);
  }

  private async read(photo: Photo, source: ImageBitmap | HTMLCanvasElement) {
    let image: ImageBitmap;
    try {
      image =
        source instanceof ImageBitmap
          ? source
          : await createImageBitmap(source);
    } catch {
      return; // freed meanwhile (a newer picture replaced it)
    }
    try {
      await this.ready;
    } catch {
      image.close();
      return;
    }
    if (photo !== this.shown && photo !== this.next) {
      image.close();
      return;
    }
    this.send({type: 'read', id: photo.id, image}, [image]);
  }

  /** Puts the picture on screen with what's been found in it. */
  private draw() {
    const photo = this.shown;
    const media = this.stream ? this.live : photo?.media;
    if (media && !this.stage.contains(media)) {
      this.stage.replaceChildren(
        ...(this.stream ? [this.video] : []),
        media,
        this.svg,
      );
    }
    // The camera's pictures fill a fixed box; photos show whole.
    this.stage.classList.toggle('camera', media instanceof HTMLCanvasElement);
    this.setButtons();
    if (!photo) return;
    this.svg.setAttribute('viewBox', `0 0 ${photo.width} ${photo.height}`);
    this.svg.replaceChildren(...photo.found.map(f => f.shape));
    this.list.replaceChildren(...photo.found.map(f => f.item));
  }

  private update() {
    const photo = this.shown;
    let text = '';
    if (!this.loaded) {
      text = 'Loading the text reader…';
    } else if (this.stream) {
      text = !photo
        ? 'Looking for text…'
        : photo.lines
          ? 'Tap a line to search it, or Freeze to hold this picture.'
          : 'Point the camera at some text.';
    } else if (!photo) {
      text = '';
    } else if (!photo.done) {
      const n = photo.found.length;
      text = n ? `Reading ${n} line${n === 1 ? '' : 's'}…` : 'Finding text…';
    } else if (photo.lines) {
      text = 'Tap a line to search it.';
    } else {
      text = photo.found.length ? 'Couldn’t read any text.' : 'No text found.';
    }
    this.status.textContent = text;
  }

  private onMessage(msg: FromWorker) {
    if (msg.type === 'ready' || msg.id === undefined) return;
    const photo = [this.shown, this.next].find(p => p?.id === msg.id);
    if (!photo) return;
    if (msg.type === 'boxes') {
      photo.found = msg.boxes.map(box => this.newFound(box));
      if (photo === this.shown) this.draw();
    } else if (msg.type === 'line') {
      if (this.setLine(photo.found[msg.index], msg.text)) photo.lines++;
    } else {
      photo.done = true;
      if (msg.type === 'error') {
        console.warn('Couldn’t read the photo:', msg.message);
      }
      if (photo === this.next) {
        // The camera's newer picture replaces the one on screen.
        this.discard(this.shown);
        this.shown = photo;
        this.next = undefined;
        this.draw();
        this.later(photo);
      }
      if (msg.type === 'error' && !this.stream) {
        this.status.textContent = `Couldn’t read the photo: ${msg.message}`;
        return;
      }
    }
    if (photo === this.shown) this.update();
  }

  private newFound(box: Quad): Found {
    const shape = document.createElementNS(SVG, 'polygon');
    shape.setAttribute('points', box.map(p => p.join(',')).join(' '));
    shape.classList.add('photo-box', 'pending');
    const item = h('li', {hidden: true});
    return {box, shape, item};
  }

  /** Shows what a line says; true if it could be read. */
  private setLine(f: Found, text: string) {
    f.text = text;
    f.shape.classList.remove('pending');
    if (!text) {
      f.shape.classList.add('unread');
      f.item.remove();
      return false;
    }
    f.item.replaceChildren(
      h('button', {type: 'button', onclick: () => this.pick(f)}, text),
    );
    f.item.hidden = false;
    f.shape.append(title(text));
    return true;
  }

  private pick(f: Found) {
    if (!f.text) return;
    // Searching holds the picture the line was found in.
    this.freeze();
    for (const s of this.svg.querySelectorAll('.selected')) {
      s.classList.remove('selected');
    }
    f.shape.classList.add('selected');
    this.dock(true);
    this.onPick(f.text);
  }

  /**
   * Docked, the panel is compact and stays at the top of the screen (see
   * style.css), so the search results scroll under the picture.
   */
  private dock(on: boolean) {
    this.element.classList.toggle('docked', on);
  }

  /** The photo's coordinates under a pointer. */
  private toPhoto(e: PointerEvent): Point {
    const r = this.svg.getBoundingClientRect();
    const {width, height} = this.shown!;
    return [
      ((e.clientX - r.left) / r.width) * width,
      ((e.clientY - r.top) / r.height) * height,
    ];
  }

  /** Zooms the picture and its boxes (style.css), kept covering the box. */
  private setZoom(z: number, x: number, y: number) {
    if (z < 1.02) [z, x, y] = [1, 0, 0];
    x = Math.min(0, Math.max(1 - z, x));
    y = Math.min(0, Math.max(1 - z, y));
    this.zoom = {z, x, y};
    const st = this.stage.style;
    st.setProperty('--z', String(z));
    st.setProperty('--zx', String(x));
    st.setProperty('--zy', String(y));
  }

  /** A point on screen as a fraction of the picture's box. */
  private toStage(x: number, y: number): Point {
    const r = this.stage.getBoundingClientRect();
    return [(x - r.left) / r.width, (y - r.top) / r.height];
  }

  /** Zooms by `factor`, keeping the point on screen at (x, y) in place. */
  private zoomAround(x: number, y: number, factor: number) {
    const [u, v] = this.toStage(x, y);
    const {z, x: zx, y: zy} = this.zoom;
    const z2 = Math.min(MAX_ZOOM, Math.max(1, z * factor));
    this.setZoom(z2, u - ((u - zx) / z) * z2, v - ((v - zy) / z) * z2);
  }

  /**
   * One finger: a tap picks the line under it; a drag moves a zoomed-in
   * picture. Two: pinch to zoom and move it (also a trackpad pinch).
   */
  private setupGestures() {
    let start: {x: number; y: number; zx: number; zy: number} | undefined;
    let moved = false;
    const pointers = new Map<number, Point>();
    /** a pinch: finger spread, the picture point between them, the zoom */
    let pinch: {d: number; at: Point; z: number} | undefined;
    /** two fingers were down: nothing else until all are lifted */
    let gesture = false;
    const fingers = () => {
      const [[ax, ay], [bx, by]] = [...pointers.values()];
      return {
        x: (ax + bx) / 2,
        y: (ay + by) / 2,
        d: Math.hypot(ax - bx, ay - by),
      };
    };
    this.stage.addEventListener('pointerdown', e => {
      if (!this.shown || e.button !== 0) return;
      // Touching the picture holds it, so what's under the finger stays.
      this.freeze();
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      try {
        this.stage.setPointerCapture(e.pointerId);
      } catch {
        // Not a live pointer (e.g. a synthetic event): no capture needed.
      }
      if (pointers.size === 2) {
        start = undefined;
        gesture = true;
        const f = fingers();
        const [u, v] = this.toStage(f.x, f.y);
        const {z, x, y} = this.zoom;
        pinch = {d: f.d, at: [(u - x) / z, (v - y) / z], z};
      }
      if (gesture) return;
      start = {x: e.clientX, y: e.clientY, zx: this.zoom.x, zy: this.zoom.y};
      moved = false;
    });
    this.stage.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pointers.size >= 2) {
        const f = fingers();
        const z = Math.min(
          MAX_ZOOM,
          Math.max(1, (pinch.z * f.d) / Math.max(1, pinch.d)),
        );
        const [u, v] = this.toStage(f.x, f.y);
        this.setZoom(z, u - pinch.at[0] * z, v - pinch.at[1] * z);
        return;
      }
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) <= TAP_SLOP) return;
      moved = true;
      const r = this.stage.getBoundingClientRect();
      this.setZoom(
        this.zoom.z,
        start.zx + dx / r.width,
        start.zy + dy / r.height,
      );
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = undefined;
      if (gesture) {
        if (!pointers.size) gesture = false;
        return;
      }
      if (!start) return;
      start = undefined;
      const photo = this.shown;
      if (!photo || moved || cancelled) return;
      // A tap: the line under it (the smallest, if boxes overlap).
      const [x, y] = this.toPhoto(e);
      let best: Found | undefined;
      for (const f of photo.found) {
        if (!f.text || !inside(f.box, x, y)) continue;
        if (!best || area(f.box) < area(best.box)) best = f;
      }
      if (best) this.pick(best);
    };
    this.stage.addEventListener('pointerup', e => end(e, false));
    this.stage.addEventListener('pointercancel', e => end(e, true));
    // A trackpad pinch arrives as a wheel event with Ctrl.
    this.stage.addEventListener(
      'wheel',
      e => {
        if (!e.ctrlKey || !this.shown) return;
        e.preventDefault();
        this.freeze();
        this.zoomAround(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      },
      {passive: false},
    );
    // Safari's own pinch would zoom the whole page.
    this.stage.addEventListener('gesturestart', e => e.preventDefault());
    this.stage.addEventListener(
      'touchmove',
      e => {
        if (e.touches.length > 1) e.preventDefault();
      },
      {passive: false},
    );
  }
}

function title(text: string) {
  const t = document.createElementNS(SVG, 'title');
  t.textContent = text;
  return t;
}

function inside(q: Quad, x: number, y: number) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const c = Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax));
    if (c && sign && c !== sign) return false;
    if (c) sign = c;
  }
  return true;
}

function area(q: Quad) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    a += ax * by - bx * ay;
  }
  return Math.abs(a) / 2;
}
