import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { listChecklist, setItem } from '../release-loop/checklist.js';
import { withFileLockSync } from '../storage/file-lock.js';

export type ConclusionKind = 'evidence' | 'decision' | 'lesson';
export type ConclusionSource = 'goal' | 'handoff' | 'run-log' | 'channel' | 'pr-discussion';
export interface ConclusionRecord {
  source: ConclusionSource;
  cell: string;
  kind: ConclusionKind;
  conclusion: string;
  /** Original URL, or a relative path to the original for non-channel sources. */
  ref: string;
  body: string;
  /** The original post's UTC timestamp; required when compressing a channel day. */
  createdAt?: string;
  /** Terminal status is required before a run can be archived. */
  status?: string;
}
export interface ConclusionBatch {
  version: string;
  day: string;
  records: ConclusionRecord[];
}
export interface ConclusionReceipt {
  archive: string;
  lines: string[];
  originalBytes: number;
  conclusionBytes: number;
}

const kinds = new Set<ConclusionKind>(['evidence', 'decision', 'lesson']);
const sources = new Set<ConclusionSource>(['goal', 'handoff', 'run-log', 'channel', 'pr-discussion']);
const closed = new Set(['done', 'failed', 'cancelled', 'superseded', 'completed', 'abandoned']);
const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

/** Archive a complete input batch; publish only source-linked, explicitly supplied conclusions to the checklist ledger. */
export function compressConclusions(batch: ConclusionBatch, root = releaseLedgerRoot()): ConclusionReceipt {
  if (!batch || !Array.isArray(batch.records) || !batch.records.length || !validDay(batch.day)) throw new Error('invalid day or empty records');
  if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(batch.version)) throw new Error('invalid checklist version');
  if (resolve(root) !== resolve(releaseLedgerRoot())) throw new Error('archive and checklist must share a ledger root');
  const checklist = listChecklist(batch.version);
  const digest = createHash('sha256').update(JSON.stringify(batch)).digest('hex');
  const archiveRef = `knowledge-compress/archive/${digest}.json`;
  const byCell = new Map<string, string[]>();
  for (const [index, record] of batch.records.entries()) {
    if (!record || !sources.has(record.source) || !kinds.has(record.kind) ||
      !checklist.items.some(item => item.id === record.cell) || !record.body?.trim() ||
      !record.conclusion?.trim() || /[\r\n]/.test(record.conclusion) || !record.ref?.trim()) {
      throw new Error('unverified source, conclusion or checklist cell');
    }
    if (record.source === 'channel') {
      if (!/^https:\/\/github\.com\/[^\s]+#issuecomment-\d+$/.test(record.ref) ||
        !record.createdAt || !Number.isFinite(Date.parse(record.createdAt)) ||
        new Date(record.createdAt).toISOString().slice(0, 10) !== batch.day) throw new Error('channel comment must link to the selected UTC day');
    }
    if (record.source === 'run-log' && !closed.has(record.status ?? '')) throw new Error('run is not finished');
    const conclusion = record.conclusion.trim().replace(/\s+/g, ' ');
    if (conclusion.length > 160 || !conclusion) throw new Error('conclusion exceeds one line');
    const ref = record.ref.trim();
    if (/\s|[\r\n]/.test(ref) || (record.source !== 'channel' && !/^(https:\/\/|[^/][^\s]*$)/.test(ref))) throw new Error('invalid source pointer');
    const line = `${record.kind}: ${conclusion} (${record.source === 'channel' ? ref : `${archiveRef}#record-${index + 1}`})`;
    byCell.set(record.cell, [...(byCell.get(record.cell) ?? []), line]);
  }
  const lines = [...byCell].flatMap(([cell, entries]) => [...new Set(entries)].map(line => `${cell} · ${line}`));
  const originalBytes = Buffer.byteLength(JSON.stringify(batch.records));
  const conclusionBytes = Buffer.byteLength(lines.join('\n'));
  if (conclusionBytes * 10 > originalBytes) throw new Error(`conclusions exceed 1/10 of original (${conclusionBytes}/${originalBytes} bytes)`);

  const dir = join(root, 'knowledge-compress');
  const archive = join(root, archiveRef);
  const lock = join(dir, 'conclusions.lock');
  mkdirSync(dirname(archive), { recursive: true });
  return withFileLockSync(lock, () => {
    if (existsSync(archive)) {
      if (readFileSync(archive, 'utf8') !== JSON.stringify(batch)) throw new Error('archive digest collision');
    } else {
      const temp = `${archive}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(batch), { flag: 'wx', mode: 0o600 });
      renameSync(temp, archive);
    }
    for (const [cell, entries] of byCell) {
      const existing = listChecklist(batch.version).items.find(item => item.id === cell);
      if (!existing) throw new Error(`checklist cell disappeared: ${cell}`);
      const additions = [...new Set(entries)].filter(line => !existing.evidence?.split('\n').includes(line));
      if (additions.length) setItem(batch.version, cell, { evidence: [existing.evidence, ...additions].filter(Boolean).join('\n') }, 'knowledge-compress');
    }
    return { archive: resolve(archive), lines, originalBytes, conclusionBytes };
  });
}
