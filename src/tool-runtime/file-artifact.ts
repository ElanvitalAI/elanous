import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Write a new, bounded file bundle and digest receipt. No commands are executed. */
export function writeFileArtifact(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.root !== 'string' || !isAbsolute(args.root)) throw new Error('root must be absolute');
  if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > 256) throw new Error('files are required');
  // Artifact transport budget, not a measured performance threshold.
  const maxBytes = 2 * 1024 * 1024;
  // OP #64386: bound path validation work before splitting/dirname loops.
  const maxPathBytes = 1024;
  const maxPathDepth = 16;
  const metadata = args.metadata ?? {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid metadata');
  const files = new Map<string, string>();
  let bytes = Buffer.byteLength(JSON.stringify(metadata));
  for (const item of args.files) {
    if (!item || typeof item !== 'object') throw new Error('invalid file');
    const { path, content } = item as Record<string, unknown>;
    if (typeof path !== 'string' || typeof content !== 'string' || path.includes('\\') || path.includes('\0') || isAbsolute(path)) throw new Error('invalid file');
    const pathBytes = Buffer.byteLength(path);
    if (pathBytes > maxPathBytes) throw new Error('file path exceeds byte limit');
    const parts = path.split('/');
    if (parts.length > maxPathDepth) throw new Error('file path exceeds depth limit');
    if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || files.has(path) || parts[0] === 'source-artifact.json') throw new Error('unsafe or duplicate file');
    files.set(path, content);
    bytes += pathBytes + Buffer.byteLength(content);
  }
  if (bytes > maxBytes) throw new Error('file artifact exceeds size limit');
  // Validate all paths before the first write, including file/directory prefix collisions.
  for (const name of files.keys()) {
    let parent = dirname(name);
    while (parent !== '.') {
      if (files.has(parent)) throw new Error('file conflicts with directory');
      parent = dirname(parent);
    }
  }
  const requested = resolve(args.root);
  const parent = realpathSync(dirname(requested));
  const appRoot = join(parent, basename(requested));
  mkdirSync(appRoot, { mode: 0o700 }); // Exclusive creation; never overwrite an existing app.
  const rootIdentity = lstatSync(appRoot);
  const assertRoot = (): void => {
    const now = lstatSync(appRoot);
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== rootIdentity.dev || now.ino !== rootIdentity.ino) throw new Error('app directory identity changed');
  };
  const hashes: Record<string, string> = Object.create(null);
  for (const [name, content] of files) {
    assertRoot();
    let directory = appRoot;
    for (const segment of name.split('/').slice(0, -1)) {
      directory = join(directory, segment);
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('unsafe app directory');
    }
    writeFileSync(join(appRoot, name), content, { flag: 'wx', mode: 0o600 });
    hashes[name] = createHash('sha256').update(content).digest('hex');
  }
  const artifact = { schemaVersion: 'source-artifact@1', root: appRoot, files: hashes, metadata, executed: false, published: false };
  assertRoot();
  writeFileSync(join(appRoot, 'source-artifact.json'), JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return artifact;
}
