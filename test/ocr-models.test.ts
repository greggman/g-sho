/**
 * Our graph engine against ONNX Runtime on the OCR models (reference outputs
 * from ml/ocr_reference.py). Skipped when the models aren't downloaded.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, test} from 'node:test';
import {convertGraph} from '../scripts/convert-graph.ts';
import {readOnnx} from '../scripts/onnx.ts';
import {decodeGraph, type Tensor} from '../src/client/nn/graph.ts';
import {runGraphCpu} from '../src/client/nn/graph-cpu.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODELS = path.join(ROOT, '.cache/ocr');
const FIXTURES = path.join(ROOT, 'test/fixtures/ocr');
const have = fs.existsSync(path.join(MODELS, 'det.onnx'));

function reference() {
  const index = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'reference.json'), 'utf8'),
  ) as Record<string, {offset: number; shape: number[]}>;
  const all = new Float32Array(
    fs.readFileSync(path.join(FIXTURES, 'reference.bin')).buffer.slice(0),
  );
  const get = (name: string): Tensor => {
    const {offset, shape} = index[name];
    const n = shape.reduce((a, b) => a * b, 1);
    return {shape, data: all.slice(offset, offset + n)};
  };
  return get;
}

function load(file: string, exact = false) {
  const {spec, weights} = convertGraph(
    readOnnx(fs.readFileSync(path.join(MODELS, file))),
    exact,
  );
  return decodeGraph(spec, weights.buffer.slice(0) as ArrayBuffer);
}

describe(
  'OCR models on our engine',
  {skip: !have && 'models not downloaded'},
  () => {
    const ref = reference();

    const detect = (exact: boolean) => {
      const graph = load('det.onnx', exact);
      const out = runGraphCpu(graph, {x: ref('det.input')});
      const got = out.get(graph.spec.outputs[0]) as Tensor;
      const want = ref('det.output');
      assert.deepEqual(got.shape, want.shape);
      let maxDiff = 0;
      for (let i = 0; i < want.data.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(got.data[i] - want.data[i]));
      }
      return maxDiff;
    };

    test('detection: every operator matches ONNX Runtime', () => {
      // With exact weights, only float rounding differs.
      const d = detect(true);
      assert.ok(d < 1e-4, `max difference ${d}`);
    });

    test('detection: fp16 weights are close enough', () => {
      // The text map is thresholded at 0.3; this is far below what matters.
      const d = detect(false);
      assert.ok(d < 0.05, `max difference ${d}`);
    });

    test('recognition matches ONNX Runtime', () => {
      const graph = load('rec.onnx');
      const out = runGraphCpu(graph, {x: ref('rec.input')});
      const got = out.get(graph.spec.outputs[0]) as Tensor;
      const best = ref('rec.best').data;
      const bestProb = ref('rec.bestProb').data;
      const [, steps, classes] = got.shape;
      assert.equal(steps, best.length);
      for (let t = 0; t < steps; t++) {
        let arg = 0;
        for (let c = 1; c < classes; c++) {
          if (got.data[t * classes + c] > got.data[t * classes + arg]) arg = c;
        }
        assert.equal(arg, best[t], `step ${t}`);
        assert.ok(
          Math.abs(got.data[t * classes + arg] - bestProb[t]) < 0.02,
          `step ${t}: ${got.data[t * classes + arg]} vs ${bestProb[t]}`,
        );
      }
    });
  },
);

test('erf', async () => {
  const {erf} = await import('../src/client/nn/graph-cpu.ts');
  // Known values (to 7 places).
  for (const [x, want] of [
    [0, 0],
    [0.1, 0.1124629],
    [0.5, 0.5204999],
    [1, 0.8427008],
    [2, 0.9953223],
    [-1.5, -0.9661051],
    [3.5, 0.9999993],
  ]) {
    assert.ok(Math.abs(erf(x) - want) < 2e-7, `erf(${x}) = ${erf(x)}`);
  }
});
