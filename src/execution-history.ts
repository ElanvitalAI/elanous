import { isRecord } from './primitives/guards.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import type { ExecutionSurfaceSpec } from './display/index.js';

export type ExecutionHistoryStatus = 'active' | 'done' | 'failed' | 'cancelled';

export interface ExecutionHistoryRecord {
  id: string;
  pluginId?: string;
  taskId?: string;
  spec: ExecutionSurfaceSpec;
  status: ExecutionHistoryStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
}

interface ExecutionHistoryFile {
  version: 1;
  records: ExecutionHistoryRecord[];
}

export class ExecutionHistoryStore {
  constructor(private readonly path = defaultExecutionHistoryPath()) {}

  start(input: {
    id?: string;
    pluginId?: string;
    taskId?: string;
    spec: ExecutionSurfaceSpec;
    now?: Date;
  }): ExecutionHistoryRecord {
    const now = input.now ?? new Date();
    const record: ExecutionHistoryRecord = {
      id: input.id ?? `exec-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      pluginId: input.pluginId,
      taskId: input.taskId,
      spec: input.spec,
      status: 'active',
      startedAt: now.toISOString(),
    };
    const file = this.read();
    file.records.unshift(record);
    this.write(file);
    return record;
  }

  finish(id: string, status: Exclude<ExecutionHistoryStatus, 'active'>, opts: {
    stdout?: string;
    stderr?: string;
    now?: Date;
  } = {}): ExecutionHistoryRecord {
    const file = this.read();
    const record = file.records.find(item => item.id === id);
    if (!record) throw new Error(`execution record not found: ${id}`);
    const endedAt = opts.now ?? new Date();
    record.status = status;
    record.endedAt = endedAt.toISOString();
    record.durationMs = Math.max(0, endedAt.getTime() - new Date(record.startedAt).getTime());
    if (opts.stdout !== undefined) record.stdout = opts.stdout;
    if (opts.stderr !== undefined) record.stderr = opts.stderr;
    this.write(file);
    return record;
  }

  list(limit = 50): ExecutionHistoryRecord[] {
    return this.read().records.slice(0, Math.max(0, limit));
  }

  get(id: string): ExecutionHistoryRecord | null {
    return this.read().records.find(record => record.id === id) ?? null;
  }

  private read(): ExecutionHistoryFile {
    if (!existsSync(this.path)) return { version: 1, records: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<ExecutionHistoryFile>;
      return {
        version: 1,
        records: Array.isArray(parsed.records) ? parsed.records.filter(isExecutionHistoryRecord) : [],
      };
    } catch {
      return { version: 1, records: [] };
    }
  }

  private write(file: ExecutionHistoryFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8');
    renameSync(tmp, this.path);
  }
}

export function defaultExecutionHistoryPath(): string {
  return join(DATA_DIR, 'execution-history.json');
}

function isExecutionHistoryRecord(value: unknown): value is ExecutionHistoryRecord {
  if (!isRecord(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === 'string'
    && typeof raw.startedAt === 'string'
    && typeof raw.status === 'string'
    && Boolean(raw.spec)
    && typeof raw.spec === 'object';
}
