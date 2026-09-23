import type {FromWorker, ToWorker} from './protocol.ts';
import type {Candidate, Recognizer, Stroke} from './types.ts';

/** A Recognizer that runs in the handwriting worker. */
export class WorkerRecognizer implements Recognizer {
  readonly name: string;
  /** which engine the worker picked ("WebGPU", …), once loaded */
  engine = '';
  readonly ready: Promise<void>;
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {resolve: (c: Candidate[]) => void; reject: (e: Error) => void}
  >();

  constructor(name: string, modelUrl: URL) {
    this.name = name;
    this.worker = new Worker(
      new URL('handwriting-worker.js', document.baseURI),
      {type: 'module'},
    );
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          this.engine = msg.engine;
          resolve();
        } else if (msg.type === 'result') {
          this.pending.get(msg.id)?.resolve(msg.candidates);
          this.pending.delete(msg.id);
        } else if (msg.id !== undefined) {
          this.pending.get(msg.id)?.reject(new Error(msg.message));
          this.pending.delete(msg.id);
        } else {
          reject(new Error(msg.message));
        }
      };
      this.worker.onerror = e => reject(new Error(e.message));
    });
    this.send({
      type: 'init',
      modelUrl: modelUrl.href,
      wasmUrl: new URL('nn.wasm', document.baseURI).href,
      engine: new URLSearchParams(location.search).get('engine') ?? undefined,
    });
  }

  private send(msg: ToWorker) {
    this.worker.postMessage(msg);
  }

  async recognize(strokes: Stroke[], count: number): Promise<Candidate[]> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.send({type: 'recognize', id, strokes, count});
    });
  }
}
