import { describe, expect, test } from 'bun:test';
import {
  ANOMALY_HOLD_THRESHOLD,
  AnomalyCluster,
  extractContainerExit,
  failureSignature,
  type FailureObservation,
} from './anomaly-cluster.js';

function obs(over: Partial<FailureObservation> = {}): FailureObservation {
  return {
    goal: '56d083ae423ded52',
    host: 'OP',
    runId: 'run-1',
    kind: 'exit',
    containerExit: 137,
    stage: 'delegate',
    lastLines: ['boot ok', 'Reason: pod-deadline-exceeded'],
    ...over,
  };
}

describe('ANOMALY-CLUSTER-PRODUCT: 실패 서명', () => {
  test('서명은 실패 종류·컨테이너 종료·단계·lastLines reason 꼬리를 담고 호스트는 담지 않는다', () => {
    const a = failureSignature(obs({ host: 'OP' }));
    const b = failureSignature(obs({ host: 'TC' }));
    expect(a).toBe(b);
    expect(a).toContain('kind=exit');
    expect(a).toContain('exit=137');
    expect(a).toContain('stage=delegate');
    expect(a).toContain('reason=pod-deadline-exceeded');
    expect(a).not.toContain('OP');
    expect(a).not.toContain('TC');
  });

  test('lastLines reason 꼬리가 다른 preflight/실행 실패는 서로 다른 서명', () => {
    const preflight = failureSignature(obs({ kind: 'preflight', stage: 'launch', containerExit: null, lastLines: ['preflight: tree is dirty'] }));
    const runtime = failureSignature(obs({ kind: 'preflight', stage: 'launch', containerExit: null, lastLines: ['runtime: tsc exited'] }));
    expect(preflight).not.toBe(runtime);
  });

  test('같은 실패 종류·단계라도 컨테이너 종료가 다르면 다른 서명', () => {
    expect(failureSignature(obs({ containerExit: 137 }))).not.toBe(failureSignature(obs({ containerExit: 1 })));
  });

  test('컨테이너 종료 문자열에서 숫자를 뽑고, 없으면 null', () => {
    expect(extractContainerExit('container exited with code 137')).toBe(137);
    expect(extractContainerExit('exit status 1')).toBe(1);
    expect(extractContainerExit('no exit hint here')).toBeNull();
  });
});

describe('ANOMALY-CLUSTER-PRODUCT: 보류·해제 판정', () => {
  test('같은 서명 2건은 보류 0', () => {
    const cluster = new AnomalyCluster();
    cluster.record(obs({ runId: 'run-1' }));
    cluster.record(obs({ runId: 'run-2' }));
    expect(cluster.hold('56d083ae423ded52', 'OP').hold).toBe(false);
  });

  test('같은 서명 3건은 해당 골·호스트 보류 1', () => {
    const cluster = new AnomalyCluster();
    for (const runId of ['run-1', 'run-2', 'run-3']) cluster.record(obs({ runId }));
    const decision = cluster.hold('56d083ae423ded52', 'OP');
    expect(decision.hold).toBe(true);
    expect(decision.runs).toBe(ANOMALY_HOLD_THRESHOLD);
    expect(cluster.isHeld('56d083ae423ded52', 'OP')).toBe(true);
    expect(cluster.hold('56d083ae423ded52', 'OP').hold ? 1 : 0).toBe(1);
  });

  test('다른 서명·호스트는 보류 0', () => {
    const cluster = new AnomalyCluster();
    cluster.record(obs({ runId: 'run-1', lastLines: ['Reason: pod-deadline-exceeded'] }));
    cluster.record(obs({ runId: 'run-2', lastLines: ['Reason: pod-deadline-exceeded'] }));
    cluster.record(obs({ runId: 'run-3', lastLines: ['Reason: oom-killed'] }));
    expect(cluster.hold('56d083ae423ded52', 'OP').hold).toBe(false);
    const other = new AnomalyCluster();
    for (const runId of ['run-1', 'run-2', 'run-3']) other.record(obs({ runId, host: 'OP' }));
    expect(other.hold('56d083ae423ded52', 'TC').hold).toBe(false);
    expect(other.hold('other-goal', 'OP').hold).toBe(false);
  });

  test('같은 실행이 반복 기록돼도 3건으로 세지 않는다', () => {
    const cluster = new AnomalyCluster();
    for (let i = 0; i < 3; i += 1) cluster.record(obs({ runId: 'run-1' }));
    cluster.record(obs({ runId: 'run-2' }));
    expect(cluster.hold('56d083ae423ded52', 'OP').hold).toBe(false);
  });

  test('원인 판정 뒤 해제 1', () => {
    const cluster = new AnomalyCluster();
    for (const runId of ['run-1', 'run-2', 'run-3']) cluster.record(obs({ runId }));
    expect(cluster.hold('56d083ae423ded52', 'OP').hold).toBe(true);
    const release = cluster.release('56d083ae423ded52', 'OP', '원인 판정: dispatcher 가 재발사 성공');
    expect(release.released).toBe(true);
    expect(cluster.isHeld('56d083ae423ded52', 'OP')).toBe(false);
    expect(cluster.hold('56d083ae423ded52', 'OP').hold).toBe(false);
    expect(cluster.release('56d083ae423ded52', 'OP', '재판정').released).toBe(false);
  });
});

describe('ANOMALY-CLUSTER-PRODUCT: 원천 미측정', () => {
  test('관측이 없는 골·호스트는 보류하지 않고 이유에 원천 미측정을 명시한다', () => {
    const cluster = new AnomalyCluster();
    const decision = cluster.hold('never-observed', 'OP');
    expect(decision.hold).toBe(false);
    expect(decision.reason).toContain('원천 미측정');
  });
});

describe('ANOMALY-CLUSTER-PRODUCT: 보류 중 서명 교체 금지', () => {
  test('보류 중 지연 도착한 다른 서명 관측은 판정 없이 해제하지 않는다', () => {
    const cluster = new AnomalyCluster();
    for (const runId of ['run-1', 'run-2', 'run-3']) cluster.record(obs({ runId }));
    expect(cluster.isHeld('56d083ae423ded52', 'OP')).toBe(true);

    // A handTask failure from an in-flight concurrent tick lands after the hold was decided.
    const late = cluster.record(
      obs({ runId: 'run-4', lastLines: ['boot ok', 'Reason: oom-killed'], at: '2026-10-23T01:02:03.000Z' }),
    );

    expect(late.hold.hold).toBe(true);
    expect(late.signature).toContain('reason=pod-deadline-exceeded');
    expect(late.hold.reason).toContain('다른 서명 1건');
    expect(cluster.isHeld('56d083ae423ded52', 'OP')).toBe(true);
  });

  test('보류 중 보관한 다른 서명 3건은 해제 판정 뒤 새 서명 기준으로 재판정된다', () => {
    const cluster = new AnomalyCluster();
    for (const runId of ['run-1', 'run-2', 'run-3']) cluster.record(obs({ runId }));
    for (const runId of ['run-4', 'run-5', 'run-6']) {
      cluster.record(obs({ runId, lastLines: ['boot ok', 'Reason: oom-killed'] }));
      expect(cluster.hold('56d083ae423ded52', 'OP').signature).toContain('reason=pod-deadline-exceeded');
    }
    expect(cluster.isHeld('56d083ae423ded52', 'OP')).toBe(true);

    const release = cluster.release('56d083ae423ded52', 'OP', '원인 판정: dispatcher 가 재발사 성공');
    expect(release.released).toBe(true);
    expect(release.reason).toContain('승격');

    const after = cluster.hold('56d083ae423ded52', 'OP');
    expect(after.signature).toContain('reason=oom-killed');
    expect(after.runs).toBe(3);
    expect(after.hold).toBe(true);
    expect(cluster.release('56d083ae423ded52', 'OP', '원인 판정: oom 은 노드 메모리 상한').released).toBe(true);
    expect(cluster.isHeld('56d083ae423ded52', 'OP')).toBe(false);
  });

  test('보류가 아니면 다른 서명이 골·호스트의 서명을 교체한다', () => {
    const cluster = new AnomalyCluster();
    cluster.record(obs({ runId: 'run-1' }));
    cluster.record(obs({ runId: 'run-2', lastLines: ['boot ok', 'Reason: oom-killed'] }));
    expect(cluster.hold('56d083ae423ded52', 'OP').signature).toContain('reason=oom-killed');
    expect(cluster.hold('56d083ae423ded52', 'OP').hold).toBe(false);
  });
});

describe('ANOMALY-CLUSTER-PRODUCT: FailureObservation.at 판독', () => {
  test('관측 시각을 모아 보류 이유의 관측 창에 남긴다', () => {
    const cluster = new AnomalyCluster();
    cluster.record(obs({ runId: 'run-1', at: '2026-10-23T06:50:00.000Z' }));
    cluster.record(obs({ runId: 'run-2', at: '2026-10-23T07:50:00.000Z' }));

    const early = cluster.hold('56d083ae423ded52', 'OP');
    expect(early.reason).toContain('2026-10-23T06:50:00.000Z..2026-10-23T07:50:00.000Z');

    cluster.record(obs({ runId: 'run-3', at: '2026-10-23T08:50:00.000Z' }));
    const held = cluster.hold('56d083ae423ded52', 'OP');
    expect(held.hold).toBe(true);
    expect(held.reason).toContain('2026-10-23T06:50:00.000Z..2026-10-23T08:50:00.000Z');
  });

  test('at 이 없는 관측은 관측 창을 만들지 않는다', () => {
    const cluster = new AnomalyCluster();
    cluster.record(obs({ runId: 'run-1' }));
    expect(cluster.hold('56d083ae423ded52', 'OP').reason).not.toContain('· 관측');
  });
});
