/**
 * Converts the downloaded OCR models (.cache/ocr/, see download.ts) to our
 * graph format and writes them to dist/ocr/: det/ and rec/ (model.json,
 * weights.bin) and dict.txt. The conversion is cached in .cache/ocr/converted/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {convertGraph} from './convert-graph.ts';
import {readOnnx} from './onnx.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, '.cache/ocr');

/** Returns false if the models haven't been downloaded. */
export function buildOcr(dist: string): boolean {
  const files = ['det.onnx', 'rec.onnx', 'dict.txt'].map(f =>
    path.join(SRC, f),
  );
  if (!files.every(f => fs.existsSync(f))) return false;
  const converted = path.join(SRC, 'converted');
  const newest = Math.max(...files.map(f => fs.statSync(f).mtimeMs));
  const stamp = path.join(converted, 'rec/model.json');
  if (!fs.existsSync(stamp) || fs.statSync(stamp).mtimeMs < newest) {
    for (const name of ['det', 'rec']) {
      const {spec, weights} = convertGraph(
        readOnnx(fs.readFileSync(path.join(SRC, `${name}.onnx`))),
      );
      const dir = path.join(converted, name);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'weights.bin'), weights);
      fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(spec));
      console.log(
        `converted OCR ${name} model: ${spec.nodes.length} ops, ${(weights.length / 1e6).toFixed(1)}MB`,
      );
    }
    fs.copyFileSync(
      path.join(SRC, 'dict.txt'),
      path.join(converted, 'dict.txt'),
    );
  }
  fs.cpSync(converted, path.join(dist, 'ocr'), {recursive: true});
  return true;
}
