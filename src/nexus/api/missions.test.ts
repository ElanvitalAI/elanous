import { describe, expect, it } from 'bun:test';
import { summarise, taskRowsToDerived } from './missions.js';
import { createMission } from '../../task-orchestrator/mission.js';
import type { Task } from '../../task-orchestrator/types.js';
import type { DerivedJob } from '../../autopilot/mission-trace.js';

describe('summarise — MissionCardWire autopilot 노출 (U1)', () => {
  it('자율 Mission 은 autopilot 메타를 카드에 담는다', () => {
    const m = createMission(
      {
        title: '반도체 아침 리포트',
        intent: '반도체 아침 리포트',
        source: { kind: 'manual', raw: '반도체 아침 리포트' },
        goalSlug: 'apm_x_semis_abc123',
        autopilot: {
          apmId: 'apm_x_semis_abc123',
          origin: 'discovery',
          executionModel: 'scheduler',
          apmStatus: 'armed',
          engine: 'schedule_manage',
        },
      },
      { now: 1000, id: 'apm_x_semis_abc123' },
    );
    const card = summarise(m, []);
    expect(card.id).toBe('apm_x_semis_abc123');
    expect(card.autopilot).not.toBeNull();
    expect(card.autopilot?.origin).toBe('discovery');
    expect(card.autopilot?.executionModel).toBe('scheduler');
    expect(card.autopilot?.apmStatus).toBe('armed');
    expect(card.autopilot?.apmId).toBe('apm_x_semis_abc123');
    expect(card.taskCount).toBe(0);
  });

  it('사람이 만든 일반 Mission 은 autopilot=null', () => {
    const m = createMission(
      { title: '사람 미션', source: { kind: 'manual' } },
      { now: 1000 },
    );
    const card = summarise(m, []);
    expect(card.autopilot).toBeNull();
    expect(card.status).toBe('planning');
  });
});

describe('summarise — 파생 롤업 ⊕ updatedAt (MISSIONS-STALE-MARK)', () => {
  const taskRow = (id: string, status: string): Task =>
    ({ id, title: `task ${id}`, status, surface: { kind: 'cron' } }) as unknown as Task;

  it('«마지막 갱신»을 카드에 싣는다 — «N일 멈춤» 판정의 «유일한» 입력', () => {
    const updatedAt = Date.parse('2026-07-12T03:00:00Z');
    const card = summarise(
      createMission({ title: '멈춘 미션', source: { kind: 'manual' } }, { now: updatedAt }),
      [],
    );
    expect(card.updatedAt).toBe(updatedAt);
  });

  it('파생이 «정말로» 0 이면 total 0 을 싣는다 — «미측정»(필드 없음)과 «다른» 값', () => {
    const card = summarise(
      createMission({ title: 'x', source: { kind: 'manual' } }, { now: 1000 }),
      [],
    );
    expect(card.derived).not.toBeUndefined();
    expect(card.derived).toEqual({ total: 0, ok: 0, stale: 0, error: 0, active: 0, pending: 0 });
  });

  it('태스크 ⊕ 크론을 «합쳐» 롤업한다 — «전부 파생 0»이던 목록이 실측으로 바뀐다', () => {
    const crons: DerivedJob[] = [
      { kind: 'cron', id: 'c1', name: 'c1', status: 'ok' },
      { kind: 'cron', id: 'c2', name: 'c2', status: 'error' },
    ];
    const card = summarise(
      createMission({ title: 'x', source: { kind: 'manual' } }, { now: 1000 }),
      [taskRow('t1', 'done'), taskRow('t2', 'failed'), taskRow('t3', 'active')],
      crons,
    );
    expect(card.derived).toEqual({ total: 5, ok: 2, stale: 0, error: 2, active: 1, pending: 0 });
  });

  it('taskRowsToDerived 는 트레이스와 «같은» 상태 매핑을 쓴다', () => {
    const rows = taskRowsToDerived([
      taskRow('t1', 'done'), taskRow('t2', 'failed'), taskRow('t3', 'active'),
      taskRow('t4', 'pending'), taskRow('t5', 'planning'),
    ]);
    expect(rows.map((r) => r.status)).toEqual(['done', 'error', 'active', 'pending', 'pending']);
    expect(rows.map((r) => r.kind)).toEqual(['task', 'task', 'task', 'task', 'task']);
  });
});
