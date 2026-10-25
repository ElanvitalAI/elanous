#!/usr/bin/env bun
/**
 * GOAL-BENCH-FU — 열 과제×세 경로(문면·구체화·구현 결과) 결과표와 절차 삭제 후보.
 *
 *   bun scripts/goals/authoring-metrics.ts --records <ledger.json|ledger.jsonl> [--json]
 *
 * 레코드 = { task, path, landed, rounds, procedureSteps }. `--records` 가 없으면 기존 측정 모드
 * (경로 인자 · chars/bytes/sections/marker)가 그대로 돈다 — 표 형식·요약 JSON 불변.
 */
import { readFileSync } from 'node:fs';
import { inspectAskMarkers } from '../ask-marker-check.js';

export interface AuthoringMeasurement {
  readonly path: string;
  readonly chars: number;
  readonly bytes: number;
  readonly sections: number;
  readonly markerAxes: number;
  readonly markerFailed: number;
}

type UnreadableMeasurement = { readonly path: string; readonly error: 'unreadable' };
type AuthoringRow = AuthoringMeasurement | UnreadableMeasurement;

export function measureAuthoring(path: string, text: string): AuthoringMeasurement {
  const axes = inspectAskMarkers(text);
  return {
    path,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    sections: text.split(/\r?\n/).filter((line) => /^#{1,6}\s/u.test(line)).length,
    markerAxes: axes.length,
    markerFailed: axes.filter((axis) => !(axis.marker && axis.extracted)).length,
  };
}

export function median(numbers: readonly number[]): number | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** 골이 지나는 세 경로 — 문면(text) · 구체화(elaboration) · 구현 결과(implementation). */
export type AuthoringPath = 'text' | 'elaboration' | 'implementation';

const AUTHORING_PATHS: readonly AuthoringPath[] = ['text', 'elaboration', 'implementation'];

export interface AuthoringRecord {
  readonly task: string;
  readonly path: AuthoringPath;
  /** 그 과제가 그 경로에서 착지했나. */
  readonly landed: boolean;
  /** 착지까지 든 라운드 수. */
  readonly rounds: number;
  /** 그 경로에서 실제로 밟은 절차 단계 — 삭제 후보 판정의 입력. */
  readonly procedureSteps: readonly string[];
}

export interface PathCell {
  readonly path: AuthoringPath;
  readonly landed: number;
  readonly total: number;
  /** 착지율 0~1. 레코드가 없으면 null. */
  readonly groundingRate: number | null;
  /** 평균 라운드. 레코드가 없으면 null. */
  readonly rounds: number | null;
}

export interface ResultRow {
  readonly task: string;
  /** buildResultTable 의 columns 와 같은 순서. 그 경로 레코드가 없으면 total 0 셀. */
  readonly cells: readonly PathCell[];
}

export interface ResultTable {
  readonly columns: readonly AuthoringPath[];
  readonly rows: readonly ResultRow[];
  readonly summary: readonly PathCell[];
}

export interface DeletionCandidate {
  readonly step: string;
  readonly withGroundingRate: number | null;
  readonly withoutGroundingRate: number | null;
  readonly withRounds: number | null;
  readonly withoutRounds: number | null;
  readonly withSamples: number;
  readonly withoutSamples: number;
  readonly reason: string;
}

export function computeGroundingRate(records: readonly AuthoringRecord[]): number | null {
  if (records.length === 0) return null;
  return records.filter((record) => record.landed).length / records.length;
}

function meanRounds(records: readonly AuthoringRecord[]): number | null {
  if (records.length === 0) return null;
  return records.reduce((sum, record) => sum + record.rounds, 0) / records.length;
}

function cellFor(path: AuthoringPath, records: readonly AuthoringRecord[]): PathCell {
  return {
    path,
    landed: records.filter((record) => record.landed).length,
    total: records.length,
    groundingRate: computeGroundingRate(records),
    rounds: meanRounds(records),
  };
}

/** 행 = 과제, 열 = 경로, 셀 = 착지율·라운드. summary 는 경로별 전체 집계다. */
export function buildResultTable(records: readonly AuthoringRecord[]): ResultTable {
  const columns = AUTHORING_PATHS.filter((path) => records.some((record) => record.path === path));
  const tasks: string[] = [];
  for (const record of records) if (!tasks.includes(record.task)) tasks.push(record.task);
  return {
    columns,
    rows: tasks.map((task) => ({
      task,
      cells: columns.map((path) =>
        cellFor(path, records.filter((record) => record.task === task && record.path === path))),
    })),
    summary: columns.map((path) => cellFor(path, records.filter((record) => record.path === path))),
  };
}

/**
 * 그 단계를 밟은 레코드가 «안 밟은 레코드보다» 착지율이 높지도 않고 라운드도 줄이지 못하면 삭제 후보다.
 * 대조군이 없는 단계(모든 레코드가 밟음)는 판정할 근거가 없으므로 후보로 올리지 않는다.
 */
export function findDeletionCandidates(records: readonly AuthoringRecord[]): readonly DeletionCandidate[] {
  const steps = [...new Set(records.flatMap((record) => record.procedureSteps))].sort();
  const candidates: DeletionCandidate[] = [];
  for (const step of steps) {
    const withStep = records.filter((record) => record.procedureSteps.includes(step));
    const withoutStep = records.filter((record) => !record.procedureSteps.includes(step));
    if (withStep.length === 0 || withoutStep.length === 0) continue;
    const withGroundingRate = computeGroundingRate(withStep);
    const withoutGroundingRate = computeGroundingRate(withoutStep);
    const withRounds = meanRounds(withStep);
    const withoutRounds = meanRounds(withoutStep);
    if (withGroundingRate === null || withoutGroundingRate === null) continue;
    if (withRounds === null || withoutRounds === null) continue;
    if (withGroundingRate > withoutGroundingRate) continue;
    if (withRounds < withoutRounds) continue;
    candidates.push({
      step,
      withGroundingRate,
      withoutGroundingRate,
      withRounds,
      withoutRounds,
      withSamples: withStep.length,
      withoutSamples: withoutStep.length,
      reason: `착지율 ${formatPercent(withGroundingRate)} ≤ ${formatPercent(withoutGroundingRate)}`
        + ` · 라운드 ${withRounds.toFixed(1)} ≥ ${withoutRounds.toFixed(1)}`,
    });
  }
  return candidates.sort((a, b) =>
    (b.withRounds! - b.withoutRounds!) - (a.withRounds! - a.withoutRounds!)
    || (a.withGroundingRate! - b.withGroundingRate!)
    || a.step.localeCompare(b.step));
}

function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function formatRounds(rounds: number | null): string {
  return rounds === null ? '—' : rounds.toFixed(1);
}

function formatCell(cell: PathCell): string {
  if (cell.total === 0) return '—';
  return `${formatPercent(cell.groundingRate)}/${formatRounds(cell.rounds)}`;
}

export function renderResultTable(table: ResultTable): string {
  const lines = [`task\t${table.columns.join('\t')}`];
  for (const row of table.rows) lines.push(`${row.task}\t${row.cells.map(formatCell).join('\t')}`);
  lines.push(`summary\t${table.summary.map(formatCell).join('\t')}`);
  return lines.join('\n');
}

export function renderDeletionCandidates(candidates: readonly DeletionCandidate[]): string {
  if (candidates.length === 0) return 'candidates\tnone';
  const lines = ['step\twith.landing\twithout.landing\twith.rounds\twithout.rounds\tsamples'];
  for (const candidate of candidates) {
    lines.push([
      candidate.step,
      formatPercent(candidate.withGroundingRate),
      formatPercent(candidate.withoutGroundingRate),
      formatRounds(candidate.withRounds),
      formatRounds(candidate.withoutRounds),
      `${candidate.withSamples}/${candidate.withoutSamples}`,
    ].join('\t'));
  }
  return lines.join('\n');
}

export type ParsedRecords =
  | { readonly ok: true; readonly records: readonly AuthoringRecord[] }
  | { readonly ok: false; readonly error: string };

function parseRecord(entry: unknown): AuthoringRecord | string {
  if (typeof entry !== 'object' || entry === null) return 'is not an object';
  const value = entry as Record<string, unknown>;
  if (typeof value.task !== 'string' || value.task.trim() === '') return 'task must be a non-empty string';
  if (!AUTHORING_PATHS.includes(value.path as AuthoringPath)) {
    return `path must be one of ${AUTHORING_PATHS.join('|')}`;
  }
  if (typeof value.landed !== 'boolean') return 'landed must be a boolean';
  if (typeof value.rounds !== 'number' || !Number.isFinite(value.rounds) || value.rounds < 0) {
    return 'rounds must be a finite number >= 0';
  }
  const steps = value.procedureSteps;
  if (steps !== undefined && (!Array.isArray(steps)
    || steps.some((step) => typeof step !== 'string' || step.trim() === ''))) {
    return 'procedureSteps must be an array of non-empty strings';
  }
  return {
    task: value.task,
    path: value.path as AuthoringPath,
    landed: value.landed,
    rounds: value.rounds,
    procedureSteps: (steps ?? []) as readonly string[],
  };
}

/** JSON 배열 한 덩어리 또는 JSON Lines(원장 한 줄 = 레코드 하나) 둘 다 받는다. */
export function parseRecords(text: string): ParsedRecords {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, records: [] };
  const entries: unknown[] = [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: 'records ledger is not valid JSON' };
    }
    if (!Array.isArray(parsed)) return { ok: false, error: 'records must be a JSON array or JSON Lines' };
    entries.push(...parsed);
  } else {
    for (const [index, line] of trimmed.split(/\r?\n/).entries()) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line) as unknown);
      } catch {
        return { ok: false, error: `line ${index + 1} is not valid JSON` };
      }
    }
  }
  const records: AuthoringRecord[] = [];
  for (const [index, entry] of entries.entries()) {
    const parsed = parseRecord(entry);
    if (typeof parsed === 'string') return { ok: false, error: `record ${index + 1}: ${parsed}` };
    records.push(parsed);
  }
  return { ok: true, records };
}

function printRecordsLedger(argv: readonly string[]): number {
  const file = argv[argv.indexOf('--records') + 1];
  if (file === undefined || file.startsWith('--')) {
    console.error('authoring-metrics: --records needs a ledger path');
    return 2;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
  } catch {
    console.error(`authoring-metrics: unreadable records ledger: ${file}`);
    return 1;
  }
  const parsed = parseRecords(text);
  if (!parsed.ok) {
    console.error(`authoring-metrics: ${parsed.error}`);
    return 1;
  }
  const table = buildResultTable(parsed.records);
  const candidates = findDeletionCandidates(parsed.records);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ columns: table.columns, rows: table.rows, summary: table.summary, candidates }));
  } else {
    console.log(renderResultTable(table));
    console.log(renderDeletionCandidates(candidates));
  }
  return 0;
}

function main(argv: readonly string[]): number {
  if (argv.includes('--records')) return printRecordsLedger(argv);
  const json = argv.includes('--json');
  const paths = argv.filter((argument) => argument !== '--json');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const rows: AuthoringRow[] = paths.map((path) => {
    let text: string;
    try {
      text = decoder.decode(readFileSync(path));
    } catch {
      return { path, error: 'unreadable' };
    }
    return measureAuthoring(path, text);
  });
  const measured = rows.filter((row): row is AuthoringMeasurement => !('error' in row));
  const summary = {
    files: measured.length,
    medianChars: median(measured.map((row) => row.chars)),
    medianBytes: median(measured.map((row) => row.bytes)),
  };

  if (json) {
    for (const row of rows) console.log(JSON.stringify(row));
    console.log(JSON.stringify(summary));
  } else {
    console.log('path\tchars\tbytes\tsections\tmarkerAxes\tmarkerFailed\terror');
    for (const row of rows) {
      console.log('error' in row
        ? `${row.path}\t\t\t\t\t\t${row.error}`
        : `${row.path}\t${row.chars}\t${row.bytes}\t${row.sections}\t${row.markerAxes}\t${row.markerFailed}\t`);
    }
    console.log(`files\t${summary.files}\tmedianChars\t${summary.medianChars ?? '—'}\tmedianBytes\t${summary.medianBytes ?? '—'}`);
  }
  return rows.some((row) => 'error' in row) ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
