/**
 * Checks our reimplementation of the LT8 handwriting model against ONNX
 * Runtime's output on the real model (test/fixtures/lt8-vectors.json, from
 * ml/lt8_reference.py).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, test} from 'node:test';
import {preprocess} from '../src/client/handwriting/lt8-preprocess.ts';
import {runCpu} from '../src/client/nn/cpu.ts';
import {
  decodeModel,
  type Model,
  type ModelSpec,
} from '../src/client/nn/model.ts';
import {WasmEngine} from '../src/client/nn/wasm.ts';

interface Vector {
  char: string;
  input: string;
  preprocessed: string;
  top: [number, number][];
}

const vectors = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, 'fixtures/lt8-vectors.json'),
    'utf8',
  ),
) as Vector[];

function bytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function input(v: Vector): Float32Array {
  return Float32Array.from(bytes(v.input));
}

function expectedPreprocessed(v: Vector): Float32Array {
  const b = bytes(v.preprocessed);
  const u16 = new Uint16Array(b.buffer, b.byteOffset, b.length / 2);
  return Float32Array.from(u16, x => x / 65535);
}

describe('LT8 preprocessing', () => {
  for (const v of vectors) {
    test(v.char, () => {
      const ours = preprocess(input(v));
      const theirs = expectedPreprocessed(v);
      let worst = 0;
      for (let i = 0; i < ours.length; i++) {
        worst = Math.max(worst, Math.abs(ours[i] - theirs[i]));
      }
      // The ONNX graph computes in fp16, so small differences are expected.
      assert.ok(worst < 0.03, `max difference ${worst}`);
    });
  }
});

const DIST = path.resolve(import.meta.dirname, '../dist');
const MODEL_DIR = path.join(DIST, 'handwriting/lt8');
const haveModel = fs.existsSync(path.join(MODEL_DIR, 'weights.bin'));
const haveWasm = fs.existsSync(path.join(DIST, 'nn.wasm'));

function loadLt8(): Model {
  return decodeModel(
    JSON.parse(
      fs.readFileSync(path.join(MODEL_DIR, 'model.json'), 'utf8'),
    ) as ModelSpec,
    new Uint8Array(fs.readFileSync(path.join(MODEL_DIR, 'weights.bin'))).slice()
      .buffer,
  );
}

/** Checks logits against ONNX Runtime's: same top 5, close values. */
function checkLogits(logits: Float32Array, v: Vector) {
  const top5 = [...logits.keys()]
    .sort((a, b) => logits[b] - logits[a])
    .slice(0, 5);
  assert.deepEqual(
    top5,
    v.top.slice(0, 5).map(([i]) => i),
  );
  for (const [i, expected] of v.top) {
    assert.ok(
      Math.abs(logits[i] - expected) < 0.05,
      `logit ${i}: ${logits[i]} vs ${expected}`,
    );
  }
}

describe('LT8 network', {skip: !haveModel && 'model not built'}, () => {
  const model = haveModel ? loadLt8() : undefined;

  // The plain JS reference takes seconds per image, so check just one.
  test(`JavaScript: ${vectors[0].char}`, () => {
    checkLogits(runCpu(model!, expectedPreprocessed(vectors[0])), vectors[0]);
  });

  describe('WebAssembly', {skip: !haveWasm && 'nn.wasm not built'}, () => {
    for (const v of vectors) {
      test(v.char, async () => {
        const engine = await WasmEngine.create(
          model!,
          fs.readFileSync(path.join(DIST, 'nn.wasm')),
        );
        checkLogits(engine.run(expectedPreprocessed(v)), v);
      });
    }
  });
});
