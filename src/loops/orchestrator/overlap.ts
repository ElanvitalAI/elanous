import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { defaultListHarnessProcesses, type HarnessProcessListObservation } from '../../harness/harness-cli-command.js';
import { getUserConfig, ORCHESTRATOR_DEFAULTS, type OrchestratorLoopConfig, type OrchestratorSeat } from '../../user-config.js';
import { seatOfTree, TRAFFIC_SEATS } from './traffic.js';
import { goalTargetPaths, simulationProofFromGoal, unresolvedGoalTargets } from '../../self-dev/sim-impact-wording.js';

export type WorkItem = { kind: 'pr' | 'goal'; ref: string; seat: OrchestratorSeat | null; files: string[]; cells: string[]; proofScenario?: string; proofScenarioFound?: boolean; unresolvedTargets?: string[]; unreadable?: true };
export type WorkRef = Pick<WorkItem, 'kind' | 'ref' | 'seat'>;
export type Overlap = ({ type: 'file'; path: string } | { type: 'cell'; cell: string }) & { refs: WorkRef[]; crossSeat: boolean };

type OpenPr = { number: number; title: string; body?: string | null; headRefName: string; files: Array<{ path: string }>; isDraft: boolean; labels: Array<{ name: string }> };
export type CollectWorkResult = { work: WorkItem[]; excluded: { stalled: number; superseded: number; draft: number }; unreadableTrees: number; unreadableGoals: number };
export interface CollectWorkDeps {
  runGh?: (args: string[]) => string;
  listProcesses?: () => HarnessProcessListObservation;
  readGoal?: (path: string) => string;
  listTrackedPaths?: (cwd: string) => string[];
  scenarioExists?: (name: string) => boolean;
  /** Keep draft/stalled/superseded open PRs for observational inventories that must count every open PR. */
  includeNonReady?: boolean;
  config?: Pick<OrchestratorLoopConfig, 'seatTrees'>;
}

/** Budget for collectWork's per-process cwd reads. */
export const COLLECT_WORK_PROCESS_DEADLINE_MS = 10_000;

const repoRoot = resolve(import.meta.dir, '../../..');
const defaultRunGh = (args: string[]): string => execFileSync('bun', ['bin/elanous.mjs', '--test', 'gh', ...args], {
  cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 20 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
});
const cellsOf = (text: string): string[] => [...new Set([...text.matchAll(/\b0\.\d+\.\d+\s+칸\s+([A-Za-z][A-Za-z0-9-]*)/g)].map(match => match[1]!))];
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

function defaultScenarioExists(name: string): boolean {
  if (name.startsWith('신설 장치:')) return true;
  const dir = join(repoRoot, 'scenarios', 'ux-sim');
  try {
    const visit = (at: string): boolean => readdirSync(at, { withFileTypes: true }).some((entry) => {
      const path = join(at, entry.name);
      if (entry.isDirectory()) return visit(path);
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) return false;
      const relative = path.slice(repoRoot.length + 1);
      if (name === relative || name === relative.replace(/\.ya?ml$/i, '')) return true;
      const text = readFileSync(path, 'utf8');
      return /^(?:id|kind):\s*([^\s#]+)/m.exec(text)?.[1] === name;
    });
    return visit(dir);
  } catch { return false; }
}

export function collectWork(deps: CollectWorkDeps = {}): CollectWorkResult {
  const prs = JSON.parse((deps.runGh ?? defaultRunGh)(['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,body,headRefName,files,isDraft,labels'])) as OpenPr[];
  if (!Array.isArray(prs)) throw new Error('PR observation is not a list');
  // Only goal-carrying launches become work, so only they need a cwd; bounded so a host with hundreds of harness processes
  // cannot hold the queue lock for minutes (10-08). Records past the budget stay cwd-unknown → their goal reads unreadable.
  const observation = deps.listProcesses ? deps.listProcesses()
    : defaultListHarnessProcesses({ include: record => goalPath(record.command) !== null, cwdOnly: true, deadlineMs: COLLECT_WORK_PROCESS_DEADLINE_MS });
  if (observation.status !== 'ok') throw new Error(`process observation ${observation.status}`);
  const cfg = deps.config ?? getUserConfig().loops?.orchestrator ?? ORCHESTRATOR_DEFAULTS;
  const scenarioProofCache = new Map<string, boolean>();
  const trackedPathCache = new Map<string, string[]>();
  const trackedPaths = (cwd: string): string[] => {
    if (deps.listTrackedPaths) return deps.listTrackedPaths(cwd);
    const cached = trackedPathCache.get(cwd);
    if (cached) return cached;
    try {
      const paths = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', timeout: 10_000 }).split('\n').filter(Boolean);
      trackedPathCache.set(cwd, paths);
      return paths;
    } catch { return []; }
  };
  const scenarioExists = deps.scenarioExists ?? ((name: string) => {
    if (scenarioProofCache.has(name)) return scenarioProofCache.get(name)!;
    const found = defaultScenarioExists(name);
    scenarioProofCache.set(name, found);
    return found;
  });
  const excluded = { stalled: 0, superseded: 0, draft: 0 };
  const ready = prs.filter(pr => {
    const labels = pr.labels ?? [];
    if (labels.some(label => label.name === 'elanous:stalled')) { excluded.stalled++; if (!deps.includeNonReady) return false; }
    if (labels.some(label => label.name === 'elanous:superseded')) { excluded.superseded++; if (!deps.includeNonReady) return false; }
    if (pr.isDraft) { excluded.draft++; if (!deps.includeNonReady) return false; }
    return true;
  });
  const seatsByPr = new Map<number, Set<OrchestratorSeat>>();
  let unreadableTrees = 0;
  let unreadableGoals = 0;
  for (const seat of TRAFFIC_SEATS) {
    for (const tree of cfg.seatTrees[seat] ?? []) {
      try {
        const goals = join(tree, 'docs', 'goals');
        const numbers = new Set<number>();
        for (const entry of readdirSync(goals, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          // One unreadable goal file must not drop the whole tree's PR→seat mapping; count it instead.
          let text: string;
          try { text = (deps.readGoal ?? ((file: string) => readFileSync(file, 'utf8')))(join(goals, entry.name)); }
          catch { unreadableGoals++; continue; }
          for (const match of text.matchAll(/^[ \t]*prNumber:[ \t]*(\d+)[ \t]*\r?$/gm)) numbers.add(Number(match[1]));
        }
        for (const number of numbers) {
          const seats = seatsByPr.get(number) ?? new Set<OrchestratorSeat>();
          seats.add(seat);
          seatsByPr.set(number, seats);
        }
      } catch {
        unreadableTrees++;
      }
    }
  }
  const work: WorkItem[] = ready.map(pr => {
    const matched = seatsByPr.get(pr.number);
    const proofScenario = simulationProofFromGoal(pr.body ?? '');
    return { kind: 'pr', ref: `#${pr.number}`, seat: seatOfPr(pr.title) ?? (matched?.size === 1 ? [...matched][0]! : null),
      files: pr.files.map(file => file.path), cells: cellsOf(`${pr.title}\n${pr.body ?? ''}`),
      ...(proofScenario ? { proofScenario, proofScenarioFound: scenarioExists(proofScenario) } : {}) };
  });
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
    const proofScenario = simulationProofFromGoal(text);
    const tracked = trackedPaths(cwd ?? repoRoot);
    const unresolvedTargets = unresolvedGoalTargets(text, tracked);
    const files = [...new Set([...goalTargetPaths(text, tracked), ...unresolvedTargets])].sort();
    work.push({ kind: 'goal', ref, seat, files, cells: cellsOf(text),
      ...(unresolvedTargets.length ? { unresolvedTargets } : {}),
      ...(proofScenario ? { proofScenario, proofScenarioFound: scenarioExists(proofScenario) } : {}) });
  }
  return { work, excluded, unreadableTrees, unreadableGoals };
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
    const { work, excluded, unreadableTrees, unreadableGoals } = collectWork();
    const overlaps = findOverlaps(work);
    const files = overlaps.filter(overlap => overlap.type === 'file').length;
    const cells = overlaps.filter(overlap => overlap.type === 'cell').length;
    const crossSeat = overlaps.filter(overlap => overlap.crossSeat).length;
    const unreadable = work.filter(item => item.unreadable).length;
    const seatNull = work.filter(item => item.kind === 'pr' && item.seat === null).length;
    debug.log('loop.orchestrator', 'exchange', { node: 'overlap', files, cells, crossSeat, excluded, seatNull, unreadableTrees, unreadableGoals });
    const summary = `overlap work=${work.length} files=${files} cells=${cells} crossSeat=${crossSeat} unreadable=${unreadable} excluded=stalled:${excluded.stalled},superseded:${excluded.superseded},draft:${excluded.draft} seatNull=${seatNull} unreadableTrees=${unreadableTrees} unreadableGoals=${unreadableGoals}`;
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ work, overlaps, excluded, seatNull, unreadableTrees, unreadableGoals }));
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
