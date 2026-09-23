/**
 * Converts the downloaded handwriting model to our own format and writes it
 * to dist/handwriting/<name>/ (model.json, weights.bin, labels.json).
 * The conversion is cached next to the download.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {convertOnnx} from './convert-onnx.ts';
import {readOnnx} from './onnx.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The tensor where LT8's in-graph preprocessing ends and the ResNet begins. */
const LT8_NETWORK_INPUT = 'grid_sampler';

/** Returns false if the model hasn't been downloaded. */
export function buildHandwriting(dist: string): boolean {
  const current = path.join(ROOT, '.cache/handwriting/current.json');
  if (!fs.existsSync(current)) return false;
  const {revision} = JSON.parse(fs.readFileSync(current, 'utf8'));
  const src = path.join(ROOT, '.cache/handwriting', revision);
  const converted = path.join(src, 'converted');

  if (!fs.existsSync(path.join(converted, 'model.json'))) {
    const graph = readOnnx(fs.readFileSync(path.join(src, 'model.fp16.onnx')));
    const {spec, weights} = convertOnnx(graph, LT8_NETWORK_INPUT, [1, 96, 96]);
    const labels = (
      JSON.parse(fs.readFileSync(path.join(src, 'labels.json'), 'utf8')) as {
        index: number;
        char: string;
      }[]
    )
      .sort((a, b) => a.index - b.index)
      .map(l => l.char);
    fs.mkdirSync(converted, {recursive: true});
    fs.writeFileSync(path.join(converted, 'model.json'), JSON.stringify(spec));
    fs.writeFileSync(path.join(converted, 'weights.bin'), weights);
    fs.writeFileSync(
      path.join(converted, 'labels.json'),
      JSON.stringify(labels),
    );
    console.log(
      `converted handwriting model: ${spec.ops.length} ops, ${(weights.length / 1e6).toFixed(1)}MB`,
    );
  }
  fs.cpSync(converted, path.join(dist, 'handwriting', 'lt8'), {
    recursive: true,
  });
  return true;
}
