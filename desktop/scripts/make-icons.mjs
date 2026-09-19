#!/usr/bin/env node
/**
 * Generate the desktop app icon with no image dependencies:
 *
 *   build/icon.png        512x512 PNG (window + tray icon)
 *   build/icon.ico        multi-size ICO (16/24/32/48/64/128/256) for the launcher and installer
 *   app/assets/icon.png   copy used at runtime
 *   docs/deepseek-icon.png  standalone 512x512 PNG, for use as an icon elsewhere
 *
 * The artwork is the **real DeepSeek whale** — `assets/deepseek-mark.svg`, the same
 * vector the Harness web frontend ships as its favicon — drawn on a rounded app tile.
 * It replaces an earlier hand-drawn approximation that shipped as a cartoon fish.
 *
 * Rasterization is done here rather than by a dependency: `scripts/svg-path.mjs`
 * flattens the mark's Bézier curves and fills them with the nonzero winding rule,
 * once per size so every ICO entry is rendered natively.
 *
 *   node scripts/make-icons.mjs                          # write the icon set
 *   node scripts/make-icons.mjs --variant blue            # switch tile, remembering the choice
 *   node scripts/make-icons.mjs --sheet                   # compare all tiles, write nothing else
 *
 * Variants: `gradient` (this project's original tile), `blue` (flat DeepSeek blue),
 * `light` (pale tile, blue mark), `mark` (no tile — the mark alone, transparent).
 *
 * The chosen variant is remembered in `assets/icon-variant.txt`, because `npm run build`
 * regenerates the icons on every run: without a recorded choice, a one-off `--variant`
 * would be silently reverted the next time anyone built.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePath, pathBounds, renderMark } from './svg-path.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SS = 4;
/** How much of the tile's width the mark occupies (leaves the icon breathing room). */
const MARK_SCALE = 0.62;
const VARIANT_FILE = path.join(ROOT, 'assets', 'icon-variant.txt');

const argValue = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

/** Resolve which tile to draw: explicit flag, then environment, then the recorded choice. */
function resolveVariant() {
  const explicit = argValue('--variant') ?? process.env.DSH_ICON_VARIANT;
  if (explicit !== undefined) return explicit;
  try {
    const recorded = readFileSync(VARIANT_FILE, 'utf8').trim();
    if (recorded.length > 0) return recorded;
  } catch {
    // No recorded choice yet; fall through to the built-in default.
  }
  return 'gradient';
}

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerp = (a, b, t) => a + (b - a) * t;

/** The tiles the mark can be drawn on. */
const VARIANTS = {
  gradient: {
    scale: MARK_SCALE,
    mark: [255, 255, 255],
    background: (x, y) => {
      // Diagonal brand gradient with a soft top-left sheen.
      const t = clamp01((x * 0.42 + y * 0.78) / 1.2);
      const sheen = clamp01(1 - Math.hypot(x - 0.12, y - 0.06) / 1.05) ** 2 * 0.24;
      return [
        lerp(lerp(0x7c, 0x27, t), 255, sheen),
        lerp(lerp(0x8d, 0x3c, t), 255, sheen),
        lerp(lerp(0xff, 0xa6, t), 255, sheen),
      ];
    },
  },
  blue: {
    scale: MARK_SCALE,
    // DeepSeek's brand blue, flat.
    mark: [255, 255, 255],
    background: () => [0x4d, 0x6b, 0xfe],
  },
  light: {
    scale: MARK_SCALE,
    mark: [0x4d, 0x6b, 0xfe],
    background: (x, y) => {
      const t = clamp01((x * 0.4 + y * 0.8) / 1.2);
      return [lerp(0xff, 0xe4, t), lerp(0xff, 0xe9, t), lerp(0xff, 0xff, t)];
    },
  },
  mark: {
    // No tile, so the mark is not hemmed in by one and can fill the canvas.
    scale: 0.94,
    mark: [0x4d, 0x6b, 0xfe],
    // No tile: the coverage of the mark becomes the alpha, so it drops onto any background.
    background: () => null,
  },
};

// ── the mark ────────────────────────────────────────────────────────────────
const svg = readFileSync(path.join(ROOT, 'assets', 'deepseek-mark.svg'), 'utf8');
const pathData = /<path[^>]*\bd="([^"]+)"/u.exec(svg)?.[1];
if (pathData === undefined) {
  process.stderr.write('[icons] assets/deepseek-mark.svg has no <path d="...">\n');
  process.exit(1);
}
// The mark lives in a 50x50 viewBox, so 0.02 units is about a fifth of a pixel at
// 512 px — fine enough that the flattening is invisible, coarse enough to stay quick.
const mark = parsePath(pathData, { tolerance: 0.02 });
const markBounds = pathBounds(mark);

/**
 * Coverage of the mark at output resolution.
 *
 * Rasterized at the target size rather than downsampled from one big mask: a box
 * downsample only works for integer factors, and the ICO's 24 px and 48 px entries do
 * not divide any convenient power of two (a 1024 px mask produced `NaN` coverage for
 * them, which showed up as a dithered black square).
 */
function markMaskAt(size, scale) {
  return renderMark(mark, { resolution: size, scale, subSamples: 8 }).mask;
}

// ── background ──────────────────────────────────────────────────────────────
/** Signed coverage of a rounded rectangle (1 inside, 0 outside). */
function inRoundRect(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

const TILE_RADIUS = 0.235;

/**
 * Render just the tile, supersampled. Returns `null` for the tile-less variant.
 * @returns a `size * size * 4` RGBA buffer.
 */
function renderBackground(size, variant) {
  const out = Buffer.alloc(size * size * 4);
  if (variant.background(0, 0) === null) return out;
  const samples = SS * SS;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inRoundRect(x, y, TILE_RADIUS)) continue;
          const [r, g, b] = variant.background(x, y);
          sr += r;
          sg += g;
          sb += b;
          sa += 1;
        }
      }
      const i = (py * size + px) * 4;
      out[i] = sa > 0 ? Math.round(sr / sa) : 0;
      out[i + 1] = sa > 0 ? Math.round(sg / sa) : 0;
      out[i + 2] = sa > 0 ? Math.round(sb / sa) : 0;
      out[i + 3] = Math.round((sa / samples) * 255);
    }
  }
  return out;
}

/**
 * Optical size adjustment.
 *
 * A mark that reads well at 256 px turns to mush at 16 px, because the tile's padding
 * costs proportionally more of the few pixels available. Rather than keep one ratio
 * for every entry, the smallest sizes give the mark more of the tile — the usual
 * correction for an icon that has to survive a title bar and a tray.
 */
function scaleFor(size, base) {
  if (base >= 0.9) return base; // already a bare mark, nothing to compensate for
  if (size <= 20) return Math.min(0.84, base + 0.22);
  if (size <= 32) return base + 0.14;
  if (size <= 48) return base + 0.07;
  return base;
}

/** Composite the mark onto the tile at one size. */
function render(size, variantName) {
  const variant = VARIANTS[variantName];
  const out = renderBackground(size, variant);
  const mask = markMaskAt(size, scaleFor(size, variant.scale));
  const [mr, mg, mb] = variant.mark;
  const bare = variant.background(0, 0) === null;
  for (let i = 0; i < size * size; i += 1) {
    const cov = clamp01(mask[i]);
    if (cov <= 0) continue;
    const at = i * 4;
    if (bare) {
      out[at] = mr;
      out[at + 1] = mg;
      out[at + 2] = mb;
      out[at + 3] = Math.round(cov * 255);
      continue;
    }
    out[at] = Math.round(out[at] * (1 - cov) + mr * cov);
    out[at + 1] = Math.round(out[at + 1] * (1 - cov) + mg * cov);
    out[at + 2] = Math.round(out[at + 2] * (1 - cov) + mb * cov);
  }
  return out;
}

// ── PNG ─────────────────────────────────────────────────────────────────────
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

function toPng(rgba, width, height = width) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO (BMP/DIB entries, no PNG compression, maximum shell compatibility) ──
function toIcoEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const src = ((size - 1 - y) * size + x) * 4; // bottom-up
      const dst = (y * size + x) * 4;
      xor[dst] = rgba[src + 2];
      xor[dst + 1] = rgba[src + 1];
      xor[dst + 2] = rgba[src];
      xor[dst + 3] = rgba[src + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  return Buffer.concat([header, xor, mask]);
}

function toIco(images) {
  const entries = images.map(({ size, data }) => ({ size, data: toIcoEntry(data, size) }));
  const directory = Buffer.alloc(6 + entries.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);
  let offset = directory.length;
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0;
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

// ── comparison sheet ────────────────────────────────────────────────────────
/**
 * Lay every variant out in a row on a mid grey, so both the pale tiles and the
 * tile-less mark stay visible against it. Written only by `--sheet`, and used while
 * choosing the artwork rather than shipped.
 */
function writeSheet() {
  const names = Object.keys(VARIANTS);
  const cell = 256;
  const gap = 24;
  const width = names.length * cell + (names.length + 1) * gap;
  const height = cell + gap * 2;
  const out = Buffer.alloc(width * height * 4);
  // Mid grey backdrop, fully opaque.
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = 0x7a;
    out[i * 4 + 1] = 0x7a;
    out[i * 4 + 2] = 0x7a;
    out[i * 4 + 3] = 255;
  }
  names.forEach((name, index) => {
    const image = render(cell, name);
    const originX = gap + index * (cell + gap);
    const originY = gap;
    for (let y = 0; y < cell; y += 1) {
      for (let x = 0; x < cell; x += 1) {
        const src = (y * cell + x) * 4;
        const alpha = image[src + 3] / 255;
        if (alpha === 0) continue;
        const dst = ((originY + y) * width + originX + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          out[dst + c] = Math.round(out[dst + c] * (1 - alpha) + image[src + c] * alpha);
        }
      }
    }
  });
  mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  writeFileSync(path.join(ROOT, 'build', 'icon-variants.png'), toPng(out, width, height));
  process.stdout.write(`[icons] wrote build/icon-variants.png (${names.join(' | ')}), ${width}x${height}\n`);
}

/**
 * The same artwork at the sizes it will actually be seen at, zoomed by a single
 * integer factor so relative legibility is preserved.
 *
 * This exists because "does the whale survive 16 px?" is the only question that
 * matters for a tray and title-bar icon and it cannot be answered from the 512 px
 * render — the small entries are where a mark turns to mush.
 */
function writeLadder(variantName) {
  const sizes = [16, 32, 48, 64, 128];
  const zoom = 4;
  const gap = 16;
  const width = sizes.reduce((sum, size) => sum + size * zoom, gap * (sizes.length + 1));
  const height = Math.max(...sizes) * zoom + gap * 2;
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = 0x55;
    out[i * 4 + 1] = 0x55;
    out[i * 4 + 2] = 0x55;
    out[i * 4 + 3] = 255;
  }
  let originX = gap;
  for (const size of sizes) {
    const image = render(size, variantName);
    const originY = Math.round((height - size * zoom) / 2);
    for (let y = 0; y < size * zoom; y += 1) {
      for (let x = 0; x < size * zoom; x += 1) {
        // Nearest neighbour: the point is to see the real pixels, not a smoothed guess.
        const src = (Math.floor(y / zoom) * size + Math.floor(x / zoom)) * 4;
        const alpha = image[src + 3] / 255;
        if (alpha === 0) continue;
        const dst = ((originY + y) * width + originX + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          out[dst + c] = Math.round(out[dst + c] * (1 - alpha) + image[src + c] * alpha);
        }
      }
    }
    originX += size * zoom + gap;
  }
  writeFileSync(path.join(ROOT, 'build', 'icon-sizes.png'), toPng(out, width, height));
  process.stdout.write(`[icons] wrote build/icon-sizes.png (${variantName} at ${sizes.join('/')} px, ${zoom}x zoom)\n`);
}

// ── main ────────────────────────────────────────────────────────────────────
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const variantName = resolveVariant();
if (!(variantName in VARIANTS)) {
  process.stderr.write(`[icons] unknown variant ${variantName}; expected one of ${Object.keys(VARIANTS).join(', ')}\n`);
  process.exit(1);
}

if (process.argv.includes('--sheet')) {
  writeSheet();
  writeLadder(variantName);
} else {
  // Record an explicitly chosen variant so `npm run build` (which regenerates the
  // icons every time) keeps drawing it. A preview run must never do this.
  if (argValue('--variant') !== undefined) {
    mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
    writeFileSync(VARIANT_FILE, `${variantName}\n`);
  }
  const images = SIZES.map((size) => ({ size, data: render(size, variantName) }));
  const big = render(512, variantName);

  mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  mkdirSync(path.join(ROOT, 'app', 'assets'), { recursive: true });
  mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  const png = toPng(big, 512);
  writeFileSync(path.join(ROOT, 'build', 'icon.png'), png);
  writeFileSync(path.join(ROOT, 'app', 'assets', 'icon.png'), png);
  writeFileSync(path.join(ROOT, 'docs', 'deepseek-icon.png'), png);
  writeFileSync(path.join(ROOT, 'build', 'icon.ico'), toIco(images));
  process.stdout.write(
    `[icons] variant=${variantName}; mark ${markBounds.width.toFixed(1)}x${markBounds.height.toFixed(1)} units; ` +
      `wrote build/icon.png (${(png.length / 1024).toFixed(1)} KB), app/assets/icon.png, docs/deepseek-icon.png, ` +
      `build/icon.ico (${SIZES.join('/')})\n`,
  );
}
