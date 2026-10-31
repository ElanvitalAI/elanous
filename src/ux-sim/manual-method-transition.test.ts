import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manualPath = resolve(import.meta.dir, '../../docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md');
const manual = readFileSync(manualPath, 'utf8');

const axes = [
  '공급자 4xx',
  '타이핑 지연',
  'release 그래프 분기',
  '원격 Pod',
  'node-b',
  '실제 공급자 구독 경로',
  '시간 경과',
];

describe('UX simulation live-train method transition', () => {
  test('documents one method and its rationale for every difficult axis in §1 and §3', () => {
    expect(manual).toContain('src/ux-sim/');
    expect(manual).toContain('방법 없음 → 방법');
    for (const axis of axes) {
      expect(manual, `missing axis: ${axis}`).toContain(axis);
    }

    const transitionSection = manual.split('방법 없음 → 방법')[1]?.split('\n## ')[0] ?? '';
    const transitionRows = transitionSection
      .split('\n')
      .filter((line) => line.startsWith('| ') && axes.some((axis) => line.includes(axis)));
    expect(transitionRows).toHaveLength(7);
    const choices = ['기존 ux-sim 재사용', 'MOCK-DEVICES', '다음 HARD · 컷 실물 위임'];
    for (const row of transitionRows) {
      const matchingChoices = choices.filter((choice) => row.includes(choice));
      expect(matchingChoices).toHaveLength(1);
      expect(row.split('|')[3]?.trim().length).toBeGreaterThan(10);
    }
    expect(transitionSection).toContain('다음 HARD · 컷 실물 위임');
    for (const file of [
      'fault-tui-400-autoheal.ts',
      'service-key-setup.ts',
      'dashboard-event-loop-stall-monitor-device.ts',
      'release-sim-rig.ts',
      'fake-kubectl.ts',
      'fault-pod-child-result.ts',
      'fake-clock.ts',
    ]) {
      expect(transitionSection, `missing grounded device: ${file}`).toContain(file);
    }
    expect(transitionSection).toContain('다음 3편');
    expect(transitionSection).toContain('감소');
    expect(manual).toContain("bun test -- 'src/ux-sim/manual-method-transition.test.ts'");
    expect(manual).toContain('기준값과 후속 관측이 없으므로 감소는 아직 입증되지 않았다.');
    expect(manual).toContain('| 다음 1편 | 미측정 | 미측정 | 미측정 | 미측정 |');
    expect(manual).toContain('| 다음 2편 | 미측정 | 미측정 | 미측정 | 미측정 |');
    expect(manual).toContain('| 다음 3편 | 미측정 | 미측정 | 미측정 | 미측정 |');
  });
});
