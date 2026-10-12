import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';

export const DUTY_STATUSES = ['standing', 'done', 'missed'] as const;
export type DutyStatus = (typeof DUTY_STATUSES)[number];

export type DutyRow = {
  at: string;
  seat: string;
  duty: string;
  source: string;
  status: DutyStatus;
  ref?: string;
};

export type DutyInput = Omit<DutyRow, 'at' | 'status'> & { at?: string; status?: DutyStatus };

const DUTY_KEYS: ReadonlySet<string> = new Set(['at', 'seat', 'duty', 'source', 'status', 'ref']);
const SEAT_PATTERN = /^(?:MK|UX|TC|OP|role:\S+)$/;

const dutyLedgerPath = (root: string): string => join(root, 'seat-duties', 'duties.jsonl');

function nonEmpty(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`duty ${key} must be a non-empty string`);
  return value;
}

function validate(input: Record<string, unknown>, now: () => Date): DutyRow {
  for (const key of Object.keys(input)) {
    if (!DUTY_KEYS.has(key)) throw new Error(`unknown duty key: ${key}`);
  }
  const seat = nonEmpty(input, 'seat');
  if (!SEAT_PATTERN.test(seat)) throw new Error(`invalid duty seat: ${seat} (use MK|UX|TC|OP|role:<name>)`);
  const status = input.status === undefined ? 'standing' : input.status;
  if (!DUTY_STATUSES.includes(status as DutyStatus)) throw new Error(`invalid duty status: ${String(status)}`);
  const at = input.at === undefined ? now().toISOString() : nonEmpty(input, 'at');
  if (Number.isNaN(Date.parse(at))) throw new Error(`invalid duty at: ${at}`);
  const row: DutyRow = { at, seat, duty: nonEmpty(input, 'duty'), source: nonEmpty(input, 'source'), status: status as DutyStatus };
  if (input.ref !== undefined) row.ref = nonEmpty(input, 'ref');
  return row;
}

/** Appends one validated row; a rejected row never reaches the file. */
export function appendDuty(root: string, input: DutyInput, now: () => Date = () => new Date()): DutyRow {
  const row = validate(input as Record<string, unknown>, now);
  const path = dutyLedgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
  try { debug.log('seat-loop.duty', 'appended', { seat: row.seat, duty: row.duty }); } catch { /* observation cannot change a write */ }
  return row;
}

export function listDuties(root: string, filters: { seat?: string } = {}): DutyRow[] {
  const path = dutyLedgerPath(root);
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line) as DutyRow)
    .filter((row) => filters.seat === undefined || row.seat === filters.seat);
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => Date.parse(a.row.at) - Date.parse(b.row.at) || a.index - b.index)
    .map(({ row }) => row);
}
