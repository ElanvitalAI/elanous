import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { ExternalTask } from './providers.js';

export interface QueuedHook { provider: ExternalTask['external']['provider']; eventId: string; task: ExternalTask }

export class HookQueue {
  readonly directory: string;
  readonly seenPath: string;
  readonly deliveredPath: string;
  private readonly seen = new Set<string>();

  constructor(root: string = effectiveInstanceRoot()) {
    const hooks = join(root, 'hooks');
    this.directory = join(hooks, 'queue');
    this.seenPath = join(hooks, 'seen.jsonl');
    this.deliveredPath = join(hooks, 'last-delivered');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (existsSync(this.seenPath)) {
      for (const line of readFileSync(this.seenPath, 'utf8').split('\n')) {
        if (!line) continue;
        const key: unknown = JSON.parse(line);
        if (typeof key !== 'string') throw new Error('invalid hooks seen entry');
        this.seen.add(key);
      }
    }
    // A crash between publishing the queue file and appending seen must not create
    // a second copy on replay (or allow a corrupt ledger to discard queued work).
    for (const event of this.entries()) this.seen.add(`${event.provider}:${event.eventId}`);
  }

  private filename(provider: string, eventId: string): string {
    return join(this.directory, `${createHash('sha256').update(`${provider}:${eventId}`).digest('hex')}.json`);
  }

  enqueue(event: QueuedHook): boolean {
    const key = `${event.provider}:${event.eventId}`;
    const path = this.filename(event.provider, event.eventId);
    if (this.seen.has(key)) return false;
    if (!existsSync(path)) this.atomicWrite(path, JSON.stringify(event));
    const fd = openSync(this.seenPath, 'a', 0o600);
    try { writeSync(fd, `${JSON.stringify(key)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.seen.add(key);
    return true;
  }

  private atomicWrite(path: string, content: string): void {
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      const dir = openSync(dirname(path), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { rmSync(temp, { force: true }); }
  }

  entries(): QueuedHook[] {
    return readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as QueuedHook);
  }
  count(): number { return readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length; }
  delivered(event: QueuedHook, now: number = Date.now()): void {
    this.atomicWrite(this.deliveredPath, new Date(now).toISOString());
    rmSync(this.filename(event.provider, event.eventId));
  }
  lastDelivered(): string | null {
    return existsSync(this.deliveredPath) ? readFileSync(this.deliveredPath, 'utf8') : null;
  }
}
