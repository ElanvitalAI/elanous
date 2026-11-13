import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';

export type SweepMode = 'light' | 'heavy';
export type CleanupKind = 'scratch' | 'cache' | 'log';
export type Candidate = { path: string; kind: CleanupKind; ageHours: number; reason: string };
export type Receipt = {
  host: string; mode: SweepMode; at: string; apply: boolean;
  before: { availableKb: number | null; inodeAvailable: number | null; worktrees: number | null; branches: number | null; dockerImages: number | null; dockerVolumes: number | null; candidates: number };
  after: { candidates: number; quarantined: number };
  candidates: Candidate[]; quarantined: string[]; skipped: string[];
};

const marker = '.elanous-sanitize-owned';
const markerVersion = 'machine-sanitize-v1';
const pathOccupied = (path: string): boolean => {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};
const syncDirectory = (path: string): void => {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
const namePattern = /^elanous-sanitize-[A-Za-z0-9_-]+$/;
const explicitKindPattern = /^elanous-sanitize-(scratch|cache|log)-[A-Za-z0-9_-]+$/;
const kindOf = (name: string): CleanupKind =>
  (name.match(explicitKindPattern)?.[1] as CleanupKind | undefined) ?? 'scratch';
const protectedName = /(?:^|[-_.])(claims?|cred[^-_.]*|evidences?|secrets?|prs?)(?:[-_.]|$)/i;
const safeRoot = (rootInput: string): string => {
  const root = resolve(rootInput);
  let current = root;
  while (current !== parse(current).root) {
    if (protectedName.test(basename(current))) throw new Error('refusing a protected scratch root or ancestor');
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('scratch root or ancestor must be a real directory');
    current = dirname(current);
  }
  if (root === '/' || root === realpathSync(tmpdir())) throw new Error('refusing a global scratch root');
  return root;
};
const activePid = (pid: unknown): boolean => {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return true;
  try { process.kill(pid as number, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
const safeCandidate = (path: string, kind: CleanupKind): boolean => {
  try {
    const info = JSON.parse(readFileSync(join(path, marker), 'utf8')) as { kind?: string; pid?: number };
    if (info.kind !== kind || activePid(info.pid)) return false;
    const pending = [path];
    let visited = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      for (const name of readdirSync(directory)) {
        if (++visited > 10_000 || protectedName.test(name) || name === '.git' || name === '.gitdir') return false;
        const entry = lstatSync(join(directory, name));
        if (entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) pending.push(join(directory, name));
      }
    }
    return true;
  } catch { return false; }
};
const safeRun = (command: string, args: string[]): string | null => {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
};
const countLines = (value: string | null): number | null => value === null ? null : value.trim() ? value.trim().split('\n').length : 0;
const filesystemNumbers = (root: string): { availableKb: number | null; inodeAvailable: number | null } => {
  const disk = safeRun('df', ['-Pk', root]);
  const inode = safeRun('df', ['-Pi', root]);
  const value = (output: string | null, column: number): number | null => {
    const row = output?.trim().split('\n').at(-1)?.trim().split(/\s+/);
    const parsed = Number(row?.[column]);
    return row && Number.isFinite(parsed) ? parsed : null;
  };
  return { availableKb: value(disk, 3), inodeAvailable: value(inode, 3) };
};

export function sweep(rootInput: string, mode: SweepMode, apply: boolean, now = new Date(), minAgeHours = 24): Receipt {
  if (apply) throw new Error('apply is deferred to the receipt-safe sanitation child');
  const root = safeRoot(rootInput);
  if (!existsSync(join(root, marker)) || !lstatSync(join(root, marker)).isFile() || readFileSync(join(root, marker), 'utf8').trim() !== markerVersion) throw new Error('scratch root lacks valid ownership marker');
  const candidates: Candidate[] = [];
  const skipped: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === '.quarantine' || name === marker) continue;
    const path = join(root, name);
    const entry = lstatSync(path);
    if (!namePattern.test(name) || protectedName.test(name) || entry.isSymbolicLink() || !entry.isDirectory()) { skipped.push(name); continue; }
    const kind = kindOf(name);
    if (mode === 'light' && kind !== 'scratch') { skipped.push(name); continue; }
    const owned = join(path, marker);
    if (!existsSync(owned) || !lstatSync(owned).isFile() || !safeCandidate(path, kind)) { skipped.push(name); continue; }
    const ageHours = (now.getTime() - entry.mtimeMs) / 3_600_000;
    if (ageHours < minAgeHours) { skipped.push(name); continue; }
    candidates.push({ path, kind, ageHours: Math.floor(ageHours), reason: `owned ${kind} directory older than threshold` });
  }
  const fsNumbers = filesystemNumbers(root);
  const worktrees = countLines(safeRun('git', ['worktree', 'list', '--porcelain'])?.match(/^worktree /gm)?.join('\n') ?? null);
  const branches = countLines(safeRun('git', ['branch', '--list']));
  const dockerImages = countLines(safeRun('docker', ['image', 'ls', '-q']));
  const dockerVolumes = countLines(safeRun('docker', ['volume', 'ls', '-q']));
  return { host: hostname(), mode, at: now.toISOString(), apply: false,
    before: { ...fsNumbers, worktrees, branches, dockerImages, dockerVolumes, candidates: candidates.length },
    after: { candidates: candidates.length, quarantined: 0 },
    candidates, quarantined: [], skipped };
}

// A manual, individually approved command only. The scheduled graph calls sweep(), which refuses apply.
// A durable prepared receipt remains readable if any move or final publication fails.
export function manualApply(rootInput: string, mode: SweepMode, receiptPath: string, approvalRef: string, now = new Date(), afterMove?: () => void): Receipt {
  if (!/^[A-Za-z0-9#][-A-Za-z0-9#]{3,99}$/.test(approvalRef)) throw new Error('manual apply requires an approval reference');
  const root = safeRoot(rootInput);
  if (resolve(dirname(receiptPath)) !== root || basename(receiptPath).startsWith('.')) throw new Error('receipt must be a visible new file in the owned root');
  const rootInfo = lstatSync(root);
  if ((rootInfo.mode & 0o077) !== 0 || rootInfo.uid !== process.getuid?.()) throw new Error('manual apply requires a private owned root');
  const preview = sweep(root, mode, false, now);
  const quarantine = join(root, '.quarantine');
  if (pathOccupied(quarantine)) {
    const info = lstatSync(quarantine);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('quarantine must be a private owned directory');
  }
  const snapshots = preview.candidates.map(candidate => lstatSync(candidate.path));
  const planned = preview.candidates.map((candidate, index) => ({
    source: candidate.path,
    target: join(quarantine, `${basename(candidate.path)}-${now.getTime()}-${index}`),
    kind: candidate.kind,
  }));
  for (const row of planned) if (pathOccupied(row.target)) throw new Error('quarantine destination already exists');
  const prepared = { phase: 'prepared', approvalRef, at: now.toISOString(), host: hostname(), root, mode, planned };
  const fd = openSync(receiptPath, 'wx', 0o600);
  let preparedPublished = false;
  try { writeFileSync(fd, JSON.stringify(prepared, null, 2) + '\n'); fsyncSync(fd); preparedPublished = true; }
  finally { closeSync(fd); if (!preparedPublished) unlinkSync(receiptPath); }
  syncDirectory(root);
  if (!pathOccupied(quarantine)) mkdirSync(quarantine, { mode: 0o700 });
  syncDirectory(root);
  const moved: string[] = [];
  for (const [index, row] of planned.entries()) {
    const current = lstatSync(row.source);
    const original = snapshots[index]!;
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || current.mtimeMs !== original.mtimeMs || (now.getTime() - current.mtimeMs) < 24 * 3_600_000 || !safeCandidate(row.source, row.kind)) throw new Error('candidate changed after preparation; inspect prepared receipt');
    if (pathOccupied(row.target)) throw new Error('quarantine destination appeared; inspect prepared receipt');
    renameSync(row.source, row.target);
    moved.push(row.target);
    afterMove?.();
  }
  // The final receipt must never outlive an unsynced directory move. Both the
  // removed source entry and added quarantine entry need durable directory metadata.
  syncDirectory(quarantine);
  syncDirectory(root);
  const receipt: Receipt = { ...preview, apply: true, quarantined: moved,
    after: { candidates: preview.before.candidates - moved.length, quarantined: moved.length } };
  const finalPath = `${receiptPath}.final-${process.pid}`;
  const finalFd = openSync(finalPath, 'wx', 0o600);
  try { writeFileSync(finalFd, JSON.stringify({ phase: 'final', approvalRef, receipt }, null, 2) + '\n'); fsyncSync(finalFd); }
  finally { closeSync(finalFd); }
  renameSync(finalPath, receiptPath);
  syncDirectory(root);
  return receipt;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const root = get('--root');
  const mode = get('--mode');
  if (!root || (mode !== 'light' && mode !== 'heavy')) {
    process.stderr.write('usage: bun scripts/ops/machine-sanitize.ts --root <owned-scratch-dir> --mode light|heavy [--receipt <path>]\n');
    process.exit(2);
  }
  if (args.includes('--apply') && !args.includes('--manual-apply')) {
    process.stderr.write('machine-sanitize: apply is deferred to the receipt-safe sanitation child\n');
    process.exit(2);
  }
  const receiptPath = get('--receipt');
  if (args.includes('--receipt') && (!receiptPath || receiptPath.startsWith('--'))) {
    process.stderr.write('machine-sanitize: --receipt requires a path\n');
    process.exit(2);
  }
  try {
    if (args.includes('--manual-apply')) {
      const approvalRef = get('--approval-ref');
      if (!args.includes('--apply') || !receiptPath || !approvalRef || approvalRef.startsWith('--')) throw new Error('manual apply requires --apply, --receipt and --approval-ref');
      const receipt = manualApply(root, mode, receiptPath, approvalRef);
      process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
      process.exit(0);
    }
    if (args.includes('--init-root') && !existsSync(root)) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      writeFileSync(join(root, marker), 'machine-sanitize-v1\n', { flag: 'wx', mode: 0o600 });
    }
    const receipt = sweep(root, mode, false);
    const json = JSON.stringify(receipt, null, 2) + '\n';
    if (receiptPath) writeFileSync(receiptPath, json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`machine-sanitize: ${String(error)}\n`); process.exit(1);
  }
}
