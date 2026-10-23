// floorplan-to-film 스킬 — 목록·트리거 제안 완료 경계 검증.
// 골의 완료 경계 실물: "elanous 스킬 목록에 floorplan-to-film 이 뜨고
// 트리거 문구(«평면도로 3D», «인테리어 영상»)로 제안됨".
// 무대는 L1(생산 함수 ⊕ 저장소 실제 skills/ 디렉터리) — 픽스처를 만들지 않고
// 진짜 skills/floorplan-to-film/SKILL.md 를 읽는다. 스킬이 없으면 전부 빨강이다.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSkillIndex } from './index.js';
import { detectSkillTrigger, shouldAutoRoute } from './router.js';

const REPO_SKILLS = join(import.meta.dir, '..', '..', 'skills');

describe('floorplan-to-film — elanous 스킬 목록·제안 계약', () => {
  test('스킬 목록에 뜬다 — SkillIndexEntry 프런트매터 계약(slug name·명시 트리거·autoTrigger·minTier·composes·category·sideEffects·cost)', () => {
    const entry = buildSkillIndex([REPO_SKILLS]).find((e) => e.name === 'floorplan-to-film');
    expect(entry).toBeDefined();
    // nameTriggers() 가 slug 기반 트리거를 유도한다 — name 이 slug 규약을 따라야 한다
    expect(entry!.triggers).toContain('floorplan-to-film');
    expect(entry!.triggers).toContain('floorplan to film');
    // 골이 요구한 두 트리거 문구가 «명시» 트리거로 선언돼 있다(router explicit weight 1.0)
    expect(entry!.triggers).toContain('평면도로 3D');
    expect(entry!.triggers).toContain('인테리어 영상');
    expect(entry!.autoTrigger).toBe(true);
    expect(entry!.minTier).toBe('T1');
    expect(entry!.composes).toContain('video-builder');
    expect(entry!.category).toBe('visual');
    expect(entry!.sideEffects).toBe('spawn');
    expect(entry!.cost).toBe('heavy');
    expect(entry!.description.length).toBeGreaterThan(0);
  });

  test('프런트매터가 name·description·Use when·sideEffects·cost·requires 를 담는다(완료 경계 코드)', () => {
    const raw = readFileSync(join(REPO_SKILLS, 'floorplan-to-film', 'SKILL.md'), 'utf8');
    const fm = raw.slice(0, raw.indexOf('\n---'));
    expect(fm).toContain('name: floorplan-to-film');
    expect(fm).toContain('description:');
    expect(fm).toContain('Use when:');
    expect(fm).toContain('sideEffects: spawn');
    expect(fm).toContain('cost: heavy');
    expect(fm).toContain('requires:');
  });

  test('트리거 문구 «평면도로 3D» 로 제안된다(detectSkillTrigger)', () => {
    const idx = buildSkillIndex([REPO_SKILLS]);
    const r = detectSkillTrigger('이 평면도로 3D 투시도를 만들어 주세요', idx);
    expect(r.top?.name).toBe('floorplan-to-film');
    expect(r.top?.matchedTriggers).toContain('평면도로 3D');
    expect(r.top!.score).toBeGreaterThanOrEqual(1.0);
  });

  test('트리거 문구 «인테리어 영상» 로 제안된다(detectSkillTrigger)', () => {
    const idx = buildSkillIndex([REPO_SKILLS]);
    const r = detectSkillTrigger('인테리어 영상 하나 만들어 주세요', idx);
    expect(r.top?.name).toBe('floorplan-to-film');
    expect(r.top?.matchedTriggers).toContain('인테리어 영상');
    expect(r.top!.score).toBeGreaterThanOrEqual(1.0);
  });

  test('두 문구가 함께 오면 자동 라우팅 관문을 통과한다 — autoRouteMinScore 2.0 ⊕ tier gate', () => {
    const idx = buildSkillIndex([REPO_SKILLS]);
    const r = detectSkillTrigger('평면도로 3D 인테리어 영상으로 워크스루를 만들어 줘', idx);
    expect(r.top?.name).toBe('floorplan-to-film');
    expect(r.top!.score).toBeGreaterThanOrEqual(2.0);
    expect(shouldAutoRoute(r, { autoRouteEnabled: true, activeTier: 'T1' })).toBe(true);
    // tier gate — minTier: T1 인데 활성 모델이 T2 면 자동실행만 막는다(제안은 살아 있다)
    expect(shouldAutoRoute(r, { autoRouteEnabled: true, activeTier: 'T2' })).toBe(false);
    // 전역 옵트인이 없으면 자동실행하지 않는다
    expect(shouldAutoRoute(r, { autoRouteEnabled: false, activeTier: 'T1' })).toBe(false);
  });
});
