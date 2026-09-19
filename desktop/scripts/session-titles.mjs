#!/usr/bin/env node
/**
 * Print the titles recorded in a dsh session store, so an interoperability
 * check can assert that the desktop window lists the sessions the command line
 * created.
 *
 * Usage: node scripts/session-titles.mjs [homeDir]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';

const home = process.argv[2] ?? path.join(os.homedir(), '.dsh');
const root = path.join(home, 'sessions');
if (!existsSync(root)) {
  process.stdout.write(`[titles] no session store at ${root}\n`);
  process.exit(0);
}

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    entry.isDirectory() ? walk(full) : files.push(full);
  }
})(root);

const results = [];
for (const file of files) {
  let text;
  try {
    const raw = readFileSync(file);
    text = file.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
  } catch (error) {
    results.push({ file: path.basename(file), error: error.message });
    continue;
  }
  let title;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const match = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(line);
    if (match && match[1].trim() !== '') {
      title = JSON.parse(`"${match[1]}"`);
      break;
    }
  }
  results.push({ file: path.basename(path.dirname(file)), title: title ?? '(untitled)' });
}

for (const result of results) {
  process.stdout.write(`${result.title === undefined ? 'ERR ' : '  - '}${result.title ?? result.error}${result.title === undefined ? ` (${result.file})` : ''}\n`);
}
process.stdout.write(`[titles] ${results.length} sessions under ${root}\n`);
