/**
 * OVW-BRIEF 판정선 시험(RFC §A4·§A7) — 흐름 판정 변화 브리핑 한 줄.
 * §A4: 마지막으로 브리핑한 판정과 «다를 때만» 발송.
 * §A7: «2연속» 같은 판정으로 관측될 때만 발송(경계값 플래핑 방지).
 * 킨드 라우팅 계약(ops-report = 운영 봇)은 digest-delivery.test.ts 가 담당한다.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeVerdict, okCell, type OverviewSnapshot } from '../ops/overview.js';
import { briefDue, briefVerdictChange, emptyVerdictBriefState, formatVerdictBrief, observeVerdict, verdictBriefStatePath, type VerdictBriefState } from './digest-delivery.js';
import { runStewardStage } from './triage.js';

describe('OVW-BRIEF — 흐름 판정 변화 브리핑(RFC §A4·§A7)', () => {
  const at = '2026-10-12T09:00:00Z';
  const snapshot = (over: Partial<OverviewSnapshot> = {}): OverviewSnapshot => ({
    generatedAt: at,
    instanceRoot: '/instance',
    since: '최근 1h',
    release: {
      version: okCell('0.2.62', 'release-meta', at),
      run: okCell('none', 'release-run-store', at),
      schedule: okCell('none', 'release-schedule', at),
      checklist: okCell({ green: 4, yellow: 0, red: 0, done: 6, p0Yellow: 0 }, 'release-checklist', at),
    },
    tasks: {
      byOwner: okCell({}, 'task-ledger', at),
      launchable: okCell({ count: 2, ids: [], skipped: { noTargetPath: 0, predecessorOpen: 0, alreadyHanded: 0 }, interim: true }, 'task-ledger', at),
      capacity: okCell({ podUsed: 1, podTarget: 2, localUsed: 0, localMax: 1, free: 2 }, 'capacity', at),
      done: okCell(3, 'task-ledger', at),
    },
    machines: {
      parents: okCell({ count: 0, staleOver6h: 0, oldestHours: null }, 'ps', at),
      hosts: [],
      pods: [],
    },
    landings: okCell({ count: 0, recent: [] }, 'git', at),
    loops: [],
    ...over,
  });
  const flowingSnapshot = (): OverviewSnapshot => snapshot();
  const blockedSnapshot = (): OverviewSnapshot => {
    const base = snapshot();
    return snapshot({
      release: {
        ...base.release,
        run: okCell({ runId: 'r-9f23c1', status: 'waiting', currentNode: 'review', startedAt: null, waitingOn: 'approval', elapsedMinutes: 12 }, 'release-run-store', at),
      },
    });
  };

  test('observeVerdict — 같은 판정은 streak 를 쌓고, 다른 판정은 1로 되돌린다(§A7)', () => {
    const first = observeVerdict(emptyVerdictBriefState(), 'flowing');
    expect(first).toEqual({ lastObserved: 'flowing', lastBriefed: null, streak: 1 });
    expect(observeVerdict(first, 'flowing').streak).toBe(2);
    const flipped = observeVerdict(first, 'blocked');
    expect(flipped).toEqual({ lastObserved: 'blocked', lastBriefed: null, streak: 1 });
  });

  test('briefDue — 2연속 관측 ⊕ 마지막 브리핑과 다른 판정일 때만 참(§A4·§A7)', () => {
    expect(briefDue({ lastObserved: 'blocked', lastBriefed: null, streak: 1 })).toBe(false);
    expect(briefDue({ lastObserved: 'blocked', lastBriefed: null, streak: 2 })).toBe(true);
    expect(briefDue({ lastObserved: 'blocked', lastBriefed: 'blocked', streak: 7 })).toBe(false);
  });

  test('formatVerdictBrief — 막힘 판정을 이전 라벨·사유·다음 행동과 함께 «한 줄»로', () => {
    const text = formatVerdictBrief(computeVerdict(blockedSnapshot()), 'flowing');
    expect(text).toBe('스튜어드 흐름 · 판정 변화 막힘 (이전 흐름 정상) · 발행 런 r-9f23c1 노드 review 승인 대기 12분 · 다음: 결정 카드 확인 — `elanous decisions list`');
    expect(text).not.toContain('\n');
    expect(formatVerdictBrief(computeVerdict(blockedSnapshot()), null)).not.toContain('이전');
  });

  test('2연속 같은 판정일 때만 한 줄 — 같은 판정 재발송 없음, 변화는 «이전» 라벨과 함께(§A4·§A7)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verdict-brief-'));
    try {
      const sent: string[] = [];
      let current: OverviewSnapshot = blockedSnapshot();
      const deps = {
        collect: async (): Promise<OverviewSnapshot> => current,
        send: async (text: string): Promise<void> => {
          sent.push(text);
        },
        statePath: verdictBriefStatePath(root),
      };
      await expect(briefVerdictChange(root, deps)).resolves.toBe(null);
      expect(sent).toEqual([]);
      const first = await briefVerdictChange(root, deps);
      expect(sent).toHaveLength(1);
      expect(first).toBe(sent[0]);
      expect(first).toContain('막힘');
      expect(first).not.toContain('이전');
      await expect(briefVerdictChange(root, deps)).resolves.toBe(null);
      expect(sent).toHaveLength(1);
      current = flowingSnapshot();
      await expect(briefVerdictChange(root, deps)).resolves.toBe(null);
      expect(sent).toHaveLength(1);
      const second = await briefVerdictChange(root, deps);
      expect(sent).toHaveLength(2);
      expect(second).toContain('이전 막힘');
      const state = JSON.parse(readFileSync(verdictBriefStatePath(root), 'utf8')) as VerdictBriefState;
      expect(state).toEqual({ lastObserved: 'flowing', lastBriefed: 'flowing', streak: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('발송 실패는 마지막 브리핑 값을 진행시키지 않는다 — 다음 관측이 재시도한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verdict-brief-'));
    try {
      const statePath = verdictBriefStatePath(root);
      let down = false;
      const deps = {
        collect: async (): Promise<OverviewSnapshot> => blockedSnapshot(),
        send: async (): Promise<void> => {
          if (down) throw new Error('ops bot down');
        },
        statePath,
      };
      await briefVerdictChange(root, deps);
      down = true;
      await expect(briefVerdictChange(root, deps)).rejects.toThrow('ops bot down');
      expect((JSON.parse(readFileSync(statePath, 'utf8')) as VerdictBriefState).lastBriefed).toBe(null);
      down = false;
      const retried = await briefVerdictChange(root, deps);
      expect(retried).toContain('막힘');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('깨진 상태 파일은 새로 시작한다 — 관측은 유실되지 않는다(fail-open)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verdict-brief-'));
    try {
      const statePath = verdictBriefStatePath(root);
      mkdirSync(join(root, 'steward'), { recursive: true });
      writeFileSync(statePath, 'not json');
      const deps = {
        collect: async (): Promise<OverviewSnapshot> => blockedSnapshot(),
        send: async (): Promise<void> => {},
        statePath,
      };
      await expect(briefVerdictChange(root, deps)).resolves.toBe(null);
      expect((JSON.parse(readFileSync(statePath, 'utf8')) as VerdictBriefState).streak).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('OVW-BRIEF 배선 — 스튜어드 report 스테이지', () => {
  test('report 스테이지가 브리핑을 몰고 다닌다 — 2연속 같은 판정에 정확히 한 줄, 같은 판정엔 재발송 없음', async () => {
    const root = mkdtempSync(join(tmpdir(), 'steward-brief-'));
    const dir = join(root, 'steward');
    const context = join(dir, 'graph-context.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(context, JSON.stringify({ graphId: 'steward', runId: 'brief-wiring' }));
    writeFileSync(join(dir, 'issues.json'), '[]');
    writeFileSync(join(dir, 'schedule.json'), '[]');
    process.env.ELANOUS_GRAPH_CONTEXT = context;
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes('commentCreate(')) return Response.json({ data: { commentCreate: { success: true } } });
      throw new Error(`unexpected Linear query: ${query.slice(0, 40)}`);
    }) as typeof fetch;
    const briefs: string[] = [];
    try {
      const deps = {
        root,
        fetch: fetchFn,
        getSecret: async (): Promise<string> => 'key',
        launchSettings: { mode: 'live' as const },
        sendDigest: async (): Promise<void> => {},
        sendBrief: async (text: string): Promise<void> => {
          briefs.push(text);
        },
      };
      await runStewardStage('report', deps);
      expect(briefs).toEqual([]);
      await runStewardStage('report', deps);
      expect(briefs).toHaveLength(1);
      expect(briefs[0]).toContain('스튜어드 흐름');
      await runStewardStage('report', deps);
      expect(briefs).toHaveLength(1);
      const state = JSON.parse(readFileSync(verdictBriefStatePath(root), 'utf8')) as VerdictBriefState;
      expect(state.lastBriefed).toBe(state.lastObserved);
    } finally {
      delete process.env.ELANOUS_GRAPH_CONTEXT;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
