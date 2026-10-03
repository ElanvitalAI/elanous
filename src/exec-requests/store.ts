import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import type { OutputKind } from './default-outputs.js';

export type SeatStatus = 'waiting' | 'running' | 'done' | 'failed';
export interface ExecSeat {
  seat: string;
  title: string;
  status: SeatStatus;
  graphId: string;
  runId: string;
  /** Requested output category, distinct from the result file MIME kind. */
  output?: OutputKind;
  inputs?: Record<string, unknown>;
  reason?: string;
  /** A5b — indexes of earlier seats this seat waits for. */
  after?: number[];
}
export interface ExecResult {
  seat: string;
  kind: 'report' | 'pdf' | 'video' | 'image' | 'text' | 'link';
  title: string;
  url: string;
  sources?: Array<{ title: string; url: string }>;
}
export interface ExecAttachment {
  name: string;
  path: string;
}

export interface ExecRequest {
  id: string;
  text: string;
  attachments?: ExecAttachment[];
  createdAt: string;
  status: 'planning' | 'running' | 'done' | 'failed';
  summary: string;
  seats: ExecSeat[];
  results: ExecResult[];
  approvals: Array<{ graphId: string; runId: string; message: string }>;
}

const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);

export class ExecRequestStore {
  readonly dir: string;
  constructor(configDir = getElanousConfigDir()) { this.dir = join(configDir, 'exec-requests'); }

  create(text: string, attachments?: ExecAttachment[]): ExecRequest {
    const item: ExecRequest = { id: randomUUID(), text, ...(attachments !== undefined ? { attachments } : {}), createdAt: new Date().toISOString(), status: 'planning', summary: '', seats: [], results: [], approvals: [] };
    this.save(item);
    return item;
  }

  get(id: string): ExecRequest | null {
    if (!validId(id)) return null;
    try {
      const item = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as ExecRequest;
      return item.id === id ? item : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  list(): ExecRequest[] {
    try {
      return readdirSync(this.dir).filter(file => /^[a-f0-9-]{36}\.json$/.test(file))
        .flatMap(file => { const item = this.get(file.slice(0, -5)); return item ? [item] : []; })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  save(item: ExecRequest): void {
    if (!validId(item.id)) throw new Error('invalid exec request id');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, `${item.id}.json`);
    const temp = join(this.dir, `${item.id}.${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(item) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  }
}
