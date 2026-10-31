/**
 * `eln life` — LIFE-KINDS 의 생산 진입점(등록 지점 = `src/index.ts` 의 `registerLifeCommands(program)`).
 *
 * Situation: `life-kinds.ts` 의 종류·끝의 증거·반복 실행 시리즈는 라이브러리만 있으면
 *   사람도 에이전트도 부를 수 없다(수용선: 새 코드는 생산 진입점에서 호출된다).
 * Answer: Commander 명령 셋을 등록한다 — `kind` 목록 · 끝 판정 · 시리즈 기록·조회.
 *   시계는 주입(`deps.now`)이라 시험은 가짜 시계로 같은 경로를 지난다.
 */
import type { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { debug } from '../debug/log.js';
import { writeStdoutJson } from '../cli/stdout-json.js';
import {
  createLifeRunSeries,
  evaluateLifeEnd,
  isLifeEndEvidenceKind,
  isLifeKind,
  LIFE_END_EVIDENCE_KINDS,
  LIFE_KIND_SPECS,
  LIFE_KINDS,
  lifeKindSpec,
  type LifeEndEvidence,
  type LifeEndEvidenceKind,
  type LifeEndVerdict,
  type LifeKind,
  type LifeRunSeriesEntry,
} from './life-kinds.js';

export interface LifeCliDeps {
  /** 시계 주입 — 시험은 가짜 시계를 넣는다. */
  now?: () => Date;
  out?: Pick<Console, 'log' | 'error'>;
}

function requireLifeKind(raw: string): LifeKind {
  if (!isLifeKind(raw)) throw new Error(`생애 종류가 아니다: ${raw} — ${LIFE_KINDS.join('|')} 중 하나여야 한다`);
  return raw;
}

/**
 * `--evidence pr:1234,artifact:out/report.md` 를 증거 목록으로 판다.
 * 참조에는 쉼표가 들어갈 수 없고(`:`) 첫 콜론만 구분자다 — URL 의 `https://` 는 참조 쪽에 남는다.
 */
export function parseLifeEndEvidenceFlag(raw: string | undefined): LifeEndEvidence[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((item) => {
    const text = item.trim();
    const separator = text.indexOf(':');
    if (separator <= 0) throw new Error(`증거는 <종류>:<참조> 꼴이어야 한다: ${text}`);
    const kind = text.slice(0, separator).trim();
    const ref = text.slice(separator + 1).trim();
    if (!isLifeEndEvidenceKind(kind)) throw new Error(`증거 종류가 아니다: ${kind} — ${LIFE_END_EVIDENCE_KINDS.join('|')} 중 하나여야 한다`);
    if (ref === '') throw new Error(`증거 참조가 비었다: ${text}`);
    return { kind: kind as LifeEndEvidenceKind, ref };
  });
}

export function formatLifeEndVerdict(verdict: LifeEndVerdict): string {
  const spec = lifeKindSpec(verdict.kind);
  const state = verdict.satisfied ? '충족' : `미충족 · 빠짐 ${verdict.missing.join(',') || '-'}`;
  return `${verdict.kind} · ${spec.label} · 필요 증거 ${verdict.required.join(',')} · ${state}`;
}

function parseStoredSeries(path: string, raw: string): LifeRunSeriesEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`생애 시리즈 파일이 JSON 이 아니다: ${path}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`생애 시리즈 파일은 배열이어야 한다: ${path}`);
  const seenSequences = new Set<string>();
  return parsed.map((item, index) => {
    const row = item as Partial<LifeRunSeriesEntry> | undefined;
    if (!row || typeof row !== 'object') throw new Error(`생애 시리즈 ${index + 1}번째 항목이 객체가 아니다: ${path}`);
    if (typeof row.kind !== 'string' || !isLifeKind(row.kind)) throw new Error(`생애 시리즈 ${index + 1}번째 항목의 종류가 잘못됐다: ${path}`);
    if (!Number.isInteger(row.seq) || (row.seq as number) < 1) throw new Error(`생애 시리즈 ${index + 1}번째 항목의 seq 가 잘못됐다: ${path}`);
    const sequenceKey = `${row.kind}:${row.seq}`;
    if (seenSequences.has(sequenceKey)) throw new Error(`생애 시리즈 ${index + 1}번째 항목의 중복 seq ${row.seq}: ${path}`);
    seenSequences.add(sequenceKey);
    if (typeof row.at !== 'string' || row.at === '') throw new Error(`생애 시리즈 ${index + 1}번째 항목의 at 이 비었다: ${path}`);
    if (typeof row.satisfied !== 'boolean') throw new Error(`생애 시리즈 ${index + 1}번째 항목의 satisfied 가 잘못됐다: ${path}`);
    const evidence = Array.isArray(row.evidence) ? row.evidence : [];
    for (const entry of evidence) {
      const item2 = entry as Partial<LifeEndEvidence> | undefined;
      if (!item2 || typeof item2.kind !== 'string' || !isLifeEndEvidenceKind(item2.kind) || typeof item2.ref !== 'string') {
        throw new Error(`생애 시리즈 ${index + 1}번째 항목의 증거가 잘못됐다: ${path}`);
      }
    }
    return {
      seq: row.seq as number,
      kind: row.kind,
      at: row.at,
      ...(typeof row.note === 'string' ? { note: row.note } : {}),
      evidence: evidence.map((entry) => ({ kind: (entry as LifeEndEvidence).kind, ref: (entry as LifeEndEvidence).ref })),
      satisfied: row.satisfied as boolean,
    };
  });
}

export function registerLifeCommands(program: Command, deps: LifeCliDeps = {}): void {
  const out = deps.out ?? console;
  const now = deps.now ?? (() => new Date());
  const lifeCmd = program.command('life').description('생애 종류 · 종류별 끝의 증거 · 반복 실행 시리즈');

  lifeCmd.command('kinds')
    .description('생애 종류(dev·run·ops·admin)와 종류별 끝의 증거를 보여 준다')
    .option('--json', 'JSON 출력')
    .action(async (opts: { json?: boolean }) => {
      const rows = LIFE_KIND_SPECS.map((spec) => ({ kind: spec.kind, label: spec.label, endsWith: [...spec.endsWith] }));
      await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('cli');
      debug.log('life.cli', 'kinds-listed', { count: rows.length });
      if (opts.json) {
        await writeStdoutJson(JSON.stringify(rows) + '\n');
        return;
      }
      for (const row of rows) out.log(`${row.kind} · ${row.label} · 끝의 증거 ${row.endsWith.join(',')}`);
    });

  lifeCmd.command('check <kind>')
    .description('한 생애 종류의 끝이 증거로 충족되는지 판정한다')
    .option('--evidence <list>', '끝의 증거 — <종류>:<참조> 를 쉼표로 잇는다(pr·artifact·state-measurement·proof)')
    .option('--json', 'JSON 출력')
    .action(async (rawKind: string, opts: { evidence?: string; json?: boolean }) => {
      const kind = requireLifeKind(rawKind);
      const verdict = evaluateLifeEnd(kind, parseLifeEndEvidenceFlag(opts.evidence));
      if (!verdict.satisfied) process.exitCode = 1;
      if (opts.json) {
        await writeStdoutJson(JSON.stringify(verdict) + '\n');
        return;
      }
      out.log(formatLifeEndVerdict(verdict));
    });

  lifeCmd.command('series <kind>')
    .description('같은 종류의 반복 실행 시리즈를 기록하고 조회한다')
    .option('--add <note>', '이번 실행을 시리즈에 덧붙인다(한 줄 메모)')
    .option('--evidence <list>', '이번 실행의 끝의 증거 — <종류>:<참조> 를 쉼표로 잇는다')
    .option('--file <path>', '시리즈를 이 JSON 파일에 이어 쓴다(없으면 그 자리에서만 산다)')
    .option('--seq <n>', '그 종류의 한 칸만 본다')
    .option('--json', 'JSON 출력')
    .action(async (rawKind: string, opts: { add?: string; evidence?: string; file?: string; seq?: string; json?: boolean }) => {
      const kind = requireLifeKind(rawKind);
      const stored = opts.file && existsSync(opts.file) ? parseStoredSeries(opts.file, readFileSync(opts.file, 'utf8')) : [];
      const series = createLifeRunSeries({ now, entries: stored });
      if (opts.add !== undefined || opts.evidence !== undefined) {
        series.append({ kind, ...(opts.add === undefined ? {} : { note: opts.add }), evidence: parseLifeEndEvidenceFlag(opts.evidence) });
        if (opts.file) {
          mkdirSync(dirname(opts.file), { recursive: true });
          writeFileSync(opts.file, JSON.stringify(series.list(), null, 2) + '\n');
        }
      }
      let rows = series.list(kind);
      if (opts.seq !== undefined) {
        const seq = Number(opts.seq);
        if (!Number.isInteger(seq) || seq < 1) throw new Error('--seq must be a positive integer');
        const found = series.lookup({ kind, seq });
        rows = found === undefined ? [] : [found];
        if (found === undefined) process.exitCode = 1;
      }
      if (opts.json) {
        await writeStdoutJson(JSON.stringify(rows) + '\n');
        return;
      }
      for (const row of rows) out.log(`${row.seq}. ${row.at} · ${row.kind} · ${row.satisfied ? '끝 충족' : '끝 미충족'}${row.note ? ` · ${row.note}` : ''}`);
    });
}
