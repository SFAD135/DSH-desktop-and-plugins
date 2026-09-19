#!/usr/bin/env node
/**
 * Generate a synthetic PNG for exercising the desktop shell's image features
 * (copy / save as / copy path / copy as Markdown / drag out).
 *
 * Pure Node: encoding comes from the shared `png-tools.mjs`, so there is no
 * third-party image dependency — the same approach `scripts/make-icons.mjs` uses.
 *
 * The picture is deliberately non-square and full of things that reveal how it
 * was handled: a 40 px grid (scaling/aliasing), four saturated swatches (colour
 * fidelity), a checkerboard in the exact top-left corner (cropping or resampling
 * shifts it), a 3 px white frame (edge clipping), and its own dimensions
 * rendered into the image (so a saved copy states what it should be).
 *
 * Usage: node scripts/make-test-image.mjs [output.png] [width] [height]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng } from './png-tools.mjs';

// ── a 5x7 bitmap font, only the glyphs this picture needs ───────────────────
const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  G: ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['#...#', '#...#', '#...#', '#####', '....#', '....#', '....#'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

// ── drawing ─────────────────────────────────────────────────────────────────
const WIDTH = Number(process.argv[3] ?? 800);
const HEIGHT = Number(process.argv[4] ?? 600);
const OUT = path.resolve(process.argv[2] ?? 'test-image.png');
const pixels = Buffer.alloc(WIDTH * HEIGHT * 4, 0xff);

const put = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = a;
};

const fillRect = (x0, y0, w, h, r, g, b) => {
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) put(x, y, r, g, b);
};

function drawText(text, x0, y0, scale, r, g, b) {
  let cursor = x0;
  for (const character of text) {
    const glyph = FONT[character] ?? FONT[' '];
    for (let gy = 0; gy < 7; gy += 1) {
      for (let gx = 0; gx < 5; gx += 1) {
        if (glyph[gy][gx] !== '#') continue;
        fillRect(cursor + gx * scale, y0 + gy * scale, scale, scale, r, g, b);
      }
    }
    cursor += 6 * scale;
  }
  return cursor - x0;
}

// 1. diagonal gradient background
for (let y = 0; y < HEIGHT; y += 1) {
  for (let x = 0; x < WIDTH; x += 1) {
    const t = (x / WIDTH + y / HEIGHT) / 2;
    put(x, y, Math.round(18 + 60 * t), Math.round(32 + 40 * (1 - t)), Math.round(72 + 120 * t));
  }
}

// 2. a 40 px grid, so any scaling or resampling is immediately visible
for (let x = 0; x < WIDTH; x += 40) for (let y = 0; y < HEIGHT; y += 1) put(x, y, 90, 110, 150);
for (let y = 0; y < HEIGHT; y += 40) for (let x = 0; x < WIDTH; x += 1) put(x, y, 90, 110, 150);

// 3. four saturated swatches, for colour fidelity
const swatches = [
  [230, 60, 60],
  [70, 200, 90],
  [70, 120, 230],
  [240, 200, 60],
];
swatches.forEach(([r, g, b], index) => {
  fillRect(40 + index * 120, HEIGHT - 110, 100, 70, r, g, b);
});

// 4. checkerboard in the exact top-left corner: cropping or resampling moves it
for (let y = 0; y < 16; y += 1) {
  for (let x = 0; x < 16; x += 1) {
    const on = (x + y) % 2 === 0;
    put(x, y, on ? 255 : 0, on ? 255 : 0, on ? 255 : 0);
  }
}

// 5. text, including the image's own dimensions
const title = 'DSH TEST IMAGE';
const titleWidth = title.length * 6 * 4 - 4;
drawText(title, Math.round((WIDTH - titleWidth) / 2), 120, 4, 255, 255, 255);

const size = `${WIDTH} x ${HEIGHT}`;
const sizeWidth = size.length * 6 * 3 - 3;
drawText(size, Math.round((WIDTH - sizeWidth) / 2), 190, 3, 255, 220, 120);

// 6. a 3 px white frame, so edge clipping shows up
for (let x = 0; x < WIDTH; x += 1) for (let t = 0; t < 3; t += 1) {
  put(x, t, 255, 255, 255);
  put(x, HEIGHT - 1 - t, 255, 255, 255);
}
for (let y = 0; y < HEIGHT; y += 1) for (let t = 0; t < 3; t += 1) {
  put(t, y, 255, 255, 255);
  put(WIDTH - 1 - t, y, 255, 255, 255);
}

// ── write, then decode the file back and compare every pixel ───────────────
const png = encodePng(pixels, WIDTH, HEIGHT);
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, png);

const back = decodePng(png);
const identical = back.rgba.equals(pixels);
const ihdrWidth = png.readUInt32BE(16);
const ihdrHeight = png.readUInt32BE(20);

process.stdout.write(
  [
    `已生成: ${OUT}`,
    `  尺寸: ${String(ihdrWidth)}x${String(ihdrHeight)}（IHDR 里的值）`,
    `  大小: ${String(png.length)} 字节`,
    `  自检: 回读 ${String(back.width)}x${String(back.height)}，颜色类型 ${String(back.colorType)}，位深 ${String(back.bitDepth)}`,
    `  自检: 回读像素与绘制结果逐字节${identical ? '一致' : '不一致！'}`,
    '',
  ].join('\n'),
);
process.exit(identical && back.width === WIDTH && back.height === HEIGHT ? 0 : 1);
