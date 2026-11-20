import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPr, planLandingTick, releaseHand, runLandingTick, type Hand, type QueuedPr } from './land-hands';

const T0 = 1_763_600_000_000;
const alive = () => true;
const row = (pr: string, files: string[] | null, queuedAt = T0): QueuedPr => ({ pr, head: `${pr}aaaa`, queuedAt, files });

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function slots(): string { const d = mkdtempSync(join(tmpdir(), 'land-hands-')); dirs.push(d); return d; }

function deps(dir: string, pid = 4242) {
  const baselines: string[][] = [];
  const landed: string[][] = [];
  return { baselines, landed, d: { slotsDir: dir, now: () => T0, pid, isAlive: alive,
    measureBaseline: (h: Hand) => { baselines.push(h.prs); }, land: (h: Hand) => { landed.push(h.prs); } } };
}

describe('classifyPr', () => {
  test('시험 전용 · 문서 전용 · 코드', () => {
    expect(classifyPr(['src/a.test.ts', 'test/rules-contract.test.ts'])).toBe('test-only');
    expect(classifyPr(['docs/conductor/X.md'])).toBe('docs-only');
    expect(classifyPr(['src/a.test.ts', 'src/a.ts'])).toBe('code');
    expect(classifyPr(['docs/x.md', 'src/a.test.ts'])).toBe('code');
    expect(classifyPr([])).toBe('code');
  });
});

describe('planLandingTick', () => {
  test('독립 코드 PR 둘은 같은 틱에 두 손 · 셋째는 슬롯 대기', () => {
    const plan = planLandingTick([row('101', ['src/a.ts']), row('102', ['src/b.ts']), row('103', ['src/c.ts'])], [], T0, alive);
    expect(plan.hands.map((h) => [h.kind, h.prs])).toEqual([['code', ['101']], ['code', ['102']]]);
    expect(plan.waiting).toEqual([{ pr: '103', reason: 'slots-full' }]);
  });

  test('보유 슬롯 하나면 손 하나만 더 · 겹치는 PR 은 건너뛰고 다음 독립 PR', () => {
    const held = [{ name: 'OP-90', prs: ['90'], files: ['src/a.ts'], pid: 7 }];
    const plan = planLandingTick([row('101', ['src/a.ts']), row('102', ['src/b.ts'])], held, T0, alive);
    expect(plan.hands.map((h) => h.prs)).toEqual([['102']]);
    expect(plan.waiting).toEqual([{ pr: '101', reason: 'file-overlap' }]);
  });

  test('시험 전용 PR 3개는 한 열차 · 기준선 1', () => {
    const plan = planLandingTick([row('201', ['src/x.test.ts']), row('202', ['test/y.test.ts']), row('203', ['scripts/z.test.ts'])], [], T0, alive);
    expect(plan.hands).toEqual([{ kind: 'light-train', prs: ['201', '202', '203'], baselines: 1,
      files: ['scripts/z.test.ts', 'src/x.test.ts', 'test/y.test.ts'] }]);
    expect(plan.waiting).toEqual([]);
  });

  test('코드 PR 은 시험 전용 열차에 섞이지 않는다 · 각자 손', () => {
    const plan = planLandingTick([row('301', ['src/x.test.ts']), row('302', ['src/core.ts']),
      row('303', ['src/y.test.ts']), row('304', ['docs/z.md'])], [], T0, alive);
    expect(plan.hands.map((h) => [h.kind, h.prs])).toEqual([['light-train', ['301', '303', '304']], ['code', ['302']]]);
  });

  test('열차는 최대 4 · 다섯째는 다음 열차', () => {
    const q = ['1', '2', '3', '4', '5'].map((n) => row(`40${n}`, [`src/t${n}.test.ts`]));
    const plan = planLandingTick(q, [], T0, alive);
    expect(plan.hands.map((h) => h.prs)).toEqual([['401', '402', '403', '404']]);
    expect(plan.waiting).toEqual([{ pr: '405', reason: 'next-train' }]);
  });

  test('가벼운 PR 2개는 30분 전엔 채우는 중 · 30분 뒤 출발', () => {
    const q = [row('501', ['src/a.test.ts'], T0), row('502', ['src/b.test.ts'], T0)];
    expect(planLandingTick(q, [], T0 + 29 * 60_000, alive).waiting)
      .toEqual([{ pr: '501', reason: 'train-filling' }, { pr: '502', reason: 'train-filling' }]);
    expect(planLandingTick(q, [], T0 + 30 * 60_000, alive).hands.map((h) => h.prs)).toEqual([['501', '502']]);
  });

  test('파일 미측정 PR 은 내지 않는다 · 보유 슬롯 파일 미상이면 아무 손도 내지 않는다', () => {
    expect(planLandingTick([row('601', null)], [], T0, alive).waiting).toEqual([{ pr: '601', reason: 'files-unmeasured' }]);
    const held = [{ name: 'X', prs: [], files: null, pid: null }];
    expect(planLandingTick([row('602', ['src/a.ts'])], held, T0, alive).hands).toEqual([]);
  });

  test('죽은 보유자 슬롯은 보고만 · 상한에는 센다', () => {
    const held = [{ name: 'OP-1', prs: ['1'], files: ['a'], pid: 11 }, { name: 'OP-2', prs: ['2'], files: ['b'], pid: 12 }];
    const plan = planLandingTick([row('701', ['src/c.ts'])], held, T0, (pid) => pid !== 12);
    expect(plan.staleSlots).toEqual(['OP-2']);
    expect(plan.hands).toEqual([]);
    expect(plan.waiting).toEqual([{ pr: '701', reason: 'slots-full' }]);
  });
});

describe('runLandingTick', () => {
  test('두 손 슬롯을 만들고 착지 둘 · 셋째 대기 · 재기동 틱은 같은 PR 을 다시 내지 않는다', () => {
    const dir = slots();
    const { d, landed } = deps(dir);
    const q = [row('101', ['src/a.ts']), row('102', ['src/b.ts']), row('103', ['src/c.ts'])];
    const plan = runLandingTick(q, d);
    expect(plan === 'lock-busy' ? [] : plan.hands.map((h) => h.prs)).toEqual([['101'], ['102']]);
    expect(landed).toEqual([['101'], ['102']]);
    expect(readdirSync(dir).sort()).toEqual(['HAND-101', 'HAND-102']);
    const again = runLandingTick(q, deps(dir, 9999).d);
    expect(again === 'lock-busy' ? 'busy' : again.hands).toEqual([]);
  });

  test('시험 전용 3개 = 기준선 측정 1회 · 착지 손 1', () => {
    const dir = slots();
    const { d, baselines, landed } = deps(dir);
    runLandingTick([row('201', ['a.test.ts']), row('202', ['b.test.ts']), row('203', ['c.test.ts'])], d);
    expect(baselines).toEqual([['201', '202', '203']]);
    expect(landed).toEqual([['201', '202', '203']]);
  });

  test('예약 잠금이 잡혀 있으면 아무것도 하지 않는다', () => {
    const dir = slots();
    mkdirSync(join(dir, '.reserve-lock'));
    const { d, landed } = deps(dir);
    expect(runLandingTick([row('101', ['src/a.ts'])], d)).toBe('lock-busy');
    expect(landed).toEqual([]);
    expect(existsSync(join(dir, '.reserve-lock'))).toBe(true);
  });

  test('내 슬롯만 푼다', () => {
    const dir = slots();
    mkdirSync(join(dir, 'HAND-9'));
    writeFileSync(join(dir, 'HAND-9', 'owner.json'), '{"prs":["9"],"files":["a"],"pid":1}\n');
    expect(releaseHand(dir, 'HAND-9', 2)).toBe(false);
    expect(existsSync(join(dir, 'HAND-9'))).toBe(true);
    expect(releaseHand(dir, 'HAND-9', 1)).toBe(true);
    expect(existsSync(join(dir, 'HAND-9'))).toBe(false);
  });
});
