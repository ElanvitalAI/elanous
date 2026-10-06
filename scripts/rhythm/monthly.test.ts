import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMonthly, type MonthlyDeps } from './monthly.js';

const roots: string[] = [];
const rootForTest = () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-monthly-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const fixture = (root: string): MonthlyDeps => ({
  root,
  now: () => new Date('2026-11-01T00:30:00Z'),
  landings: async () => [{}, {}, {}],
  decisions: async () => [{}],
  schedules: () => [{ version: 'v1', cutAt: '2026-10-28T00:00:00+09:00' },
    { version: 'outside', cutAt: '2026-11-02T00:00:00+09:00' }],
});

describe('runMonthly', () => {
  test('drafts the KST previous month once, without reading weekly content', async () => {
    const root = rootForTest();
    const weekly = join(root, 'rhythm', 'weekly');
    mkdirSync(weekly, { recursive: true });
    for (const name of ['2026-W41.md', '2026-W42.md', '2026-W45.md']) writeFileSync(join(weekly, name), 'not a markdown review');
    let calls = 0;
    const deps = { ...fixture(root), landings: async (window: { from: Date; to: Date }) => {
      calls++;
      expect(window.from.toISOString()).toBe('2026-09-30T15:00:00.000Z');
      expect(window.to.toISOString()).toBe('2026-10-31T15:00:00.000Z');
      return [{}, {}, {}];
    } };
    const first = await runMonthly(deps);
    const file = join(root, 'rhythm', 'monthly', '2026-10.md');
    expect(first.file).toBe(file);
    const bytes = readFileSync(file);
    const text = bytes.toString();
    expect(text).toContain('착지 3');
    expect(text).toContain('2026-10-28');
    expect(text).toContain('판 1건');
    expect(text).toContain('결정 대기 1');
    expect(text).toContain('2026-W41');
    expect(text).toContain('2026-W42');
    expect(text).not.toContain('2026-W45');
    for (const section of ['## S 지난달', '## C 로드맵 거리', '## Q 다음 달 방향', '## A 다음 달 첫 주']) expect(text).toContain(section);
    expect(text).toContain('기존 로드맵 기준(현행 목표 여부 미확인): 10-28 출시 · 11월 기업용');
    expect(text.match(/^\d\. .*\?$/gm)).toHaveLength(2);
    expect(text).toContain('착지 3건과 판 1건을 바탕으로 다음 달에 점검할 거리는 얼마인가?');
    expect(text).toContain('결정 대기 1건과 주간 리뷰 2개의 신호로 다음 달 첫 우선순위는 무엇인가?');
    expect((await runMonthly(deps)).status).toBe('이미 있음');
    expect(readFileSync(file)).toEqual(bytes);
    expect(calls).toBe(1);
  });

  test('isolates a failed landing source without writing zero', async () => {
    const root = rootForTest();
    mkdirSync(join(root, 'rhythm', 'weekly'), { recursive: true });
    const result = await runMonthly({ ...fixture(root), landings: async () => { throw new Error('source offline'); } });
    const text = readFileSync(result.file, 'utf8');
    expect(text.split('## S 지난달\n')[1]?.split('\n\n## C')[0]).toContain('못 읽음 · source offline');
    expect(text).not.toContain('착지 0');
    expect(text).toContain('결정 대기 1');
    expect(text).toContain('2026-10-28');
  });

  test('reports independent schedule, decision and weekly failures without turning them into zeros', async () => {
    const root = rootForTest();
    const result = await runMonthly({ ...fixture(root),
      schedules: () => { throw new Error('schedule offline'); },
      decisions: async () => { throw new Error('decision offline'); },
    });
    const text = readFileSync(result.file, 'utf8');
    expect(text).toContain('착지 3건');
    expect(text).toContain('못 읽음 · schedule offline');
    expect(text).toContain('못 읽음 · decision offline');
    expect(text).toContain('못 읽음 · ENOENT');
    expect(text).not.toContain('결정 대기 0');
    expect(text).not.toContain('판 0');
    expect(text).not.toContain('주간 리뷰 0');
  });

  test('uses KST when the year rolls over', async () => {
    const root = rootForTest();
    const weeklyDir = join(root, 'weekly');
    mkdirSync(weeklyDir);
    writeFileSync(join(weeklyDir, '2026-W53.md'), '');
    const result = await runMonthly({ ...fixture(root), weeklyDir,
      now: () => new Date('2026-12-31T15:30:00Z'),
      landings: async window => {
        expect(window.from.toISOString()).toBe('2026-11-30T15:00:00.000Z');
        expect(window.to.toISOString()).toBe('2026-12-31T15:00:00.000Z');
        return [];
      },
    });
    expect(result.file).toBe(join(root, 'rhythm', 'monthly', '2026-12.md'));
    const text = readFileSync(result.file, 'utf8');
    expect(text).toContain('2026-W53');
    expect(text).toContain('기존 로드맵 기준(현행 목표 여부 미확인): 10-28 출시 · 11월 기업용');
    const nextMonth = text.split('## Q 다음 달 방향\n')[1]?.split('\n\n## A')[0];
    expect(nextMonth).toContain('착지 0건과 판 0건');
    expect(nextMonth).toContain('결정 대기 1건과 주간 리뷰 1개의 신호');
    expect(nextMonth).not.toContain('10-28');
    expect(nextMonth).not.toContain('11월 기업용');
    expect(text.split('## A 다음 달 첫 주\n')[1]).not.toContain('11월 기업용');
  });

  test('does not read real ledgers without injected sources under NODE_ENV=test', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try { await expect(runMonthly()).rejects.toThrow('주입 필요'); }
    finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
  });
});
