import { LIMITS } from './limits';
/** Inspect the image container, not its declared upload MIME or extension. */
export function inspectImage(
  b: Uint8Array,
): { mime: string; width: number; height: number } | null {
  if (b.length < 24) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (n: number, len: number) => String.fromCharCode(...b.slice(n, n + len));
  const result = (mime: string, width: number, height: number) =>
    width > 0 &&
    height > 0 &&
    width <= 20000 &&
    height <= 20000 &&
    width * height <= LIMITS.storedPixels
      ? { mime, width, height }
      : null;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => b[i] === x)) {
    if (
      b.length < 45 ||
      v.getUint32(8) !== 13 ||
      ascii(12, 4) !== 'IHDR' ||
      ascii(b.length - 8, 4) !== 'IEND'
    )
      return null;
    return result('image/png', v.getUint32(16), v.getUint32(20));
  }
  if (b[0] === 255 && b[1] === 216 && b[b.length - 2] === 255 && b[b.length - 1] === 217) {
    let i = 2;
    while (i + 4 < b.length) {
      if (b[i++] !== 255) return null;
      while (b[i] === 255) i++;
      const marker = b[i++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > b.length) return null;
      const length = v.getUint16(i);
      if (length < 2 || i + length > b.length) return null;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8) return null;
        return result('image/jpeg', v.getUint16(i + 5), v.getUint16(i + 3));
      }
      i += length;
    }
    return null;
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && v.getUint32(4, true) === b.length - 8) {
    const u24 = (i: number) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16);
    const type = ascii(12, 4),
      size = v.getUint32(16, true);
    if (size + 20 > b.length) return null;
    if (type === 'VP8X' && size >= 10) return result('image/webp', u24(24) + 1, u24(27) + 1);
    if (type === 'VP8L' && size >= 5 && b[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      return result('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (type === 'VP8 ' && size >= 10 && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a)
      return result('image/webp', v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
  }
  return null;
}
