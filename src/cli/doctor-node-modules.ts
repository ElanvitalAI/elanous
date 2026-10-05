import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';

export interface NodeModulesCheck {
  dir: string;
  status: 'ok' | 'issues' | 'unreadable';
  missing: string[];
  mismatch: { name: string; expected: string; actual: string }[];
  borrowed: { target: string; tree: string } | null;
  reason?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function dependencyNames(pkg: Record<string, unknown>): string[] {
  if (!record(pkg.dependencies ?? {}) || !record(pkg.devDependencies ?? {})) throw new Error('invalid package.json dependencies');
  return [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])].sort();
}

interface LockContext { lockRoot: string; workspace: Record<string, unknown>; packages: Record<string, unknown>; scope: string | null }

/** Own bun.lock first; otherwise the nearest ancestor bun.lock whose workspaces list this folder (root-lock Bun workspaces). */
function findLock(root: string, packageName: string | null): LockContext {
  let current = root;
  for (;;) {
    let text: string | null = null;
    try { text = readFileSync(join(current, 'bun.lock'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (text !== null) {
      const lock = Bun.JSONC.parse(text) as unknown;
      if (!record(lock) || !record(lock.packages) || !record(lock.workspaces)) throw new Error('invalid bun.lock');
      const key = relative(current, root).split(sep).join('/');
      const workspace = lock.workspaces[key];
      if (record(workspace)) return { lockRoot: current, workspace, packages: lock.packages, scope: key === '' ? null : (packageName ?? key) };
      if (key === '') throw new Error('invalid bun.lock');
      throw new Error(`bun.lock at ${current} does not list workspace ${key}`);
    }
    const parent = dirname(current);
    if (parent === current) throw new Error('no bun.lock in this folder or any parent workspace root');
    current = parent;
  }
}

function lockedVersion(packages: Record<string, unknown>, name: string, scope: string | null = null): string {
  // Bun keys a workspace-specific resolution as «<workspace>/<dep>» when it differs from the hoisted one.
  const scoped = scope ? packages[`${scope}/${name}`] : undefined;
  const entry = Array.isArray(scoped) ? scoped : packages[name];
  if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0].startsWith(`${name}@`) || entry[0].length <= name.length + 1) {
    throw new Error(`bun.lock has no resolved version for ${name}`);
  }
  return entry[0].slice(name.length + 1);
}

export function checkNodeModules(dir: string): NodeModulesCheck {
  const root = resolve(dir);
  const result: NodeModulesCheck = { dir: root, status: 'ok', missing: [], mismatch: [], borrowed: null };
  try {
    const pkg = loadJson(join(root, 'package.json'));
    if (!record(pkg)) throw new Error('invalid package.json');
    const names = dependencyNames(pkg);
    const lock = findLock(root, typeof pkg.name === 'string' ? pkg.name : null);
    const declared = dependencyNames(lock.workspace);
    for (const name of names) {
      if (!declared.includes(name)) throw new Error(`bun.lock does not declare ${name}`);
    }
    const versions = new Map(names.map((name) => [name, lockedVersion(lock.packages, name, lock.scope)]));
    // A workspace without its own node_modules resolves hoisted packages from the lock root.
    const own = join(root, 'node_modules');
    const modules = lock.lockRoot !== root && !lstatSync(own, { throwIfNoEntry: false }) ? join(lock.lockRoot, 'node_modules') : own;
    try {
      const entry = lstatSync(modules);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(modules);
        if (!lstatSync(target).isDirectory()) throw new Error('node_modules symlink target is not a directory');
        result.borrowed = { target, tree: dirname(target) };
      } else if (!entry.isDirectory()) {
        throw new Error('node_modules is not a directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink has a different cause from an absent node_modules directory.
      if (lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('node_modules symlink target is missing');
      result.missing.push(...names);
      if (names.length) result.status = 'issues';
      return result;
    }
    for (const name of names) {
      let installed: unknown;
      const candidates = [...new Set([modules, join(lock.lockRoot, 'node_modules')])];
      for (const base of candidates) {
        try {
          installed = loadJson(join(base, name, 'package.json'));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (installed === undefined) {
        result.missing.push(name);
        continue;
      }
      if (!record(installed) || typeof installed.version !== 'string') throw new Error(`invalid node_modules/${name}/package.json`);
      const expected = versions.get(name)!;
      if (installed.version !== expected) result.mismatch.push({ name, expected, actual: installed.version });
    }
    if (result.missing.length || result.mismatch.length) result.status = 'issues';
  } catch (error) {
    result.status = 'unreadable';
    result.reason = error instanceof Error ? error.message : String(error);
  } finally {
    debug.log('doctor.node-modules', 'checked', { dir: root, missing: result.missing, mismatch: result.mismatch, borrowed: result.borrowed });
  }
  return result;
}

export function nodeModulesTrees(dir: string): string[] {
  const root = resolve(dir);
  const found = [root];
  const skip = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.elanous-test']);
  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || skip.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = join(current, entry.name);
      const children = readdirSync(child);
      if (children.includes('package.json')) found.push(child);
      visit(child);
    }
  }
  visit(root);
  return found;
}

export function formatNodeModulesCheck(result: NodeModulesCheck): string {
  const lines = [`${result.dir}: ${result.status === 'ok' ? '정상' : result.status === 'unreadable' ? '못 읽음' : '결손'}`];
  if (result.borrowed) lines.push(`  빌린 트리: ${result.borrowed.tree} (node_modules → ${result.borrowed.target})`);
  if (result.missing.length) lines.push(`  빠짐 ${result.missing.length}: ${result.missing.join(', ')}`);
  if (result.mismatch.length) lines.push(`  버전 다름 ${result.mismatch.length}: ${result.mismatch.map(({ name, expected, actual }) => `${name} (${actual} != ${expected})`).join(', ')}`);
  if (result.reason) lines.push(`  이유: ${result.reason}`);
  return lines.join('\n');
}
