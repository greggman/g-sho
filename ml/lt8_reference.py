"""
Reference implementation of the LT8 handwriting model's in-graph
preprocessing, checked against ONNX Runtime, and a generator for the test
vectors the TypeScript implementation is tested against.

    .venv/bin/python lt8_reference.py            # check preprocessing
    .venv/bin/python lt8_reference.py --vectors  # also write test/fixtures
"""
import base64
import json
import pathlib
import sys

import numpy as np
import onnx
import onnxruntime as ort
from PIL import Image, ImageDraw

import kanjivg

ROOT = pathlib.Path(__file__).resolve().parent.parent


def model_path() -> pathlib.Path:
    current = json.loads((ROOT / '.cache/handwriting/current.json').read_text())
    return ROOT / '.cache/handwriting' / current['revision'] / 'model.fp16.onnx'


def render(strokes, draw_size=320, line_width=14, out_size=128, supersample=4) -> np.ndarray:
    """Black round-capped strokes on white, like the browser's canvas."""
    s = draw_size * supersample
    w = line_width * supersample
    img = Image.new('L', (s, s), 255)
    d = ImageDraw.Draw(img)
    for stroke in strokes:
        pts = [(x * s, y * s) for x, y in stroke]
        if len(pts) > 1:
            d.line(pts, fill=0, width=w)
        for x, y in pts:
            d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=0)
    return np.asarray(img.resize((out_size, out_size), Image.BOX), np.float32)


def preprocess(x: np.ndarray) -> np.ndarray:
    """Port of the graph's preprocessing: 128x128 luminance -> 96x96 in [0, 1]."""
    flat = np.sort(x.ravel())
    mn, mx = flat[0], flat[-1]
    if flat[8192] > (mn + mx) * 0.5:
        x = (mn + mx) - x  # make ink bright
    s2 = np.sort(x.ravel())
    lo, hi = s2[8191], s2[16366]
    n = np.clip((x - lo) / max(hi - lo, 0.0010004043579101562), 0.0, 1.0)

    mask = n > 0.300048828125
    def pool(m, fn):
        p = np.pad(m, 1, constant_values=fn is np.min)
        return fn(np.stack([p[i:i + 128, j:j + 128] for i in range(3) for j in range(3)]), axis=0)
    opened = pool(pool(mask, np.min), np.max)

    def bbox(m):
        cols, rows = m.any(axis=0), m.any(axis=1)
        if not cols.any() or not rows.any():
            return None
        xs, ys = np.nonzero(cols)[0], np.nonzero(rows)[0]
        return xs.min(), xs.max(), ys.min(), ys.max()
    box = bbox(opened) or bbox(mask) or (10000, -10000, 10000, -10000)
    x0, x1, y0, y1 = (np.clip(v, 0, 127) for v in (box[0] - 2, box[1] + 2, box[2] - 2, box[3] + 2))

    cx, cy = (x0 + x1) * 0.5, (y0 + y1) * 0.5
    scale = max(x1 - x0 + 1, y1 - y0 + 1) * 1.16015625 / 128
    tx, ty = (cx * 2 + 1) / 128 - 1, (cy * 2 + 1) / 128 - 1

    # affine_grid (align_corners=False) + grid_sample (bilinear, zero padding)
    base = (2 * np.arange(96) + 1) / 96 - 1
    gx = scale * base[None, :] + tx
    gy = scale * base[:, None] + ty
    ix = ((gx + 1) * 128 - 1) / 2
    iy = ((gy + 1) * 128 - 1) / 2
    ix0, iy0 = np.floor(ix).astype(int), np.floor(iy).astype(int)
    fx, fy = ix - ix0, iy - iy0

    def at(yy, xx):
        ok = (xx >= 0) & (xx < 128) & (yy >= 0) & (yy < 128)
        return np.where(ok, n[np.clip(yy, 0, 127), np.clip(xx, 0, 127)], 0.0)
    return ((1 - fx) * (1 - fy) * at(iy0, ix0) + fx * (1 - fy) * at(iy0, ix0 + 1)
            + (1 - fx) * fy * at(iy0 + 1, ix0) + fx * fy * at(iy0 + 1, ix0 + 1)).astype(np.float32)


def session_with_intermediate():
    """The model with the preprocessed 96x96 image exposed as a second output."""
    m = onnx.load(str(model_path()))
    m.graph.output.append(onnx.helper.make_tensor_value_info('grid_sampler', onnx.TensorProto.FLOAT16, None))
    return ort.InferenceSession(m.SerializeToString(), providers=['CPUExecutionProvider'])


def main():
    sess = session_with_intermediate()
    labels = json.loads((model_path().parent / 'labels.json').read_text())
    chars = ['十', '日', '食', 'あ', '一', 'ヘ', '書', '犬']
    vectors = []
    worst = 0.0
    for ch in chars:
        img = render(kanjivg.strokes(ch))
        logits, pre = sess.run(['logits', 'grid_sampler'], {'input': img[None, None]})
        mine = preprocess(img)
        diff = float(np.abs(mine - pre[0, 0].astype(np.float32)).max())
        worst = max(worst, diff)
        top = np.argsort(-logits[0])[:20]
        print(ch, 'preprocess max diff %.4f' % diff, 'top5', ''.join(labels[i]['char'] for i in top[:5]))
        # Kept small: the image as bytes, the preprocessed image as uint16
        # fractions, and only the 20 largest logits.
        pre16 = np.round(np.clip(pre[0, 0].astype(np.float32), 0, 1) * 65535).astype('<u2')
        vectors.append({
            'char': ch,
            'input': base64.b64encode(img.astype(np.uint8).tobytes()).decode(),
            'preprocessed': base64.b64encode(pre16.tobytes()).decode(),
            'top': [[int(i), float(logits[0][i])] for i in top],
        })
    print('worst preprocessing difference', worst)
    if '--vectors' in sys.argv:
        out = ROOT / 'test/fixtures/lt8-vectors.json'
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(vectors))
        print('wrote', out)


if __name__ == '__main__':
    main()
