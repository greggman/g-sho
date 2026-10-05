import type {Quad} from './pipeline.ts';

/** Messages between the page and the OCR worker. */
export type ToWorker =
  | {
      type: 'init';
      /** where det/, rec/ and dict.txt are */
      baseUrl: string;
      /** force an engine ("js"), for testing */
      engine?: string;
    }
  /** Find and read every line; the photo stays in the worker for 'region'. */
  | {type: 'read'; id: number; image: ImageBitmap}
  /** Read just this part of the last photo (a box the user drew). */
  | {type: 'region'; id: number; box: Quad};

export type FromWorker =
  | {type: 'ready'; engine: string}
  | {type: 'error'; message: string; id?: number}
  /** where the lines are, before they're read */
  | {type: 'boxes'; id: number; boxes: Quad[]}
  /** one line read (index into the boxes; text empty if unreadable) */
  | {type: 'line'; id: number; index: number; text: string; score: number}
  | {type: 'done'; id: number};
