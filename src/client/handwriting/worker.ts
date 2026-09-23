/**
 * Handwriting recognition worker: loads the model, picks the fastest
 * available engine, and turns strokes into ranked candidates off the main
 * thread.
 */
import {runCpu} from '../nn/cpu.ts';
import {loadModel, type Model} from '../nn/model.ts';
import {WasmEngine} from '../nn/wasm.ts';
import {WebGpuEngine} from '../nn/webgpu.ts';
import {preprocess, SOURCE_SIZE} from './lt8-preprocess.ts';
import type {FromWorker, ToWorker} from './protocol.ts';
import {rasterize} from './raster.ts';
import type {Candidate} from './types.ts';

/**
 * The drawing is rendered at the size and pen width of the model's own demo
 * canvas (320px, 14px pen), which is what its canvas accuracy was measured
 * on, then scaled to the model's 128×128 input.
 */
const DRAW_SIZE = 320;
const LINE_WIDTH = 14;

type Run = (input: Float32Array) => Promise<Float32Array>;

let ready: Promise<{run: Run; labels: string[]}> | undefined;

function post(message: FromWorker) {
  postMessage(message);
}

/** The fastest engine available: WebGPU, then WebAssembly, then plain JS. */
async function chooseEngine(
  model: Model,
  wasmUrl: string,
  force?: string,
): Promise<[string, Run]> {
  if (!force || force === 'webgpu') {
    try {
      const gpu = await WebGpuEngine.create(model);
      if (gpu) return ['WebGPU', input => gpu.run(input)];
    } catch (e) {
      console.warn('WebGPU unavailable:', e);
    }
  }
  if (!force || force === 'wasm') {
    try {
      const wasm = await WasmEngine.create(
        model,
        await (await fetch(wasmUrl)).arrayBuffer(),
      );
      return ['WebAssembly', async input => wasm.run(input)];
    } catch (e) {
      console.warn('WebAssembly engine unavailable:', e);
    }
  }
  return ['JavaScript', async input => runCpu(model, input)];
}

function softmax(logits: Float32Array): Float32Array {
  let max = -Infinity;
  for (const v of logits) max = Math.max(max, v);
  const out = new Float32Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - max);
    sum += out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/** Indices of the `count` largest values, largest first. */
function topK(values: Float32Array, count: number): number[] {
  return [...values.keys()]
    .sort((a, b) => values[b] - values[a])
    .slice(0, count);
}

async function init({
  modelUrl,
  wasmUrl,
  engine: force,
}: ToWorker & {type: 'init'}) {
  const base = new URL(modelUrl);
  const [model, labels] = await Promise.all([
    loadModel(base),
    fetch(new URL('labels.json', base)).then(
      r => r.json() as Promise<string[]>,
    ),
  ]);
  const [engine, run] = await chooseEngine(model, wasmUrl, force);
  post({type: 'ready', engine});
  return {run, labels};
}

onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    ready = init(msg);
    ready.catch(err => post({type: 'error', message: String(err)}));
    return;
  }
  try {
    const {run, labels} = await ready!;
    const start = performance.now();
    const pixels = rasterize(msg.strokes, DRAW_SIZE, LINE_WIDTH, SOURCE_SIZE);
    const probs = softmax(await run(preprocess(pixels)));
    const candidates: Candidate[] = topK(probs, msg.count).map(i => ({
      char: labels[i],
      score: probs[i],
    }));
    post({
      type: 'result',
      id: msg.id,
      candidates,
      ms: performance.now() - start,
    });
  } catch (err) {
    post({type: 'error', message: String(err), id: msg.id});
  }
};
