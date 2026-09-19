#!/usr/bin/env node
/**
 * Asserts the rule that decides which bundled-runtime files are authoring metadata.
 *
 * The stakes are asymmetric: pruning one file too many breaks dsh at run time, in
 * a way that only shows up when the user hits the relevant feature, while pruning
 * one too few merely costs a little install time. So the tests below spend most of
 * their effort on the "must NOT be pruned" side — above all that a plain `.ts`
 * source file and a `.md` are kept, since those are the near-misses of the pattern.
 *
 * Usage: node scripts/test-prune-runtime.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnneededRuntimeFile, keepForRuntime, pruneRuntimeTree, summarize } from './prune-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = path.join(ROOT, 'build', 'prune-test');

let checks = 0;
let failures = 0;
function check(label, ok, detail = '') {
  checks += 1;
  if (ok) process.stdout.write(`  ok   ${label}\n`);
  else {
    failures += 1;
    process.stdout.write(`  FAIL ${label}${detail === '' ? '' : `\n         ${detail}`}\n`);
  }
  return ok;
}

// ── pruned: authoring metadata ──────────────────────────────────────────────
process.stdout.write('\npruned\n');
const pruned = [
  'node_modules/@opentelemetry/resources/build/esm/getMachineId.js.map',
  'node_modules/pkg/index.js.map',
  'node_modules\\pkg\\index.js.map', // Windows separators must behave the same
  'node_modules/pkg/index.d.ts',
  'node_modules/pkg/index.d.mts',
  'node_modules/pkg/index.d.cts',
  'C:\\some\\dir\\package\\types.d.ts',
];
for (const file of pruned) check(`prunes ${path.basename(file)} (${file.includes('\\') ? 'backslash' : 'forward'} path)`, isUnneededRuntimeFile(file) === true);

// ── kept: everything the runtime may read ──────────────────────────────────
process.stdout.write('\nkept\n');
const kept = [
  'node_modules/pkg/index.js',
  'node_modules/pkg/index.cjs',
  'node_modules/pkg/index.mjs',
  'node_modules/pkg/package.json',
  'node_modules/pkg/binding.node',
  'node_modules/pkg/README.md',
  'node_modules/pkg/LICENSE',
  // A plain .ts source file is NOT a declaration and must survive: the pattern is
  // anchored on the `.d.` infix precisely so `foo.ts` and `foo.d.ts` differ.
  'node_modules/pkg/src/index.ts',
  'node_modules/pkg/src/helper.mts',
  'node_modules/pkg/src/helper.cts',
  // Near-misses of the `.map` suffix.
  'node_modules/pkg/sourcemap.js',
  'node_modules/pkg/map',
  'node_modules/pkg/index.map.js',
  // Near-misses of the `.d.ts` suffix.
  'node_modules/pkg/index.d.tsx',
  'node_modules/pkg/d.ts',
];
for (const file of kept) {
  check(`keeps ${path.basename(file)}`, isUnneededRuntimeFile(file) === false, file);
}
check('a `.ts` source is kept even though `.d.ts` is pruned',
  isUnneededRuntimeFile('a/index.ts') === false && isUnneededRuntimeFile('a/index.d.ts') === true);
check('`keepForRuntime` is the exact inverse of the predicate',
  kept.every((f) => keepForRuntime(f) === true) && pruned.every((f) => keepForRuntime(f) === false));

// ── summarize and pruneRuntimeTree on a real tree ───────────────────────────
process.stdout.write('\nreal tree\n');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(path.join(SCRATCH, 'deep', 'nested'), { recursive: true });
const files = {
  'keep.js': 100,
  'keep.json': 10,
  'gone.map': 1000,
  [path.join('deep', 'x.d.ts')]: 2000,
  [path.join('deep', 'nested', 'y.d.mts')]: 3000,
  [path.join('deep', 'nested', 'z.js')]: 50,
};
for (const [name, size] of Object.entries(files)) {
  writeFileSync(path.join(SCRATCH, name), 'x'.repeat(size));
}

const before = summarize(SCRATCH);
check('summarize counts the kept files', before.kept.files === 3, `kept=${before.kept.files}`);
check('summarize counts the prunable files', before.pruned.files === 3, `pruned=${before.pruned.files}`);
check('summarize adds kept bytes', before.kept.bytes === 160, `bytes=${before.kept.bytes}`);
check('summarize adds prunable bytes', before.pruned.bytes === 6000, `bytes=${before.pruned.bytes}`);

const removed = pruneRuntimeTree(SCRATCH);
check('pruneRuntimeTree removes exactly the prunable files', removed === 3, `removed=${removed}`);
const after = summarize(SCRATCH);
check('nothing prunable survives', after.pruned.files === 0, `pruned=${after.pruned.files}`);
check('every needed file survives', after.kept.files === 3 && after.kept.bytes === 160, JSON.stringify(after.kept));
check('pruning an empty/missing directory is harmless',
  pruneRuntimeTree(path.join(SCRATCH, 'does-not-exist')) === 0 &&
    summarize(path.join(SCRATCH, 'does-not-exist')).kept.files === 0);

rmSync(SCRATCH, { recursive: true, force: true });

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
