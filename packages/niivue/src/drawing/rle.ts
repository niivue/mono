import { log } from "@/logger";

/**
 * PackBits RLE encoder. Operates byte-by-byte on uint8 data.
 * Drawing bitmaps are always Uint8Array label indices (0–255), so runs
 * compress well. Passing non-uint8 typed arrays (e.g. Uint16Array viewed
 * as bytes) will interleave zero bytes and defeat run compression.
 * @see https://en.wikipedia.org/wiki/PackBits
 */
export function encodeRLE(data: Uint8Array): Uint8Array {
  const dl = data.length;
  let dp = 0;
  const r = new Uint8Array(dl + Math.ceil(0.01 * dl));
  const rI = new Int8Array(r.buffer);
  let rp = 0;
  while (dp < dl) {
    let v = data[dp];
    dp++;
    let rl = 1;
    while (rl < 129 && dp < dl && data[dp] === v) {
      dp++;
      rl++;
    }
    if (rl > 1) {
      rI[rp] = -rl + 1;
      rp++;
      r[rp] = v;
      rp++;
      continue;
    }
    while (dp < dl) {
      if (rl > 127) {
        break;
      }
      if (dp + 2 < dl) {
        if (
          v !== data[dp] &&
          data[dp + 2] === data[dp] &&
          data[dp + 1] === data[dp]
        ) {
          break;
        }
      }
      v = data[dp];
      dp++;
      rl++;
    }
    r[rp] = rl - 1;
    rp++;
    for (let i = 0; i < rl; i++) {
      r[rp] = data[dp - rl + i];
      rp++;
    }
  }
  log.debug(`PackBits ${dl} -> ${rp} bytes (x${dl / rp})`);
  return r.slice(0, rp);
}

export function decodeRLE(rle: Uint8Array, decodedlen: number): Uint8Array {
  const r = new Uint8Array(rle.buffer);
  const rI = new Int8Array(r.buffer);
  let rp = 0;
  const d = new Uint8Array(decodedlen);
  let dp = 0;
  while (rp < r.length) {
    const hdr = rI[rp];
    rp++;
    if (hdr < 0) {
      const v = rI[rp];
      rp++;
      for (let i = 0; i < 1 - hdr; i++) {
        d[dp] = v;
        dp++;
      }
    } else {
      for (let i = 0; i < hdr + 1; i++) {
        d[dp] = rI[rp];
        rp++;
        dp++;
      }
    }
  }
  return d;
}
