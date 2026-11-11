// Detects whether a texture really uses transparency (not just "has an alpha channel"),
// so opaque 32-bit textures don't turn every material into a blended one.

import zlib from 'node:zlib';

const THRESHOLD = 250;

function pngUsesAlpha(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return false;
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const depth = buf[24], colorType = buf[25], interlace = buf[28];
  let pos = 8, hasTrns = false;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (type === 'tRNS') hasTrns = true;
    else if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (colorType !== 4 && colorType !== 6) return hasTrns;
  if (interlace || (depth !== 8 && depth !== 16)) return true; // can't cheaply scan: assume used
  const bytesPer = depth / 8;
  const channels = colorType === 6 ? 4 : 2;
  const bpp = channels * bytesPer;
  const stride = width * bpp;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return true; }
  if (raw.length < (stride + 1) * height) return true;
  let prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const alphaOffset = (channels - 1) * bytesPer;
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let x = 0; x < stride; x++) {
      const v = raw[base + 1 + x];
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let out;
      switch (filter) {
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: out = v;
      }
      cur[x] = out & 0xff;
    }
    for (let x = alphaOffset; x < stride; x += bpp) if (cur[x] < THRESHOLD) return true;
    cur.copy(prev);
  }
  return false;
}

function tgaUsesAlpha(buf) {
  if (buf.length < 18) return false;
  const idLen = buf[0], mapType = buf[1], type = buf[2];
  const width = buf.readUInt16LE(12), height = buf.readUInt16LE(14), bpp = buf[16];
  if (bpp !== 32 || mapType !== 0 || (type !== 2 && type !== 10)) return false;
  if ((buf[17] & 0x0f) === 0) return false; // no attribute bits declared
  let pos = 18 + idLen;
  const total = width * height;
  if (type === 2) {
    for (let i = 0; i < total && pos + 3 < buf.length; i++, pos += 4) if (buf[pos + 3] < THRESHOLD) return true;
    return false;
  }
  let done = 0;
  while (done < total && pos < buf.length) {
    const head = buf[pos++];
    const count = (head & 0x7f) + 1;
    if (head & 0x80) {
      if (buf[pos + 3] < THRESHOLD) return true;
      pos += 4;
    } else {
      for (let i = 0; i < count && pos + 3 < buf.length; i++, pos += 4) if (buf[pos + 3] < THRESHOLD) return true;
    }
    done += count;
  }
  return false;
}

/** @param {Buffer} buf file contents @param {string} ext lower-case extension with dot */
export function textureUsesAlpha(buf, ext) {
  try {
    if (ext === '.png') return pngUsesAlpha(buf);
    if (ext === '.tga') return tgaUsesAlpha(buf);
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return pngUsesAlpha(buf); // mislabelled PNG
  } catch { /* fall through */ }
  return false;
}
