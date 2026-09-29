import { describe, expect, test } from 'bun:test';
import type { DaemonTerminalSummary } from '@/lib/daemon-client';
import { agentLabel, defaultWall, intentsFor, wallFromSearch } from './pty-wall';

const t = (id: string, kind: string, alive = true, runId?: string) => ({ id, kind, alive, runId } as unknown as DaemonTerminalSummary);

describe('pty wall', () => {
  test('agent label and default picks agents first (max 3, alive only)', () => {
    expect(agentLabel({ kind: 'codex', runId: 'run-8e1f2233-x' })).toBe('에이전트: codex · 런 8e1f2233');
    expect(agentLabel({ kind: 'self' })).toBe('에이전트: elanous');
    expect(defaultWall([t('s1', 'shell'), t('c1', 'codex'), t('x', 'claude', false), t('m1', 'mission'), t('k1', 'claude')])).toEqual(['c1', 'm1', 'k1']);
    expect(wallFromSearch('?wall=a,b,c,d')).toEqual(['a', 'b', 'c']);
    expect(wallFromSearch('')).toEqual([]);
  });

  test('intent band: same run or targeted at the PTY, newest first', () => {
    const rows = [
      { ts: '2026-09-28T01:00:00Z', data: { kind: 'ROUTE', what: 'codex 로 보낸다', reason: '구현 칸', runId: 'run-a' } },
      { ts: '2026-09-28T01:05:00Z', data: { kind: 'VERIFY', what: '게이트 재실행', runId: 'run-a', target: 'codex_1' } },
      { ts: '2026-09-28T01:06:00Z', data: { kind: 'PLAN', what: '다른 런', runId: 'run-b' } },
      { ts: '2026-09-28T01:07:00Z', data: { kind: 'heal', what: 'PTY 에 입력', target: 'codex_1' } },
    ];
    expect(intentsFor({ id: 'codex_1', runId: 'run-a' }, rows).map((i) => [i.kind, i.what])).toEqual([['HEAL', 'PTY 에 입력'], ['VERIFY', '게이트 재실행'], ['ROUTE', 'codex 로 보낸다']]);
    expect(intentsFor({ id: 'zzz', runId: undefined }, rows)).toEqual([]);
  });
});
