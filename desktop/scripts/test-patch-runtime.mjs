#!/usr/bin/env node
/**
 * Tests for `scripts/patch-runtime.mjs`, the build step that fixes the bundled
 * `dsh-native-command` so a Windows desktop open actually shows a window.
 *
 * The patch is only worth having if three separate things hold, so each is checked:
 *
 *   1. the transformation is correct and idempotent, and refuses to run when upstream
 *      text has moved (a silent skip would ship a desktop where nothing opens);
 *   2. the shipped runtime really is patched;
 *   3. the patched module *behaves* differently — opening a path calls `explorer.exe`
 *      instead of `powershell.exe Invoke-Item`, which is the whole point.
 *
 *   node scripts/test-patch-runtime.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { moduleFiles, patchSource } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'patch-runtime.mjs')).href);

let failed = 0;
let ran = 0;
const check = (name, ok, extra = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${extra}`}`);
};

// ── the transformation ──────────────────────────────────────────────────────
// A miniature of the upstream file: just the three anchors the patch rewrites.
const UPSTREAM = [
  'import { execFile } from "node:child_process";',
  'import { release } from "node:os";',
  'import { dirname, extname } from "node:path";',
  'import { pathToFileURL } from "node:url";',
  'const runNativeCommand = (command, args, signal) => new Promise((resolve, reject) => {',
  '\texecFile(command, [...args], {',
  '\t\tencoding: "utf8",',
  '\t\tsignal,',
  '\t\twindowsHide: true',
  '\t}, (error, stdout, stderr) => {',
  '\t\tresolve({ stdout, stderr });',
  '\t});',
  '});',
  '/** PowerShell single-quoted literal (doubles embedded quotes). */',
  'function powershellLiteral(path) {',
  '\treturn `\'${path.replace(/^\'/g, "\'\'")}\'`;',
  '}',
  '/** Open one Windows-resolvable path through its registered desktop application. */',
  'async function openWindowsPath(path, signal, run) {',
  '\tawait run("powershell.exe", [',
  '\t\t"-NoProfile",',
  '\t\t"-Command",',
  '\t\t`Invoke-Item -LiteralPath ${powershellLiteral(path)}`',
  '\t], signal);',
  '}',
  '\t\tconst target = pathToFileURL(windowsPath, { windows: true }).href.replaceAll(",", "%2C");',
  '\t\ttry {',
  '\t\t\tawait run("explorer.exe", ["/select,", target], signal);',
  '\t\t} catch (error) {',
  '\t\t\tsignal.throwIfAborted();',
  '\t\t\tif (!(error instanceof Error) || !("code" in error) || error.code !== 1) throw error;',
  '\t\t}',
  '\t\treturn;',
  'export { openWindowsPath, runNativeCommand };',
].join('\n');

const first = patchSource(UPSTREAM);
check('the patch applies to upstream text', first.changed === true && first.problems.length === 0, JSON.stringify(first.problems));
check('the patch stops hiding explorer.exe', first.code.includes('GUI_LAUNCHERS'), 'marker missing');
check('the patch hides console helpers by name, not by accident',
  /windowsHide: !GUI_LAUNCHERS\.has\(basename\(command\)\.toLowerCase\(\)\)/u.test(first.code), 'conditional missing');
check('the patch adds the basename import the conditional needs',
  first.code.includes('import { basename, dirname, extname } from "node:path";'), 'import not rewritten');
check('the patch opens folders with explorer.exe', first.code.includes('await run("explorer.exe", [path], signal);'), 'call not rewritten');
// The function's comment still explains why `Invoke-Item` was dropped, so the check is
// on the call rather than on the text.
check('the patch no longer shells out to powershell for a folder',
  !first.code.includes('await run("powershell.exe"'), 'powershell call kept');
// explorer.exe exits 1 after a successful handoff. Without this tolerance the patched
// openWindowsPath would reject a launch that had already worked, turning a fixed button
// into an error dialog.
check('the patch tolerates explorer.exe exit code 1',
  first.code.includes('error.code !== 1'), 'exit-code tolerance missing');
check('the patch reveals with the native path, not a percent-encoded URL',
  first.code.includes('["/select,", windowsPath]') && !first.code.includes('.replaceAll(",", "%2C")'),
  'reveal still builds a file URL');

const second = patchSource(first.code);
check('the patch is idempotent', second.changed === false && second.code === first.code, 'second run changed the file');
check('an already-patched file reports no problems', second.problems.length === 0, JSON.stringify(second.problems));

// A tree patched by an earlier revision must be upgraded, not rejected — otherwise every
// existing build would need a full rebuild to pick up the exit-code fix.
const R1_FUNCTION = 'async function openWindowsPath(path, signal, run) {\n\tawait run("explorer.exe", [path], signal);\n}';
const openWindowsPathOf = (source) => /async function openWindowsPath[\s\S]*?\n\}/u.exec(source)?.[0] ?? '';
const r1Source = first.code.replace(/async function openWindowsPath[\s\S]*?\n\}/u, R1_FUNCTION);
check('the revision-1 fixture really is revision 1',
  openWindowsPathOf(r1Source) === R1_FUNCTION, openWindowsPathOf(r1Source));
const upgraded = patchSource(r1Source);
check('an earlier revision is upgraded in place', upgraded.changed === true, JSON.stringify(upgraded));
check('the upgrade adds the exit-code tolerance', upgraded.code.includes('error.code !== 1'), 'tolerance still missing');
check('the upgrade leaves no stacked doc comments',
  (upgraded.code.match(/Open one Windows-resolvable path/gu) ?? []).length <= 1, 'duplicate JSDoc');
check('the upgrade is idempotent', patchSource(upgraded.code).changed === false, 'upgrade ran twice');

const unrelated = patchSource('export const nothing = true;\n');
check('upstream text that moved is reported, not silently skipped',
  unrelated.changed === false && unrelated.problems.length === 4, JSON.stringify(unrelated.problems));
check('a file with moved anchors is left untouched', unrelated.code === 'export const nothing = true;\n');

// ── the shipped runtime ─────────────────────────────────────────────────────
const shipped = moduleFiles();
check('at least one runtime tree is present', shipped.length > 0, 'run npm run prepare:runtime / npm run build');
for (const file of shipped) {
  const shown = path.relative(ROOT, file);
  const source = fs.readFileSync(file, 'utf8');
  check(`runtime is patched: ${shown}`, source.includes('GUI_LAUNCHERS'), 'unpatched — run: npm run patch:runtime');
}

// ── the patched module's behaviour ──────────────────────────────────────────
const target = shipped.find((file) => fs.existsSync(file));
if (target === undefined) {
  check('a patched module can be imported', false, 'no runtime tree');
} else {
  const mod = await import(pathToFileURL(target).href);
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    // `revealNativePath` under WSL translates the path first and rejects an empty
    // answer, so the stub has to answer that one command meaningfully.
    if (command === 'wslpath') return { stdout: 'D:\\proj\\a.txt\r\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const signal = new AbortController().signal;

  // An injected runner makes the command choice observable without opening anything.
  await mod.revealNativePath('D:\\proj\\a.txt', signal, { platform: 'win32', run });
  check('reveal calls explorer.exe', calls[0]?.command === 'explorer.exe', JSON.stringify(calls[0]));
  check('reveal keeps the /select, switch', calls[0]?.args[0] === '/select,', JSON.stringify(calls[0]?.args));
  check('reveal passes a native path, not a file URL',
    calls[0]?.args[1] === 'D:\\proj\\a.txt', JSON.stringify(calls[0]?.args));

  calls.length = 0;
  await mod.openNativePath('D:\\proj', signal, { platform: 'win32', run });
  check('opening a folder no longer shells out to powershell',
    calls[0]?.command === 'explorer.exe', JSON.stringify(calls[0]));
  check('opening a folder passes the path as a single argument',
    calls[0]?.args.length === 1 && calls[0].args[0] === 'D:\\proj', JSON.stringify(calls[0]?.args));

  calls.length = 0;
  await mod.openNativePath('D:\\proj\\notes.md', signal, { platform: 'win32', run });
  check('opening a file also goes through explorer.exe',
    calls[0]?.command === 'explorer.exe' && calls[0].args[0] === 'D:\\proj\\notes.md', JSON.stringify(calls[0]));

  // The console helpers must keep their hidden console, or every open flashes one.
  calls.length = 0;
  await mod.revealNativePath('/home/u/a.txt', signal, { platform: 'linux', run, osRelease: 'microsoft-standard', env: {} });
  check('a WSL reveal still translates the path through wslpath',
    calls[0]?.command === 'wslpath', JSON.stringify(calls[0]));
  check('a WSL reveal hands the translated path to explorer.exe',
    calls[1]?.command === 'explorer.exe' && calls[1].args[1] === 'D:\\proj\\a.txt',
    JSON.stringify(calls[1]));

  check('the module still exports its whole surface',
    ['canOpenNativePath', 'nativeFileManager', 'openNativePath', 'openNativeTextFile', 'revealNativePath', 'runNativeCommand']
      .every((name) => typeof mod[name] === 'function'),
    Object.keys(mod).join(','));
}

console.log(`\n${ran - failed}/${ran} checks passed`);
process.exit(failed === 0 ? 0 : 1);
