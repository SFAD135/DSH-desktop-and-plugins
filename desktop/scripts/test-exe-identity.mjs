#!/usr/bin/env node
/**
 * Unit tests for the exe-identity source generator (`scripts/exe-identity.mjs`).
 *
 * Three things are worth pinning down here, all of them cheap to get wrong and awkward
 * to notice:
 *
 *   - the version `package.json` carries (`0.1.5-rc.2`) is not a legal `AssemblyVersion`,
 *     so it has to be normalized, and getting that wrong fails the compile;
 *   - **assembly attributes must precede every other element in a C# file** — the first
 *     version of this generator emitted them after the class and csc rejected it with
 *     CS1730, which the build reports only as a warning;
 *   - the file has to declare the entry point a `winexe` target demands, or the compile
 *     fails for a second, unrelated reason.
 *
 * Usage: node scripts/test-exe-identity.mjs
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { identitySource, numericVersion } from './exe-identity.mjs';

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

// ── version normalization ───────────────────────────────────────────────────
check('a prerelease suffix is dropped', numericVersion('0.1.5-rc.2') === '0.1.5.0', numericVersion('0.1.5-rc.2'));
check('a three-part version is padded', numericVersion('0.1.5') === '0.1.5.0', numericVersion('0.1.5'));
check('a two-part version is padded twice', numericVersion('1.2') === '1.2.0.0', numericVersion('1.2'));
check('a single-part version is padded', numericVersion('7') === '7.0.0.0', numericVersion('7'));
check('a four-part version is untouched', numericVersion('1.2.3.4') === '1.2.3.4', numericVersion('1.2.3.4'));
check('extra parts beyond four are dropped', numericVersion('1.2.3.4.5') === '1.2.3.4', numericVersion('1.2.3.4.5'));
check('build metadata after + is dropped', numericVersion('1.2.3+build') === '1.2.3.0', numericVersion('1.2.3+build'));
check('prerelease and metadata together are both dropped',
  numericVersion('1.2.3-rc.1+build.5') === '1.2.3.0', numericVersion('1.2.3-rc.1+build.5'));

// The version this project actually ships must normalize cleanly, or every build would
// fail at the csc step with an error about AssemblyVersion.
const pkgVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
check(`the shipped version (${pkgVersion}) normalizes to four numeric parts`,
  /^\d+\.\d+\.\d+\.\d+$/u.test(numericVersion(pkgVersion)), numericVersion(pkgVersion));

// ── the generated C# ────────────────────────────────────────────────────────
const source = identitySource('0.1.5-rc.2');

check('the normalized version reaches AssemblyVersion', source.includes('AssemblyVersion("0.1.5.0")'), 'missing');
check('the normalized version reaches AssemblyFileVersion',
  source.includes('AssemblyFileVersion("0.1.5.0")'), 'missing');
check('the raw prerelease version is nowhere in the output', !source.includes('0.1.5-rc.2'), 'prerelease leaked');
check('the product name becomes AssemblyProduct', source.includes('AssemblyProduct("DeepSeek Harness")'), 'missing');
check('the title becomes AssemblyTitle', source.includes('AssemblyTitle("DeepSeek Harness")'), 'missing');
check('the company becomes AssemblyCompany',
  source.includes('AssemblyCompany("DeepSeek Harness Desktop")'), 'missing');
check('the reflection namespace is imported', source.includes('using System.Reflection;'), 'missing');
check('an entry point is declared', /static\s+void\s+Main\s*\(\s*\)/u.test(source), 'winexe needs one');
check('lines are CRLF-terminated', source.includes('\r\n') && !/(?<!\r)\n/u.test(source), 'mixed line endings');

// The structural rule, not a golden-string compare: every assembly attribute must come
// before the first type declaration. This is the check that CS1730 would have caught.
const lines = source.split('\r\n');
const firstTypeAt = lines.findIndex((line) => /\b(class|struct|interface|enum)\b/u.test(line));
const lastAttributeAt = lines.reduce((last, line, index) => (line.trimStart().startsWith('[assembly:') ? index : last), -1);
check('a type declaration is present to order against', firstTypeAt > 0, `firstTypeAt=${String(firstTypeAt)}`);
check('every [assembly:] attribute precedes the first type declaration',
  lastAttributeAt !== -1 && firstTypeAt !== -1 && lastAttributeAt < firstTypeAt,
  `lastAttributeAt=${String(lastAttributeAt)} firstTypeAt=${String(firstTypeAt)}`);

// ── the identity names must match what the launcher already claims ──────────
const launcher = readFileSync(path.join(ROOT, 'tools', 'launcher.cs'), 'utf8');
for (const attribute of ['AssemblyProduct', 'AssemblyCompany']) {
  const claimed = new RegExp(`${attribute}\\("([^"]+)"\\)`, 'u').exec(launcher)?.[1];
  check(`the ${attribute} matches the launcher's`,
    claimed !== undefined && source.includes(`${attribute}("${claimed}")`),
    `launcher='${String(claimed)}'`);
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
