import type {Stroke} from './types.ts';

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Draws strokes (in [0, 1] coordinates) into a `size`×`size` area with round
 * caps and joins. A stroke with a single point (a tap) is drawn as a dot.
 */
export function drawStrokes(
  ctx: Context2D,
  strokes: Stroke[],
  size: number,
  lineWidth: number,
) {
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) drawStroke(ctx, stroke, size, lineWidth);
}

export function drawStroke(
  ctx: Context2D,
  stroke: Stroke,
  size: number,
  lineWidth: number,
) {
  if (stroke.length === 0) return;
  const [x0, y0] = stroke[0];
  if (stroke.length === 1) {
    ctx.beginPath();
    ctx.arc(x0 * size, y0 * size, lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x0 * size, y0 * size);
  for (let i = 1; i < stroke.length; i++) {
    ctx.lineTo(stroke[i][0] * size, stroke[i][1] * size);
  }
  ctx.stroke();
}

/**
 * Renders black strokes on white at `drawSize` (so the pen width matches
 * what a recognizer was tested with), scales the result down to
 * `outSize`×`outSize`, and returns its luminance in 0–255, row by row.
 */
export function rasterize(
  strokes: Stroke[],
  drawSize: number,
  lineWidth: number,
  outSize: number,
): Float32Array {
  const big = new OffscreenCanvas(drawSize, drawSize);
  const bctx = big.getContext('2d')!;
  bctx.fillStyle = '#fff';
  bctx.fillRect(0, 0, drawSize, drawSize);
  bctx.fillStyle = '#000';
  bctx.strokeStyle = '#000';
  drawStrokes(bctx, strokes, drawSize, lineWidth);

  const small = new OffscreenCanvas(outSize, outSize);
  const sctx = small.getContext('2d', {willReadFrequently: true})!;
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, outSize, outSize);
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(big, 0, 0, outSize, outSize);
  const px = sctx.getImageData(0, 0, outSize, outSize).data;
  const out = new Float32Array(outSize * outSize);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  }
  return out;
}
