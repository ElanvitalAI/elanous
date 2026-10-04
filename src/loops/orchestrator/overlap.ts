import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { defaultListHarnessProcesses, type HarnessProcessListObservation } from '../../harness/harness-cli-command.js';
import { getUserConfig, ORCHESTRATOR_DEFAULTS, type OrchestratorLoopConfig, type OrchestratorSeat } from '../../user-config.js';
import { seatOfTree, TRAFFIC_SEATS } from './traffic.js';

export type WorkItem = { kind: 'pr' | 'goal'; ref: string; seat: OrchestratorSeat | null; files: string[]; cells: string[]; unreadable?: true };
export type WorkRef = Pick<WorkItem, 'kind' | 'ref' | 'seat'>;
export type Overlap = ({ type: 'file'; path: string } | { type: 'cell'; cell: string }) & { refs: WorkRef[]; crossSeat: boolean };

type OpenPr = { number: number; title: string; body?: string | null; headRefName: string; files: Array<{ path: string }>; isDraft: boolean };
export interface CollectWorkDeps {
  runGh?: (args: string[]) => string;
  listProcesses?: () => HarnessProcessListObservation;
  readGoal?: (path: string) => string;
  config?: Pick<OrchestratorLoopConfig, 'seatTrees'>;
}

const repoRoot = resolve(import.meta.dir, '../../..');
const defaultRunGh = (args: string[]): string => execFileSync('bun', ['bin/elanous.mjs', '--test', 'gh', ...args], {
  cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 20 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
});
const cellsOf = (text: string): string[] => [...new Set([...text.matchAll(/\b0\.2\.\d+\s+칸\s+([A-Za-z][A-Za-z0-9-]*)/g)].map(match => match[1]!))];
const seatOfPr = (title: string): OrchestratorSeat | null => {
  const seat = /^\s*\[(OP|TC|MK|UX)\]/.exec(title)?.[1];
  return TRAFFIC_SEATS.find(id => id === seat) ?? null;
};

function goalPath(command: string): string | null {
  // ps supplies an argv-shaped command, not a shell to execute. Only inspect explicit goal-file arguments.
  const argv = [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(match => match[1] ?? match[2] ?? match[3]!);
  const entry = argv.findIndex(arg => /(?:^|\/)elanous\.mjs$/.test(arg));
  if (entry < 0) return null;
  let commandAt = entry + 1;
  while (argv[commandAt] === '--test' || argv[commandAt] === '--config-dir') {
    commandAt += argv[commandAt] === '--config-dir' ? 2 : 1;
  }
  const launch = argv[commandAt] === 'harness' && ['ask', 'say'].includes(argv[commandAt + 1] ?? '') ? commandAt : -1;
  const dev = argv[commandAt] === 'dev' ? commandAt : -1;
  if (launch < 0 && dev < 0) return null;
  const fileFlag = argv.indexOf('--file', (launch >= 0 ? launch : dev) + 1);
  if (fileFlag >= 0) return argv[fileFlag + 1] ?? null;
  if (launch >= 0) {
    const candidate = argv[launch + 2];
    return candidate && !candidate.startsWith('-') && /\.(?:txt|md)$/.test(candidate) ? candidate : null;
  }
  const implement = argv.indexOf('--implement', dev + 1);
  const candidate = implement >= 0 ? argv[implement + 1] : undefined;
  return candidate && !candidate.startsWith('-') && /\.(?:txt|md)$/.test(candidate) ? candidate : null;
}

function goalFiles(text: string): string[] {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  const match = /^대상 경로:\s*(.*)$/.exec(line);
  if (!match) return [];
  return [...new Set(match[1]!.split(/\s*[·,]\s*/).map(file => file.trim().replace(/^`|`$/g, '')).filter(Boolean))];
}

export function collectWork(deps: CollectWorkDeps = {}): WorkItem[] {
  const prs = JSON.parse((deps.runGh ?? defaultRunGh)(['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,body,headRefName,files,isDraft'])) as OpenPr[];
  if (!Array.isArray(prs)) throw new Error('PR observation is not a list');
  const observation = (deps.listProcesses ?? defaultListHarnessProcesses)();
  if (observation.status !== 'ok') throw new Error(`process observation ${observation.status}`);
  const cfg = deps.config ?? getUserConfig().loops?.orchestrator ?? ORCHESTRATOR_DEFAULTS;
  const work: WorkItem[] = prs.map(pr => ({ kind: 'pr', ref: `#${pr.number}`, seat: seatOfPr(pr.title),
    files: pr.files.map(file => file.path), cells: cellsOf(`${pr.title}\n${pr.body ?? ''}`) }));
  for (const process of observation.records) {
    const path = goalPath(process.command);
    if (path === null) continue;
    const ref = basename(path);
    const cwd = process.cwdStatus === 'observed' && process.cwd && isAbsolute(process.cwd) ? process.cwd : undefined;
    const seat = seatOfTree(cwd, cfg);
    if (!isAbsolute(path) && !cwd) {
      work.push({ kind: 'goal', ref, seat, files: [], cells: [], unreadable: true });
      continue;
    }
    let text: string;
    try {
      text = (deps.readGoal ?? ((file: string) => readFileSync(file, 'utf8')))(isAbsolute(path) ? path : resolve(cwd!, path));
    } catch {
      work.push({ kind: 'goal', ref, seat, files: [], cells: [], unreadable: true });
      continue;
    }
    work.push({ kind: 'goal', ref, seat, files: goalFiles(text), cells: cellsOf(text) });
  }
  return work;
}

export function findOverlaps(work: readonly WorkItem[], excludedFiles: readonly string[] = ['release/next.md']): Overlap[] {
  const excluded = new Set(excludedFiles);
  const files = new Map<string, WorkRef[]>();
  const cells = new Map<string, WorkRef[]>();
  for (const item of work) {
    const ref = { kind: item.kind, ref: item.ref, seat: item.seat };
    for (const path of new Set(item.files)) {
      if (!excluded.has(path)) files.set(path, [...(files.get(path) ?? []), ref]);
    }
    for (const cell of new Set(item.cells)) cells.set(cell, [...(cells.get(cell) ?? []), ref]);
  }
  const details = (refs: WorkRef[]) => ({ refs, crossSeat: new Set(refs.map(ref => ref.seat).filter(Boolean)).size > 1 });
  return [
    ...[...files.entries()].filter(([, refs]) => refs.length > 1).map(([path, refs]): Overlap => ({ type: 'file', path, ...details(refs) })),
    ...[...cells.entries()].filter(([, refs]) => refs.length > 1).map(([cell, refs]): Overlap => ({ type: 'cell', cell, ...details(refs) })),
  ];
}

export function renderOverlaps(overlaps: readonly Overlap[]): string[] {
  return overlaps.map(overlap => {
    const refs = overlap.refs.map(ref => `${ref.kind === 'pr' ? 'PR ' : 'goal '}${ref.ref}(${ref.seat ?? '?'})`).join(' · ');
    return overlap.type === 'file'
      ? `⚠ 겹침 file ${overlap.path} — ${refs} · 먼저 착지하는 쪽 뒤에 다른 쪽 rebase`
      : `⚠ 같은 칸 ${overlap.cell} — ${refs}`;
  });
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--json')) throw new Error('usage: overlap.ts [--json]');
    const work = collectWork();
    const overlaps = findOverlaps(work);
    const files = overlaps.filter(overlap => overlap.type === 'file').length;
    const cells = overlaps.filter(overlap => overlap.type === 'cell').length;
    const crossSeat = overlaps.filter(overlap => overlap.crossSeat).length;
    const unreadable = work.filter(item => item.unreadable).length;
    debug.log('loop.orchestrator', 'exchange', { node: 'overlap', files, cells, crossSeat });
    const summary = `overlap work=${work.length} files=${files} cells=${cells} crossSeat=${crossSeat} unreadable=${unreadable}`;
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ work, overlaps }));
      console.error(summary);
    } else {
      for (const line of renderOverlaps(overlaps)) console.log(line);
      console.log(summary);
    }
  } catch (error) {
    console.error(`overlap: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
