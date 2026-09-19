'use strict';
/**
 * A minimal SVG path rasterizer — just enough for the one path this project needs.
 *
 * The icon generator must draw the app mark faithfully rather than approximate it,
 * and the project deliberately carries no image or vector dependencies. The
 * mark is a single filled path, so the smallest honest implementation is: read the
 * `d` attribute, flatten its curves to line segments, and fill those with the
 * nonzero winding rule.
 *
 * Scope, stated so nobody expects more than it does:
 *
 *   - absolute `M` / `C` / `L` / `Z` only. Adding `S`, `Q`, `A`, `H`, `V` or the
 *     relative forms is a small amount of work, but they are not in the mark, and
 *     silently mis-parsing them would be worse than refusing;
 *   - one solid colour per fill, no strokes, no gradients in the path itself;
 *   - a single transform (scale + translate), which is all "fit this mark into a
 *     square tile" needs.
 *
 * Anti-aliasing is **analytic horizontally and sampled vertically**: spans between
 * crossings are accumulated as exact fractional pixel coverage, while rows are
 * sampled at `subSamples` sub-row positions. Rasterize at the size you need rather
 * than scaling a big mask down — averaging a high-resolution mask only works for
 * integer decimation factors, and silently produces garbage for the others (an
 * ICO's 24 px and 48 px entries do not divide a 1024 px mask).
 *
 * @module dsh-desktop/scripts/svg-path
 */

/** Command letters this parser accepts, as a set for quick lookups. */
const SUPPORTED = new Set(['M', 'L', 'C', 'Z']);

/**
 * Split a `d` attribute into command letters and numbers.
 *
 * Whitespace and commas are both separators, and a sign also starts a new number
 * (`1-2` is two numbers), which is why this is not a plain `split`.
 * @param d - the path data.
 * @returns an array of single-letter commands and numeric strings.
 */
function tokenize(d) {
  const tokens = [];
  const pattern = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/gu;
  let match;
  while ((match = pattern.exec(d)) !== null) {
    tokens.push(match[1] ?? match[2]);
  }
  return tokens;
}

/**
 * Flatten one cubic Bézier adaptively.
 *
 * Adaptive rather than fixed-count: a long gentle curve needs few segments while a
 * tight turn needs many, and a fixed count either wastes work or shows visible
 * facets at 1024 px. `tolerance` is in path units, so callers can scale it to the
 * resolution they will render at.
 */
function flattenCubic(out, x0, y0, x1, y1, x2, y2, x3, y3, tolerance, depth = 0) {
  // Flatness = how far the control points stray from the chord. If both are within
  // tolerance the curve is indistinguishable from a line at this scale.
  const dx = x3 - x0;
  const dy = y3 - y0;
  const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  const limit = tolerance * (dx * dx + dy * dy);
  // Depth cap: a cusp can otherwise subdivide forever, and 16 levels is already far
  // finer than any icon size.
  if (depth >= 16 || (d1 + d2) * (d1 + d2) <= limit * limit) {
    out.push([x3, y3]);
    return;
  }
  const x01 = (x0 + x1) / 2;
  const y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2;
  const y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2;
  const y23 = (y2 + y3) / 2;
  const x012 = (x01 + x12) / 2;
  const y012 = (y01 + y12) / 2;
  const x123 = (x12 + x23) / 2;
  const y123 = (y12 + y23) / 2;
  const xm = (x012 + x123) / 2;
  const ym = (y012 + y123) / 2;
  flattenCubic(out, x0, y0, x01, y01, x012, y012, xm, ym, tolerance, depth + 1);
  flattenCubic(out, xm, ym, x123, y123, x23, y23, x3, y3, tolerance, depth + 1);
}

/**
 * Parse path data into closed polylines.
 *
 * Every subpath is returned closed, because filling always closes an open subpath
 * implicitly.
 * @param d - the path data.
 * @param options - `tolerance` in path units (default 0.02, roughly a fifth of a
 *   pixel when a 50-unit mark is drawn at 512 px).
 * @returns an array of subpaths, each an array of `[x, y]` points.
 * @throws when the data uses a command this parser does not implement, rather than
 *   quietly drawing something wrong.
 */
function parsePath(d, { tolerance = 0.02 } = {}) {
  const tokens = tokenize(d);
  const subpaths = [];
  /** The point list currently being built, or null between subpaths. */
  let current = null;
  /** The command a bare number repeats; `M` repeats as `L`, per the SVG grammar. */
  let repeat = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let i = 0;

  const number = () => {
    const value = Number(tokens[i]);
    i += 1;
    if (!Number.isFinite(value)) throw new Error(`expected a number, found ${String(tokens[i - 1])}`);
    return value;
  };

  while (i < tokens.length) {
    const token = tokens[i];
    let command;
    if (/[A-Za-z]/u.test(token)) {
      if (!SUPPORTED.has(token)) {
        throw new Error(`unsupported path command "${token}" (this parser implements ${[...SUPPORTED].join('/')})`);
      }
      command = token;
      repeat = command === 'M' ? 'L' : command;
      i += 1;
    } else {
      command = repeat;
      if (command === null) throw new Error('path data starts with a number instead of a command');
    }

    if (command === 'M' || command === 'L') {
      const nx = number();
      const ny = number();
      if (command === 'M') {
        current = [[nx, ny]];
        subpaths.push(current);
        startX = nx;
        startY = ny;
      } else {
        if (current === null) throw new Error('path data continues a subpath that was already closed');
        current.push([nx, ny]);
      }
      x = nx;
      y = ny;
    } else if (command === 'C') {
      const x1 = number();
      const y1 = number();
      const x2 = number();
      const y2 = number();
      const x3 = number();
      const y3 = number();
      if (current === null) throw new Error('path data continues a subpath that was already closed');
      flattenCubic(current, x, y, x1, y1, x2, y2, x3, y3, tolerance);
      x = x3;
      y = y3;
    } else if (command === 'Z') {
      if (current !== null && (x !== startX || y !== startY)) current.push([startX, startY]);
      x = startX;
      y = startY;
      current = null;
    }
  }
  return subpaths;
}

/**
 * The bounding box of flattened subpaths.
 * @param subpaths - the result of {@link parsePath}.
 * @returns `{ minX, minY, maxX, maxY, width, height }`.
 */
function pathBounds(subpaths) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const points of subpaths) {
    for (const [px, py] of points) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Rasterize subpaths into a per-pixel coverage mask (0..1, one float per pixel).
 *
 * Uses the nonzero winding rule, matching SVG's default `fill-rule`. A contour wound
 * against the one enclosing it comes out as a hole, which is how cut-outs are drawn;
 * the current mark has no holes, but the rule is what makes that expressible.
 *
 * @param subpaths - the result of {@link parsePath}.
 * @param options - `width`/`height` in pixels, a `transform(x, y)` mapping path
 *   coordinates to pixel coordinates, and `subSamples` rows per pixel.
 * @returns a `Float32Array` of `width * height` coverage values, row-major.
 */
function rasterizeCoverage(subpaths, { width, height, transform, subSamples = 4 }) {
  const coverage = new Float32Array(width * height);

  // Flatten the outline into device-space edges once; every scanline reuses them.
  const edges = [];
  for (const points of subpaths) {
    for (let i = 0; i < points.length; i += 1) {
      const [ax, ay] = transform(points[i][0], points[i][1]);
      const [bx, by] = transform(points[(i + 1) % points.length][0], points[(i + 1) % points.length][1]);
      if (ay !== by) edges.push([ax, ay, bx, by]);
    }
  }
  if (edges.length === 0) return coverage;

  const crossings = [];
  const rows = height * subSamples;
  for (let row = 0; row < rows; row += 1) {
    const y = (row + 0.5) / subSamples;
    crossings.length = 0;
    for (const [ax, ay, bx, by] of edges) {
      // Half-open comparison: a vertex shared by two edges counts exactly once, so
      // spans never get an extra crossing at a join.
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        crossings.push({ x: ax + ((y - ay) / (by - ay)) * (bx - ax), dir: by > ay ? 1 : -1 });
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((p, q) => p.x - q.x);

    let winding = 0;
    for (let i = 0; i < crossings.length - 1; i += 1) {
      winding += crossings[i].dir;
      if (winding === 0) continue; // outside: between a span's start and end
      const from = Math.max(crossings[i].x, 0);
      const to = Math.min(crossings[i + 1].x, width);
      if (to <= from) continue;
      // Distribute the span as exact fractional coverage per pixel, which is what
      // makes near-vertical edges smooth no matter how few sub-rows are used.
      const base = Math.floor(row / subSamples) * width;
      for (let px = Math.floor(from); px <= Math.min(Math.ceil(to) - 1, width - 1); px += 1) {
        const left = Math.max(from, px);
        const right = Math.min(to, px + 1);
        if (right > left) coverage[base + px] += right - left;
      }
    }
  }

  const scale = 1 / subSamples;
  for (let i = 0; i < coverage.length; i += 1) coverage[i] *= scale;
  return coverage;
}

/**
 * Render the mark fitted into a square, ready to composite at any icon size.
 *
 * @param subpaths - the result of {@link parsePath}.
 * @param options - `resolution` (the pixel size to rasterize at — pass the final icon
 *   size directly), and `scale`/`centerX`/`centerY` describing where the mark sits as
 *   fractions of the square.
 * @returns `{ mask, resolution, bounds }`; `mask` is `resolution^2` coverage values.
 */
function renderMark(subpaths, { resolution = 1024, scale = 0.66, centerX = 0.5, centerY = 0.5, subSamples = 6 } = {}) {
  const bounds = pathBounds(subpaths);
  // Preserve the mark's aspect ratio, fitting its longer side to `scale`.
  const longer = Math.max(bounds.width, bounds.height);
  const factor = (resolution * scale) / longer;
  const anchorX = (bounds.minX + bounds.maxX) / 2;
  const anchorY = (bounds.minY + bounds.maxY) / 2;
  const cx = resolution * centerX;
  const cy = resolution * centerY;
  const transform = (px, py) => [cx + (px - anchorX) * factor, cy + (py - anchorY) * factor];
  return {
    bounds,
    resolution,
    mask: rasterizeCoverage(subpaths, { width: resolution, height: resolution, transform, subSamples }),
  };
}

export { flattenCubic, parsePath, pathBounds, rasterizeCoverage, renderMark, tokenize };
