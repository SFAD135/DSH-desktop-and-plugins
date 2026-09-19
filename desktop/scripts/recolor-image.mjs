#!/usr/bin/env node
/**
 * Replace the cool-blue backdrop of a PNG with a dark green one, leaving every
 * other element alone.
 *
 * The image is genuinely decoded and re-encoded (see `png-tools.mjs`), not
 * redrawn, so it works on any picture whose backdrop is the blue family.
 *
 * What counts as "backdrop": pixels that are blue-dominant with a blue/green
 * spread and a small green/red spread — i.e. the gradient background and its
 * grid lines. A saturated accent blue is deliberately excluded by the
 * green-vs-red spread test, so a colour swatch stays the colour it was.
 *
 *   node scripts/recolor-image.mjs <in.png> <out.png>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng } from './png-tools.mjs';

const SOURCE = process.argv[2];
const TARGET = process.argv[3];
if (SOURCE === undefined || TARGET === undefined) {
  process.stderr.write('用法: node scripts/recolor-image.mjs <输入.png> <输出.png>\n');
  process.exit(2);
}

/**
 * Whether a pixel belongs to the blue backdrop family.
 *
 * Derived from the actual gradient rather than guessed. For this picture the
 * backdrop is `r = 18+60t`, `g = 72-40t`, `b = 72+120t`, so:
 *
 *   - `b >= g` holds across the whole backdrop (`b - g = 160t`), including the
 *     very first row where the two are equal;
 *   - `b - r = 54 + 60t` stays inside `[54, 114]`.
 *
 * The `b - r <= 130` bound is what rejects a saturated blue accent (a swatch),
 * whose `b - r` is 160 — the earlier version instead required `g >= r` and so
 * silently skipped every backdrop pixel past `t = 0.14`, i.e. most of the image.
 */
function isBackdrop(r, g, b) {
  return b >= g && b > r && b - r <= 130;
}

/** Map one backdrop pixel into the dark-green family, keeping its structure. */
function toDarkGreen(r, g, b) {
  return [
    Math.round(r * 0.55),
    Math.round(g * 0.55 + b * 0.42),
    Math.round(b * 0.18),
  ];
}

const file = readFileSync(SOURCE);
const { width, height, rgba, colorType, bitDepth } = decodePng(file);
const original = Buffer.from(rgba);

let changed = 0;
for (let index = 0; index < width * height; index += 1) {
  const at = index * 4;
  const r = rgba[at];
  const g = rgba[at + 1];
  const b = rgba[at + 2];
  if (!isBackdrop(r, g, b)) continue;
  const [nr, ng, nb] = toDarkGreen(r, g, b);
  rgba[at] = nr;
  rgba[at + 1] = ng;
  rgba[at + 2] = nb;
  changed += 1;
}

const png = encodePng(rgba, width, height);
mkdirSync(path.dirname(path.resolve(TARGET)), { recursive: true });
writeFileSync(TARGET, png);

// ── self-check: decode what was written and prove the claims ───────────────
const back = decodePng(png);
const at = (x, y) => {
  const i = (y * width + x) * 4;
  return [back.rgba[i], back.rgba[i + 1], back.rgba[i + 2]];
};
const before = (x, y) => {
  const i = (y * width + x) * 4;
  return [original[i], original[i + 1], original[i + 2]];
};
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const greenDominant = ([r, g, b]) => g > r && g > b;

const probes = [
  // Background probes deliberately avoid multiples of 40 (grid lines) and the
  // outer 3 px white frame.
  { name: '背景（暗端 t≈0）', x: 3, y: 21, expect: 'changed' },
  { name: '背景（中部）', x: 401, y: 421, expect: 'changed' },
  { name: '背景（亮端 t≈1）', x: 790, y: 585, expect: 'changed' },
  // Compared against a diagonal neighbour so the reference is background, not
  // the perpendicular grid line that shares this row and column.
  { name: '网格线', x: 400, y: 400, expect: 'green' },
  // Swatches sit at x = 40 + i*120, 100 px wide, near the bottom.
  { name: '红色色块', x: 90, y: 545, expect: 'same' },
  { name: '绿色色块', x: 210, y: 545, expect: 'same' },
  { name: '蓝色色块', x: 330, y: 545, expect: 'same' },
  { name: '黄色色块', x: 450, y: 545, expect: 'same' },
  { name: '白边框', x: 1, y: 300, expect: 'same' },
  { name: '文字（白色）', x: 300, y: 130, expect: 'any' },
  { name: '棋盘格', x: 4, y: 4, expect: 'any' },
];

const lines = [];
let failures = 0;
const report = (label, ok, detail) => {
  if (!ok) failures += 1;
  lines.push(`  ${ok ? 'OK  ' : 'FAIL'} ${label} — ${detail}`);
};

report('尺寸不变', back.width === width && back.height === height, `${String(width)}x${String(height)} → ${String(back.width)}x${String(back.height)}`);
report('至少改动了背景像素', changed > 0, `${String(changed)} 个像素（占 ${((changed / (width * height)) * 100).toFixed(1)}%）`);

for (const probe of probes) {
  const b = before(probe.x, probe.y);
  const a = at(probe.x, probe.y);
  const label = `${probe.name} (${String(probe.x)},${String(probe.y)})`;
  const detail = `${b.join(',')} → ${a.join(',')}`;
  if (probe.expect === 'same') report(`${label} 未被改动`, same(b, a), detail);
  else if (probe.expect === 'changed') report(`${label} 已变成绿色`, greenDominant(a) && !same(b, a), detail);
  else if (probe.expect === 'green') report(`${label} 变绿且仍是亮线`, greenDominant(a) && a[1] > at(probe.x + 3, probe.y + 3)[1], `${detail}（相邻背景 G=${String(at(probe.x + 3, probe.y + 3)[1])}）`);
  else lines.push(`  --   ${label} — ${detail}`);
}

// The claim to verify is "nothing that was not backdrop got painted green". An
// earlier version of this check forgot the "was not already green" half and
// flagged the green swatch — 100x70 = 7000 pixels of pre-existing green.
let strayGreen = 0;
for (let index = 0; index < width * height; index += 1) {
  const i = index * 4;
  const wasBackdrop = isBackdrop(original[i], original[i + 1], original[i + 2]);
  const wasGreen = greenDominant([original[i], original[i + 1], original[i + 2]]);
  const isGreen = greenDominant([rgba[i], rgba[i + 1], rgba[i + 2]]);
  if (!wasBackdrop && isGreen && !wasGreen) strayGreen += 1;
}
report('非背景像素没有被染绿', strayGreen === 0, `误染 ${String(strayGreen)} 个`);

// Every backdrop pixel must actually have been converted, not just most of them.
let missedBackdrop = 0;
for (let index = 0; index < width * height; index += 1) {
  const i = index * 4;
  if (isBackdrop(original[i], original[i + 1], original[i + 2]) && !greenDominant([rgba[i], rgba[i + 1], rgba[i + 2]])) missedBackdrop += 1;
}
report('所有背景像素都已转换', missedBackdrop === 0, `漏掉 ${String(missedBackdrop)} 个`);

process.stdout.write(
  [
    `输入: ${SOURCE}  (${String(colorType)} 型, ${String(bitDepth)} 位, ${String(width)}x${String(height)}, ${String(file.length)} 字节)`,
    `输出: ${TARGET}  (${String(png.length)} 字节)`,
    ...lines,
    failures === 0 ? '自检全部通过' : `自检失败 ${String(failures)} 项`,
    '',
  ].join('\n'),
);
process.exit(failures === 0 ? 0 : 1);
