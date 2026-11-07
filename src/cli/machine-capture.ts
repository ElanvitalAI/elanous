import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { closeSync, fchmodSync, fstatSync, fsyncSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Command } from 'commander';

const MAX_PACKAGE_ROWS = 2_000;
const MAX_TAP_ROWS = 500;
const MAX_FONT_ROWS = 2_000;
const MAX_DOTFILE_BYTES = 2 * 1024 * 1024;
// Darwin exposes O_NOFOLLOW_ANY in sys/fcntl.h but Node does not export it in fs.constants.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const DOTFILE_ALLOWLIST = [
  '.zshrc',
  '.zprofile',
  '.p10k.zsh',
  '.gitconfig',
  '.config/ghostty/config',
  '.vimrc',
  '.config/nvim/init.lua',
  '.config/nvim/init.vim',
  '.config/yazi/yazi.toml',
] as const;
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.dfont']);

export interface MachineCapture {
  readonly schemaVersion: 1;
  readonly kind: 'machine-capture';
  readonly capturedAt: string;
  readonly platform: string;
  readonly architecture: string;
  readonly packages: {
    readonly manager: 'homebrew' | null;
    readonly status: 'captured' | 'unavailable' | 'failed' | 'unsupported-platform';
    readonly formulaeStatus: 'captured' | 'unavailable' | 'failed' | 'unsupported-platform';
    readonly casksStatus: 'captured' | 'unavailable' | 'failed' | 'unsupported-platform';
    readonly tapsStatus: 'captured' | 'unavailable' | 'failed' | 'unsupported-platform';
    readonly formulaeFailureClass?: 'command-unavailable' | 'untrusted-tap' | 'command-failed';
    readonly casksFailureClass?: 'command-unavailable' | 'untrusted-tap' | 'command-failed';
    readonly tapsFailureClass?: 'command-unavailable' | 'untrusted-tap' | 'command-failed';
    readonly taps: readonly string[];
    readonly formulae: readonly { readonly name: string; readonly version?: string }[];
    readonly casks: readonly { readonly name: string; readonly version?: string }[];
    readonly omittedRows: number;
  };
  readonly dotfiles: readonly {
    readonly path: string;
    readonly status: 'hashed' | 'missing' | 'not-regular' | 'too-large' | 'unreadable';
    readonly sha256?: string;
  }[];
  readonly fonts: {
    readonly status: 'captured' | 'partial' | 'unavailable' | 'unsupported-platform';
    readonly names: readonly { readonly name: string; readonly scope: 'user' | 'library' | 'system' }[];
    readonly omittedRows: number;
    readonly unreadableDirectories: number;
  };
  readonly scope: readonly string[];
}

export interface MachineCaptureDeps {
  readonly platform?: string;
  readonly architecture?: string;
  readonly home?: string;
  readonly path?: string;
  readonly now?: () => Date;
}

function parseBrewRows(stdout: string): { rows: { name: string; version?: string }[]; omittedRows: number } {
  const rows: { name: string; version?: string }[] = [];
  let omittedRows = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, ...version] = trimmed.split(/\s+/);
    if (!name || !/^(?:[A-Za-z0-9][A-Za-z0-9@+._-]*\/){0,2}[A-Za-z0-9][A-Za-z0-9@+._-]*$/.test(name)
      || version.some((part) => !/^[A-Za-z0-9@+.,_-]+$/.test(part))) {
      omittedRows += 1;
      continue;
    }
    if (rows.length >= MAX_PACKAGE_ROWS) {
      omittedRows += 1;
      continue;
    }
    rows.push({ name, ...(version.length ? { version: version.join(' ') } : {}) });
  }
  return { rows, omittedRows };
}

function readBrewRows(args: readonly string[], pathValue: string, home: string): {
  status: 'captured' | 'unavailable' | 'failed';
  failureClass?: 'command-unavailable' | 'untrusted-tap' | 'command-failed';
  rows: { name: string; version?: string }[];
  omittedRows: number;
} {
  const result = spawnSync('brew', [...args], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    env: { PATH: pathValue, HOME: home },
  });
  if (result.error) {
    const unavailable = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      status: unavailable ? 'unavailable' : 'failed',
      failureClass: unavailable ? 'command-unavailable' : 'command-failed',
      rows: [],
      omittedRows: 0,
    };
  }
  if (result.status !== 0) {
    return {
      status: 'failed',
      failureClass: result.stderr.toLowerCase().includes('untrusted tap') ? 'untrusted-tap' : 'command-failed',
      rows: [],
      omittedRows: 0,
    };
  }
  return { status: 'captured', ...parseBrewRows(result.stdout) };
}

function readBrewTaps(pathValue: string, home: string): {
  status: 'captured' | 'unavailable' | 'failed';
  failureClass?: 'command-unavailable' | 'untrusted-tap' | 'command-failed';
  taps: string[];
} {
  const result = spawnSync('brew', ['tap'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { PATH: pathValue, HOME: home },
  });
  if (result.error) {
    const unavailable = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    return { status: unavailable ? 'unavailable' : 'failed', failureClass: unavailable ? 'command-unavailable' : 'command-failed', taps: [] };
  }
  if (result.status !== 0) {
    return { status: 'failed', failureClass: result.stderr.toLowerCase().includes('untrusted tap') ? 'untrusted-tap' : 'command-failed', taps: [] };
  }
  const taps: string[] = [];
  let invalid = false;
  for (const line of result.stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
      invalid = true;
      continue;
    }
    if (!taps.includes(value)) taps.push(value);
    if (taps.length > MAX_TAP_ROWS) invalid = true;
  }
  // A malformed row must never turn a partial tap list into a captured empty inventory.
  return invalid
    ? { status: 'failed', failureClass: 'command-failed', taps: [] }
    : { status: 'captured', taps: taps.sort() };
}

function captureDotfiles(home: string): MachineCapture['dotfiles'] {
  const homeRoot = realpathSync(home);
  return DOTFILE_ALLOWLIST.map((path) => {
    const absolutePath = join(home, path);
    let fd: number | undefined;
    try {
      const resolvedPath = realpathSync(absolutePath);
      if (!isPathWithin(homeRoot, resolvedPath)) {
        return { path, status: 'not-regular' as const };
      }
      const relativeTarget = relative(homeRoot, resolvedPath);
      const safePath = join(homeRoot, relativeTarget);
      const openFlags = constants.O_RDONLY | constants.O_NONBLOCK
        | (process.platform === 'darwin' ? DARWIN_O_NOFOLLOW_ANY : constants.O_NOFOLLOW);
      fd = openSync(safePath, openFlags);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { path, status: 'not-regular' as const };
      if (stat.size > MAX_DOTFILE_BYTES) return { path, status: 'too-large' as const };
      if (process.platform !== 'darwin') {
        const descriptorPath = realpathSync(`/proc/self/fd/${fd}`);
        if (!isPathWithin(homeRoot, descriptorPath)) return { path, status: 'not-regular' as const };
      }
      const hash = createHash('sha256');
      let bytesReadTotal = 0;
      while (bytesReadTotal <= MAX_DOTFILE_BYTES) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_DOTFILE_BYTES + 1 - bytesReadTotal));
        const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        bytesReadTotal += bytesRead;
        if (bytesReadTotal > MAX_DOTFILE_BYTES) return { path, status: 'too-large' as const };
        hash.update(buffer.subarray(0, bytesRead));
      }
      const sha256 = hash.digest('hex');
      return { path, status: 'hashed' as const, sha256 };
    } catch (error) {
      return { path, status: isMissing(error) ? 'missing' as const : 'unreadable' as const };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* The capture result already records read failures. */ }
      }
    }
  });
}

function isPathWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function captureFonts(platform: string, home: string): MachineCapture['fonts'] {
  if (platform !== 'darwin') return { status: 'unsupported-platform', names: [], omittedRows: 0, unreadableDirectories: 0 };
  const names: { name: string; scope: 'user' | 'library' | 'system' }[] = [];
  let omittedRows = 0;
  let unreadableDirectories = 0;
  let sawReadableDirectory = false;
  const directories: { path: string; scope: 'user' | 'library' | 'system' }[] = [
    { path: join(home, 'Library/Fonts'), scope: 'user' },
    { path: '/Library/Fonts', scope: 'library' },
    { path: '/System/Library/Fonts', scope: 'system' },
  ];
  const scan = (directory: string, scope: 'user' | 'library' | 'system', depth: number): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
      sawReadableDirectory = true;
    } catch (error) {
      if (!isMissing(error)) unreadableDirectories += 1;
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 5) {
        scan(join(directory, entry.name), scope, depth + 1);
        continue;
      }
      if (entry.isDirectory()) {
        omittedRows += 1;
        continue;
      }
      const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !FONT_EXTENSIONS.has(extension)) continue;
      if (names.length >= MAX_FONT_ROWS) {
        omittedRows += 1;
        continue;
      }
      names.push({ name: entry.name, scope });
    }
  };
  for (const directory of directories) scan(directory.path, directory.scope, 0);
  return {
    status: !sawReadableDirectory ? 'unavailable' : unreadableDirectories > 0 || omittedRows > 0 ? 'partial' : 'captured',
    names: names.sort((left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope)),
    omittedRows,
    unreadableDirectories,
  };
}

export function captureMachineProfile(deps: MachineCaptureDeps = {}): MachineCapture {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const brewSupported = platform === 'darwin' || platform === 'linux';
  const formulae = brewSupported
    ? readBrewRows(['list', '--formula', '--full-name', '--versions'], deps.path ?? process.env.PATH ?? '', home)
    : { status: 'unsupported-platform' as const, failureClass: undefined, rows: [], omittedRows: 0 };
  const casks = brewSupported
    ? readBrewRows(['list', '--cask', '--full-name', '--versions'], deps.path ?? process.env.PATH ?? '', home)
    : { status: 'unsupported-platform' as const, failureClass: undefined, rows: [], omittedRows: 0 };
  const taps = brewSupported
    ? readBrewTaps(deps.path ?? process.env.PATH ?? '', home)
    : { status: 'unsupported-platform' as const, failureClass: undefined, taps: [] };
  const packageStatus = formulae.status === 'failed' || casks.status === 'failed' || taps.status === 'failed'
    ? 'failed'
    : formulae.status === 'captured'
      ? 'captured'
      : formulae.status === 'unavailable'
        ? 'unavailable'
        : 'unsupported-platform';

  return {
    schemaVersion: 1,
    kind: 'machine-capture',
    capturedAt: (deps.now ?? (() => new Date()))().toISOString(),
    platform,
    architecture: deps.architecture ?? process.arch,
    packages: {
      manager: brewSupported ? 'homebrew' : null,
      status: packageStatus,
      formulaeStatus: formulae.status,
      casksStatus: casks.status,
      tapsStatus: taps.status,
      ...(formulae.failureClass ? { formulaeFailureClass: formulae.failureClass } : {}),
      ...(casks.failureClass ? { casksFailureClass: casks.failureClass } : {}),
      ...(taps.failureClass ? { tapsFailureClass: taps.failureClass } : {}),
      formulae: formulae.rows,
      casks: casks.rows,
      taps: taps.taps,
      omittedRows: formulae.omittedRows + casks.omittedRows,
    },
    dotfiles: captureDotfiles(home),
    fonts: captureFonts(platform, home),
    scope: [
      ...(brewSupported ? ['Homebrew formulae, casks, and tapped repositories'] : []),
      ...(platform === 'darwin' ? ['font filenames'] : []),
      'allowlisted dotfile hashes',
    ],
  };
}

export interface MachineCaptureCliDeps {
  readonly out?: { log(value: string): void };
  readonly err?: { error(value: string): void };
  readonly setExitCode?: (code: number) => void;
  readonly capture?: () => MachineCapture;
}

export function registerMachineCaptureCommand(command: Command, deps: MachineCaptureCliDeps = {}): void {
  const out = deps.out ?? { log: (value: string) => console.log(value) };
  const err = deps.err ?? { error: (value: string) => console.error(value) };
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  command
    .option('--out <file>', 'write the profile to a new private JSON file instead of stdout')
    .action((opts: { out?: string }) => {
      let profile: MachineCapture;
      try {
        profile = (deps.capture ?? captureMachineProfile)();
      } catch {
        err.error('machine capture failed; no profile was written');
        setExitCode(1);
        return;
      }
      const serialized = `${JSON.stringify(profile, null, 2)}\n`;
      if (!opts.out) {
        out.log(serialized.trimEnd());
        return;
      }
      try {
        const outputPath = resolve(opts.out);
        let fd: number | undefined;
        try {
          fd = openSync(outputPath, 'wx', 0o600);
          fchmodSync(fd, 0o600);
          writeFileSync(fd, serialized, { encoding: 'utf8' });
          fsyncSync(fd);
          closeSync(fd);
          fd = undefined;
        } catch (error) {
          if (fd !== undefined) {
            try { closeSync(fd); } catch { /* Keep handling the original write failure. */ }
          }
          throw error;
        }
        out.log('machine profile captured');
      } catch {
        err.error('machine capture could not write the output file; partial output may remain and existing files are never overwritten');
        setExitCode(1);
      }
    });
}
