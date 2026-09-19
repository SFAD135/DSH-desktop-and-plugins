/**
 * Which files in the bundled runtime are not needed to run dsh.
 *
 * The bundled tree ships whatever npm published, and publishers include a lot of
 * authoring metadata that nothing reads at run time. Two kinds dominate it:
 *
 *   `.map`                     source maps. Node loads these only under
 *                              `--enable-source-maps`; the shell never passes it.
 *   `.d.ts`/`.d.mts`/`.d.cts`  TypeScript declarations, consumed by a type checker
 *                              at author time and by nothing else.
 *
 * They are 12,858 of 25,972 files (49.5%) but only 73.4 MB of 688.4 MB (10.7%).
 * That imbalance is why removing them pays off far more than the size suggests.
 * Measured back to back in one session (`scripts/time-install.mjs`), same machine:
 *
 *   full tree    25,973 files / 688.4 MB -> 156.8 MB setup -> install 26.1 s, uninstall 5.1 s
 *   pruned       13,115 files / 615.0 MB -> 153.1 MB setup -> install 20.7 s, uninstall 3.9 s
 *
 * So the setup gets smaller *and* the install gets 21% faster, because NSIS's
 * per-file cost — not the byte count — is roughly half of the time above the
 * raw-copy floor. Repeat runs of one configuration vary by a second or two, which
 * is why comparisons must be made in the same session to mean anything.
 *
 * Deliberately NOT removed: `.md` (some packages read their own docs) and
 * non-declaration `.ts` sources. Together they are about 10 MB, and the point of
 * this module is to be obviously safe rather than maximally small.
 *
 * The rule is pure, so it is unit-testable (`scripts/test-prune-runtime.mjs`), and
 * it lives in `scripts/` rather than `app/` because it is a build concern: `app/`
 * is copied verbatim into an installed shell, where this would be dead weight.
 *
 * @module dsh-desktop/prune-runtime
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Is this authoring metadata that nothing reads at run time?
 * @param filePath - any path inside a package tree.
 */
export function isUnneededRuntimeFile(filePath) {
  const base = path.basename(filePath);
  if (base.endsWith('.map')) return true;
  return /\.d\.(?:ts|mts|cts)$/u.test(base);
}

/**
 * `cpSync` filter form: returns `false` for files the runtime does not need, so
 * they are never copied in the first place (cheaper than copying then deleting).
 * @param source - the path `cpSync` is about to copy.
 */
export function keepForRuntime(source) {
  return !isUnneededRuntimeFile(source);
}

/**
 * Count files and bytes in a tree, split by whether the runtime needs them.
 * Used to report what a build pruned and to assert it in tests.
 * @param root - directory to walk.
 * @returns `{ kept: { files, bytes }, pruned: { files, bytes } }`.
 */
export function summarize(root) {
  const kept = { files: 0, bytes: 0 };
  const pruned = { files: 0, bytes: 0 };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const size = statSync(full).size;
      const bucket = isUnneededRuntimeFile(full) ? pruned : kept;
      bucket.files += 1;
      bucket.bytes += size;
    }
  };
  if (existsSync(root)) walk(root);
  return { kept, pruned };
}

/**
 * Delete the unneeded files from an already-assembled tree, in place. Needed for a
 * tree that was copied before the rule existed, and to repair a partial build.
 * @returns how many files were removed.
 */
export function pruneRuntimeTree(root) {
  let removed = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (isUnneededRuntimeFile(full)) { rmSync(full, { force: true }); removed += 1; }
    }
  };
  if (existsSync(root)) walk(root);
  return removed;
}

/** Human-readable list of what gets pruned, for logs and the README. */
export const PRUNED_PATTERNS = ['*.map', '*.d.ts', '*.d.mts', '*.d.cts'];
