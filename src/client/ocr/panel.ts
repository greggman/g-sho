/**
 * The photo panel: reads text through the camera, a picture at a time, with
 * a box on every line of text found and a list of what each says. Freeze
 * holds the picture; tap a box or a line to search it, or drag a box around
 * just the part you want to read that. A photo chosen from files is read
 * the same way.
 */
import {h} from '../dom.ts';
import type {Point, Quad} from './pipeline.ts';
import type {FromWorker, ToWorker} from './protocol.ts';
import {trackWorker} from '../versions.ts';

const SVG = 'http://www.w3.org/2000/svg';
/** Photos are scaled down to this (long side) before reading. */
const MAX_SIDE = 2048;
/** Pointer movement (CSS px) that makes a drag rather than a tap. */
const DRAG = 8;
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

/** A box the user drew, being read. */
interface Region {
  photo: Photo;
  found?: Found;
}

export class PhotoPanel {
  readonly element: HTMLElement;
  private readonly status: HTMLElement;
  private readonly cameraButton: HTMLButtonElement;
  private readonly stage: HTMLElement;
  private readonly video: HTMLVideoElement;
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
  private regions = new Map<number, Region>();
  private stream?: MediaStream;
  /** bumped by every new photo or camera start, to drop older ones */
  private session = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private url = '';

  private readonly onPick: (text: string) => void;

  constructor(onPick: (text: string) => void, choosePhoto: () => void) {
    this.onPick = onPick;
    this.status = h('p', {class: 'photo-status', role: 'status'});
    this.cameraButton = h('button', {
      type: 'button',
      // Under the picture, in reach of a thumb.
      class: 'photo-shutter',
      hidden: !navigator.mediaDevices?.getUserMedia,
      onclick: () => (this.stream ? this.freeze() : this.startCamera()),
    });
    this.video = h('video', {class: 'photo-image'});
    // iOS plays camera video inline only with these.
    this.video.muted = true;
    this.video.playsInline = true;
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
        h('div', {class: 'photo-shutter-row'}, this.cameraButton),
        this.list,
      ),
    );
    this.setButtons();
    this.setupDrag();
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
          ? 'The camera isn’t allowed for this site. Choose a photo instead.'
          : name === 'NotFoundError'
            ? 'No camera found. Choose a photo instead.'
            : `Couldn’t start the camera: ${(e as Error).message}`;
      return;
    }
    if (session !== this.session) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    this.video.srcObject = stream;
    this.stage.replaceChildren(this.video, this.svg);
    this.stage.classList.add('camera');
    this.setButtons();
    this.update();
    try {
      await this.video.play();
    } catch {
      // Autoplay of muted inline video is allowed; if not, frames still come.
    }
    this.tick();
  }

  /**
   * Stops the camera and holds the last picture read (or, if none was yet,
   * the one being read).
   */
  freeze() {
    if (!this.stream) return;
    if (!this.shown && !this.next && this.video.videoWidth) {
      const photo = this.capture();
      this.shown = photo;
      void this.read(photo, photo.media as HTMLCanvasElement);
    }
    this.stopCamera();
    if (this.next) {
      if (this.shown) {
        this.send({type: 'cancel'});
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
    this.dock(false);
    this.stopCamera();
    if (this.shown || this.next) this.send({type: 'cancel'});
    this.shown = this.next = undefined;
    this.regions.clear();
    this.stage.replaceChildren(this.svg);
    this.stage.classList.remove('camera');
    this.svg.replaceChildren();
    this.list.replaceChildren();
    this.setButtons();
  }

  private stopCamera() {
    clearTimeout(this.timer);
    if (!this.stream) return;
    for (const t of this.stream.getTracks()) t.stop();
    this.stream = undefined;
    this.video.srcObject = null;
    this.setButtons();
  }

  private setButtons() {
    this.cameraButton.textContent = this.stream ? 'Freeze' : 'Camera';
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

  /** The camera's current picture, scaled for reading. */
  private capture(): Photo {
    // Just the part on screen: the video fills a box of the panel's own
    // shape (style.css), showing its middle.
    const {videoWidth: vw, videoHeight: vh} = this.video;
    const box = this.stage.getBoundingClientRect();
    const k = Math.max(box.width / vw, box.height / vh) || 1;
    const sw = Math.min(vw, box.width / k || vw);
    const sh = Math.min(vh, box.height / k || vh);
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.className = 'photo-image';
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    canvas
      .getContext('2d')!
      .drawImage(
        this.video,
        (vw - sw) / 2,
        (vh - sh) / 2,
        sw,
        sh,
        0,
        0,
        canvas.width,
        canvas.height,
      );
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

  private async read(photo: Photo, source: ImageBitmap | HTMLCanvasElement) {
    const image =
      source instanceof ImageBitmap ? source : await createImageBitmap(source);
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
    const media = this.stream ? this.video : photo?.media;
    if (media && this.stage.firstChild !== media) {
      this.stage.replaceChildren(media, this.svg);
    }
    // The camera's pictures fill a fixed box; photos show whole.
    this.stage.classList.toggle(
      'camera',
      media === this.video || media instanceof HTMLCanvasElement,
    );
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
      text =
        'Tap a line to search it, or drag a box around just the part you want.';
    } else {
      text = photo.found.length
        ? 'Couldn’t read any text. Drag a box around some text to try.'
        : 'No text found. Drag a box around some text to read it.';
    }
    this.status.textContent = text;
  }

  private onMessage(msg: FromWorker) {
    if (msg.type === 'ready' || msg.id === undefined) return;
    const region = this.regions.get(msg.id);
    if (region) {
      this.onRegion(msg.id, region, msg);
      return;
    }
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

  private onRegion(id: number, region: Region, msg: FromWorker) {
    if (msg.type === 'boxes') {
      region.found = this.newFound(msg.boxes[0]);
      region.photo.found.push(region.found);
      if (region.photo === this.shown) {
        this.svg.append(region.found.shape);
        this.list.append(region.found.item);
      }
    } else if (msg.type === 'line' && region.found) {
      const f = region.found;
      if (this.setLine(f, msg.text)) region.photo.lines++;
      if (region.photo !== this.shown) return;
      if (f.text) this.pick(f);
      this.status.textContent = f.text ? '' : 'Couldn’t read that.';
    } else if (msg.type === 'done' || msg.type === 'error') {
      this.regions.delete(id);
      if (msg.type === 'error' && region.photo === this.shown) {
        this.status.textContent = `Couldn’t read that: ${msg.message}`;
      }
    }
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

  /** Taps pick a box; drags draw one, which is then read. */
  private setupDrag() {
    let start: {x: number; y: number; at: Point} | undefined;
    let drawn: SVGPolygonElement | undefined;
    const rect = (a: Point, b: Point): Quad => {
      const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
      const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      return [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
    };
    this.svg.addEventListener('pointerdown', e => {
      if (!this.shown || e.button !== 0) return;
      // Touching the picture holds it, so what's under the finger stays.
      this.freeze();
      start = {x: e.clientX, y: e.clientY, at: this.toPhoto(e)};
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener('pointermove', e => {
      if (!start) return;
      const far = Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG;
      if (!far && !drawn) return;
      if (!drawn) {
        drawn = document.createElementNS(SVG, 'polygon');
        drawn.classList.add('photo-box', 'drawing');
        this.svg.append(drawn);
      }
      const q = rect(start.at, this.toPhoto(e));
      drawn.setAttribute('points', q.map(p => p.join(',')).join(' '));
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      if (!start) return;
      const from = start.at;
      start = undefined;
      const photo = this.shown;
      if (!photo) return;
      if (drawn) {
        drawn.remove();
        drawn = undefined;
        if (cancelled) return;
        const box = rect(from, this.toPhoto(e)).map(([x, y]) => [
          Math.round(Math.min(photo.width - 1, Math.max(0, x))),
          Math.round(Math.min(photo.height - 1, Math.max(0, y))),
        ]) as Quad;
        if (box[1][0] - box[0][0] < 4 || box[3][1] - box[0][1] < 4) return;
        this.status.textContent = 'Reading…';
        const id = this.nextId++;
        this.regions.set(id, {photo});
        this.send({type: 'region', id, photo: photo.id, box});
        return;
      }
      if (cancelled) return;
      // A tap: the line under it (the smallest, if boxes overlap).
      const [x, y] = from;
      let best: Found | undefined;
      for (const f of photo.found) {
        if (!f.text || !inside(f.box, x, y)) continue;
        if (!best || area(f.box) < area(best.box)) best = f;
      }
      if (best) this.pick(best);
    };
    this.svg.addEventListener('pointerup', e => end(e, false));
    this.svg.addEventListener('pointercancel', e => end(e, true));
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
