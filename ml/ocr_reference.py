"""
Reference outputs for the OCR models (PaddleOCR PP-OCRv6 tiny detection,
small recognition), computed with ONNX Runtime, for our engine's tests
(test/ocr-models.test.ts).

    python3 -m venv .venv-ocr
    .venv-ocr/bin/pip install onnxruntime numpy pillow
    .venv-ocr/bin/python ml/ocr_reference.py .cache/ocr test/fixtures/ocr

Writes test/fixtures/ocr/reference.json and reference.bin (float32 arrays,
little-endian, at the offsets in the JSON): small inputs cut from the test
images, and what each model outputs for them. For recognition, only each
step's best class and its probability are kept (the full output is
18,710 classes per step).
"""
import json
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

models, fixtures = sys.argv[1], sys.argv[2]
blob = bytearray()
out = {}


def add(name, array):
    a = np.ascontiguousarray(array, dtype='<f4')
    out[name] = {'offset': len(blob) // 4, 'shape': list(a.shape)}
    blob.extend(a.tobytes())


def normalize(img):
    """HWC uint8 RGB -> 1x3xHxW, (x/255 - 0.5) / 0.5, as PaddleOCR does."""
    x = np.asarray(img, dtype=np.float32) / 255.0
    x = (x - 0.5) / 0.5
    return x.transpose(2, 0, 1)[None]


det = ort.InferenceSession(os.path.join(models, 'det.onnx'))
rec = ort.InferenceSession(os.path.join(models, 'rec.onnx'))

# Detection: the label, scaled to 160x96 (sides multiples of 32).
label = Image.open(os.path.join(fixtures, 'label.png')).convert('RGB')
x = normalize(label.resize((160, 96), Image.BILINEAR))
add('det.input', x)
add('det.output', det.run(None, {'x': x})[0])

# Recognition: the line 黒煎り七味, scaled to height 48.
line = label.crop((60, 110, 420, 190)).resize((216, 48), Image.BILINEAR)
x = normalize(line)
add('rec.input', x)
probs = rec.run(None, {'x': x})[0][0]
add('rec.best', probs.argmax(-1).astype(np.float32))
add('rec.bestProb', probs.max(-1))

with open(os.path.join(fixtures, 'reference.bin'), 'wb') as f:
    f.write(blob)
with open(os.path.join(fixtures, 'reference.json'), 'w') as f:
    json.dump(out, f, indent=1)
print({k: v['shape'] for k, v in out.items()}, len(blob) // 1024, 'KB')
