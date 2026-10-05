/**
 * OCR worker: loads PaddleOCR's detector and recognizer, then finds and
 * reads the lines of text in photos, off the main thread. Lines are posted
 * as they're read, so the page can show them one by one.
 */
import {loadGraph, type Graph, type Tensor} from '../nn/graph.ts';
import {runGraphCpu} from '../nn/graph-cpu.ts';
import {
  detect,
  OPTIONS,
  readLine,
  type Rgba,
  type RunModel,
} from './pipeline.ts';
import type {FromWorker, ToWorker} from './protocol.ts';

interface Models {
  det: RunModel;
  rec: RunModel;
  dict: string[];
}

let ready: Promise<Models> | undefined;
/** the last photo, for reading regions of it */
let photo: Rgba | undefined;
/** the latest photo's request; older ones stop between lines */
let latest = 0;

function post(message: FromWorker) {
  postMessage(message);
}

function cpu(graph: Graph): RunModel {
  return (x: Tensor) =>
    runGraphCpu(graph, {[graph.spec.inputs[0]]: x}).get(
      graph.spec.outputs[0],
    ) as Tensor;
}

async function init({baseUrl}: ToWorker & {type: 'init'}): Promise<Models> {
  const base = new URL(baseUrl);
  const [det, rec, dict] = await Promise.all([
    loadGraph(new URL('det/', base)),
    loadGraph(new URL('rec/', base)),
    fetch(new URL('dict.txt', base)).then(async r => {
      if (!r.ok) throw new Error(`dict.txt: ${r.status}`);
      return (await r.text()).replace(/\n$/, '').split('\n');
    }),
  ]);
  post({type: 'ready', engine: 'JavaScript'});
  return {det: cpu(det), rec: cpu(rec), dict};
}

function pixels(image: ImageBitmap): Rgba {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  image.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    ready = init(msg);
    ready.catch(err => post({type: 'error', message: String(err)}));
    return;
  }
  if (msg.type === 'read') latest = msg.id;
  try {
    const {det, rec, dict} = await ready!;
    if (msg.type === 'read') photo = pixels(msg.image);
    const img = photo;
    if (!img) throw new Error('no photo');
    const boxes = msg.type === 'read' ? await detect(img, det) : [msg.box];
    post({type: 'boxes', id: msg.id, boxes});
    for (const [index, box] of boxes.entries()) {
      // Let other requests in between lines (a region drawn meanwhile, or a
      // new photo, which makes this one stale).
      await new Promise(resolve => setTimeout(resolve));
      if (msg.type === 'read' && latest !== msg.id) return;
      const line = await readLine(img, box, rec, dict);
      const ok = line.score >= OPTIONS.textScore;
      post({
        type: 'line',
        id: msg.id,
        index,
        text: ok ? line.text : '',
        score: line.score,
      });
    }
    post({type: 'done', id: msg.id});
  } catch (err) {
    post({type: 'error', message: String(err), id: msg.id});
  }
};
