#!/usr/bin/env node
'use strict';

// Node-only npm entrypoint. Bun is installed privately and checksum-verified on first use.
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { inflateRawSync } = require('node:zlib');
const { delimiter, join } = require('node:path');
const os = require('node:os');

const ROOT = join(__dirname, '..');
const ENTRY = join(__dirname, 'elanous.mjs');
const BUN_MIN = '1.3.5';
const IS_WIN = process.platform === 'win32';
const BUN_EXE = IS_WIN ? 'bun.exe' : 'bun';

function compareVersions(a, b) {
  const left = String(a).match(/\d+/g)?.map(Number) ?? [];
  const right = String(b).match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

function dataPrefix(env) {
  return env.ELANOUS_INSTALL_PREFIX?.trim()
    || join(env.XDG_DATA_HOME?.trim() || join(env.HOME || env.USERPROFILE || os.homedir(), '.local', 'share'), 'elanous');
}

function bunVersion(path) {
  try {
    const result = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.status !== 0) return null;
    const output = String(result.stdout || '').trim();
    const version = /^\d+\.\d+\.\d+$/.test(output) ? output : null;
    return version && compareVersions(version, BUN_MIN) >= 0 ? version : null;
  } catch { return null; }
}

function findBun(env, resolveNpmBun = () => {
  try { return require.resolve('bun/bin/bun.exe'); } catch { return null; }
}) {
  const prefix = dataPrefix(env);
  const candidates = [];
  if (env.ELANOUS_BUN) candidates.push(env.ELANOUS_BUN);
  candidates.push(join(prefix, 'bin', BUN_EXE));
  for (const dir of String(env.PATH || env.Path || '').split(delimiter)) if (dir) candidates.push(join(dir, BUN_EXE));
  candidates.push(join(env.BUN_INSTALL || join(env.HOME || env.USERPROFILE || os.homedir(), '.bun'), 'bin', BUN_EXE));
  const npmBun = resolveNpmBun();
  if (npmBun) candidates.push(npmBun);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try { if (existsSync(candidate) && bunVersion(candidate)) return candidate; } catch { /* try the next candidate */ }
  }
  return null;
}

function bunTarget(platform = process.platform, arch = process.arch) {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x64' : null;
  if (!cpu) throw new Error(`unsupported CPU architecture: ${arch}`);
  if (platform === 'darwin') return `darwin-${cpu}`;
  if (platform === 'win32') return `windows-${cpu}`;
  if (platform === 'linux') {
    const musl = existsSync('/etc/alpine-release') ? '-musl' : '';
    return `linux-${cpu}${musl}`;
  }
  throw new Error(`unsupported operating system: ${platform}`);
}

function archiveEntry(zip, wanted) {
  const min = Math.max(0, zip.length - 0xffff - 22);
  let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Bun archive has no ZIP directory');
  const entries = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Bun archive has a malformed ZIP directory');
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Bun archive entry is malformed');
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(start, start + compressedSize);
      const result = method === 0 ? Buffer.from(compressed)
        : method === 8 ? inflateRawSync(compressed)
          : (() => { throw new Error(`unsupported ZIP compression method: ${method}`); })();
      if (result.length !== size) throw new Error('Bun archive entry size mismatch');
      return result;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Bun archive is missing ${wanted}`);
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  const announcedSize = Number(response.headers.get('content-length') || 0);
  if (announcedSize > 128 * 1024 * 1024) throw new Error('official Bun download exceeds the 128 MiB safety limit');
  return Buffer.from(await response.arrayBuffer());
}

async function installBun(env = process.env) {
  const version = readFileSync(join(ROOT, '.bun-version'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version) || compareVersions(version, BUN_MIN) < 0) throw new Error('packaged Bun pin is invalid or below 1.3.5');
  const target = bunTarget();
  const archive = `bun-${target}.zip`;
  const release = `https://github.com/oven-sh/bun/releases/download/bun-v${version}`;
  const manifest = await download(`${release}/SHASUMS256.txt`);
  const line = manifest.toString('utf8').split(/\r?\n/).find((entry) => entry.trim().split(/\s+/).at(-1) === archive);
  const expected = line?.trim().split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error(`official Bun checksum is missing for ${archive}`);
  const zip = await download(`${release}/${archive}`);
  const actual = createHash('sha256').update(zip).digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`Bun SHA-256 mismatch: expected ${expected}, received ${actual}`);
  const executable = archiveEntry(zip, `bun-${target}/${BUN_EXE}`);
  const binDir = join(dataPrefix(env), 'bin');
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const destination = join(binDir, BUN_EXE);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, executable, { mode: 0o755, flag: 'wx' });
    if (IS_WIN && existsSync(destination)) rmSync(destination, { force: true });
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return destination;
}

function consentToInstall(env, args) {
  if (env.ELANOUS_INSTALL_YES === '1' || env.ELANOUS_INSTALL_YES === 'true' || args.includes('--yes')) return true;
  if (!process.stdin.isTTY || !process.stderr.isTTY || env.CI) return false;
  process.stderr.write(`Install official Bun ${readFileSync(join(ROOT, '.bun-version'), 'utf8').trim()} to ${join(dataPrefix(env), 'bin')}? [y/N] `);
  const input = Buffer.alloc(64);
  try {
    const size = require('node:fs').readSync(0, input, 0, input.length, null);
    return /^\s*y(?:es)?\s*$/i.test(input.toString('utf8', 0, size));
  } catch { return false; }
}

function markerPath(env) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const markerRoot = join(home, '.local', 'share', 'elanous');
  return join(markerRoot, `doctor-ok-${version}`);
}

function prefixMarkerPath(env) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  return join(dataPrefix(env), `bootstrap-ready-${version}`);
}

function invalidatePrefixReadiness(env) {
  try { rmSync(prefixMarkerPath(env), { force: true }); } catch { /* bootstrap will report write failures */ }
}

function shouldInvalidatePrefixReadiness(args, env) {
  return args[0] === 'bootstrap' || shouldAutoBootstrap(args, env);
}

function killChildTree(child, platform = process.platform, run = spawnSync, kill = process.kill) {
  // Known limit: if both Windows tree-kill tools are unavailable or blocked, Node can only kill the launcher process; see install.md.
  if (platform === 'win32' && child.pid) {
    let result;
    try { result = run('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); }
    catch { result = { error: true, status: 1 }; }
    if (result.error || result.status !== 0) {
      const script = `$ErrorActionPreference='Stop';$p=${Number(child.pid)};$all=Get-CimInstance Win32_Process;$ids=@($p);$front=@($p);while($front.Count){$next=@($all|Where-Object{$front -contains [int]$_.ParentProcessId}|ForEach-Object{[int]$_.ProcessId});$ids+= $next;$front=$next};[array]::Reverse($ids);foreach($id in $ids){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}`;
      let fallback;
      try { fallback = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); }
      catch { fallback = { error: true, status: 1 }; }
      if (fallback.error || fallback.status !== 0) try { child.kill('SIGKILL'); } catch { /* bounded timeout handles an unkillable process */ }
    }
  } else if (child.pid) {
    try { kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
  }
}

function spawnWithTimeout(file, args, options, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, { ...options, detached: process.platform !== 'win32' });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
    const signalHandlers = new Map();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);
      resolve(result);
    };
    const onSignal = (sig) => {
      const handler = () => {
        killChildTree(child);
        process.removeListener(sig, handler);
        try { process.kill(process.pid, sig); } catch { process.exit(128); }
      };
      signalHandlers.set(sig, handler);
      return handler;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { killChildTree(child); } catch { /* timeout still releases the caller */ }
      finally { finish({ error: null, status: null, signal: 'SIGKILL', timedOut: true }); }
    }, timeoutMs);
    for (const sig of signals) {
      try { process.on(sig, onSignal(sig)); } catch { /* unsupported signal */ }
    }
    child.once('error', (error) => finish({ error, status: null, signal: null, timedOut }));
    child.once('exit', (status, signal) => finish({ error: null, status, signal, timedOut }));
  });
}

function shouldAutoBootstrap(args, env, markerExists = existsSync) {
  return args[0] !== 'bootstrap'
    && !['--version', '-V'].includes(args[0])
    && env.ELANOUS_NO_AUTO_DOCTOR !== '1'
    && (!markerExists(markerPath(env)) || !markerExists(prefixMarkerPath(env)));
}

async function run(bun, args, env) {
  const childEnv = { ...env, ELANOUS_INSTALL_PREFIX: dataPrefix(env), PATH: `${join(dataPrefix(env), 'bin')}${delimiter}${env.PATH || ''}` };
  if (shouldAutoBootstrap(args, env)) {
    try {
      const bootstrap = await spawnWithTimeout(bun, [ENTRY, 'bootstrap'], { stdio: 'inherit', env: childEnv, windowsHide: true });
      if (bootstrap.error) process.stderr.write(`elanous: first-run bootstrap could not run: ${bootstrap.error.message}; retry with \`eln bootstrap\`.\n`);
      else if (bootstrap.timedOut) process.stderr.write('elanous: first-run bootstrap timed out after 10 minutes; retry with `eln bootstrap`.\n');
      else if (bootstrap.status !== 0) process.stderr.write(`elanous: first-run bootstrap exited ${bootstrap.status ?? bootstrap.signal}; retry with \`eln bootstrap\`.\n`);
    } catch (error) { process.stderr.write(`elanous: first-run bootstrap could not run: ${error.message}; retry with \`eln bootstrap\`.\n`); }
  }
  const child = spawn(bun, [ENTRY, ...args], { stdio: 'inherit', env: childEnv, windowsHide: true });
  try { process.on('SIGINT', () => {}); } catch { /* Windows */ }
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    try { process.on(sig, () => { try { child.kill(sig); } catch { /* already exited */ } }); } catch { /* unsupported signal */ }
  }
  child.on('error', (error) => {
    process.stderr.write(`elanous: Bun could not be started (${bun}): ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.removeAllListeners(sig);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code == null ? 1 : code);
  });
}

function packedVersion() {
  let version = 'unknown';
  let commit = 'unknown';
  try { version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || 'unknown'; } catch { /* do not invent */ }
  try { commit = JSON.parse(readFileSync(join(ROOT, 'src', 'version', 'packed-revision.json'), 'utf8')).commit || 'unknown'; } catch { /* no packaged revision */ }
  return `${version} ${commit}`;
}

async function main(args = process.argv.slice(2), env = process.env) {
  if (compareVersions(process.versions.node, '18.0.0') < 0) {
    process.stderr.write('elanous npm launcher requires Node.js >= 18.0.0 (global fetch is required).\n');
    process.exit(1);
  }
  if (shouldInvalidatePrefixReadiness(args, env)) invalidatePrefixReadiness(env);
  let bun = findBun(env);
  if (!bun && args.length === 1 && ['--version', '-V'].includes(args[0])) {
    process.stdout.write(`${packedVersion()}\n`);
    process.exit(0);
  }
  if (!bun) {
    if (!consentToInstall(env, args)) {
      process.stderr.write(`elanous needs Bun >= ${BUN_MIN}. To install it in ${join(dataPrefix(env), 'bin')}, run again interactively or set ELANOUS_INSTALL_YES=1.\n`);
      process.exit(1);
    }
    try { bun = await installBun(env); }
    catch (error) {
      process.stderr.write(`elanous: official Bun bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    if (!bunVersion(bun)) {
      process.stderr.write('elanous: installed Bun did not pass its version check.\n');
      process.exit(1);
    }
  }
  return run(bun, args, env);
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`elanous: launcher failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

module.exports = { archiveEntry, bunTarget, compareVersions, consentToInstall, dataPrefix, findBun, installBun, invalidatePrefixReadiness, killChildTree, main, markerPath, prefixMarkerPath, shouldAutoBootstrap, shouldInvalidatePrefixReadiness, spawnWithTimeout };
