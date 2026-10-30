/**
 * COORD-ENTRANCE-FOLD · 0.2.42 칸 · TASK-AGENT(OP 디스패처) — 조율자 그림자 모듈 계약 시험.
 *
 * 완료 경계 실물: 조율자 그림자가 ④ 빌더로 같은 칸·같은 지시서를 달력 기준 3일 연속
 * 디스패치하면 «셸 디스패처 은퇴» 결정 카드를 원장에 정확히 1장 기록한다.
 * 무대: mock 시나리오 + 격리 임시 루트/원장 + 가짜 시계 — 생산 호출 경로
 * (tick() → 그림자 디스패치 원장 판독 → DecisionLedger.raise)를 그대로 통과한다.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coordinatorShadowJournalPath,
  detectBuilderThreeDayStreak,
  detectBuilderThreeDayStreaks,
  retirementCardStamp,
  resolveCoordinatorShadowRoot,
  tick,
  type CoordinatorShadowDispatch,
} from './coordinator-shadow.js';
import { DecisionLedger } from '../../decisions/decision-ledger.js';

const CELL = 'src/loops/orchestrator/coordinator-shadow.ts';
const DIRECTIVE = 'DIR-coord-entrance-fold-shadow';
const now = (): Date => new Date('2026-02-02T09:00:00Z');

const row = (date: string, overrides: Partial<CoordinatorShadowDispatch> = {}): CoordinatorShadowDispatch =>
  ({ date, agent: 'b4', cell: CELL, directive: DIRECTIVE, ...overrides });

interface Staged {
  root: string;
  stateDir: string;
}

/** 그림자 디스패치 원장 파일을 임시 루트에 준비한다(문자열 행은 그대로 기록해 파손 행을 흉낸다). */
const stage = (rows: readonly unknown[]): Staged => {
  const root = mkdtempSync(join(tmpdir(), 'coord-shadow-module-'));
  mkdirSync(join(root, 'seat-state', 'OP'), { recursive: true });
  writeFileSync(
    coordinatorShadowJournalPath(root),
    rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n',
    'utf8',
  );
  return { root, stateDir: join(root, '.elanous-state') };
};

const cleanup = (staged: Staged): void => rmSync(staged.root, { recursive: true, force: true });

const retirementCards = (stateDir: string) =>
  new DecisionLedger({ stateDir, now }).list({ status: 'all' })
    .filter(entry => entry.title.startsWith('셸 디스패처 은퇴'));

describe('COORD-ENTRANCE-FOLD · 조율자 그림자 모듈 계약 (coordinator-shadow.ts)', () => {
  test('저장소 하위 디렉터리에서 시작해도 그림자 원장 루트는 checkout 루트다', () => {
    const root = mkdtempSync(join(tmpdir(), 'coord-shadow-repo-root-'));
    const nested = join(root, 'packages', 'nested');
    mkdirSync(nested, { recursive: true });
    const init = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    try {
      expect(init.status).toBe(0);
      expect(resolveCoordinatorShadowRoot(nested)).toBe(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('그림자 디스패치 원장 파일에서 ④ 빌더 같은 칸·같은 지시서 3일 연속 → 은퇴 결정 카드를 원장에 정확히 1장', async () => {
    const staged = stage([
      // 생산 원장 별칭 형식(day/target/lane/directiveId) + 파손 행은 판독에서 건너뛴다.
      '{"day":"2026-01-31","target":"b4","lane":"' + CELL + '","directiveId":"' + DIRECTIVE + '"}',
      'not-json-at-all',
      row('2026-02-01'),
      row('2026-02-02'),
    ]);
    try {
      const first = await tick({ root: staged.root, stateDir: staged.stateDir, now });
      expect(first.checked).toBe('2026-02-02');
      expect(first.evidence?.dates).toEqual(['2026-01-31', '2026-02-01', '2026-02-02']);
      expect(first.evidence?.agent).toBe('b4');
      const raised = retirementCards(staged.stateDir);
      expect(raised.length).toBe(1);
      expect(raised[0].refs).toContain(retirementCardStamp(first.evidence!));
      expect(first.cardId).toBe(raised[0].id);
      const again = await tick({ root: staged.root, stateDir: staged.stateDir, now });
      expect(again.skipped).toBe('duplicate');
      expect(again.cardId).toBe(raised[0].id);
      expect(retirementCards(staged.stateDir).length).toBe(1);
    } finally { cleanup(staged); }
  }, 30000);

  test('연속 끊김(무디스패치·다른 지시서·다른 칸·비빌더)이면 카드를 올리지 않는다', async () => {
    for (const rows of [
      [row('2026-01-31'), row('2026-02-02')],
      [row('2026-01-31'), row('2026-02-01'), row('2026-02-02', { directive: 'DIR-other' })],
      [row('2026-01-31'), row('2026-02-01'), row('2026-02-02', { cell: 'src/other.ts' })],
      [row('2026-01-31', { agent: 'builder-3' }), row('2026-02-01', { agent: 'builder-3' }), row('2026-02-02', { agent: 'builder-3' })],
      [],
    ]) {
      const staged = stage(rows);
      try {
        const result = await tick({ root: staged.root, stateDir: staged.stateDir, now });
        expect(result.evidence).toBeNull();
        expect(result.cardId).toBeUndefined();
        expect(retirementCards(staged.stateDir).length).toBe(0);
      } finally { cleanup(staged); }
    }
  });

  test('같은 3일 창에 복수 칸·지시서 쌍이 충족되면 각 쌍의 카드를 하나씩 올린다', async () => {
    const otherCell = 'src/loops/orchestrator/tick.ts';
    const staged = stage([
      row('2026-01-31'), row('2026-02-01'), row('2026-02-02'),
      row('2026-01-31', { cell: otherCell, directive: 'DIR-second' }),
      row('2026-02-01', { cell: otherCell, directive: 'DIR-second' }),
      row('2026-02-02', { cell: otherCell, directive: 'DIR-second' }),
    ]);
    try {
      const matches = detectBuilderThreeDayStreaks(
        [...[row('2026-01-31'), row('2026-02-01'), row('2026-02-02')],
          ...[row('2026-01-31', { cell: otherCell, directive: 'DIR-second' }),
            row('2026-02-01', { cell: otherCell, directive: 'DIR-second' }),
            row('2026-02-02', { cell: otherCell, directive: 'DIR-second' })]],
        '2026-02-02',
      );
      expect(matches).toHaveLength(2);
      const result = await tick({ root: staged.root, stateDir: staged.stateDir, now });
      expect(result.cardId).toBeDefined();
      expect(retirementCards(staged.stateDir)).toHaveLength(2);
      const again = await tick({ root: staged.root, stateDir: staged.stateDir, now });
      expect(again.skipped).toBe('duplicate');
      expect(retirementCards(staged.stateDir)).toHaveLength(2);
    } finally { cleanup(staged); }
  }, 30_000);

  test('원장 배포 전 recipient 누락 행과 새 recipient 포함 행은 같은 연속 streak로 합친다', async () => {
    const staged = stage([]);
    const dispatches = [
      row('2026-01-31'),
      row('2026-02-01', { recipient: 'UX' }),
      row('2026-02-02', { recipient: 'UX' }),
    ];
    try {
      const matches = detectBuilderThreeDayStreaks(dispatches, '2026-02-02');
      expect(matches).toHaveLength(1);
      expect(matches[0]?.recipient).toBe('UX');
      const result = await tick({ root: staged.root, stateDir: staged.stateDir, dispatches, now });
      expect(result.evidence?.recipient).toBe('UX');
      expect(retirementCards(staged.stateDir)[0]?.refs).toContain('recipient:UX');
    } finally { cleanup(staged); }
  }, 20_000);

  test('recipient는 연속 판정 3일 창 안의 기록에서만 가져온다', () => {
    const dispatches = [
      row('2026-01-31', { recipient: 'UX' }),
      row('2026-02-01'),
      row('2026-02-02'),
      row('2026-02-03', { recipient: 'MK' }),
      row('2026-02-04'),
    ];
    expect(detectBuilderThreeDayStreaks(dispatches, '2026-02-02')[0]?.recipient).toBe('UX');
    expect(detectBuilderThreeDayStreaks(dispatches, '2026-02-04')[0]?.recipient).toBe('MK');
  });

  test('같은 ④ 빌더의 허용 표기 변형은 연속 streak 하나로 묶는다', () => {
    const dispatches = [
      row('2026-01-31', { agent: 'builder-4' }),
      row('2026-02-01', { agent: 'Builder_4' }),
      row('2026-02-02', { agent: 'b4' }),
    ];
    expect(detectBuilderThreeDayStreaks(dispatches, '2026-02-02')).toHaveLength(1);
  });

  test('두 독립 프로세스가 같은 tick을 동시에 실행해도 동일 카드 하나만 남긴다', async () => {
    const staged = stage([row('2026-01-31'), row('2026-02-01'), row('2026-02-02')]);
    const readyA = join(staged.root, 'ready-a');
    const readyB = join(staged.root, 'ready-b');
    const go = join(staged.root, 'go');
    const script = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const root = process.env.COORD_ROOT;
      const id = process.env.COORD_CHILD_ID;
      writeFileSync(join(root, 'ready-' + id), 'ready');
      while (!existsSync(join(root, 'go'))) await new Promise(resolve => setTimeout(resolve, 5));
      const { tick } = await import(process.env.COORD_MODULE);
      const result = await tick({ root, stateDir: process.env.ELANOUS_STATE_DIR, now: () => new Date('2026-02-02T09:00:00Z') });
      console.log(JSON.stringify(result));
    `;
    const envFor = (id: string): Record<string, string> => {
      const env = {
      ...process.env,
      COORD_ROOT: staged.root,
      COORD_CHILD_ID: id,
      COORD_MODULE: join(import.meta.dir, 'coordinator-shadow.ts'),
      ELANOUS_STATE_DIR: staged.stateDir,
      } as Record<string, string>;
      // Sharded tests inject a private config dir; a child with a different state dir must not inherit it.
      delete env.ELANOUS_CONFIG_DIR;
      return env;
    };
    const children = [
      Bun.spawn([process.execPath, '-e', script], { cwd: staged.root, env: envFor('a'), stdout: 'pipe', stderr: 'pipe' }),
      Bun.spawn([process.execPath, '-e', script], { cwd: staged.root, env: envFor('b'), stdout: 'pipe', stderr: 'pipe' }),
    ];
    try {
      const deadline = Date.now() + 10_000;
      while ((!existsSync(readyA) || !existsSync(readyB)) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(readyA)).toBe(true);
      expect(existsSync(readyB)).toBe(true);
      writeFileSync(go, 'go');
      const outputs = await Promise.all(children.map(async child => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe('');
        expect(exitCode).toBe(0);
        return JSON.parse(stdout.trim()) as { cardId?: string };
      }));
      expect(outputs[0]?.cardId).toBeDefined();
      expect(outputs[1]?.cardId).toBe(outputs[0]?.cardId);
      expect(retirementCards(staged.stateDir)).toHaveLength(1);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      cleanup(staged);
    }
  }, 60_000);

  test('월 경계 창(1월31→2월2)은 주입 행으로도 성립하고 스탬프는 칸·지시서마다 한 장이다', async () => {
    const dispatches = [row('2026-01-31'), row('2026-02-01'), row('2026-02-02')];
    const evidence = detectBuilderThreeDayStreak(dispatches, '2026-02-02');
    expect(evidence?.dates).toEqual(['2026-01-31', '2026-02-01', '2026-02-02']);
    expect(retirementCardStamp(evidence!))
      .toBe('coordinator-shadow-streak:' + CELL + ':' + DIRECTIVE);
    const staged = stage([]);
    try {
      const result = await tick({ root: staged.root, stateDir: staged.stateDir, dispatches, now });
      expect(result.cardId).toBeDefined();
      const raised = retirementCards(staged.stateDir);
      expect(raised.length).toBe(1);
      expect(raised[0].refs).toContain('dates:2026-01-31,2026-02-01,2026-02-02');
    } finally { cleanup(staged); }
  }, 30000);

  test('동시 tick 두 개도 DecisionLedger의 원자 raiseOnce로 같은 카드 한 장만 받는다', async () => {
    const staged = stage([row('2026-01-31'), row('2026-02-01'), row('2026-02-02')]);
    try {
      const results = await Promise.all([
        tick({ root: staged.root, stateDir: staged.stateDir, now }),
        tick({ root: staged.root, stateDir: staged.stateDir, now }),
      ]);
      expect(results[0]?.cardId).toBeDefined();
      expect(results[1]?.cardId).toBe(results[0]?.cardId);
      expect(retirementCards(staged.stateDir).length).toBe(1);
    } finally { cleanup(staged); }
  }, 30000);

  test('원장 `null`(유효 JSON) 한 줄도 파손 행으로 건너뛴다 — throw 없이 유효 행만 판독한다', async () => {
    const staged = stage([
      row('2026-01-31'),
      'null',
      row('2026-02-01'),
      'null',
      row('2026-02-02'),
    ]);
    try {
      const result = await tick({ root: staged.root, stateDir: staged.stateDir, now });
      expect(result.checked).toBe('2026-02-02');
      expect(result.evidence?.dates).toEqual(['2026-01-31', '2026-02-01', '2026-02-02']);
      expect(result.cardId).toBeDefined();
      expect(retirementCards(staged.stateDir).length).toBe(1);
    } finally { cleanup(staged); }
  }, 30000);

  test('원장 부재·전 행 파손 상태에서도 throw 없이 빈 판독으로 끝난다', async () => {
    const absent = mkdtempSync(join(tmpdir(), 'coord-shadow-absent-'));
    try {
      const result = await tick({ root: absent, stateDir: join(absent, '.elanous-state'), now });
      expect(result.checked).toBe('2026-02-02');
      expect(result.evidence).toBeNull();
      expect(result.cardId).toBeUndefined();
    } finally { rmSync(absent, { recursive: true, force: true }); }
    const staged = stage(['not-json-at-all', 'null', '123', 'true', '"text"', '[]', '{}']);
    try {
      const result = await tick({ root: staged.root, stateDir: staged.stateDir, now });
      expect(result.evidence).toBeNull();
      expect(result.cardId).toBeUndefined();
      expect(retirementCards(staged.stateDir).length).toBe(0);
    } finally { cleanup(staged); }
  });
});
