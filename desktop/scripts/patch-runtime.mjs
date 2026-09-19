#!/usr/bin/env node
/**
 * Patch the bundled `@deepseek-ai/dsh-native-command` so that opening a path on the
 * Windows desktop actually shows a window.
 *
 * ## The upstream bug
 *
 * Every native open goes through `runNativeCommand`, which launches the child with
 * `windowsHide: true`. That option is documented as hiding the subprocess *console*
 * window, but it is implemented with `STARTF_USESHOWWINDOW` + `SW_HIDE`, which applies
 * to the process's first window whatever it is. For a GUI launcher it means the window
 * is created **hidden**: it exists, Explorer registers it, `Shell.Application` lists
 * it, and the user never sees it. Measured on a real machine:
 *
 *   execFile('explorer.exe', ['/select,', 'file:///D:/1848/123.txt'],
 *            { encoding: 'utf8', windowsHide: true })
 *   -> [{"hwnd":11537172,"title":"1848 - 文件资源管理器","visible":false}]
 *
 * It also explains the accumulating "ghost" windows: one invisible window per click,
 * which then makes any "is this folder already open?" probe answer yes forever.
 *
 * The second half is `openWindowsPath`, which opens folders with
 * `powershell.exe -Command "Invoke-Item -LiteralPath <path>"`. `Invoke-Item` delegates
 * to the shell's *default verb*, and a machine with no `HKCR\Directory\shell`
 * registration has no default action for folders — that command then exits 0, prints
 * nothing, and opens nothing, while files keep working normally.
 *
 * ## What this script changes
 *
 *   1. `openWindowsPath` launches `explorer.exe <path>` directly: a documented argument
 *      instead of a registry verb, and a GUI program rather than a console one.
 *   2. `runNativeCommand` stops hiding `explorer.exe`, while still hiding genuine
 *      console helpers (`wslpath`, `powershell.exe`), so no console window flashes.
 *
 * ## Usage
 *
 *   node scripts/patch-runtime.mjs            # patch every runtime tree that exists
 *   node scripts/patch-runtime.mjs <dir>...   # patch specific runtime roots
 *
 * Idempotent, and loud when it cannot apply: an anchor that no longer matches means
 * upstream changed, and a silent skip would ship a broken desktop. An already-patched
 * tree carrying an earlier revision of this patch is upgraded rather than rejected.
 * `test:patch-runtime` fails if the shipped runtime is unpatched.
 *
 * @module dsh-desktop/patch-runtime
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where a runtime tree can live, relative to a project root. */
const RUNTIME_ROOTS = [
  path.join('build', 'runtime', 'dsh'),
  path.join('dist', 'DeepSeek Harness', 'resources', 'runtime', 'dsh'),
  path.join('build', 'installer', 'payload', 'DeepSeek Harness', 'resources', 'runtime', 'dsh'),
];

const MODULE_RELATIVE = path.join('node_modules', '@deepseek-ai', 'dsh-native-command', 'lib', 'index.js');

const IMPORT_FROM = 'import { dirname, extname } from "node:path";';
const IMPORT_TO = 'import { basename, dirname, extname } from "node:path";';

const RUNNER_FROM = `const runNativeCommand = (command, args, signal) => new Promise((resolve, reject) => {
	execFile(command, [...args], {
		encoding: "utf8",
		signal,
		windowsHide: true
	}, (error, stdout, stderr) => {`;

const RUNNER_TO = `/**
* Programs whose first window is the result the caller asked for. \`windowsHide\` is
* implemented with \`SW_HIDE\` and applies to that window, so hiding a GUI launcher
* creates a window the user never sees — an invisible folder that the desktop still
* reports as open. Console helpers stay hidden, or they would flash a console.
*/
const GUI_LAUNCHERS = new Set(["explorer.exe"]);
const runNativeCommand = (command, args, signal) => new Promise((resolve, reject) => {
	execFile(command, [...args], {
		encoding: "utf8",
		signal,
		windowsHide: !GUI_LAUNCHERS.has(basename(command).toLowerCase())
	}, (error, stdout, stderr) => {`;

const WINDOWS_PATH_FROM = `async function openWindowsPath(path, signal, run) {
	await run("powershell.exe", [
		"-NoProfile",
		"-Command",
		\`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`
	], signal);
}`;

/**
 * The first revision of this patch, as it exists in trees patched before the exit-code
 * tolerance was added. Anchors are the function text alone, never the JSDoc above it, so
 * upgrading cannot leave two doc comments stacked on one another.
 */
const WINDOWS_PATH_R1 = `async function openWindowsPath(path, signal, run) {
	await run("explorer.exe", [path], signal);
}`;

const WINDOWS_PATH_TO = `async function openWindowsPath(path, signal, run) {
	// \`explorer.exe <path>\` replaces \`powershell.exe -Command "Invoke-Item -LiteralPath
	// <path>"\`. Invoke-Item delegates to the shell's default verb, and a machine with no
	// HKCR\\\\Directory\\\\shell registration has no default action for folders: it then exits
	// 0, prints nothing and opens nothing, while files keep working. This documented
	// argument form does not consult that registration at all, and hands the path to a
	// GUI program rather than a console one.
	try {
		await run("explorer.exe", [path], signal);
	} catch (error) {
		// explorer.exe exits 1 after handing the path to the running shell, which is a
		// successful handoff rather than a failure — the same tolerance revealNativePath
		// already applies to its own \`explorer.exe /select,\` call.
		signal.throwIfAborted();
		if (!(error instanceof Error) || !("code" in error) || error.code !== 1) throw error;
	}
}`;

/**
 * Reveal: upstream builds a percent-encoded `file://` URL and hands that to
 * `explorer.exe /select,`. For a path containing non-ASCII characters Explorer opens
 * nothing at all — no window, not even a hidden one — while the same call with a plain
 * path works, commas included. The URL form was presumably chosen to keep commas from
 * breaking the switch, but passing the path as its own argv element already does that.
 */
const REVEAL_FROM = `		const target = pathToFileURL(windowsPath, { windows: true }).href.replaceAll(",", "%2C");
		try {
			await run("explorer.exe", ["/select,", target], signal);
		} catch (error) {
			signal.throwIfAborted();
			if (!(error instanceof Error) || !("code" in error) || error.code !== 1) throw error;
		}
		return;`;

const REVEAL_TO = `		try {
			// The native path is passed as its own argument. A percent-encoded \`file://\`
			// URL — what this used to build — opens nothing at all for a path containing
			// non-ASCII characters, while \`explorer.exe /select,\` accepts a plain path,
			// commas included.
			await run("explorer.exe", ["/select,", windowsPath], signal);
		} catch (error) {
			signal.throwIfAborted();
			if (!(error instanceof Error) || !("code" in error) || error.code !== 1) throw error;
		}
		return;`;

/**
 * One rewrite: the text it should end up as, and every earlier form it may currently
 * have. Listing earlier revisions keeps the patcher usable on a tree that already
 * carries an older patch instead of forcing a full rebuild.
 */
const EDITS = [
  { label: 'path import', to: IMPORT_TO, from: [IMPORT_FROM] },
  { label: 'runNativeCommand', to: RUNNER_TO, from: [RUNNER_FROM] },
  { label: 'openWindowsPath', to: WINDOWS_PATH_TO, from: [WINDOWS_PATH_FROM, WINDOWS_PATH_R1] },
  { label: 'revealNativePath', to: REVEAL_TO, from: [REVEAL_FROM] },
];

/**
 * Apply every edit to one module source.
 *
 * Each edit is independently idempotent: a file already carrying the final text is left
 * alone, so re-running is safe, and a file carrying an earlier revision is upgraded.
 * @param source - the contents of `dsh-native-command/lib/index.js`.
 * @returns `{ code, changed, problems, changedEdits }`; `problems` is non-empty when an
 *   anchor is missing, in which case the source is returned untouched.
 */
export function patchSource(source) {
  let code = source;
  const problems = [];
  const changedEdits = [];
  for (const edit of EDITS) {
    if (code.includes(edit.to)) continue;
    const found = edit.from.find((variant) => code.includes(variant));
    if (found === undefined) {
      problems.push(`anchor not found: ${edit.label}`);
      continue;
    }
    code = code.replace(found, edit.to);
    changedEdits.push(edit.label);
  }
  if (problems.length > 0) return { code: source, changed: false, problems, changedEdits: [] };
  return { code, changed: changedEdits.length > 0, problems: [], changedEdits };
}

/** Every `dsh-native-command` module file that exists under the given roots. */
export function moduleFiles(roots = RUNTIME_ROOTS.map((rel) => path.join(ROOT, rel))) {
  const files = [];
  for (const root of roots) {
    const file = path.join(root, MODULE_RELATIVE);
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

/** Patch one file in place. */
function patchFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const { code, changed, problems } = patchSource(source);
  if (problems.length > 0) return { file, status: 'failed', problems };
  if (!changed) return { file, status: 'already' };
  fs.writeFileSync(file, code);
  return { file, status: 'patched' };
}

/** Patch every module file found under `roots`. */
export function patchTrees(roots, { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const files = moduleFiles(roots);
  let failed = 0;
  for (const file of files) {
    const result = patchFile(file);
    const shown = path.relative(ROOT, file) || file;
    if (result.status === 'failed') {
      failed += 1;
      log(`[patch-runtime] FAILED ${shown}`);
      for (const problem of result.problems) log(`                 ${problem}`);
    } else {
      log(`[patch-runtime] ${result.status.padEnd(7)} ${shown}`);
    }
  }
  return { files, failed };
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const roots = args.length > 0 ? args.map((a) => path.resolve(a)) : RUNTIME_ROOTS.map((rel) => path.join(ROOT, rel));
  const { files, failed } = patchTrees(roots);
  if (files.length === 0) {
    process.stderr.write(
      '[patch-runtime] no dsh-native-command module found; run: npm run prepare:runtime && npm run build\n',
    );
    process.exit(1);
  }
  if (failed > 0) {
    process.stderr.write(
      `[patch-runtime] ${String(failed)} file(s) could not be patched — upstream ` +
        'dsh-native-command changed; update scripts/patch-runtime.mjs to match.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`[patch-runtime] ${String(files.length)} runtime tree(s) OK\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
