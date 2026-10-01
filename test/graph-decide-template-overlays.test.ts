import { describe, expect, it } from 'bun:test';
import { decideTemplate, resolveGraphAuthority } from '../src/self-implement/graph-authority.js';
import { parseGraphOverlayYaml } from '../src/self-implement/graph-overlay-yaml.js';

/** ⭐ 대표 지시 ② «변형» — 「최초 결정 시 템플릿을 변형한다」.
 *  🩸 그 전까지 `selectOverlays` 는 «아무도 안 불렀다» — 지었는데 안 도는 기계였다. */
const overlay = (yaml: string) => {
  const parsed = parseGraphOverlayYaml(yaml, 'inline.yaml');
  expect(parsed.errors).toEqual([]);
  return parsed.overlay!;
};

const PATIENT = overlay(`
overlay_id: heal-patient-inline
target: self-implement
stage: launch
applies_when: attempts >= 2
patch:
  - op: replace
    path: /nodes/0/maxVisits
    value: 9
`);

describe('decideTemplate — ② 변형', () => {
  const on = resolveGraphAuthority({ flag: true });
  it('⛔ 첫째 반증 — 옛 꺼짐 플래그에도 그래프 권위가 유지되어 오버레이가 적용된다', () => {
    const authority = resolveGraphAuthority({ flag: false });
    expect(authority).toEqual({ enabled: true, source: 'default' });
    const r = decideTemplate({ goalType: 'implement', authority, overlays: [PATIENT], state: { attempts: 5 }, stage: 'launch' });
    expect(r.appliedIds).toEqual(['heal-patient-inline']);
    expect(r.template.nodes[0]!.maxVisits).toBe(9);
  });

  it('조건이 맞으면 얹히고 «그 값이 실제로» 바뀐다', () => {
    const r = decideTemplate({ goalType: 'implement', authority: on, overlays: [PATIENT], state: { attempts: 5 }, stage: 'launch' });
    expect(r.appliedIds).toEqual(['heal-patient-inline']);
    expect(r.template.nodes[0]!.maxVisits).toBe(9);
  });

  it('⛔ 반증 — 조건이 «안» 맞으면 값이 그대로다(항상 얹는 자가 아니다)', () => {
    const r = decideTemplate({ goalType: 'implement', authority: on, overlays: [PATIENT], state: { attempts: 1 }, stage: 'launch' });
    expect(r.appliedIds).toEqual([]);
    expect(r.selections[0]!.verdict).toBe('does-not-apply');
    expect(r.template.nodes[0]!.maxVisits).not.toBe(9);
  });

  it('⛔ 키가 «없는» 것은 「거짓」이 아니다 — 다른 처방이다', () => {
    const r = decideTemplate({ goalType: 'implement', authority: on, overlays: [PATIENT], state: {}, stage: 'launch' });
    expect(r.selections[0]!.verdict).toBe('key-absent');
    expect(r.appliedIds).toEqual([]);
  });

  it('⛔ runtime 오버레이는 「최초 결정」에서 «후보가 아니다» — ③ 다이나믹의 몫이다', () => {
    const runtime = overlay(`
overlay_id: runtime-only
target: self-implement
stage: runtime
applies_when: attempts >= 0
patch:
  - op: replace
    path: /nodes/0/maxVisits
    value: 7
`);
    const r = decideTemplate({ goalType: 'implement', authority: on, overlays: [runtime], state: {}, stage: 'launch' });
    expect(r.selections[0]!.verdict).toBe('wrong-stage');
    expect(r.template.nodes[0]!.maxVisits).not.toBe(7);
  });

  it('⛔ 거절되면 «기준 선언»으로 돈다 — 반쯤 얹힌 그래프를 만들지 않는다', () => {
    const bad = overlay(`
overlay_id: bad-pointer
target: self-implement
stage: launch
applies_when: attempts >= 0
patch:
  - op: replace
    path: /nodes/0/max_visits
    value: 9
`);
    const r = decideTemplate({ goalType: 'implement', authority: on, overlays: [bad], state: { attempts: 0 }, stage: 'launch' });
    expect(r.appliedIds).toEqual([]);
    expect(r.rejections.length).toBeGreaterThan(0);   // ⛔ 조용히 no-op 하지 않는다
    expect(r.template.nodes[0]!.maxVisits).not.toBe(9);
  });
});

/** ⭐ 대표 지시 ③ «다이나믹» — 「실제 구현간에 다이나믹 대응으로 바꿀수 있게」.
 *  ⛔ ② 와 «같은 함수»이고 갈리는 것은 `stage` 하나다 — 둘을 다른 기계로 지으면 어휘가 갈린다. */
describe('decideTemplate — ③ 다이나믹', () => {
  const on = resolveGraphAuthority({ flag: true });
  const RUNTIME = overlay(`
overlay_id: patient-runtime
target: self-implement
stage: runtime
applies_when: attempts >= 2
patch:
  - op: replace
    path: /nodes/0/maxVisits
    value: 9
`);

  it('구현 중 조건이 차면 얹힌다', () => {
    const r = decideTemplate({ goalType: 'implement', authority: on, overlays: [RUNTIME], state: { attempts: 3 }, stage: 'runtime' });
    expect(r.appliedIds).toEqual(['patient-runtime']);
    expect(r.template.nodes[0]!.maxVisits).toBe(9);
  });

  it('⛔ 반증 — 라운드가 «아직» 안 찼으면 안 얹힌다', () => {
    const r = decideTemplate({ goalType: 'implement', authority: on, overlays: [RUNTIME], state: { attempts: 0 }, stage: 'runtime' });
    expect(r.appliedIds).toEqual([]);
    expect(r.template.nodes[0]!.maxVisits).not.toBe(9);
  });

  it('⛔ launch 오버레이는 «구현 중»에 후보가 아니다 — 두 층이 서로를 안 삼킨다', () => {
    const r = decideTemplate({ goalType: 'implement', authority: on, overlays: [PATIENT], state: { attempts: 5 }, stage: 'runtime' });
    expect(r.selections[0]!.verdict).toBe('wrong-stage');
    expect(r.appliedIds).toEqual([]);
  });

  it('⛔⭐ 매번 «기준 선언»에서 다시 얹는다 — 누적되지 않는다', () => {
    // 같은 오버레이를 두 번 얹어도 값이 «두 배»가 되지 않는다(누적이면 사후 해석이 불가능해진다).
    const first = decideTemplate({ goalType: 'implement', authority: on, overlays: [RUNTIME], state: { attempts: 3 }, stage: 'runtime' });
    const second = decideTemplate({ goalType: 'implement', authority: on, overlays: [RUNTIME], state: { attempts: 4 }, stage: 'runtime' });
    expect(second.template.nodes[0]!.maxVisits).toBe(first.template.nodes[0]!.maxVisits);
  });
});
