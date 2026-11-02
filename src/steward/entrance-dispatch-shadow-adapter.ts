/** Test-only bridge for comparing a frozen dispatcher decision with the real
 * orchestrator launch node. The child process isolates config globals; all
 * state, config, and process inventory are synthetic and disposable.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FrozenDispatcherCell {
  cellId: string;
  cardId: string;
  title: string;
  seat: 'OP' | 'MK' | 'TC' | 'UX';
  version: string;
  candidateKey: string;
  shellDecision: 'would-run' | 'would-skip';
  shellReason: string;
}

export interface FrozenDispatcherSnapshot {
  cycleId: string;
  at: string;
  cells: FrozenDispatcherCell[];
  runningBySeat?: Partial<Record<'OP' | 'MK' | 'TC' | 'UX', number>>;
}

export interface ComparedDispatcherDecision extends FrozenDispatcherCell {
  snapshotHash: string;
  graphDecision: 'would-run' | 'would-skip' | 'unobserved';
  graphStatus?: string;
  parity: boolean | null;
}

export interface GraphShadowOptions {
  inventory?: 'complete' | 'incomplete';
  failLaunchInventory?: boolean;
}

interface GraphChildOutput {
  nodeStatus: string;
  launched: Array<{ key?: string; status: string }>;
}

interface GraphDecision {
  decision: 'would-run' | 'would-skip' | 'unobserved';
  status?: string;
}

function runGraphChild(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
    timer.unref();
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > 1024 * 1024) { overflow = true; child.kill('SIGTERM'); }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > 1024 * 1024) { overflow = true; child.kill('SIGTERM'); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => {
      clearTimeout(timer);
      if (overflow) reject(new Error('graph shadow child output exceeded 1 MiB'));
      else resolve({ status, stdout, stderr });
    });
  });
}

function validateSnapshot(snapshot: FrozenDispatcherSnapshot): void {
  if (!snapshot || typeof snapshot.cycleId !== 'string' || !snapshot.cycleId.trim()
    || !Number.isFinite(Date.parse(snapshot.at)) || !Array.isArray(snapshot.cells) || snapshot.cells.length === 0)
    throw new Error('invalid snapshot identity or cells');
  const cellIds = new Set<string>();
  const graphKeys = new Set<string>();
  for (const cell of snapshot.cells) {
    if (!cell.cellId?.trim() || !cell.cardId?.trim() || !cell.title?.trim() || !cell.version?.trim()
      || !cell.candidateKey?.trim() || !cell.shellReason?.trim()) throw new Error('snapshot cell is missing identity');
    if (cell.cellId.includes(':') || cell.cardId.includes(':')) throw new Error('cell and card IDs must not contain colon');
    if (!/^[a-f0-9]{64}$/i.test(cell.candidateKey)) throw new Error(`invalid candidate key: ${cell.cellId}`);
    if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(cell.version)) throw new Error(`invalid version: ${cell.cellId}`);
    if (cellIds.has(cell.cellId)) throw new Error(`duplicate cell ID: ${cell.cellId}`);
    const graphKey = `orch:${cell.cardId}:${cell.cellId}`;
    if (graphKeys.has(graphKey)) throw new Error(`duplicate graph key: ${graphKey}`);
    cellIds.add(cell.cellId);
    graphKeys.add(graphKey);
  }
  for (const [seat, count] of Object.entries(snapshot.runningBySeat ?? {})) {
    if (!['OP', 'MK', 'TC', 'UX'].includes(seat) || !Number.isSafeInteger(count) || Number(count) < 0)
      throw new Error(`invalid process inventory: ${seat}`);
  }
}

/** Hash exact execution order as well as row content: launch capacity makes order observable. */
export function frozenDispatcherSnapshotHash(snapshot: FrozenDispatcherSnapshot): string {
  validateSnapshot(snapshot);
  const canonical = {
    cycleId: snapshot.cycleId,
    at: snapshot.at,
    cells: snapshot.cells.map(cell => ({
      cellId: cell.cellId, cardId: cell.cardId, title: cell.title, seat: cell.seat, version: cell.version,
      candidateKey: cell.candidateKey, shellDecision: cell.shellDecision, shellReason: cell.shellReason,
    })),
    runningBySeat: Object.fromEntries(Object.entries(snapshot.runningBySeat ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Execute the graph in a child process so its module-global config cannot race
 * with the host test process or other callers. This adapter never invokes a task turn.
 */
export async function graphShadowForSnapshot(
  snapshot: FrozenDispatcherSnapshot,
  options: GraphShadowOptions = {},
): Promise<{ decisions: Map<string, { decision: 'would-run' | 'would-skip' | 'unobserved'; status?: string }>; nodeStatus: string }> {
  validateSnapshot(snapshot);
  let root: string | undefined;
  let configDir: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), 'entrance-graph-shadow-'));
    configDir = mkdtempSync(join(tmpdir(), 'entrance-graph-shadow-config-'));
    const runId = `entrance-shadow-${snapshot.cycleId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48) || 'cycle'}`;
    const stateDir = join(root, 'loop', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { mode: 'shadow' } } }));

    const cells = snapshot.cells.map(cell => ({
      cardId: cell.cardId, id: cell.cellId, title: cell.title, seat: cell.seat, version: cell.version, origin: 'flow1a' as const,
    }));
    const initial = {
      runId, window: '08', mode: 'shadow', day: snapshot.at.slice(0, 10), cards: [], skippedCards: [], cells,
      placed: cells.length, delegated: 0, wouldDelegate: 0,
      reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 },
      steps: [], nodes: { delegate: 'ok' }, missing: [],
    };
    writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify(initial));
    const records = Object.entries(snapshot.runningBySeat ?? {}).flatMap(([seat, count]) =>
      Array.from({ length: Number(count ?? 0) }, (_, index) => ({
        command: `bun bin/elanous.mjs harness say frozen-${seat}-${index}`,
        elapsedSeconds: 1, cwd: root!, seat: seat as 'OP' | 'MK' | 'TC' | 'UX',
      })));
    const childArgs = [
      join(import.meta.dir, 'entrance-dispatch-shadow-adapter-child.ts'), root, configDir, runId,
      snapshot.at, JSON.stringify(records), options.inventory ?? 'complete', String(options.failLaunchInventory ?? false),
    ];
    let child: { status: number | null; stdout: string; stderr: string };
    try { child = await runGraphChild(childArgs); }
    catch (error) { throw new Error(`graph shadow child failed to start: ${String(error)}`); }
    if (child.status !== 0) throw new Error(`graph shadow child failed (${child.status}): ${(child.stderr || child.stdout).slice(-1200)}`);
    let output: GraphChildOutput;
    try { output = JSON.parse(child.stdout) as GraphChildOutput; }
    catch { throw new Error(`graph shadow child returned invalid output: ${child.stdout.slice(-1200)}`); }
    if (output.nodeStatus !== 'ok') throw new Error(`graph launch node did not complete: ${output.nodeStatus}`);

    const cellByGraphKey = new Map(cells.map(cell => [`orch:${cell.cardId}:${cell.id}`, cell]));
    const decisions = new Map<string, GraphDecision>();
    for (const cell of snapshot.cells) decisions.set(cell.cellId, { decision: 'unobserved' });
    const seen = new Set<string>();
    for (const row of output.launched) {
      if (!row.key || !cellByGraphKey.has(row.key)) throw new Error(`graph returned an unrecognized launch key: ${row.key ?? 'missing'}`);
      if (seen.has(row.key)) throw new Error(`graph returned duplicate launch key: ${row.key}`);
      seen.add(row.key);
      if (!row.status.startsWith('would-')) throw new Error(`unexpected shadow launch status: ${row.status}`);
      const cell = cellByGraphKey.get(row.key)!;
      decisions.set(cell.id, { decision: row.status === 'would-launch' ? 'would-run' : 'would-skip', status: row.status });
    }
    return { decisions, nodeStatus: output.nodeStatus };
  } finally {
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

export async function compareFrozenDispatcherSnapshot(
  snapshot: FrozenDispatcherSnapshot,
  options: GraphShadowOptions = {},
): Promise<ComparedDispatcherDecision[]> {
  const { decisions } = await graphShadowForSnapshot(snapshot, options);
  const snapshotHash = frozenDispatcherSnapshotHash(snapshot);
  return snapshot.cells.map(cell => {
    const graph = decisions.get(cell.cellId) ?? { decision: 'unobserved' as const };
    return {
      ...cell,
      snapshotHash,
      graphDecision: graph.decision,
      ...(graph.status ? { graphStatus: graph.status } : {}),
      parity: graph.decision === 'unobserved' ? null : cell.shellDecision === graph.decision,
    };
  });
}
