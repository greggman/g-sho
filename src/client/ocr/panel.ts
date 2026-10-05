/**
 * The photo panel: shows a photo with a box on every line of text found,
 * and lists what each says. Tap a box or a line to search it; drag a box
 * around just the part you want to read that.
 */
import {h} from '../dom.ts';
import type {Point, Quad} from './pipeline.ts';
import type {FromWorker, ToWorker} from './protocol.ts';

const SVG = 'http://www.w3.org/2000/svg';
/** Photos are scaled down to this (long side) before reading. */
const MAX_SIDE = 2048;
/** Pointer movement (CSS px) that makes a drag rather than a tap. */
const DRAG = 8;

interface Found {
  box: Quad;
  text?: string;
  shape: SVGPolygonElement;
  item: HTMLLIElement;
}

export class PhotoPanel {
  readonly element: HTMLElement;
  private readonly status: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly svg: SVGSVGElement;
  private readonly list: HTMLOListElement;
  private readonly worker: Worker;
  private readonly ready: Promise<string>;
  private nextId = 1;
  /** the photo's request id; results for older photos are ignored */
  private current = 0;
  private found = new Map<number, Found[]>();
  private size = {width: 0, height: 0};
  private url = '';
  private lines = 0;
  /** drawn boxes waiting to be read, to search once they are */
  private onRead = new Map<number, (f: Found) => void>();

  private readonly onPick: (text: string) => void;

  constructor(onPick: (text: string) => void, newPhoto: () => void) {
    this.onPick = onPick;
    this.status = h('p', {class: 'photo-status', role: 'status'});
    this.img = h('img', {class: 'photo-image', alt: ''});
    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.classList.add('photo-overlay');
    this.list = h('ol', {class: 'photo-lines', lang: 'ja'});
    this.element = h(
      'div',
      {class: 'photo-panel'},
      h(
        'div',
        {class: 'photo-toolbar'},
        h(
          'button',
          {type: 'button', class: 'photo-new', onclick: () => newPhoto()},
          'New photo',
        ),
        this.status,
      ),
      h('div', {class: 'photo-stage'}, this.img, this.svg),
      this.list,
    );
    this.setupDrag();

    this.worker = new Worker(new URL('ocr-worker.js', document.baseURI), {
      type: 'module',
    });
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
    this.ready.catch(e => {
      this.status.textContent = `Couldn’t load the text reader: ${(e as Error).message}`;
    });
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

  /** Shows a photo and reads it. */
  async show(file: Blob) {
    this.found.clear();
    this.list.replaceChildren();
    this.svg.replaceChildren();
    this.lines = 0;
    URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.img.src = this.url;
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
      this.status.textContent = 'Couldn’t open that image.';
      return;
    }
    this.size = {width: image.width, height: image.height};
    this.svg.setAttribute('viewBox', `0 0 ${image.width} ${image.height}`);
    const id = this.nextId++;
    this.current = id;
    this.status.textContent = 'Loading the text reader…';
    try {
      await this.ready;
    } catch {
      return;
    }
    if (this.current !== id) return;
    this.status.textContent = 'Finding text…';
    this.send({type: 'read', id, image}, [image]);
  }

  private onMessage(msg: FromWorker) {
    if (msg.type === 'ready' || msg.id === undefined) return;
    const found = this.found.get(msg.id);
    if (msg.type === 'boxes') {
      // A region read belongs to the current photo too.
      if (msg.id < this.current) return;
      const entries = msg.boxes.map(box => this.addBox(box));
      this.found.set(msg.id, entries);
      if (msg.id === this.current) {
        this.status.textContent = msg.boxes.length
          ? `Reading ${msg.boxes.length} line${msg.boxes.length === 1 ? '' : 's'}…`
          : 'No text found. Drag a box around some text to read it.';
      }
    } else if (msg.type === 'line' && found) {
      const f = found[msg.index];
      f.text = msg.text;
      f.shape.classList.remove('pending');
      this.onRead.get(msg.id)?.(f);
      this.onRead.delete(msg.id);
      if (!msg.text) {
        f.shape.classList.add('unread');
        f.item.remove();
        return;
      }
      this.lines++;
      f.item.replaceChildren(
        h('button', {type: 'button', onclick: () => this.pick(f)}, msg.text),
      );
      f.item.hidden = false;
      f.shape.append(title(msg.text));
    } else if (msg.type === 'done' && found && msg.id === this.current) {
      this.status.textContent = this.lines
        ? 'Tap a line to search it, or drag a box around just the part you want.'
        : 'Couldn’t read any text. Drag a box around some text to try.';
    } else if (msg.type === 'error') {
      if (msg.id >= this.current) {
        this.status.textContent = `Couldn’t read the photo: ${msg.message}`;
      }
    }
  }

  private addBox(box: Quad): Found {
    const shape = document.createElementNS(SVG, 'polygon');
    shape.setAttribute('points', box.map(p => p.join(',')).join(' '));
    shape.classList.add('photo-box', 'pending');
    const item = h('li', {hidden: true});
    const f: Found = {box, shape, item};
    this.svg.append(shape);
    this.list.append(item);
    return f;
  }

  private pick(f: Found) {
    if (!f.text) return;
    for (const s of this.svg.querySelectorAll('.selected')) {
      s.classList.remove('selected');
    }
    f.shape.classList.add('selected');
    this.onPick(f.text);
  }

  /** The photo's coordinates under a pointer. */
  private toPhoto(e: PointerEvent): Point {
    const r = this.svg.getBoundingClientRect();
    return [
      ((e.clientX - r.left) / r.width) * this.size.width,
      ((e.clientY - r.top) / r.height) * this.size.height,
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
      if (!this.size.width || e.button !== 0) return;
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
      if (drawn) {
        drawn.remove();
        drawn = undefined;
        if (cancelled) return;
        const box = rect(from, this.toPhoto(e)).map(([x, y]) => [
          Math.round(Math.min(this.size.width - 1, Math.max(0, x))),
          Math.round(Math.min(this.size.height - 1, Math.max(0, y))),
        ]) as Quad;
        if (box[1][0] - box[0][0] < 4 || box[3][1] - box[0][1] < 4) return;
        this.status.textContent = 'Reading…';
        const id = this.nextId++;
        this.onRead.set(id, f => {
          if (f.text) this.pick(f);
          this.status.textContent = f.text ? '' : 'Couldn’t read that.';
        });
        this.send({type: 'region', id, box});
        return;
      }
      if (cancelled) return;
      // A tap: the line under it (the smallest, if boxes overlap).
      const [x, y] = from;
      let best: Found | undefined;
      for (const f of [...this.found.values()].flat()) {
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
