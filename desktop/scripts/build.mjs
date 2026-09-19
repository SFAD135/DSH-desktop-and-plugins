#!/usr/bin/env node
/**
 * Assemble the portable desktop application:
 *
 *   dist/DeepSeek Harness/
 *     DeepSeek Harness.exe      double-click entry (product icon + metadata)
 *     electron-core.exe         Electron/Chromium runtime
 *     *.dll, *.pak, locales/    Electron support files
 *     resources/app/            the shell (main process + local shell pages)
 *     resources/runtime/        bundled node.exe, full dsh package tree, pnpm
 *
 * Usage: node scripts/build.mjs [--out <dir>] [--layout portable|installed] [--keep-metadata]
 *
 * `--out` (or `$DSH_DESKTOP_DIST`) assembles somewhere else than
 * `dist/DeepSeek Harness`. That is what makes a clean build possible while an
 * instance is running: Windows will not let go of the running `electron-core.exe`
 * and the bundled `node.exe`, so the default output cannot be cleaned in place.
 *
 * Authoring metadata (source maps and TypeScript declarations) is left out of the
 * bundled runtime; `--keep-metadata` copies the tree verbatim instead. See
 * `scripts/prune-runtime.mjs` for why, and for the measured effect on install time.
 *
 * `--layout` only changes the shipped readme and whether the "create a desktop
 * shortcut" script is included. `installed` describes a copy that an installer
 * placed somewhere, with its data in `<install>\data`; `portable` (the default)
 * describes the self-contained folder this project produces directly.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepForRuntime, summarize } from './prune-runtime.mjs';
import { patchTrees } from './patch-runtime.mjs';
import { identitySource as source, numericVersion } from './exe-identity.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD = path.join(ROOT, 'build');
const APP_NAME = 'DeepSeek Harness';

const outIndex = process.argv.indexOf('--out');
const outOverride = outIndex >= 0 ? process.argv[outIndex + 1] : process.env.DSH_DESKTOP_DIST;
const DIST = outOverride ? path.resolve(ROOT, outOverride) : path.join(ROOT, 'dist', APP_NAME);
const layoutIndex = process.argv.indexOf('--layout');
const LAYOUT = layoutIndex >= 0 ? process.argv[layoutIndex + 1] : 'portable';
if (!['portable', 'installed'].includes(LAYOUT)) {
  process.stderr.write(`[build] unknown layout "${LAYOUT}"; expected portable or installed\n`);
  process.exit(1);
}
const RUNTIME = path.join(BUILD, 'runtime');
const ELECTRON = path.join(BUILD, 'electron');

const log = (message) => process.stdout.write(`[build] ${message}\n`);

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

// ── preconditions ───────────────────────────────────────────────────────────
const required = [
  [path.join(RUNTIME, 'node', 'node.exe'), 'bundled Node runtime'],
  [path.join(RUNTIME, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'bundled dsh package tree'],
  [path.join(ELECTRON, 'electron.exe'), 'Electron distribution'],
];
for (const [target, label] of required) {
  if (!existsSync(target)) {
    process.stderr.write(`[build] missing ${label}: ${target}\n[build] run: npm run prepare:runtime\n`);
    process.exit(1);
  }
}

// ── icons ───────────────────────────────────────────────────────────────────
log('generating icons');
const icons = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icons.mjs')], { stdio: 'inherit' });
if (icons.status !== 0) process.exit(icons.status ?? 1);

// ── fresh dist ──────────────────────────────────────────────────────────────
log(`cleaning ${path.relative(ROOT, DIST)}`);
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// ── electron core ───────────────────────────────────────────────────────────
log('copying the Electron/Chromium runtime');
cpSync(ELECTRON, DIST, { recursive: true, dereference: true });
const defaultApp = path.join(DIST, 'resources', 'default_app.asar');
if (existsSync(defaultApp)) rmSync(defaultApp, { force: true });
const coreExe = path.join(DIST, 'electron-core.exe');
if (existsSync(path.join(DIST, 'electron.exe'))) renameSync(path.join(DIST, 'electron.exe'), coreExe);

// ── shell app ───────────────────────────────────────────────────────────────
log('copying the shell application');
const appDir = path.join(DIST, 'resources', 'app');
mkdirSync(appDir, { recursive: true });
cpSync(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'));
cpSync(path.join(ROOT, 'app'), path.join(appDir, 'app'), { recursive: true, dereference: true });

// ── bundled runtime ─────────────────────────────────────────────────────────
// Authoring metadata is filtered out while copying, so it is never written to the
// output at all. `--keep-metadata` exists for diagnosing a suspected missing file.
const keepMetadata = process.argv.includes('--keep-metadata');
log(`copying the bundled runtime (Node + dsh + pnpm)${keepMetadata ? ', metadata included' : ', without authoring metadata'}`);
const runtimeDest = path.join(DIST, 'resources', 'runtime');
cpSync(RUNTIME, runtimeDest, {
  recursive: true,
  dereference: true,
  filter: keepMetadata ? undefined : (source) => keepForRuntime(source),
});

// The bundled dsh is patched in place: upstream opens Windows paths with a helper that
// creates the window HIDDEN, and with `Invoke-Item`, which silently does nothing where a
// machine has no default verb registered for directories. Both make the Web GUI's
// "open on the desktop" buttons do nothing at all. See scripts/patch-runtime.mjs.
const patched = patchTrees([path.join(runtimeDest, 'dsh')]);
if (patched.failed > 0 || patched.files.length === 0) {
  process.stderr.write('[build] the bundled runtime could not be patched; see above\n');
  process.exit(1);
}
if (!keepMetadata) {
  // What was left out comes from the SOURCE; the destination is then checked to
  // prove none of it slipped through. Reporting the destination as "left out"
  // would always print zero and hide a filter that never applied.
  const source = summarize(RUNTIME);
  const written = summarize(runtimeDest);
  const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  log(
    `runtime is ${written.kept.files.toLocaleString('en-US')} files / ${mb(written.kept.bytes)}` +
      ` (left out ${source.pruned.files.toLocaleString('en-US')} files / ${mb(source.pruned.bytes)} of source maps and type declarations)`,
  );
  if (written.pruned.files > 0) {
    process.stderr.write(
      `[build] ${written.pruned.files} authoring-metadata file(s) reached the output; the copy filter did not apply\n`,
    );
    process.exit(1);
  }
}

// ── launcher with the product icon ──────────────────────────────────────────
const launcherExe = path.join(DIST, 'DeepSeek Harness.exe');
const cscCandidates = [
  path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const csc = cscCandidates.find((candidate) => existsSync(candidate));

/**
 * Give `electron-core.exe` the product's icon and version identity.
 *
 * The window belongs to this process, so the taskbar button and Task Manager read
 * **its** resources. Renaming electron.exe left both saying "Electron" / "GitHub,
 * Inc." — the launcher cannot fix that, because it owns no window. The replacement
 * blobs are authored by compiling a throwaway assembly with csc (the same toolchain
 * that builds the launcher) and transplanted by `tools/set-exe-identity.cs` through
 * the Win32 resource API; see that file for why not by hand.
 *
 * Only the copy inside the output directory is touched: `build/electron` stays
 * pristine, so a bad patch is undone by rebuilding.
 */
function applyExeIdentity() {
  const identitySource = path.join(BUILD, 'identity.cs');
  const identityExe = path.join(BUILD, 'identity.exe');
  const toolExe = path.join(BUILD, 'set-exe-identity.exe');
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  writeFileSync(identitySource, source(version));

  const compile = (args, label) => {
    const result = spawnSync(csc, args, { stdio: 'inherit' });
    if (result.status !== 0) {
      process.stderr.write(`[build] ${label} failed\n`);
      return false;
    }
    return true;
  };
  log(`compiling the product identity resource (version ${numericVersion(version)})`);
  if (!compile([
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    `/win32icon:${path.join(BUILD, 'icon.ico')}`,
    `/out:${identityExe}`, identitySource,
  ], 'identity compilation')) return false;
  if (!compile([
    '/nologo', '/target:exe', '/platform:x64', '/optimize+',
    `/out:${toolExe}`, path.join(ROOT, 'tools', 'set-exe-identity.cs'),
  ], 'identity tool compilation')) return false;

  const applied = spawnSync(toolExe, [coreExe, identityExe], { stdio: 'inherit' });
  return applied.status === 0;
}

if (csc) {
  if (!applyExeIdentity()) {
    // Not fatal: the app still runs. It is reported loudly because the visible
    // symptom is a taskbar/Task Manager entry that says "Electron".
    log('WARNING: electron-core.exe keeps the Electron icon and version info; the taskbar and Task Manager will show "Electron"');
  }
  log('compiling the launcher executable');
  const compile = spawnSync(csc, [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    `/win32icon:${path.join(BUILD, 'icon.ico')}`,
    '/r:System.dll',
    '/r:System.Windows.Forms.dll',
    `/out:${launcherExe}`,
    path.join(ROOT, 'tools', 'launcher.cs'),
  ], { stdio: 'inherit' });
  if (compile.status !== 0 || !existsSync(launcherExe)) {
    process.stderr.write('[build] launcher compilation failed; falling back to the Electron binary as the entry point\n');
    renameSync(coreExe, launcherExe);
  }
} else {
  log('no .NET Framework compiler found; using the Electron binary as the entry point (default Electron icon)');
  renameSync(coreExe, launcherExe);
}

// ── docs shipped next to the exe ────────────────────────────────────────────
writeFileSync(path.join(DIST, '使用说明.txt'), (LAYOUT === 'installed' ? installedReadme() : portableReadme()).join('\r\n'));
// The shortcut script only makes sense for the folder you unzip and run.
if (LAYOUT === 'portable') cpSync(path.join(ROOT, 'scripts', 'make-shortcut.ps1'), path.join(DIST, '创建桌面快捷方式.ps1'));

function portableReadme() {
  return [
    'DeepSeek Harness 桌面版（便携版）',
    '',
    '启动：双击 “DeepSeek Harness.exe”。',
    '  首次启动会拉起内置的本地 dsh 服务（仅监听 127.0.0.1，端口自动分配），',
    '  随后在原生窗口中打开完整的 Harness 界面。',
    '',
    '数据：与命令行 dsh 完全互通。',
    '  会话 / 设置 / 凭据 / 插件都位于 %USERPROFILE%\\.dsh，',
    '  因此命令行 `dsh web`、`dsh plugin --profile web ...` 与桌面版共享同一份数据。',
    '  菜单「帮助 → 关于」里能看到真实的 home 路径，以及本版使用的 profile（web）与它的目录。',
    '',
    '想让数据跟着这个文件夹走（整个目录可拷贝、可删除）：',
    '  在本目录下新建一个名为 data 的文件夹，桌面端就会把数据放进 data\\ 里',
    '  （data\\dsh-home 为 dsh 数据，data\\shell 为桌面端自身状态）。',
    '  此时请再设置用户环境变量 DSH_HOME 指向 data\\dsh-home，命令行 dsh 才会共用同一份。',
    '',
    '同时只建议开一个。',
    '  若检测到另一个 dsh 也在使用同一 profile（包括默认端口 3080 上有 dsh 响应），',
    '  窗口标题与启动页会给出温和提示（不会阻止启动）。要真正并行，请用独立数据目录启动：',
    '  设置环境变量 DSH_DESKTOP_DATA 指向另一个目录即可。',
    '',
    '桌面快捷方式：右键“创建桌面快捷方式.ps1” → 使用 PowerShell 运行。',
    '',
    '菜单：应用 / 编辑 / 视图 / 帮助（含“打开日志文件夹”“端口设置”“重启本地服务”）。',
    '日志：%APPDATA%\\DeepSeek Harness\\logs（若使用 data 布局则为 data\\shell\\logs）',
    '',
  ];
}

function installedReadme() {
  return [
    'DeepSeek Harness 桌面版',
    '',
    '启动：桌面快捷方式、开始菜单，或双击本目录下的 “DeepSeek Harness.exe”。',
    '  首次启动会拉起内置的本地 dsh 服务（仅监听 127.0.0.1，端口自动分配），',
    '  随后在原生窗口中打开完整的 Harness 界面。',
    '',
    '数据：全部保存在本安装目录的 data 文件夹里。',
    '  data\\dsh-home   会话 / 设置 / 凭据 / 插件（即 DSH_HOME）',
    '  data\\shell      桌面端自身状态（窗口位置、日志、登录 cookie）',
    '  因此本目录可以直接整体复制到别处或删除；删除 data 等于重置。',
    '  安装时若勾选了“让命令行 dsh 共用本目录的数据”，用户环境变量 DSH_HOME',
    '  已指向 data\\dsh-home，命令行 `dsh web` 与桌面端读写的就是同一份数据。',
    '  若当时取消了勾选，命令行 dsh 仍使用 %USERPROFILE%\\.dsh，两者互不相通；',
    '  想改成共用，手动设置 DSH_HOME 指向 data\\dsh-home 即可。',
    '',
    '首次启动时若检测到 %USERPROFILE%\\.dsh 里已有数据，会询问是否导入（复制，不移动）。',
    '',
    '同时只建议开一个。',
    '  若检测到另一个 dsh 也在使用同一 profile（包括默认端口 3080 上有 dsh 响应），',
    '  窗口标题与启动页会给出温和提示（不会阻止启动）。要真正并行，请用独立数据目录启动：',
    '  设置环境变量 DSH_DESKTOP_DATA 指向另一个目录即可。',
    '',
    '菜单：应用 / 编辑 / 视图 / 帮助（含“打开日志文件夹”“端口设置”“重启本地服务”）。',
    '  菜单「帮助 → 关于」会显示真实的 DSH_HOME、profile 与数据根目录。',
    '',
    '卸载：设置 → 应用 → 已安装的应用，或开始菜单里的“卸载 DeepSeek Harness”。',
    '  卸载默认保留 data 目录，会另行询问是否一并删除。',
    '',
  ];
}

// ── summary ─────────────────────────────────────────────────────────────────
const total = dirSize(DIST);
log(`done: ${DIST}`);
log(`  entry     DeepSeek Harness.exe${csc ? '' : ' (Electron icon)'}`);
log(`  app       resources/app`);
log(`  runtime   resources/runtime (Node ${path.basename(RUNTIME)})`);
log(`  size      ${mb(total)}`);
