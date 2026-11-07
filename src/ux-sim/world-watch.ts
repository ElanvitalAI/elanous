import { appendFileSync, fstatSync, lstatSync, openSync, readSync, realpathSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { getTestStateRoot } from '../nexus/paths.js';

export interface SimWorldWatchTarget { id: string; root?: string; rootDir?: string }

export interface SimWorldWatchEvent {
  id: string;
  runId: string;
  sequence?: number;
  at: string;
  event: string;
  verdict: string;
}

function eventPath(world: SimWorldWatchTarget): string {
  const testRoot = getTestStateRoot();
  if (!testRoot) throw new Error('sim watch requires an explicit --test universe');
  const physicalTestRoot = realpathSync(resolve(testRoot));
  const worldRoot = world.rootDir ?? world.root;
  if (!worldRoot) throw new Error('sim watch world has no root');
  const physicalWorld = realpathSync(resolve(worldRoot));
  const worldRel = relative(physicalTestRoot, physicalWorld);
  if (!worldRel || worldRel === '..' || worldRel.startsWith(`..${sep}`) || resolve(physicalWorld) !== physicalWorld) {
    throw new Error('sim watch world escaped the explicit test universe');
  }
  const info = lstatSync(physicalWorld);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error('sim watch world must be a private directory');
  }
  const path = join(physicalWorld, 'watch-events.jsonl');
  try {
    const eventInfo = lstatSync(path);
    if (eventInfo.isSymbolicLink() || !eventInfo.isFile() || (eventInfo.mode & 0o077) !== 0) {
      throw new Error('sim watch event log must be a private regular file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path;
}

export function appendSimWorldWatchEvents(world: SimWorldWatchTarget, runId: string, events: readonly { event: string; verdict: string }[]): void {
  if (!events.length) return;
  const path = eventPath(world);
  const rows = events.map((row) => JSON.stringify({ id: randomUUID(), runId, at: new Date().toISOString(), ...row } satisfies SimWorldWatchEvent)).join('\n') + '\n';
  appendFileSync(path, rows, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

export function readSimWorldWatchEvents(world: SimWorldWatchTarget, offset = 0): { events: SimWorldWatchEvent[]; offset: number } {
  const path = eventPath(world);
  let fd: number;
  try { fd = openSync(path, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], offset };
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    if (offset > size) offset = 0;
    const chunk = Buffer.alloc(size - offset);
    readSync(fd, chunk, 0, chunk.length, offset);
    const end = chunk.lastIndexOf(0x0a);
    if (end < 0) return { events: [], offset };
    const completeBytes = chunk.subarray(0, end + 1);
    const events: SimWorldWatchEvent[] = [];
    const legacySequences = new Map<string, number>();
    let lineStart = 0;
    while (lineStart < completeBytes.length) {
      const lineEnd = completeBytes.indexOf(0x0a, lineStart);
      if (lineEnd < 0) break;
      const line = completeBytes.subarray(lineStart, lineEnd).toString('utf8');
      if (line) {
        const parsed = JSON.parse(line) as Partial<SimWorldWatchEvent>;
        // UUIDs are this writer's durable row IDs. Older versions used `runId:sequence`,
        // which could collide after a restart or across concurrent writers; upgrade those
        // rows to their stable byte position in the append-only log.
        const hasDurableId = typeof parsed.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id);
        const id = hasDurableId ? parsed.id! : `legacy:${offset + lineStart}`;
        const sequence = typeof parsed.sequence === 'number' ? parsed.sequence : (legacySequences.get(parsed.runId ?? '') ?? 0) + 1;
        legacySequences.set(parsed.runId ?? '', sequence);
        events.push({ ...parsed, id, sequence } as SimWorldWatchEvent);
      }
      lineStart = lineEnd + 1;
    }
    return { events, offset: offset + end + 1 };
  } finally {
    closeSync(fd);
  }
}

export function renderSimWorldWatchEvent(event: SimWorldWatchEvent): string {
  return `[${event.id.slice(0, 8)}] [${event.at}] ${event.runId} · ${event.event} · ${event.verdict}`;
}
