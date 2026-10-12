import { describe, expect, test } from 'bun:test';
import { podDeathAfterPartialScenario, renderPodDeath, simPartialLine, simPodDeath } from './fault-pod-death.js';

describe('simPodDeath — 결함 주입 «Pod 사망» (METER-POD-ROLLUP-GAP-3 반증 짝)', () => {
  test('a pod killed after a PARTIAL line yields a rollup row with podExitClass, not a bare missing row', () => {
    // 끝 로그는 비었고(Pod 삭제) 호스트는 도는 동안 PARTIAL 을 봤다 → 결손 행이 아니라 live PARTIAL 재방출.
    const live = simPodDeath();
    expect(live.source).toBe('partial-live');
    expect(live.missingRows).toHaveLength(0);
    expect(live.partialRows).toHaveLength(1);
    expect(live.partialRows[0]!.data).toMatchObject({ site: 'pod-rollup:self-implement', partial: true, partialSource: 'live-capture', partialSeq: 1 });

    // 도는 동안에도 PARTIAL 을 못 봤으면 결손 행 — 그때도 «왜» 가 실린다(종료 분류 podExitClass).
    const lost = simPodDeath(podDeathAfterPartialScenario({ livePartialLine: null }));
    expect(lost.source).toBe('missing');
    expect(lost.missingRows).toHaveLength(1);
    expect(lost.missingRows[0]!.data).toMatchObject({ measured: false, reason: 'logs-unavailable', runId: 'run-sim-pod-death' });
    expect(lost.missingRows[0]!.data.podExitClass).toBe('no-result-line'); // SIGTERM 전용 분류는 없다(TC 07:08) — «왜 없나» 가 실렸는지만 본다
  });

  test('control: when the final logs still hold the PARTIAL line, it wins over the live capture', () => {
    const obs = simPodDeath(podDeathAfterPartialScenario({ logs: `${simPartialLine(2)}\n`, livePartialLine: simPartialLine(1) }));
    expect(obs.source).toBe('partial-log');
    expect(obs.partialRows).toHaveLength(1);
    expect(obs.partialRows[0]!.data.partialSeq).toBe(2);
  });

  test('control: logs still readable and SIGTERM 143 → the missing row says sigterm-143', () => {
    const obs = simPodDeath(podDeathAfterPartialScenario({ logs: 'child said nothing useful\n', livePartialLine: null }));
    expect(obs.source).toBe('missing');
    expect(obs.missingRows[0]!.data.reason).toBe('sigterm-143');
  });

  test('render names the counts a person reads first', () => {
    const lines = renderPodDeath(simPodDeath());
    expect(lines[0]).toStartWith('pod-death · source=partial-live · 관측 줄 ');
    expect(lines.some((l) => l.includes('PARTIAL 재방출 행: 1'))).toBe(true);
    expect(lines.some((l) => l.includes('결손 행: 0'))).toBe(true);
  });
});
