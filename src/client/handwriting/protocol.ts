import type {Candidate, Stroke} from './types.ts';

/** Messages between the page and the handwriting worker. */
export type ToWorker =
  | {
      type: 'init';
      modelUrl: string;
      wasmUrl: string;
      /** force an engine ("webgpu", "wasm", "js"), for testing */
      engine?: string;
    }
  | {type: 'recognize'; id: number; strokes: Stroke[]; count: number};

export type FromWorker =
  | {type: 'ready'; engine: string}
  | {type: 'error'; message: string; id?: number}
  | {type: 'result'; id: number; candidates: Candidate[]};
