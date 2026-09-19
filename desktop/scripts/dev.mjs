#!/usr/bin/env node
/**
 * Launch the shell straight from the checkout, using the assembled Electron
 * distribution and the assembled runtime in build/ (no packaging step).
 *
 * Usage: npm start
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const electron = path.join(ROOT, 'build', 'electron', 'electron.exe');
if (!existsSync(electron)) {
  process.stderr.write(`[dev] missing ${electron}\n[dev] run: npm run prepare:runtime\n`);
  process.exit(1);
}

const child = spawn(electron, [ROOT, `--user-data-dir=${path.join(ROOT, 'build', 'dev-userdata')}`], { cwd: ROOT, stdio: 'inherit', windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
