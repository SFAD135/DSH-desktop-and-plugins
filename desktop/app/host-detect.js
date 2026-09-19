'use strict';
/**
 * Detect other dsh hosts that may be using the same profile as this desktop
 * shell.
 *
 * Why this exists: the desktop shell deliberately shares `$DSH_HOME` (and the
 * `web` profile) with the command-line `dsh`, so sessions/settings/plugins are
 * common. Nothing in dsh takes a profile-wide lock — its only cross-process
 * lock is a per-session kernel lease (`session.lock`, taken while a session is
 * being written), which an idle host does not hold. Running two hosts against
 * one profile is therefore possible and only mildly hazardous (live patch
 * reload and shared storage writes), so the shell reports it as a *gentle*
 * warning instead of blocking.
 *
 * Two independent signals, both best-effort and fail-open:
 *   1. a process scan (WMI/CIM) whose command lines are parsed structurally,
 *      so a host is only reported when a real `.../dsh/lib/bin.js <profile>`
 *      launcher is found — a tool subprocess echoing that text is not one;
 *   2. a fingerprint probe of the default web port (3080), which a dsh host
 *      identifies with its unauthenticated-reply wording.
 *
 * The process list is collected through a temp file rather than a pipe: a pipe
 * would need the host to allow piped child stdio, and the shell already relies
 * on file redirection everywhere else for the same reason.
 *
 * @module dsh-desktop/host-detect
 */
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The default port `dsh web` binds when no `--port` is given. */
const DEFAULT_WEB_PORT = 3080;

/** Flags that consume the following token as a value at the launcher level. */
const VALUE_FLAGS = new Set(['--patch', '--from-default-profile']);

/** Flags that make an invocation transient (it never binds a server). */
const TRANSIENT_FLAGS = new Set(['--help', '-h', '--dump-config', '--dump-default-config']);

/** Matches the CLI entry of any dsh installation, source or built. */
const BIN_PATTERN = /[\\/]dsh[\\/]lib[\\/]bin\.js$/iu;

/**
 * Split a Windows command line into tokens, honouring double quotes.
 * @param commandLine - the raw command line.
 * @returns the token list (quotes removed).
 */
function tokenize(commandLine) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const character of commandLine) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (character === ' ' || character === '\t')) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Classify one command line as a dsh host (or not), and which profile it boots.
 *
 * The parse is structural: the token that looks like the dsh CLI entry must be
 * a standalone argument, and the profile is read from the launcher-level flags
 * or the bare `web` alias. A command whose first positional token is anything
 * else (`plugin`, `headless`, a prompt) is not a web host.
 * @param commandLine - a process command line (may be undefined).
 * @returns the classification: `isHost`, the `profile` when known, and a reason otherwise.
 */
function classifyDshHost(commandLine) {
  const tokens = tokenize(commandLine ?? '');
  const binIndex = tokens.findIndex((token) => BIN_PATTERN.test(token));
  if (binIndex < 0) return { isHost: false, profile: null, reason: 'not a dsh launcher' };

  const rest = tokens.slice(binIndex + 1);
  for (const token of rest) {
    if (TRANSIENT_FLAGS.has(token)) return { isHost: false, profile: null, reason: `transient (${token})` };
  }
  if (rest[0] === 'plugin') return { isHost: false, profile: null, reason: 'plugin management' };

  let profile = null;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--profile') {
      profile = rest[index + 1] ?? null;
      break;
    }
    if (token.startsWith('--profile=')) {
      profile = token.slice('--profile='.length) || null;
      break;
    }
    if (VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (token === 'web') {
      profile = 'web';
      break;
    }
    return { isHost: false, profile: null, reason: `mode ${token}` };
  }

  if (profile === null) return { isHost: false, profile: null, reason: 'no profile selected' };
  return { isHost: true, profile, reason: 'dsh host' };
}

/**
 * Enumerate node processes and return the ones that look like dsh hosts.
 *
 * Uses WMI/CIM through PowerShell because a process command line is not
 * reachable from Node alone. The result is written to a temp file and read
 * back, so no piped stdio is required. Availability is reported honestly: a
 * locked-down host that refuses WMI yields `available: false` rather than a
 * false "clear".
 * @param options - `timeoutMs` bounds the scan.
 * @returns a promise of `{ available, hosts, error }`; each host is `{ pid, parentPid, profile, commandLine }`.
 */
function scanDshHosts({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ available: false, hosts: [], error: 'process scan is only implemented on Windows' });
      return;
    }
    const outFile = path.join(os.tmpdir(), `dsh-desktop-hosts-${String(process.pid)}-${randomBytes(4).toString('hex')}.json`);
    const removeOut = () => {
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        /* best effort */
      }
    };
    const script = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      "$ErrorActionPreference='Stop'",
      'try {',
      "  $rows = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine)",
      '  $payload = @{ ok = $true; rows = $rows }',
      '} catch {',
      '  $payload = @{ ok = $false; error = $_.Exception.Message }',
      '}',
      `$payload | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath '${outFile}' -Encoding utf8`,
    ].join('; ');

    let child;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeOut();
      resolve(result);
    };
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (error) {
      finish({ available: false, hosts: [], error: `could not run the process scan: ${error.message}` });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      finish({ available: false, hosts: [], error: `process scan timed out after ${String(timeoutMs)}ms` });
    }, timeoutMs);

    child.on('error', (error) => finish({ available: false, hosts: [], error: error.message }));
    child.on('close', (code) => {
      let text;
      try {
        text = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/u, '').trim();
      } catch (error) {
        finish({ available: false, hosts: [], error: `process scan produced no result (exit ${String(code)}): ${error.message}` });
        return;
      }
      if (text === '' || text === 'null') {
        finish({ available: true, hosts: [] });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        finish({ available: false, hosts: [], error: `could not parse the process list: ${error.message}` });
        return;
      }
      if (!Array.isArray(parsed) && parsed?.ok === false) {
        finish({ available: false, hosts: [], error: `the process list is not readable: ${parsed.error ?? 'unknown error'}` });
        return;
      }
      const raw = Array.isArray(parsed) ? parsed : (parsed?.rows ?? []);
      const rows = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
      const hosts = [];
      for (const row of rows) {
        const classification = classifyDshHost(row.CommandLine);
        if (!classification.isHost) continue;
        hosts.push({
          pid: row.ProcessId,
          parentPid: row.ParentProcessId,
          profile: classification.profile,
          commandLine: row.CommandLine,
        });
      }
      finish({ available: true, hosts });
    });
  });
}

/**
 * Probe one loopback port for a dsh host fingerprint.
 *
 * A dsh web host answers an unauthenticated request with 401 and the sentence
 * `dsh web authentication required; reopen the URL printed by dsh web.`; a
 * request that already carries a valid cookie is served the harness boot
 * payload instead. Anything else on the port is somebody else and is reported
 * as absent, so an unrelated app on 3080 is never mistaken for a conflict.
 * @param port - the loopback port to probe.
 * @param options - `timeoutMs` bounds the request.
 * @returns a promise of `{ port, isDshHost, status, detail }`.
 */
async function probeWebHost(port, { timeoutMs = 1500 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const cookie = response.headers.getSetCookie?.().join('; ') ?? response.headers.get('set-cookie') ?? '';
    if (/dsh-auth/iu.test(cookie)) return { port, isDshHost: true, status: response.status, detail: 'auth cookie challenge' };
    const body = await response.text();
    if (/dsh web authentication required/iu.test(body)) return { port, isDshHost: true, status: response.status, detail: 'auth challenge' };
    if (/__DSH_BOOT__/u.test(body)) return { port, isDshHost: true, status: response.status, detail: 'boot payload' };
    if (response.status === 404) return { port, isDshHost: false, status: response.status, detail: 'no harness route' };
    return { port, isDshHost: false, status: response.status, detail: 'unrecognised responder' };
  } catch {
    return { port, isDshHost: false, status: null, detail: 'no answer' };
  }
}

/**
 * Drop the shell's own service from a host list.
 *
 * The rule is deliberately narrow: only a process that is *this* shell's direct
 * child AND was launched through one of the shell's own dsh entry files is
 * dropped. Excluding every process that merely uses the same entry file would
 * hide a genuine second instance started from the same portable folder, and
 * excluding by pid alone would race with the spawn (the scan runs while that
 * service is starting up).
 * @param hosts - candidate hosts from {@link scanDshHosts}.
 * @param options - `excludePids` (extra pids to ignore), `ownPid`, `ownBinPaths` (the shell's dsh entry files).
 * @returns the hosts that are not this shell's own service.
 */
function selectOtherHosts(hosts, { excludePids = [], ownPid = process.pid, ownBinPaths = [] } = {}) {
  const excludedPids = new Set([ownPid, ...excludePids].filter((pid) => typeof pid === 'number' && pid > 0));
  const ownPaths = ownBinPaths.map((value) => String(value).toLowerCase()).filter(Boolean);
  return hosts.filter((host) => {
    if (excludedPids.has(host.pid)) return false;
    if (host.parentPid !== ownPid) return true;
    const commandLine = String(host.commandLine ?? '').toLowerCase();
    return !ownPaths.some((needle) => commandLine.includes(needle));
  });
}

/**
 * Run both signals and summarize the conflict state for one profile.
 *
 * @param options - `profile` to match, `excludePids`/`ownBinPaths` for this shell's own service, `probePorts` to fingerprint, `skipProbe` to disable the port signal.
 * @returns a promise of the detection result: `{ checked, scanAvailable, hosts, matching, probes, portConflicts, conflict, detail }`.
 */
async function detectProfileConflicts({ profile, excludePids = [], ownBinPaths = [], probePorts = [DEFAULT_WEB_PORT], skipProbe = false } = {}) {
  const scan = await scanDshHosts();
  const hosts = selectOtherHosts(scan.hosts, { excludePids, ownBinPaths });
  const matching = hosts.filter((host) => host.profile === profile);
  const otherProfile = hosts.filter((host) => host.profile !== profile);

  const probes = skipProbe ? [] : await Promise.all(probePorts.map((port) => probeWebHost(port)));
  const portConflicts = probes.filter((probe) => probe.isDshHost);

  const conflict = matching.length > 0 || portConflicts.length > 0;
  const evidence = [];
  // A process command line does not reveal another host's DSH_HOME, so the
  // process signal can only say "profile X is in use somewhere" — the wording
  // keeps that limit visible instead of overclaiming shared data.
  for (const host of matching) {
    evidence.push(`进程 pid=${String(host.pid)} 正在运行 profile「${String(host.profile)}」（若其 DSH_HOME 相同，则与本窗口共用同一份数据）`);
  }
  for (const probe of portConflicts) {
    evidence.push(`端口 ${String(probe.port)} 上有 dsh host 响应（${probe.detail}）；这是 dsh web 的默认端口`);
  }
  for (const host of otherProfile) evidence.push(`另有 pid=${String(host.pid)} 运行 profile「${String(host.profile)}」`);

  return {
    checked: true,
    scanAvailable: scan.available,
    scanError: scan.error ?? null,
    hosts,
    matching,
    otherProfile,
    probes,
    portConflicts,
    conflict,
    detail: evidence,
  };
}

module.exports = {
  DEFAULT_WEB_PORT,
  classifyDshHost,
  detectProfileConflicts,
  probeWebHost,
  scanDshHosts,
  selectOtherHosts,
  tokenize,
};
