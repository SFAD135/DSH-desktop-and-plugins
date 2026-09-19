#!/usr/bin/env node
/**
 * Asserts the SVG path rasterizer that draws the app icon (`scripts/svg-path.mjs`).
 *
 * The stakes here are quiet ones. A wrong fill makes the icon look slightly off and
 * nobody investigates; a wrong **mask size** produced `NaN` coverage for the ICO's
 * 24 px and 48 px entries, which rendered as a dithered black square and was only
 * caught by looking at the artwork at real size. So the tests concentrate on the
 * invariants that fail loudly instead of subtly:
 *
 *   - coverage is always finite and within 0..1, for every icon size in use;
 *   - the nonzero winding rule really produces holes, since the mark's eye and belly
 *     notch depend on it; and
 *   - an unimplemented path command throws rather than drawing something wrong.
 *
 * Usage: node scripts/test-svg-path.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parsePath, pathBounds, rasterizeCoverage, renderMark, tokenize } from './svg-path.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let checks = 0;
let failures = 0;
function check(label, ok, detail = '') {
  checks += 1;
  if (ok) process.stdout.write(`  ok   ${label}\n`);
  else {
    failures += 1;
    process.stdout.write(`  FAIL ${label}${detail === '' ? '' : `\n         ${detail}`}\n`);
  }
}

/** Identity transform onto a Pixel canvas of the given size. */
const square = (size) => (x, y) => [x, y];

// ── tokenizing ──────────────────────────────────────────────────────────────
check('tokens split on whitespace', tokenize('M 1 2').join(',') === 'M,1,2');
check('tokens split on commas', tokenize('M1,2').join(',') === 'M,1,2');
// A sign starts a new number, which is how real path data omits separators.
check('a minus sign starts a new number', tokenize('M10 10L-5-5').join(',') === 'M,10,10,L,-5,-5');
check('decimals are kept whole', tokenize('C1.5 2.5').join(',') === 'C,1.5,2.5');
check('exponents survive', tokenize('L1e-2 3').join(',') === 'L,1e-2,3');

// ── parsing ─────────────────────────────────────────────────────────────────
const box = parsePath('M0 0L10 0L10 10L0 10Z');
check('one subpath per M', box.length === 1, String(box.length));
check('Z closes the contour explicitly', box[0].length === 5, JSON.stringify(box[0]));
check('the closing point repeats the start',
  box[0].at(-1)[0] === 0 && box[0].at(-1)[1] === 0, JSON.stringify(box[0].at(-1)));

const open = parsePath('M0 0L10 0L10 10');
check('an open subpath is left open', open[0].length === 3, JSON.stringify(open[0]));

// Bare numbers repeat the previous command, and after `M` they mean `L`.
const implicit = parsePath('M0 0 10 0 10 10Z');
check('implicit lineto after moveto', implicit[0].length === 4, JSON.stringify(implicit[0]));

const bx = pathBounds(box);
check('bounds cover the box',
  bx.minX === 0 && bx.minY === 0 && bx.maxX === 10 && bx.maxY === 10, JSON.stringify(bx));

// A cubic really is subdivided, and lands exactly on its endpoint.
const curve = parsePath('M0 0C0 10 10 10 10 0Z', { tolerance: 0.01 });
check('a cubic is flattened into many segments', curve[0].length > 8, String(curve[0].length));
check('the curve ends exactly where it should',
  curve[0].some(([x, y]) => Math.abs(x - 10) < 1e-9 && Math.abs(y) < 1e-9), JSON.stringify(curve[0].at(-1)));

// Refusing beats guessing: a command this parser does not implement must be loud.
let threw = '';
try {
  parsePath('M0 0Q5 5 10 0Z');
} catch (error) {
  threw = error.message;
}
check('an unimplemented command throws', threw.includes('unsupported path command'), threw);
let started = '';
try {
  parsePath('10 10');
} catch (error) {
  started = error.message;
}
check('path data starting with a number throws', started.includes('starts with a number'), started);

// ── the nonzero winding rule ────────────────────────────────────────────────
// Outer square clockwise, inner square counter-clockwise: the middle is a hole.
const holed = parsePath('M0 0L20 0L20 20L0 20ZM6 6L6 14L14 14L14 6Z');
const holedMask = rasterizeCoverage(holed, {
  width: 20, height: 20, transform: square(20), subSamples: 8,
});
const at = (mask, x, y, size = 20) => mask[y * size + x];
check('an opposite-wound contour punches a hole', at(holedMask, 10, 10) === 0, String(at(holedMask, 10, 10)));
check('the material around the hole is still filled', at(holedMask, 2, 10) === 1, String(at(holedMask, 2, 10)));

// Same winding direction: it is filled solid, which is the "even-odd would differ" case.
const solid = parsePath('M0 0L20 0L20 20L0 20ZM6 6L14 6L14 14L6 14Z');
const solidMask = rasterizeCoverage(solid, {
  width: 20, height: 20, transform: square(20), subSamples: 8,
});
check('a same-wound contour stays filled (nonzero, not even-odd)',
  at(solidMask, 10, 10) === 1, String(at(solidMask, 10, 10)));

// Coverage must be exact outside and inside, and fractional only at the boundary.
const half = rasterizeCoverage(parsePath('M0 0L10 0L10 20L0 20Z'), {
  width: 20, height: 20, transform: square(20), subSamples: 8,
});
check('a half-canvas rect covers the inside fully', at(half, 5, 10) === 1, String(at(half, 5, 10)));
check('a half-canvas rect covers the outside not at all', at(half, 15, 10) === 0, String(at(half, 15, 10)));

// ── the invariant that the 48 px bug violated ───────────────────────────────
const svg = readFileSync(path.join(ROOT, 'assets', 'deepseek-mark.svg'), 'utf8');
const pathData = /<path[^>]*\bd="([^"]+)"/u.exec(svg)?.[1] ?? '';
check('the mark asset still has a path', pathData.length > 1000, `${pathData.length} chars`);

const mark = parsePath(pathData, { tolerance: 0.02 });
check('the mark parses into four contours', mark.length === 4, String(mark.length));
const markBox = pathBounds(mark);
check('the mark fits its 50x50 viewBox',
  markBox.minX >= 0 && markBox.minY >= 0 && markBox.maxX <= 50 && markBox.maxY <= 50,
  JSON.stringify(markBox));

// Every size the icon generator emits, including the two that do not divide a power
// of two. These are the ones a box downsample got wrong; asserting finiteness here is
// what stops that class of bug from coming back unnoticed.
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
  const { mask } = renderMark(mark, { resolution: size, scale: 0.62, subSamples: 8 });
  let finite = true;
  let inRange = true;
  let min = 1;
  let max = 0;
  for (const value of mask) {
    if (!Number.isFinite(value)) finite = false;
    else if (value < 0 || value > 1) inRange = false;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  check(`${String(size).padStart(3)}px coverage is finite and within 0..1`, finite && inRange,
    `finite=${String(finite)} inRange=${String(inRange)} min=${String(min)} max=${String(max)}`);
  // A blank or solid mask would pass the range check but draw nothing.
  check(`${String(size).padStart(3)}px mask is neither blank nor solid`, min === 0 && max === 1,
    `min=${String(min)} max=${String(max)}`);
}

// The mark's own details must survive: a solid blob would mean the fill rule failed.
const detail = renderMark(mark, { resolution: 256, scale: 0.62, subSamples: 8 }).mask;
const covered = detail.reduce((sum, value) => sum + (value > 0.5 ? 1 : 0), 0);
const ratio = covered / detail.length;
check('the mark covers a plausible fraction of its box', ratio > 0.12 && ratio < 0.45, `ratio=${ratio.toFixed(3)}`);

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
