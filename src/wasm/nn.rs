//! Neural network kernels for the WebAssembly engine (src/client/nn/wasm.ts),
//! using 128-bit SIMD. No allocator: the JavaScript side lays out every
//! buffer in linear memory above `__heap_base` and passes pointers in.
//!
//! Build: see scripts/build-wasm.ts.
#![no_std]

use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unreachable()
}

#[inline(always)]
unsafe fn load(p: *const f32) -> v128 {
    v128_load(p as *const v128)
}

#[inline(always)]
unsafe fn store(p: *mut f32, v: v128) {
    v128_store(p as *mut v128, v)
}

#[inline(always)]
fn madd(acc: v128, a: v128, b: v128) -> v128 {
    f32x4_add(acc, f32x4_mul(a, b))
}

/// Copies a CHW image into a zero-bordered buffer of size
/// c × (h + 2·pad) × (w + 2·pad), so convolution needs no bounds checks.
#[no_mangle]
pub unsafe extern "C" fn pad(x: *const f32, c: usize, h: usize, w: usize, p: usize, out: *mut f32) {
    let ph = h + 2 * p;
    let pw = w + 2 * p;
    for i in 0..c * ph * pw {
        *out.add(i) = 0.0;
    }
    for ch in 0..c {
        for y in 0..h {
            let src = x.add((ch * h + y) * w);
            let dst = out.add((ch * ph + y + p) * pw + p);
            for i in 0..w {
                *dst.add(i) = *src.add(i);
            }
        }
    }
}

/// Convolution over a padded input (ic × ih × iw, already padded) with
/// weights packed as [oc / 8][ic][k·k][8] and oc a multiple of 8.
/// Output is oc × oh × ow. Each inner step computes 4 output pixels of a row
/// for 8 output channels: 8 vector accumulators.
#[no_mangle]
pub unsafe extern "C" fn conv(
    x: *const f32,
    ic: usize,
    ih: usize,
    iw: usize,
    w: *const f32,
    bias: *const f32,
    oc: usize,
    k: usize,
    stride: usize,
    oh: usize,
    ow: usize,
    relu: u32,
    y: *mut f32,
) {
    let kk = k * k;
    let plane = oh * ow;
    let zero = f32x4_splat(0.0);
    for ob in 0..oc / 8 {
        let b0 = load(bias.add(ob * 8));
        let b1 = load(bias.add(ob * 8 + 4));
        let wb = w.add(ob * ic * kk * 8);
        let yb = y.add(ob * 8 * plane);
        for oy in 0..oh {
            let mut ox = 0;
            while ox + 4 <= ow {
                let mut a = [b0, b1, b0, b1, b0, b1, b0, b1];
                let mut wp = wb;
                for i in 0..ic {
                    let xc = x.add(i * ih * iw);
                    for ky in 0..k {
                        let row = xc.add((oy * stride + ky) * iw + ox * stride);
                        for kx in 0..k {
                            let w0 = load(wp);
                            let w1 = load(wp.add(4));
                            wp = wp.add(8);
                            let r = row.add(kx);
                            let v0 = f32x4_splat(*r);
                            let v1 = f32x4_splat(*r.add(stride));
                            let v2 = f32x4_splat(*r.add(2 * stride));
                            let v3 = f32x4_splat(*r.add(3 * stride));
                            a[0] = madd(a[0], v0, w0);
                            a[1] = madd(a[1], v0, w1);
                            a[2] = madd(a[2], v1, w0);
                            a[3] = madd(a[3], v1, w1);
                            a[4] = madd(a[4], v2, w0);
                            a[5] = madd(a[5], v2, w1);
                            a[6] = madd(a[6], v3, w0);
                            a[7] = madd(a[7], v3, w1);
                        }
                    }
                }
                let base = yb.add(oy * ow + ox);
                for p in 0..4 {
                    let mut lo = a[2 * p];
                    let mut hi = a[2 * p + 1];
                    if relu != 0 {
                        lo = f32x4_max(lo, zero);
                        hi = f32x4_max(hi, zero);
                    }
                    let d = base.add(p);
                    *d = f32x4_extract_lane::<0>(lo);
                    *d.add(plane) = f32x4_extract_lane::<1>(lo);
                    *d.add(2 * plane) = f32x4_extract_lane::<2>(lo);
                    *d.add(3 * plane) = f32x4_extract_lane::<3>(lo);
                    *d.add(4 * plane) = f32x4_extract_lane::<0>(hi);
                    *d.add(5 * plane) = f32x4_extract_lane::<1>(hi);
                    *d.add(6 * plane) = f32x4_extract_lane::<2>(hi);
                    *d.add(7 * plane) = f32x4_extract_lane::<3>(hi);
                }
                ox += 4;
            }
            // Leftover pixels at the end of the row, one at a time.
            while ox < ow {
                let mut lo = b0;
                let mut hi = b1;
                let mut wp = wb;
                for i in 0..ic {
                    let xc = x.add(i * ih * iw);
                    for ky in 0..k {
                        let row = xc.add((oy * stride + ky) * iw + ox * stride);
                        for kx in 0..k {
                            let v = f32x4_splat(*row.add(kx));
                            lo = madd(lo, v, load(wp));
                            hi = madd(hi, v, load(wp.add(4)));
                            wp = wp.add(8);
                        }
                    }
                }
                if relu != 0 {
                    lo = f32x4_max(lo, zero);
                    hi = f32x4_max(hi, zero);
                }
                let d = yb.add(oy * ow + ox);
                let mut tmp = [0f32; 8];
                store(tmp.as_mut_ptr(), lo);
                store(tmp.as_mut_ptr().add(4), hi);
                for l in 0..8 {
                    *d.add(l * plane) = tmp[l];
                }
                ox += 1;
            }
        }
    }
}

/// out = a + b, n a multiple of 4.
#[no_mangle]
pub unsafe extern "C" fn add(a: *const f32, b: *const f32, n: usize, out: *mut f32) {
    let mut i = 0;
    while i < n {
        store(out.add(i), f32x4_add(load(a.add(i)), load(b.add(i))));
        i += 4;
    }
}

/// Per-channel out = x · scale[c] + shift[c], optionally followed by ReLU.
/// hw (pixels per channel) a multiple of 4.
#[no_mangle]
pub unsafe extern "C" fn scale_shift(
    x: *const f32,
    c: usize,
    hw: usize,
    scale: *const f32,
    shift: *const f32,
    relu: u32,
    out: *mut f32,
) {
    let zero = f32x4_splat(0.0);
    for ch in 0..c {
        let s = f32x4_splat(*scale.add(ch));
        let t = f32x4_splat(*shift.add(ch));
        let mut i = ch * hw;
        while i < (ch + 1) * hw {
            let mut v = madd(t, load(x.add(i)), s);
            if relu != 0 {
                v = f32x4_max(v, zero);
            }
            store(out.add(i), v);
            i += 4;
        }
    }
}

/// Mean of each channel.
#[no_mangle]
pub unsafe extern "C" fn global_avg_pool(x: *const f32, c: usize, hw: usize, out: *mut f32) {
    for ch in 0..c {
        let mut sum = 0.0;
        for i in 0..hw {
            sum += *x.add(ch * hw + i);
        }
        *out.add(ch) = sum / hw as f32;
    }
}

/// out = W x + b, W is [out_f][in_f] with in_f a multiple of 4.
#[no_mangle]
pub unsafe extern "C" fn linear(
    x: *const f32,
    in_f: usize,
    w: *const f32,
    b: *const f32,
    out_f: usize,
    out: *mut f32,
) {
    for o in 0..out_f {
        let row = w.add(o * in_f);
        let mut acc = f32x4_splat(0.0);
        let mut i = 0;
        while i < in_f {
            acc = madd(acc, load(row.add(i)), load(x.add(i)));
            i += 4;
        }
        *out.add(o) = *b.add(o)
            + f32x4_extract_lane::<0>(acc)
            + f32x4_extract_lane::<1>(acc)
            + f32x4_extract_lane::<2>(acc)
            + f32x4_extract_lane::<3>(acc);
    }
}
