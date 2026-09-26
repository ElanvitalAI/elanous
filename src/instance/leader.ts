// Installed execution detection and Nexus refusal diagnostics (no leader-tree authority).
import { INSTALLED_PACKAGE_MARKERS, isInstalledPackagePath } from './installed-package.js';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface LeaderRefusalRecord {
  refusedAt: string;
  selfTree: string;
  /** Retained for compatibility with earlier refusal records; never authoritative. */
  leaderTree: string;
  root: string;
  depth: number;
  why: string;
}

export function leaderRefusalFilePath(): string {
  return join(homedir(), '.elanous', 'leader-refusal.json');
}

export function readLeaderRefusal(path = leaderRefusalFilePath()): LeaderRefusalRecord | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LeaderRefusalRecord>;
    if (!raw || typeof raw !== 'object') return null;
    const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (!str(raw.refusedAt) || !str(raw.why) || !str(raw.selfTree) || !str(raw.root)) return null;
    if (typeof raw.leaderTree !== 'string') return null;
    if (typeof raw.depth !== 'number' || !Number.isInteger(raw.depth) || raw.depth < 0) return null;
    return raw as LeaderRefusalRecord;
  } catch { return null; }
}

export function writeLeaderRefusal(rec: LeaderRefusalRecord): void {
  try {
    const p = leaderRefusalFilePath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(tmp, p);
  } catch { /* diagnostic failure must not prevent refusal */ }
}

export function clearLeaderRefusal(): void {
  try {
    const p = leaderRefusalFilePath();
    if (existsSync(p)) unlinkSync(p);
  } catch { /* diagnostic only */ }
}

export function normalizeTree(p: string): string {
  const abs = resolve(p.trim().replace(/\/+$/, ''));
  try { return realpathSync(abs); } catch { return abs; }
}

export function treeFromScriptPath(scriptPath: string): string | null {
  let dir = dirname(normalizeTree(scriptPath));
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function installedCopyRoot(scriptPath: string): string | null {
  const normalized = normalizeTree(scriptPath).replace(/\\/g, '/');
  const marker = INSTALLED_PACKAGE_MARKERS.find((m) => normalized.includes(`${m}/`));
  if (!marker || treeFromScriptPath(scriptPath) !== null) return null;
  const at = normalized.indexOf(`${marker}/`);
  return normalized.slice(0, at + marker.length);
}

export function isInstalledCopyScript(argv1 = process.argv[1] ?? ''): boolean {
  if (!argv1) return false;
  try {
    const real = realpathSync(argv1).replace(/\\/g, '/');
    return isInstalledPackagePath(real) && treeFromScriptPath(real) === null;
  } catch { return false; }
}

export function resolveSelfTree(argv1 = process.argv[1] ?? '', cwd = process.cwd()): string {
  return (argv1 ? treeFromScriptPath(argv1) : null) ?? treeFromScriptPath(join(cwd, 'x')) ?? normalizeTree(cwd);
}
