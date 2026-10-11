import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  applyGraphOverlays, loadGraphOverlays, parseGraphOverlayYaml, selectOverlays,
  type GraphOverlaySpec,
} from './graph-overlay-yaml.js';
import { loadGraphTemplates, type GraphTemplateSpec } from './graph-yaml.js';
import { decideTemplate, resolveGraphAuthority } from './graph-authority.js';

const ROOT = join(import.meta.dir, '../..');
const templates = loadGraphTemplates(join(ROOT, 'graphs')).templates;
const base = templates['default-loop'] as GraphTemplateSpec;

const overlay = (patch: GraphOverlaySpec['patch'], id = 'test'): GraphOverlaySpec =>
  ({ overlayId: id, target: 'default-loop', stage: 'runtime', appliesWhen: 'attempts >= 0', patch });

describe('RFC §5 3단계 — 오버레이 파서', () => {
  test('⛔ 던지지 않는다 — 깨진 YAML 도 구조화 오류다', () => {
    const result = parseGraphOverlayYaml('overlay_id: [bad\n :', 'bad.yaml');
    expect(result.overlay).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('⛔ stage·op·path 를 «전부» 검사한다', () => {
    const result = parseGraphOverlayYaml(`
overlay_id: x
target: default-loop
stage: whenever
patch:
  - { op: mutate, path: nodes/0 }
`, 'bad2.yaml');
    const messages = result.errors.map((e) => e.message).join(' | ');
    expect(messages).toContain('stage');
    expect(messages).toContain('op');
  });

  test('⛔ 빈 patch 는 거절한다 — 아무것도 안 바꾸는 오버레이다', () => {
    const result = parseGraphOverlayYaml('overlay_id: x\ntarget: t\nstage: launch\napplies_when: goal_type == implement\npatch: []', 'empty.yaml');
    expect(result.errors.some((e) => e.message.includes('아무것도 안 바꾸는'))).toBe(true);
  });

  test('⛔ applies_when 없는 오버레이는 구조화 오류로 거절하고 생성하지 않는다', () => {
    const result = parseGraphOverlayYaml(`
      overlay_id: conditionless
      target: default-loop
      stage: runtime
      patch:
        - { op: replace, path: /nodes/0/maxVisits, value: 3 }
    `, 'conditionless.yaml');
    expect(result.overlay).toBeUndefined();
    expect(result.errors).toEqual([{
      path: 'conditionless.yaml/applies_when',
      message: 'applies_when 이 없거나 문자열이 아니다',
    }]);
  });

  test('`---` 로 나눈 문서는 문서마다 오버레이 하나로 읽고 오류 경로에 문서 번호가 붙는다', () => {
    const doc = (id: string, extra = 'applies_when: attempts >= 1') => `overlay_id: ${id}\ntarget: self-implement\nstage: runtime\n${extra}\npatch:\n  - { op: replace, path: /version, value: 2 }\n`;
    const ok = parseGraphOverlayYaml(`# 머리말\n---\n${doc('a')}---\n${doc('b')}`, 'multi.yaml');
    expect(ok.errors).toEqual([]);
    expect(ok.overlays.map((o) => o.overlayId)).toEqual(['a', 'b']);
    expect(ok.overlay?.overlayId).toBe('a');

    const bad = parseGraphOverlayYaml(`---\n${doc('a')}---\n${doc('b', '')}`, 'multi.yaml');
    expect(bad.overlays).toEqual([]);
    expect(bad.overlay).toBeUndefined();
    expect(bad.errors).toEqual([{ path: 'multi.yaml#1/applies_when', message: 'applies_when 이 없거나 문자열이 아니다' }]);

    const dup = parseGraphOverlayYaml(`---\n${doc('a')}---\n${doc('a')}`, 'multi.yaml');
    expect(dup.errors.map((e) => e.message)).toEqual(["overlay_id 'a' 가 한 파일에서 중복이다"]);
  });

  test('실물 graphs/overlays/ 를 오류 0 으로 읽는다', () => {
    const result = loadGraphOverlays(join(ROOT, 'graphs/overlays'));
    expect({ errors: result.errors, scanned: result.scannedFiles > 0 }).toEqual({ errors: [], scanned: true });
    // ⛔ 목록을 «못 박지» 않는다 — 오버레이는 늘고 준다. 무는 것은 「오류 0」이고
    //   「닿지 않는 것이 늘었나」는 `test/graph-overlay-reachability.test.ts` 가 «따로» 센다.
    expect(result.overlays.length).toBeGreaterThan(0);
  });

  test('⛔ 조건(applies_when)이 «값»으로 실린다 — 사람이 판단해 얹는 경로가 아니다', () => {
    for (const o of loadGraphOverlays(join(ROOT, 'graphs/overlays')).overlays) {
      expect({ id: o.overlayId, hasCondition: o.appliesWhen !== undefined })
        .toEqual({ id: o.overlayId, hasCondition: true });
    }
  });

  test('실물 rework-patient는 실행기 attempts로 runtime rework 예산을 바꾼다', () => {
    const overlays = loadGraphOverlays(join(ROOT, 'graphs/overlays')).overlays;
    const patient = overlays.find((candidate) => candidate.overlayId === 'rework-patient');
    expect(patient).toBeDefined();
    expect(patient?.target).toBe('self-implement');
    expect(patient?.stage).toBe('runtime');
    // ⛔ 값을 «상수로» 물지 않는다 — 예산 조정마다 이 시험이 깨지고, 그러면 「값이 무엇인가」를
    //    시험이 «정하게» 된다. 무는 것은 ***「기준 선언보다 큰가」***다(그것이 이 오버레이의 뜻이다).
    const implement = templates['self-implement'] as GraphTemplateSpec;
    const reworkIndex = implement.nodes.findIndex((node) => node.nodeId === 'rework');
    expect(reworkIndex).toBeGreaterThanOrEqual(0);
    expect({ op: patient?.patch[0]?.op, path: patient?.patch[0]?.path })
      .toEqual({ op: 'replace', path: `/nodes/${reworkIndex}/maxVisits` });
    expect(patient?.patch).toHaveLength(1);

    const authority = resolveGraphAuthority({ flag: true });
    const applied = decideTemplate({
      goalType: 'implement', authority, overlays, state: { attempts: 3, goal_id: 'goal' }, stage: 'runtime',
    });
    const baseline = decideTemplate({
      goalType: 'implement', authority, overlays, state: { attempts: 2, goal_id: 'goal' }, stage: 'runtime',
    });
    expect(applied.template.nodes[reworkIndex]?.nodeId).toBe('rework');
    // ⛔ 여기서도 «상수»가 아니라 ***기준 선언과의 «관계»***를 문다.
    const patchedVisits = applied.template.nodes[reworkIndex]?.maxVisits ?? 0;
    const baseVisits = baseline.template.nodes[reworkIndex]?.maxVisits ?? 0;
    expect({ appliedIds: applied.appliedIds, rejections: applied.rejections, raised: patchedVisits > baseVisits })
      .toEqual({ appliedIds: ['rework-patient'], rejections: [], raised: true });
    expect(applied.appliedPatches).toEqual([{
      overlayId: 'rework-patient', field: 'maxVisits', node: 'rework', before: baseVisits, after: patchedVisits,
    }]);
    expect({ appliedIds: baseline.appliedIds, maxVisits: baseline.template.nodes[reworkIndex]?.maxVisits, rejections: baseline.rejections, appliedPatches: baseline.appliedPatches })
      .toEqual({ appliedIds: [], maxVisits: 10, rejections: [], appliedPatches: [] });
  });
});

describe('RFC §5 3단계 — 오버레이 적용 (⛔ 얹은 «결과»를 다시 검사한다)', () => {
  test('예산 조정이 «실제로» 먹는다', () => {
    const result = applyGraphOverlays(base, [overlay([
      { op: 'replace', path: '/nodes/6/maxVisits', value: 9 },
    ])]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rework = result.template.nodes.find((n) => n.nodeId === 'rework');
    expect(rework?.maxVisits).toBe(9);
    // ⛔ 원본은 «안 만진다» — 오버레이가 실패해도 기준 선언이 살아 있어야 한다.
    expect(base.nodes.find((n) => n.nodeId === 'rework')?.maxVisits).toBe(6);
  });

  test('🚨 «조용한 무의미»를 거절한다 — 없는 키에 replace 하면 no-such-key 다', () => {
    // 🩸 계기(2026-09-08): 오버레이가 `/nodes/5/max_visits` 를 썼는데 파싱된 스펙은 `maxVisits` 라
    //   아무것도 안 바뀌고 «ok» 가 나왔다. ⇒ 「얹었다」와 「먹었다」가 갈리지 않았다.
    const result = applyGraphOverlays(base, [overlay([
      { op: 'replace', path: '/nodes/6/max_visits', value: 9 },
    ])]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections.some((r) => r.kind === 'no-such-key')).toBe(true);
  });

  test('⭐ 노드를 «추가»할 수 있다 — 다이나믹 대응의 핵심', () => {
    const result = applyGraphOverlays(base, [overlay([
      { op: 'add', path: '/nodes/-', value: {
        nodeId: 'probe', kind: 'judge', recipe: 'observe-only', maxVisits: 1,
        contract: { inputs: ['worktree'], tools: 'read-only', outputs: ['findings'] },
      } },
      { op: 'add', path: '/edges/-', value: { from: 'gate', on: 'outcome', map: { probe: 'probe' } } },
      { op: 'add', path: '/edges/-', value: { from: 'probe', to: 'review' } },
    ])]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.nodes.some((n) => n.nodeId === 'probe')).toBe(true);
    expect(result.overlayIds).toEqual(['test']);
  });

  test('⛔ 계약 «없는» 노드를 추가하면 거절한다 — 권한 없는 노드가 조용히 들어오지 않는다', () => {
    const result = applyGraphOverlays(base, [overlay([
      { op: 'add', path: '/nodes/-', value: { nodeId: 'sneaky', kind: 'agent', recipe: 'x', maxVisits: 1 } },
    ])]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections.some((r) => r.kind === 'node-without-contract')).toBe(true);
  });

  test('⛔ 얹은 «결과»가 그래프를 깨면 거절한다 — 노드 집합이 그대로여도 도달 가능성은 바뀐다', () => {
    // merge 로 가는 유일한 길을 끊는다.
    const openPrIndex = base.edges.findIndex((e) => e.from === 'open-pr');
    const result = applyGraphOverlays(base, [overlay([
      { op: 'replace', path: `/edges/${openPrIndex}`, value: { from: 'open-pr', to: 'stopped' } },
    ])]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections.some((r) => r.kind === 'breaks-graph')).toBe(true);
  });

  test('⛔ 다른 그래프를 겨눈 오버레이는 거절한다', () => {
    const result = applyGraphOverlays(base, [{ ...overlay([{ op: 'replace', path: '/version', value: 9 }]), target: 'research-loop' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections[0]?.kind).toBe('unknown-target');
  });
});

describe('RFC §5 4단계 — 선택 (⛔ 「안 얹혔다」의 이유가 «넷»이다)', () => {
  const all = loadGraphOverlays(join(ROOT, 'graphs/overlays')).overlays;
  const select = (stage: 'launch' | 'runtime', state: Record<string, unknown>) =>
    selectOverlays(all, { graphId: 'default-loop', stage, state });

  test('런타임 · 조건 충족 ⇒ 얹힌다', () => {
    const { applied, selections } = select('runtime', { heal_attempts: 2 });
    expect(applied.map((o) => o.overlayId)).toEqual(['heal-patient']);
    expect(selections.find((s) => s.overlayId === 'heal-patient')?.verdict).toBe('applies');
  });

  test('⛔ 「조건 거짓」·「키 없음」·「때가 아니다」가 «서로 다른 값»이다', () => {
    expect(select('runtime', { heal_attempts: 1 }).selections.find((s) => s.overlayId === 'heal-patient')?.verdict)
      .toBe('does-not-apply');
    const absent = select('runtime', {}).selections.find((s) => s.overlayId === 'heal-patient');
    expect({ verdict: absent?.verdict, detail: absent?.detail })
      .toEqual({ verdict: 'key-absent', detail: 'heal_attempts' });
    expect(select('launch', { goal_type: 'research' }).selections.find((s) => s.overlayId === 'heal-patient')?.verdict)
      .toBe('wrong-stage');
  });

  test('같은 대상은 적용하고 다른 대상은 판정만 남긴다', () => {
    const sameTarget = overlay([{ op: 'replace', path: '/version', value: 9 }], 'same-target');
    const differentTarget = { ...sameTarget, overlayId: 'different-target', target: 'research-loop' };
    const same = selectOverlays([sameTarget], { graphId: 'default-loop', stage: 'runtime', state: { attempts: 0 } });
    const different = selectOverlays([differentTarget], { graphId: 'default-loop', stage: 'runtime', state: { attempts: 0 } });

    expect(same.applied.map((candidate) => candidate.overlayId)).toEqual(['same-target']);
    expect(same.selections).toEqual([{ overlayId: 'same-target', verdict: 'applies' }]);
    expect(different.applied).toEqual([]);
    expect(different.selections).toEqual([{
      overlayId: 'different-target', verdict: 'target-mismatch', detail: 'research-loop',
    }]);
  });

  test('발사 단계 — goal_type 으로 갈린다', () => {
    // ⛔ 운영 오버레이 파일에 «묶지» 않는다 — 그 파일은 정당하게 사라진다(실제로 하나가 사라졌고
    //   이 시험이 그때 깨졌다). 갈림 자체를 인라인 픽스처로 문다.
    const launchOverlay = parseGraphOverlayYaml(`
overlay_id: research-only-fixture
target: default-loop
stage: launch
applies_when: goal_type == research
patch:
  - op: replace
    path: /nodes/0/maxVisits
    value: 3
`, 'fixture.yaml').overlay!;
    const pick = (state: Record<string, unknown>) =>
      selectOverlays([launchOverlay], { graphId: 'default-loop', stage: 'launch', state }).applied.map((o) => o.overlayId);
    expect(pick({ goal_type: 'research' })).toEqual(['research-only-fixture']);
    expect(pick({ goal_type: 'implement' })).toEqual([]);
  });

  test('⭐ 선택 → 적용이 «이어진다» — 예산이 실제로 바뀐다', () => {
    const base = loadGraphTemplates(join(ROOT, 'graphs')).templates['default-loop'] as GraphTemplateSpec;
    const { applied } = select('runtime', { heal_attempts: 2 });
    const result = applyGraphOverlays(base, applied);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overlayIds).toEqual(['heal-patient']);
    expect(result.template.nodes.find((n) => n.nodeId === 'rework')?.maxVisits).toBe(9);
  });
});
