import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
import { join } from 'node:path';
import { listMemories, memoryRoot, saveMemory, type MemoryEntry } from '../memory.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { condenseContextWindowWithReport, readCondenseEvents, type CondenseFunnel, type CondenseSkipped, type MemoryDeps, type MemoryItem, type MemorySource, type MemorySummary } from './long-term-memory.js';

const summarize = async (source: MemorySource): Promise<MemorySummary> =>
  (await import('./nightly-condense.js')).summarize(source);

export interface CondenseReport {
  since: string;
  until: string;
  cards: MemoryItem[];
  conflicts: number;
  skipped: CondenseSkipped;
  funnel: CondenseFunnel;
  folded: number;
  droppedHarnessChild: number;
  markdown: string;
  applied?: { written: number; retired: number; decisions: string[] };
}

function mdCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderCondenseMarkdown(report: Pick<CondenseReport, 'since' | 'until' | 'cards' | 'conflicts' | 'skipped' | 'droppedHarnessChild' | 'funnel'>): string {
  const seats = (counts: Record<string, number>) => ['OP', 'TC', 'MK', 'UX', ...Object.keys(counts).filter(seat => !['OP', 'TC', 'MK', 'UX'].includes(seat)).sort()]
    .map(seat => `${seat} ${counts[seat] ?? 0}`).join(' · ');
  const stage = (name: string, value: { total: number; bySeat: Record<string, number> }) =>
    `${name} ${value.total} (${seats(value.bySeat)})`;
  const lines = [
    '# Long-term context memory candidates',
    '',
    `Window: ${report.since} → ${report.until} · Cards: ${report.cards.length} · Conflicts: ${report.conflicts}`,
    `Funnel: ${stage('read', report.funnel.read)} → ${stage('sources', report.funnel.sources)} → ${stage('summarized', report.funnel.summarized)} → ${stage('cards', report.funnel.cards)}`,
    `Skipped: ${JSON.stringify(report.skipped)} · Dropped harness-child: ${report.droppedHarnessChild}`,
    '',
  ];
  for (const card of report.cards) {
    lines.push(`## ${mdCell(card.project)} · ${mdCell(card.seat)} · ${mdCell(card.topic)}`,
      `- Updated: ${card.updatedAt}`,
      `- Candidate: ${mdCell(card.summary)}`,
      `- Source: ${card.source}`);
    if (card.conflict) lines.push(`- 충돌 (${card.conflict.owner}): ${card.conflict.sources.join(' ↔ ')}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

type CondenseStore = {
  list(): MemoryEntry[];
  save(input: Parameters<typeof saveMemory>[0]): MemoryEntry;
  raise(input: Parameters<DecisionLedger['raiseOnce']>[0], ref: string): string;
  withLock<T>(action: () => T): T;
};

/** Persistent inode in the existing memory directory: all condense writers share one cross-process lock. */
function withMemoryLock<T>(dir: string, action: () => T): T {
  mkdirSync(dir, { recursive: true });
  const libc = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : process.platform === 'linux' ? 'libc.so.6' : null;
  if (!libc) throw new Error('context memory locking unavailable on this platform');
  const lib = dlopen(libc, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  const flock = lib.symbols.flock as (fd: number, op: number) => number;
  const path = join(dir, '.context-condense.lock');
  let fd: number | undefined;
  let acquired = false;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd);
    const current = lstatSync(path);
    if (!stat.isFile() || stat.ino !== current.ino || stat.dev !== current.dev || (stat.mode & 0o077) !== 0) {
      throw new Error('context memory lock must be a private regular file');
    }
    const deadline = Date.now() + 10_000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (flock(fd, 2 | 4) !== 0) {
      if (Date.now() >= deadline) throw new Error('context memory lock timed out');
      Atomics.wait(pause, 0, 0, 10);
    }
    acquired = true;
    const locked = lstatSync(path);
    if (stat.ino !== locked.ino || stat.dev !== locked.dev) throw new Error('context memory lock changed');
    return action();
  } finally {
    if (fd !== undefined) {
      try { if (acquired) flock(fd, 8); } finally { closeSync(fd); }
    }
    lib.close();
  }
}

function defaultStore(root?: string): CondenseStore {
  const memoryDir = root ? join(root, 'elanous', 'memory') : memoryRoot();
  const ledger = new DecisionLedger(root ? { stateDir: root } : {});
  return {
    list: () => listMemories({}, memoryDir),
    save: input => saveMemory(input, memoryDir),
    raise: (input, ref) => ledger.raiseOnce(input, ref).id,
    withLock: action => withMemoryLock(memoryDir, action),
  };
}

function cardKey(card: Pick<MemoryItem, 'project' | 'seat' | 'topic'>): string {
  return JSON.stringify([card.project, card.seat, card.topic]);
}

function newestActive(entries: readonly MemoryEntry[]): MemoryEntry | undefined {
  return entries.reduce<MemoryEntry | undefined>((best, entry) => {
    const current = entry.contextCard!;
    const previous = best?.contextCard;
    return !previous || current.updatedAt > previous.updatedAt
      || (current.updatedAt === previous.updatedAt && current.source > previous.source)
      || (current.updatedAt === previous.updatedAt && current.source === previous.source && entry.id > best!.id)
      ? entry : best;
  }, undefined);
}

/** Apply candidate cards through the existing curated memory and decision ledger paths. */
export function applyCondensedCards(cards: readonly MemoryItem[], store: CondenseStore): NonNullable<CondenseReport['applied']> {
  const decisions: string[] = [];
  let written = 0;
  let retired = 0;
  for (const card of cards) {
    if (card.conflict) {
      const ref = `context-condense:${JSON.stringify([card.project, card.seat, card.topic, card.source, card.updatedAt])}`;
      decisions.push(store.raise({
        title: `Context conflict: ${card.project} / ${card.seat} / ${card.topic}`.slice(0, 120),
        category: 'scope',
        scqa: { s: `Candidate (${card.updatedAt}): ${card.summary}`.slice(0, 220), c: `Conflicting sources: ${card.conflict.sources.join(' ↔ ')}`.slice(0, 220) },
        options: [
          { key: 'a', label: 'Keep the existing claim', consequence: 'Candidate is not stored' },
          { key: 'b', label: 'Reconcile and apply the new claim', consequence: 'Resolve source disagreement before memory update' },
        ],
        recommendation: { skipped: true, reason: 'Conflicting claims require OP judgment' },
        raisedBy: { agent: 'context-condense', track: 'OP' },
        refs: [ref, ...card.conflict.sources],
      }, ref));
      continue;
    }
    if (card.status !== 'active') continue;
    const applyTopic = () => {
      const prior = store.list().filter(entry => entry.contextCard?.status === 'active' && cardKey(entry.contextCard) === cardKey(card));
      const winner = newestActive(prior);
      const alreadyPresent = prior.some(entry => entry.contextCard!.updatedAt === card.updatedAt && entry.contextCard!.source === card.source);
      if (!alreadyPresent && (!winner || winner.contextCard!.updatedAt < card.updatedAt
        || (winner.contextCard!.updatedAt === card.updatedAt && winner.contextCard!.source < card.source))) {
        store.save({ type: 'project', name: `${card.project} · ${card.seat} · ${card.topic}`,
          description: card.summary, body: `${card.summary}\n\nSource: ${card.source}\nUpdated: ${card.updatedAt}\n`,
          contextCard: { project: card.project, seat: card.seat, topic: card.topic, source: card.source, updatedAt: card.updatedAt, status: 'active' } });
        written++;
      }
      const active = store.list().filter(entry => entry.contextCard?.status === 'active' && cardKey(entry.contextCard) === cardKey(card));
      const keep = newestActive(active);
      for (const old of active) {
        if (old.id === keep?.id) continue;
        store.save({ type: old.type, name: old.name, description: old.description, body: old.body, id: old.id,
          pinned: false, priority: old.priority, contextCard: { ...old.contextCard!, status: 'retired' } });
        retired++;
      }
    };
    store.withLock(applyTopic);
  }
  return { written, retired, decisions };
}

/** Produce a rolling-window candidate snapshot; no store is opened for writing in dry-run. */
export async function runContextCondense(options: {
  hours: number; apply?: boolean; now?: Date; root?: string;
}, deps: MemoryDeps = { summarize }, store?: CondenseStore): Promise<CondenseReport> {
  if (!Number.isSafeInteger(options.hours) || options.hours <= 0 || options.hours > 24 * 30) {
    throw new Error('--since must be a positive number of hours (at most 720h)');
  }
  const now = options.now ?? new Date();
  const until = now.toISOString();
  const since = new Date(now.getTime() - options.hours * 3_600_000).toISOString();
  const { cards, skipped, folded, droppedHarnessChild, funnel } = await condenseContextWindowWithReport(since, until, [], {
    summarize: deps.summarize,
    events: deps.events ?? readCondenseEvents,
    decisions: deps.decisions ?? (() => new DecisionLedger(options.root ? { stateDir: options.root } : {}).list({ status: 'all' })
      .filter(decision => decision.raisedBy.agent !== 'context-condense')),
  }, now);
  const conflicts = cards.filter(card => card.conflict !== undefined).length;
  const report: CondenseReport = { since, until, cards, conflicts, skipped, folded, droppedHarnessChild, funnel,
    markdown: renderCondenseMarkdown({ since, until, cards, conflicts, skipped, droppedHarnessChild, funnel }) };
  if (options.apply === true) report.applied = applyCondensedCards(cards, store ?? defaultStore(options.root));
  return report;
}
