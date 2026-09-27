import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';

export class EventLedger {
  readonly path: string;

  constructor(path = join(getElanousConfigDir(), 'connectors', 'events.jsonl')) {
    this.path = path;
  }

  seen(provider: string, eventId: string): boolean {
    return this.rows().some(row => row.provider === provider && row.eventId === eventId);
  }

  seenChange(provider: string, ref: string, occurredAt: string): boolean {
    return this.rows().some(row => row.provider === provider && row.ref === ref && row.occurredAt === occurredAt);
  }

  private rows(): Array<{ provider: string; eventId: string; ref?: string; occurredAt?: string }> {
    try {
      return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  record(provider: string, eventId: string, change?: { ref: string; occurredAt: string }): boolean {
    if (this.seen(provider, eventId) || (change && this.seenChange(provider, change.ref, change.occurredAt))) return false;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ provider, eventId, ...change })}\n`, { mode: 0o600 });
    return true;
  }
}
