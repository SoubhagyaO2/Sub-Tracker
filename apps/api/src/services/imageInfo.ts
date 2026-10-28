/**
 * Reads the type and pixel size of a PNG, JPEG or WebP image from its own header, without decoding it. Used to refuse anything
 * that merely CLAIMS to be an image, and anything whose dimensions would be expensive for a browser to decode.
 */
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(b: Buffer): ImageInfo | null {
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIGNATURE) || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let o = 2;
  for (let guard = 0; guard < 64 && o + 4 <= b.length; guard++) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) { o += 1; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; } // markers without a length
    const length = b.readUInt16BE(o + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return o + 9 <= b.length ? { type: 'image/jpeg', height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7) } : null;
    o += 2 + length;
  }
  return null;
}

function webp(b: Buffer): ImageInfo | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const fourcc = b.toString('latin1', 12, 16);
  const d = 20; // chunk data
  if (fourcc === 'VP8 ') {
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return null;
    return { type: 'image/webp', width: b.readUInt16LE(d + 6) & 0x3fff, height: b.readUInt16LE(d + 8) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    if (b[d] !== 0x2f) return null;
    return {
      type: 'image/webp',
      width: 1 + (b[d + 1]! | ((b[d + 2]! & 0x3f) << 8)),
      height: 1 + ((b[d + 2]! >> 6) | (b[d + 3]! << 2) | ((b[d + 4]! & 0x0f) << 10)),
    };
  }
  if (fourcc === 'VP8X') {
    return { type: 'image/webp', width: 1 + (b[d + 4]! | (b[d + 5]! << 8) | (b[d + 6]! << 16)), height: 1 + (b[d + 7]! | (b[d + 8]! << 8) | (b[d + 9]! << 16)) };
  }
  return null;
}

export function readImageInfo(buffer: Buffer): ImageInfo | null {
  return png(buffer) ?? jpeg(buffer) ?? webp(buffer);
}
