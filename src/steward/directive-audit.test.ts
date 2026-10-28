// COORD-DIRECTIVE-AUDIT — 조율자 틱마다 지시 원장의 «로직 점검» 열을 실제로 실행하는 감사 장치.
//
// 무대: 격리 임시 root + 주입 가짜 원장(seat-state/OP/directives/*.md) · 가짜 원문 로그(*.jsonl) ·
//       가짜 로그 줄/ config 조회 · 호출 로그 스파이. 네트워크·시크릿은 대역을 «던지는» 함수로 바꿔 미접촉을 증명한다.
// 순서: RED(불일치 탐지·원장 없는 지시 탐지) → 원장·로그를 바로잡으면 GREEN 수렴.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directiveHash } from './directive.js';
import {
  ALERTS_FILE,
  AUDIT_LOG_CATEGORY,
  PROPOSALS_FILE,
  inspectDirectives,
  parseDirectivesLedger,
  parseVerbatimJsonl,
  runDirectiveAudit,
  type DirectiveAuditDeps,
} from './directive-audit.js';
import { runOrchestratorNode } from '../loops/orchestrator/tick.js';

const TEXT = '칸 COORD-DIRECTIVE-AUDIT 세워라 — 지시 원장 행마다 로직 점검을 돌린다';
const HASH = directiveHash(TEXT);

const verbatimLine = (text: string, ts = '2026-10-22T07:40:00+09:00') =>
  JSON.stringify({ ts, kind: 'directive', text, situation: 'MK 0.2.40 칸 COORD-DIRECTIVE-AUDIT' });

const ledgerDoc = (rows: Array<{ id: string; check: string; hash?: string }>) => [
  '# DIRECTIVES-LEDGER',
  '',
  '| 칸 | 원문 | 로직 점검 |',
  '|---|---|---|',
  ...rows.map(row => `| ${row.id} | ${TEXT} | ${row.check} |${row.hash === undefined ? '' : ` <!-- [directive-hash:${row.hash}] -->`}`),
  '',
].join('\n');

type Stage = {
  root: string;
  dir: string;
  logCalls: Array<{ category: string; event: string; data?: unknown }>;
  alerts: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
  deps: (extra?: Partial<DirectiveAuditDeps>) => DirectiveAuditDeps;
};

const stage = (files: Record<string, string>, logLines: string[], config: Record<string, string> = {}): Stage => {
  const root = mkdtempSync(join(tmpdir(), 'directive-audit-'));
  const dir = join(root, 'seat-state', 'OP', 'directives');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const logCalls: Stage['logCalls'] = [];
  const alerts: Stage['alerts'] = [];
  const proposals: Stage['proposals'] = [];
  return {
    root,
    dir,
    logCalls,
    alerts,
    proposals,
    deps: (extra = {}) => ({
      root,
      dir,
      now: () => new Date('2026-10-27T02:10:00Z'),
      logLines: () => logLines,
      config: key => config[key],
      log: (category, event, data) => logCalls.push({ category, event, data }),
      recordAlert: alert => alerts.push(alert as unknown as Record<string, unknown>),
      proposeRepair: proposal => proposals.push(proposal as unknown as Record<string, unknown>),
      ...extra,
    }),
  };
};

const close = (s: Stage) => rmSync(s.root, { recursive: true, force: true });

describe('COORD-DIRECTIVE-AUDIT — 입력 판독(원장 ⊕ 원문 로그)', () => {
  test('원문 로그 jsonl 은 ts·kind·원문을 읽고 directiveHash 로 행 식별자를 만든다', () => {
    const parsed = parseVerbatimJsonl(`${verbatimLine(TEXT)}\n`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      ts: '2026-10-22T07:40:00+09:00',
      kind: 'directive',
      text: TEXT,
      situation: 'MK 0.2.40 칸 COORD-DIRECTIVE-AUDIT',
      hash: HASH,
    });
  });

  test('원장 마크다운은 «로직 점검» 열을 행 단위로 읽고 [directive-hash] 표기를 보존한다', () => {
    const rows = parseDirectivesLedger(ledgerDoc([{ id: 'COORD-DIRECTIVE-AUDIT', check: 'log:coordinator.tick', hash: HASH }]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'COORD-DIRECTIVE-AUDIT', check: 'log:coordinator.tick', hash: HASH });
  });
});

describe('COORD-DIRECTIVE-AUDIT — RED: 근거 불일치는 «지시 미이행» 경보 ⊕ 수리 칸 제안이 된다', () => {
  test('로직 점검이 거짓이면 경보·수리 제안이 남고 debug.log(coordinator.directive-audit) 가 찍힌다', () => {
    const s = stage(
      {
        'CEO-VERBATIM-2026-10-22.jsonl': `${verbatimLine(TEXT)}\n`,
        'DIRECTIVES-LEDGER-0.2.40.md': ledgerDoc([
          { id: 'COORD-DIRECTIVE-AUDIT', check: 'log:coordinator.directive-audit', hash: HASH },
        ]),
      },
      [],                                  // 로그가 아직 없다 = 미이행
      {},                                  // config 도 비어 있다
    );
    try {
      const report = runDirectiveAudit(s.deps());

      expect(report.directives).toBe(1);
      expect(report.alerts).toHaveLength(1);
      expect(report.alerts[0]).toMatchObject({ kind: 'directive-unfulfilled', hash: HASH });
      expect(report.alerts[0]!.reasons).toEqual(['로직 점검 실패: log:coordinator.directive-audit']);
      expect(s.alerts).toHaveLength(1);
      expect(s.proposals).toHaveLength(1);
      expect(s.proposals[0]).toMatchObject({ source: 'directive-audit' });
      expect(String(s.proposals[0]!.title)).toContain('수리');
      expect(s.logCalls).toHaveLength(1);
      expect(s.logCalls[0]!.category).toBe(AUDIT_LOG_CATEGORY);
      expect(s.logCalls[0]!.data).toMatchObject({ directives: 1, checked: 1, passed: 0, alerts: 1 });
    } finally { close(s); }
  });

  test('원문 로그에 있는데 원장에 로직 점검이 없으면 경보가 선다', () => {
    const s = stage(
      { 'CEO-VERBATIM-2026-10-22.jsonl': `${verbatimLine(TEXT)}\n`, 'DIRECTIVES-LEDGER-0.2.40.md': ledgerDoc([]) },
      ['[02:00:00.000] [coordinator.tick] tick'],
    );
    try {
      const report = runDirectiveAudit(s.deps());
      expect(report.alerts).toHaveLength(1);
      expect(report.alerts[0]!.reasons).toEqual(['원장 행 없음 — 로직 점검 열이 없다']);
      expect(s.proposals).toHaveLength(1);
    } finally { close(s); }
  });

  test('directive-hash 가 원문 로그에 없으면 근거 불일치로 잡는다', () => {
    const s = stage(
      {
        'CEO-VERBATIM-2026-10-22.jsonl': `${verbatimLine(TEXT)}\n`,
        'DIRECTIVES-LEDGER-0.2.40.md': ledgerDoc([
          { id: 'COORD-DIRECTIVE-AUDIT', check: 'log:coordinator.tick', hash: 'f'.repeat(64) },
        ]),
      },
      ['[02:00:00.000] [coordinator.tick] tick'],
    );
    try {
      const report = runDirectiveAudit(s.deps());
      // 원장 행(hash 불일치) + 원장에 없는 원문 지시 — 두 사실이 모두 경보가 된다.
      expect(report.alerts).toHaveLength(2);
      expect(report.alerts.flatMap(alert => alert.reasons)).toContain(`원문 로그에 없는 directive-hash: ${'f'.repeat(64)}`);
      expect(report.alerts.flatMap(alert => alert.reasons)).toContain('원장 행 없음 — 로직 점검 열이 없다');
    } finally { close(s); }
  });
});

describe('COORD-DIRECTIVE-AUDIT — GREEN: 원장·로그를 바로잡으면 수렴한다', () => {
  test('같은 무대에서 근거를 채우면 경보 0 · 통과 보고가 찍힌다', () => {
    const s = stage(
      {
        'CEO-VERBATIM-2026-10-22.jsonl': `${verbatimLine(TEXT)}\n`,
        'DIRECTIVES-LEDGER-0.2.40.md': ledgerDoc([
          { id: 'COORD-DIRECTIVE-AUDIT', check: 'log:coordinator.directive-audit', hash: HASH },
        ]),
      },
      [], {},
    );
    try {
      const red = runDirectiveAudit(s.deps());
      expect(red.alerts).toHaveLength(1);

      // 원장을 바로잡는다 — 점검이 실제로 실행됐음을 로그가 말한다.
      const fixed = s.deps({ logLines: () => ['[02:10:00.000] [coordinator.directive-audit] 지시 원장 점검 1행 · 불일치 0'] });
      const green = runDirectiveAudit(fixed);

      expect(green.alerts).toHaveLength(0);
      expect(green.proposals).toHaveLength(0);
      expect(green.findings[0]).toMatchObject({ status: 'ok', hash: HASH });
      expect(s.logCalls.at(-1)!.data).toMatchObject({ checked: 1, passed: 1, alerts: 0 });
    } finally { close(s); }
  });

  test('config·file 점검도 실행된다(원장·로그·config 조회)', () => {
    const s = stage(
      {
        'CEO-VERBATIM-2026-10-22.jsonl': `${verbatimLine(TEXT)}\n`,
        'DIRECTIVES-LEDGER-0.2.40.md': ledgerDoc([
          { id: 'C1', check: 'config:coordinator.directiveAudit=true', hash: HASH },
          { id: 'C2', check: 'file:seat-state/OP/directives/COORD-DIRECTIVE-AUDIT.md', hash: HASH },
        ]),
      },
      [],
      { 'coordinator.directiveAudit': 'true' },
    );
    writeFileSync(join(s.dir, 'COORD-DIRECTIVE-AUDIT.md'), 'proof\n');
    try {
      const report = inspectDirectives(s.deps());
      expect(report.alerts).toHaveLength(0);
      expect(report.findings).toHaveLength(2);
      expect(report.findings.every(f => f.status === 'ok')).toBe(true);
    } finally { close(s); }
  });
});

describe('COORD-DIRECTIVE-AUDIT — 네트워크·시크릿 미접촉', () => {
  test('감사 한 바퀴에 fetch 를 건드리지 않는다', () => {
    const s = stage(
      {
        'CEO-VERBATIM-2026-10-22.jsonl': `${verbatimLine(TEXT)}\n`,
        'DIRECTIVES-LEDGER-0.2.40.md': ledgerDoc([
          { id: 'COORD-DIRECTIVE-AUDIT', check: 'log:coordinator.directive-audit', hash: HASH },
        ]),
      },
      [],
    );
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error('audit must not touch the network'); }) as unknown as typeof fetch;
    try {
      runDirectiveAudit(s.deps());
      expect(calls).toBe(0);
    } finally { globalThis.fetch = originalFetch; close(s); }
  });

  test('원장·원문 로그가 없으면 아무것도 쓰지 않고 조용히 끝난다', () => {
    const s = stage({}, []);
    try {
      const report = runDirectiveAudit(s.deps());
      expect(report).toMatchObject({ directives: 0, alerts: [], proposals: [], logged: false });
      expect(existsSync(join(s.dir, ALERTS_FILE))).toBe(false);
      expect(existsSync(join(s.dir, PROPOSALS_FILE))).toBe(false);
    } finally { close(s); }
  });
});

describe('COORD-DIRECTIVE-AUDIT — 생산 진입점(조율자 틱 report 노드)에서 실제로 돈다', () => {
  test('runOrchestratorNode(report, live) 가 감사를 호출해 경보를 남긴다', async () => {
    const s = stage(
      {
        'CEO-VERBATIM-2026-10-22.jsonl': `${verbatimLine(TEXT)}\n`,
        'DIRECTIVES-LEDGER-0.2.40.md': ledgerDoc([
          { id: 'COORD-DIRECTIVE-AUDIT', check: 'log:coordinator.directive-audit', hash: HASH },
        ]),
      },
      [],
    );
    const now = new Date('2026-10-27T02:10:00Z');
    try {
      await runOrchestratorNode('intake', { root: s.root, runId: 'directive-audit-wire', window: '08', mode: 'live', now, print: () => {} });
      const statePath = join(s.root, 'loop', 'orchestrator', 'directive-audit-wire.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state.nodes = { intake: 'ok', split: 'ok', place: 'ok', delegate: 'ok', launch: 'ok', reconcile: 'ok' };
      writeFileSync(statePath, JSON.stringify(state));

      await runOrchestratorNode('report', {
        root: s.root, runId: 'directive-audit-wire', window: '08', mode: 'live', now, print: () => {},
        directiveAudit: s.deps(),
      });

      expect(s.logCalls.some(call => call.category === AUDIT_LOG_CATEGORY)).toBe(true);
      expect(s.alerts).toHaveLength(1);
    } finally { close(s); }
  });
});
