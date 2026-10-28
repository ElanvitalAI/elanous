// COORD-DIRECTIVE-AUDIT — 지시 원장 행마다 «로직 점검» 을 실제로 실행하는 감사기.
//
// 입력: seat-state/OP/directives/CEO-VERBATIM-*.jsonl (ts·kind·원문·상황)
//       ⊕ seat-state/OP/directives/DIRECTIVES-LEDGER-*.md (지시마다 «로직 점검» 열)
// 로직: 행마다 점검(원장 · 로그 · config · 원문 hash 조회) 실행 → 거짓이면 «지시 미이행» 경보 ⊕ 수리 칸 제안.
// 기록: debug.log('coordinator.directive-audit') · 경보·제안 JSONL.
// 지침 문서 확인으로 갈음하지 않는다 — 판정은 이 코드가 돌려 만든 값이다.

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { directiveHash } from './directive.js';

export const AUDIT_LOG_CATEGORY = 'coordinator.directive-audit';
export const VERBATIM_PREFIX = 'CEO-VERBATIM-';
export const LEDGER_PREFIX = 'DIRECTIVES-LEDGER-';
export const ALERTS_FILE = 'DIRECTIVE-AUDIT-ALERTS.jsonl';
export const PROPOSALS_FILE = 'DIRECTIVE-REPAIR-PROPOSALS.jsonl';

const HASH_MARKER = /\[directive-hash:([0-9a-f]{64})\]/;

export interface VerbatimDirective {
  ts: string;
  kind: string;
  text: string;
  situation?: string;
  hash: string;
}

export interface LedgerRow {
  id: string;
  text: string;
  /** «로직 점검» 열 원문 — 예: `log:coordinator.tick`, `config:a.b`, `file:path`. */
  check: string;
  hash: string | null;
}

export interface CheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export interface DirectiveFinding {
  directive: string;
  hash: string | null;
  status: 'ok' | 'mismatch';
  reasons: string[];
  checks: CheckResult[];
}

export interface DirectiveAlert {
  kind: 'directive-unfulfilled';
  directive: string;
  hash: string | null;
  reasons: string[];
  at: string;
}

export interface RepairProposal {
  id: string;
  title: string;
  body: string;
  source: 'directive-audit';
  at: string;
}

export interface DirectiveAuditReport {
  at: string;
  directives: number;
  checked: number;
  passed: number;
  findings: DirectiveFinding[];
  alerts: DirectiveAlert[];
  proposals: RepairProposal[];
  logged: boolean;
}

export interface DirectiveAuditDeps {
  /** 격리 root — `file:` 점검의 기준점 겸 기본 원장 위치의 부모. */
  root?: string;
  /** 원장·원문 로그가 있는 디렉터리(생략 시 `<root>/seat-state/OP/directives`). */
  dir?: string;
  now?: () => Date;
  readFile?: (path: string) => string | null;
  listFiles?: (path: string) => string[];
  /** config 조회(점 표기 키). 기본은 환경 변수 조회. */
  config?: (key: string) => string | undefined;
  /** 로그 조회. 기본은 debug 링 버퍼 꼬리. */
  logLines?: () => string[];
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  recordAlert?: (alert: DirectiveAlert) => void;
  proposeRepair?: (proposal: RepairProposal) => void;
}

const readFileOrNull = (path: string): string | null => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

const listFilesIn = (path: string): string[] => {
  try { return readdirSync(path).sort(); } catch { return []; }
};

/** 원문 jsonl → 지시 행. 행 식별자는 기존 `directiveHash` 규약(NFKC·공백압축·소문자)을 그대로 쓴다. */
export function parseVerbatimJsonl(body: string): VerbatimDirective[] {
  const out: VerbatimDirective[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const text = typeof row.text === 'string' ? row.text : typeof row['원문'] === 'string' ? (row['원문'] as string) : '';
    const ts = typeof row.ts === 'string' ? row.ts : '';
    if (text.trim() === '') continue;
    out.push({
      ts,
      kind: typeof row.kind === 'string' ? row.kind : 'directive',
      text,
      ...(typeof row.situation === 'string' ? { situation: row.situation } : {}),
      hash: directiveHash(text),
    });
  }
  return out;
}

const cells = (line: string): string[] =>
  line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

const isSeparator = (line: string): boolean => {
  const parts = cells(line);
  return parts.length > 0 && parts.every(part => /^:?-{2,}:?$/.test(part));
};

/** 원장 마크다운 → 행. «로직 점검» 열과 `[directive-hash:<hash>]` 표기를 그대로 읽는다. */
export function parseDirectivesLedger(body: string): LedgerRow[] {
  const lines = body.split('\n');
  const headerAt = lines.findIndex(line => line.trim().startsWith('|') && line.includes('로직 점검'));
  if (headerAt < 0) return [];
  const header = cells(lines[headerAt]!);
  const checkIdx = header.findIndex(cell => cell.includes('로직 점검'));
  const textIdx = header.findIndex(cell => cell.includes('원문'));
  const hashIdx = header.findIndex(cell => /해시|hash/i.test(cell));
  const idIdx = header.findIndex(cell => cell !== '' && !cell.includes('로직 점검') && !cell.includes('원문') && !/해시|hash/i.test(cell));

  const rows: LedgerRow[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (rows.length > 0) break;
      continue;
    }
    if (isSeparator(trimmed)) continue;
    const parts = cells(trimmed);
    if (parts.every(part => part === '')) continue;
    const marker = HASH_MARKER.exec(trimmed);
    const hashCell = hashIdx >= 0 ? parts[hashIdx] ?? '' : '';
    const cellMarker = HASH_MARKER.exec(hashCell);
    const hash = cellMarker ? cellMarker[1]! : marker ? marker[1]! : null;
    const id = (idIdx >= 0 ? parts[idIdx] ?? '' : '').replace(HASH_MARKER, '').trim();
    const textCell = (textIdx >= 0 ? parts[textIdx] ?? '' : '').replace(/<!--[\s\S]*?-->/g, '').trim();
    rows.push({
      id: id !== '' ? id : textCell,
      text: textCell !== '' ? textCell : id,
      check: (parts[checkIdx] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim(),
      hash,
    });
  }
  return rows;
}

const envConfig = (key: string): string | undefined => {
  const direct = process.env[key];
  if (direct !== undefined && direct !== '') return direct;
  const mangled = `ELANOUS_${key.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
  const viaEnv = process.env[mangled];
  return viaEnv !== undefined && viaEnv !== '' ? viaEnv : undefined;
};

interface CheckContext {
  baseDir: string;
  dir: string;
  read: (path: string) => string | null;
  config: (key: string) => string | undefined;
  logLines: () => string[];
  verbatimHashes: Set<string>;
}

/** 점검 한 줄 실행 — 원장·로그·config·원문 hash 조회. */
export function runCheck(check: string, ctx: CheckContext): CheckResult {
  const spec = check.trim();
  if (spec === '') return { check, ok: false, detail: '점검 없음 — 로직 점검 열이 비어 있다' };

  const [kind, ...rest] = spec.split(':');
  const arg = rest.join(':').trim();

  if (kind === 'log') {
    if (arg === '') return { check, ok: false, detail: 'log 점검에 카테고리가 없다' };
    const hit = ctx.logLines().some(line => line.includes(arg));
    return { check, ok: hit, detail: hit ? `로그에 ${arg} 발견` : `로그에 ${arg} 없음` };
  }

  if (kind === 'config') {
    const [key, expected] = arg.split('=');
    const value = ctx.config((key ?? '').trim());
    const absent = value === undefined || value === '';
    const ok = !absent && (expected === undefined || value === expected.trim());
    return { check, ok, detail: absent ? `config ${key} 없음` : `config ${key}=${value}` };
  }

  if (kind === 'file') {
    const body = ctx.read(arg.startsWith('/') ? arg : join(ctx.baseDir, arg));
    const ok = body !== null && body.trim() !== '';
    return { check, ok, detail: ok ? `파일 ${arg} 존재` : `파일 ${arg} 없음` };
  }

  if (kind === 'hash') {
    const ok = ctx.verbatimHashes.has(arg);
    return { check, ok, detail: ok ? `원문 hash ${arg.slice(0, 12)} 확인` : `원문 hash ${arg.slice(0, 12)} 없음` };
  }

  return { check, ok: false, detail: `알 수 없는 점검 형식: ${spec}` };
}

const defaultDir = (root: string | undefined): string =>
  join(root ?? process.cwd(), 'seat-state', 'OP', 'directives');

function buildContext(deps: DirectiveAuditDeps, dir: string, verbatimHashes: Set<string>): CheckContext {
  return {
    baseDir: deps.root ?? dir,
    dir,
    read: deps.readFile ?? readFileOrNull,
    config: deps.config ?? envConfig,
    logLines: deps.logLines ?? (() => debug.tail(400)),
    verbatimHashes,
  };
}

const proposalId = (hash: string | null, directive: string): string =>
  `DIRREPAIR-${(hash ?? directiveHash(directive)).slice(0, 8)}`;

/** 부작용 없는 점검 — 보고서만 만든다. */
export function inspectDirectives(deps: DirectiveAuditDeps = {}): DirectiveAuditReport {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const dir = deps.dir ?? defaultDir(deps.root);
  const list = deps.listFiles ?? listFilesIn;
  const read = deps.readFile ?? readFileOrNull;

  const names = list(dir);
  const verbatim = names
    .filter(name => name.startsWith(VERBATIM_PREFIX) && name.endsWith('.jsonl'))
    .flatMap(name => parseVerbatimJsonl(read(join(dir, name)) ?? ''));
  const rows = names
    .filter(name => name.startsWith(LEDGER_PREFIX) && name.endsWith('.md'))
    .flatMap(name => parseDirectivesLedger(read(join(dir, name)) ?? ''));

  const verbatimHashes = new Set(verbatim.map(row => row.hash));
  const ctx = buildContext(deps, dir, verbatimHashes);
  const findings: DirectiveFinding[] = [];
  const alerts: DirectiveAlert[] = [];
  const proposals: RepairProposal[] = [];

  const alert = (directive: string, hash: string | null, reasons: string[], checks: CheckResult[]) => {
    findings.push({ directive, hash, status: 'mismatch', reasons, checks });
    alerts.push({ kind: 'directive-unfulfilled', directive, hash, reasons, at });
    proposals.push({
      id: proposalId(hash, directive),
      title: `[수리 칸 제안] 지시 미이행 — ${directive}`,
      body: [
        `지시: ${directive}`,
        hash === null ? 'directive-hash: (없음)' : `directive-hash: ${hash}`,
        `불일치: ${reasons.join(' / ')}`,
        '조치: 원장 «로직 점검» 열을 실제 근거(로그·config·산출물)로 고치거나, 지시를 이행한 뒤 근거를 남긴다.',
      ].join('\n'),
      source: 'directive-audit',
      at,
    });
  };

  for (const row of rows) {
    const checks: CheckResult[] = [];
    const reasons: string[] = [];
    if (row.check === '') {
      reasons.push('로직 점검 열이 비어 있다');
    } else {
      const result = runCheck(row.check, ctx);
      checks.push(result);
      if (!result.ok) reasons.push(`로직 점검 실패: ${row.check}`);
    }
    if (row.hash !== null && !verbatimHashes.has(row.hash)) {
      reasons.push(`원문 로그에 없는 directive-hash: ${row.hash}`);
    }
    if (reasons.length > 0) {
      alert(row.id, row.hash, reasons, checks);
    } else {
      findings.push({ directive: row.id, hash: row.hash, status: 'ok', reasons, checks });
    }
  }

  for (const verbatimRow of verbatim) {
    const covered = rows.some(row => row.hash === verbatimRow.hash);
    if (covered) continue;
    alert(verbatimRow.text, verbatimRow.hash, ['원장 행 없음 — 로직 점검 열이 없다'], []);
  }

  const checked = findings.filter(finding => finding.checks.length > 0).length;
  const passed = findings.filter(finding => finding.status === 'ok').length;

  return {
    at,
    directives: findings.length,
    checked,
    passed,
    findings,
    alerts,
    proposals,
    logged: false,
  };
}

const appendJsonl = (path: string, row: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
};

/**
 * 조율자 틱마다 부르는 감사 진입점 — 점검 실행 → 경보·수리 제안 기록 →
 * debug.log('coordinator.directive-audit').
 */
export function runDirectiveAudit(deps: DirectiveAuditDeps = {}): DirectiveAuditReport {
  const report = inspectDirectives(deps);
  if (report.directives === 0) return report;

  const dir = deps.dir ?? defaultDir(deps.root);
  const recordAlert = deps.recordAlert ?? ((alert: DirectiveAlert) => appendJsonl(join(dir, ALERTS_FILE), alert));
  const proposeRepair = deps.proposeRepair ?? ((proposal: RepairProposal) => appendJsonl(join(dir, PROPOSALS_FILE), proposal));

  for (const alert of report.alerts) recordAlert(alert);
  for (const proposal of report.proposals) proposeRepair(proposal);

  const data = {
    directives: report.directives,
    checked: report.checked,
    passed: report.passed,
    alerts: report.alerts.length,
  };
  const message = report.alerts.length === 0
    ? `지시 원장 점검 ${report.directives}행 · 불일치 0`
    : `지시 원장 점검 ${report.directives}행 · 불일치 ${report.alerts.length}`;

  const log = deps.log ?? ((category: string, event: string, payload: Record<string, unknown>) => debug.log(category, event, payload));
  log(AUDIT_LOG_CATEGORY, message, data);

  return { ...report, logged: true };
}
