import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';

const BLOCK = 512;
const EXCLUDED = new Set(['.git', 'node_modules', '.DS_Store']);
const excluded = (name: string) => EXCLUDED.has(name) || name.startsWith('.env');

type Entry = { path: string; source: string; executable: boolean };

function tarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let slash = path.lastIndexOf('/', path.length - 2); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`tar path exceeds ustar limits: ${path}`);
}

function text(header: Buffer, offset: number, width: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > width) throw new Error(`tar field exceeds ${width} bytes: ${value}`);
  bytes.copy(header, offset);
}

function octal(header: Buffer, offset: number, width: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value.toString(8).length > width - 1) {
    throw new Error(`tar numeric field exceeds ${width} bytes: ${value}`);
  }
  text(header, offset, width, value.toString(8).padStart(width - 1, '0'));
}

function headerFor(entry: Entry, size: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  const { name, prefix } = tarPath(entry.path);
  text(header, 0, 100, name);
  octal(header, 100, 8, entry.executable ? 0o755 : 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  text(header, 156, 1, '0');
  text(header, 257, 6, 'ustar');
  text(header, 263, 2, '00');
  text(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  text(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

/** Pack a directory as a reproducible ustar gzip archive; archive paths are relative to its root. */
export function packDirDeterministic(dir: string, opts?: {
  exclude?: RegExp;
  extraDirs?: ReadonlyArray<{ from: string; as: string }>;
}): Uint8Array {
  const root = lstatSync(dir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`not a directory: ${dir}`);
  const entries: Entry[] = [];
  function walk(source: string, relative: string, normalizeSkill?: string): void {
    for (const name of readdirSync(source)) {
      if (excluded(name)) continue;
      const path = relative ? `${relative}/${name}` : name;
      if (opts?.exclude) {
        opts.exclude.lastIndex = 0;
        if (opts.exclude.test(path)) continue;
      }
      const child = join(source, name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error(`cannot pack symbolic link: ${path}`);
      if (stat.isDirectory()) {
        walk(child, path);
      } else if (stat.isFile()) {
        // Compare real directory entries: on a case-insensitive disk (macOS) existsSync('SKILL.md') is true for skill.md.
        const archivePath = normalizeSkill && name === 'skill.md' && relative === normalizeSkill &&
          !readdirSync(source).includes('SKILL.md') ? `${relative}/SKILL.md` : path;
        entries.push({ path: archivePath, source: child, executable: (stat.mode & 0o111) !== 0 });
      } else {
        throw new Error(`cannot pack non-regular file: ${path}`);
      }
    }
  }
  walk(dir, '');
  const destinations: string[] = [];
  for (const { from, as } of opts?.extraDirs ?? []) {
    if (!as || posix.isAbsolute(as) || as.split('/').some(part => !part || part === '.' || part === '..' || excluded(part)) || as.includes('\\')) {
      throw new Error(`bundle-conflict: invalid destination ${as}`);
    }
    if (destinations.some(path => as === path || as.startsWith(`${path}/`) || path.startsWith(`${as}/`)) ||
        existsSync(join(dir, ...as.split('/'))) ||
        entries.some(entry => entry.path === as || entry.path.startsWith(`${as}/`) || as.startsWith(`${entry.path}/`))) {
      throw new Error(`bundle-conflict: ${as}`);
    }
    const stat = lstatSync(from);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`not a directory or file: ${from}`);
    destinations.push(as);
    // A single file (e.g. a graph declaration) lands at exactly `as`.
    if (stat.isFile()) entries.push({ path: as, source: from, executable: (stat.mode & 0o111) !== 0 });
    else walk(from, as, as);
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]?.path === entries[i - 1]?.path) throw new Error(`bundle-conflict: ${entries[i]?.path}`);
  }
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = readFileSync(entry.source);
    blocks.push(headerFor(entry, contents.length));
    if (contents.length) {
      blocks.push(contents);
      const padding = (BLOCK - (contents.length % BLOCK)) % BLOCK;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  const gzip = gzipSync(Buffer.concat(blocks));
  gzip.fill(0, 4, 8);
  gzip[9] = 255;
  return gzip;
}
