/**
 * Minimal PNG decode/encode, in pure Node — no third-party image library.
 *
 * Why hand-written: this project has no image dependency, and the acceptance
 * tooling needs to read a real PNG back (to prove bytes survived), so the same
 * tiny codec is shared instead of copied per script.
 *
 * Decoding supports what real screenshots and the harness's re-encoded
 * attachments actually use: non-interlaced, bit depth 8 or 16, colour types
 * 0 (grey), 2 (RGB), 3 (palette), 4 (grey+alpha) and 6 (RGBA), all five scanline
 * filters. Interlaced (Adam7) files and sub-byte depths are rejected with a clear
 * message rather than decoded wrongly.
 *
 * Encoding writes 8-bit RGBA with the `Sub` filter, which suits the smooth or
 * flat images this tooling produces.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** The Paeth predictor from the PNG specification. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode a PNG into 8-bit RGBA pixels.
 *
 * @param buffer - the whole PNG file.
 * @returns `{ width, height, rgba, colorType, bitDepth }`, where `rgba` has
 * `width * height * 4` bytes.
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行（Adam7）PNG');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }

  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (channels === undefined) throw new Error(`不支持的颜色类型 ${String(colorType)}`);
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`不支持的位深 ${String(bitDepth)}`);
  if (idat.length === 0) throw new Error('PNG 里没有图像数据');

  const raw = inflateSync(Buffer.concat(idat));
  const sampleBytes = bitDepth / 8;
  const bytesPerPixel = channels * sampleBytes;
  const stride = width * bytesPerPixel;
  if (raw.length < (stride + 1) * height) throw new Error('图像数据长度不足');

  // Undo the per-scanline filters, in place, one row at a time.
  const planes = Buffer.alloc(stride * height);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const current = planes.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? planes.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const up = previous === null ? 0 : previous[x];
      const upLeft = previous === null || x < bytesPerPixel ? 0 : previous[x - bytesPerPixel];
      let value = line[x];
      if (filter === 1) value = (value + left) & 0xff;
      else if (filter === 2) value = (value + up) & 0xff;
      else if (filter === 3) value = (value + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) value = (value + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`未知的滤波类型 ${String(filter)}`);
      current[x] = value;
    }
  }

  // Expand to RGBA8. A 16-bit sample contributes its high byte, which is what
  // 8-bit consumers see anyway.
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const at = index * bytesPerPixel;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    if (colorType === 0 || colorType === 4) {
      r = planes[at];
      g = r;
      b = r;
      if (colorType === 4) a = planes[at + sampleBytes];
    } else if (colorType === 2) {
      r = planes[at];
      g = planes[at + sampleBytes];
      b = planes[at + 2 * sampleBytes];
    } else if (colorType === 6) {
      r = planes[at];
      g = planes[at + sampleBytes];
      b = planes[at + 2 * sampleBytes];
      a = planes[at + 3 * sampleBytes];
    } else {
      const entry = planes[at];
      if (palette === null || (entry + 1) * 3 > palette.length) throw new Error('调色板索引越界');
      r = palette[entry * 3];
      g = palette[entry * 3 + 1];
      b = palette[entry * 3 + 2];
      if (transparency !== null && entry < transparency.length) a = transparency[entry];
    }
    rgba[index * 4] = r;
    rgba[index * 4 + 1] = g;
    rgba[index * 4 + 2] = b;
    rgba[index * 4 + 3] = a;
  }

  return { width, height, rgba, colorType, bitDepth };
}

/**
 * Encode 8-bit RGBA pixels as a PNG.
 *
 * @param rgba - `width * height * 4` bytes.
 * @param width - pixel width.
 * @param height - pixel height.
 * @returns the PNG file.
 */
export function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 1; // filter: Sub
    for (let x = 0; x < stride; x += 1) {
      const current = rgba[y * stride + x];
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
      raw[rowStart + 1 + x] = (current - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
