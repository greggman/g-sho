/**
 * The whole OCR pipeline (src/client/ocr/pipeline.ts) on test images, on the
 * CPU engine. What RapidOCR reads with the same models is the bar. Skipped
 * when the models aren't downloaded (npm run download:models).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, test} from 'node:test';
import {convertGraph} from '../scripts/convert-graph.ts';
import {readOnnx} from '../scripts/onnx.ts';
import {decodeGraph, type Graph, type Tensor} from '../src/client/nn/graph.ts';
import {runGraphCpu} from '../src/client/nn/graph-cpu.ts';
import {
  convexHull,
  ctcDecode,
  detSize,
  minAreaRect,
  readText,
  rotateLeft,
} from '../src/client/ocr/pipeline.ts';
import {readPng} from './png.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODELS = path.join(ROOT, '.cache/ocr');
const FIXTURES = path.join(ROOT, 'test/fixtures/ocr');
const PHOTO = path.join(ROOT, 'test/images/ocr/IMG_6674.png');
const have = fs.existsSync(path.join(MODELS, 'det.onnx'));

describe('OCR pipeline', {skip: !have && 'models not downloaded'}, () => {
  const load = (file: string) => {
    const {spec, weights} = convertGraph(
      readOnnx(fs.readFileSync(path.join(MODELS, file))),
    );
    return decodeGraph(spec, weights.buffer.slice(0) as ArrayBuffer);
  };
  const run = (g: Graph) => (x: Tensor) =>
    runGraphCpu(g, {[g.spec.inputs[0]]: x}).get(g.spec.outputs[0]) as Tensor;
  const det = run(load('det.onnx'));
  const rec = run(load('rec.onnx'));
  const dict = fs
    .readFileSync(path.join(MODELS, 'dict.txt'), 'utf8')
    .replace(/\n$/, '')
    .split('\n');
  const read = async (file: string) =>
    (await readText(readPng(fs.readFileSync(file)), det, rec, dict)).map(
      l => l.text,
    );

  for (const [name, want] of [
    ['label', ['香り豊かな', '黒煎り七味', '内容量 15g']],
    [
      'lines',
      ['日本語を勉強しています。', '猫が魚を食べた。', '東京駅まで歩いて五分'],
    ],
    // Vertical lines: each read top to bottom.
    ['vertical', ['京都の味', '七味唐辛子']],
    ['colorful', ['抹茶ラテ']],
  ] as const) {
    test(name, async () => {
      assert.deepEqual(await read(path.join(FIXTURES, `${name}.png`)), want);
    });
  }

  test(
    'a phone photo',
    {skip: !fs.existsSync(PHOTO) && 'no photo'},
    async () => {
      const lines = await read(PHOTO);
      assert.ok(lines.includes('黒煎り'), lines.join(' | '));
      assert.ok(lines.includes('七味'), lines.join(' | '));
    },
  );
});

test('detection size: multiples of 32, long side capped', () => {
  assert.deepEqual(detSize(3024, 4032), {w: 736, h: 960});
  assert.deepEqual(detSize(480, 300), {w: 960, h: 608});
  assert.deepEqual(detSize(10, 10), {w: 736, h: 736});
});

test('smallest rectangle around a rotated one', () => {
  // A 40×10 rectangle turned 30°.
  const a = Math.PI / 6;
  const pts: [number, number][] = [];
  for (let u = -20; u <= 20; u += 2) {
    for (let v = -5; v <= 5; v += 2.5) {
      pts.push([
        100 + u * Math.cos(a) - v * Math.sin(a),
        50 + u * Math.sin(a) + v * Math.cos(a),
      ]);
    }
  }
  const r = minAreaRect(convexHull(pts));
  const [long, short] = r.w > r.h ? [r.w, r.h] : [r.h, r.w];
  assert.ok(Math.abs(long - 40) < 1e-6 && Math.abs(short - 10) < 1e-6);
  assert.ok(Math.abs(r.cx - 100) < 1e-6 && Math.abs(r.cy - 50) < 1e-6);
});

test('CTC decoding merges repeats and drops blanks', () => {
  // Steps: a a blank a b b space → "aab "
  const dict = ['a', 'b'];
  const steps = [1, 1, 0, 1, 2, 2, 3];
  const data = new Float32Array(steps.length * 4);
  steps.forEach((c, t) => (data[t * 4 + c] = 1));
  assert.deepEqual(ctcDecode({shape: [1, steps.length, 4], data}, dict), {
    text: 'aab ',
    score: 1,
  });
});

test('rotateLeft turns counter-clockwise', () => {
  // 2×1: red, green → 1×2: green on top, red below.
  const img = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
  };
  const r = rotateLeft(img);
  assert.equal(r.width, 1);
  assert.equal(r.height, 2);
  assert.deepEqual([...r.data], [0, 255, 0, 255, 255, 0, 0, 255]);
});
