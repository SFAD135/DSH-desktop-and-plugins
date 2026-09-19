#!/usr/bin/env node
/**
 * Prepare an isolated DSH_HOME for the interoperability check: copy the real
 * user home's product data (sessions, settings, credentials, storages,
 * attachments, profile manifests) — but never node_modules — so the desktop
 * shell must read the same session store the command line writes.
 *
 * Usage: node scripts/prepare-shared-home.mjs <destination>
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dest = process.argv[2];
if (!dest) {
  process.stderr.write('usage: node scripts/prepare-shared-home.mjs <destination>\n');
  process.exit(2);
}
const source = path.join(os.homedir(), '.dsh');
if (!existsSync(source)) {
  process.stderr.write(`no DSH_HOME at ${source}\n`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const isNodeModules = (src) => /[\\/]node_modules(?:[\\/]|$)/u.test(src);
const entries = ['sessions', 'storages', 'attachments', 'llm-deepseek', 'settings.yaml', '.credentials.yaml', '.anonymous-user-id', 'cordis.patch.yml'];
for (const entry of entries) {
  const from = path.join(source, entry);
  if (!existsSync(from)) continue;
  cpSync(from, path.join(dest, entry), { recursive: true, dereference: false, filter: (src) => !isNodeModules(src) });
}
// Profile manifests only (the desktop shell regenerates node_modules links).
for (const name of ['web']) {
  const from = path.join(source, 'profiles', name);
  if (!existsSync(from)) continue;
  cpSync(from, path.join(dest, 'profiles', name), {
    recursive: true,
    dereference: false,
    filter: (src) => !isNodeModules(src),
  });
}
process.stdout.write(`[shared-home] prepared ${dest} from ${source}\n`);
