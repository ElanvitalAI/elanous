import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WIZARD_MAX_RETRIES, WIZARD_STEPS, WIZARD_STEP_IDS, recipesSiblingOf, recipesYamlFor, runWizardStep, runWizardStepWithRetries } from './steps.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('SW-WIZARD-LOOP-DECL recipe format', () => {
  test('SW-WIZARD-LOOP-DECL: recipesYamlFor 는 cmd 노드를 <bin> graph step <id> --arg 형식으로 낸다', () => {
    const yaml = recipesYamlFor(
      [{ nodeId: 'ground', recipe: 'cmd:ground' }],
      { ground: { step: 'web-search', arg: '오늘 AI 뉴스' } },
      'bun bin/elanous.mjs',
    );
    const parsed = parseYaml(yaml) as Record<string, { command?: string; timeout_ms?: number }>;
    expect(Object.keys(parsed)).toEqual(['ground']);
    expect(parsed.ground!.command).toBe(`bun bin/elanous.mjs graph step web-search --arg '오늘 AI 뉴스'`);
    expect(parsed.ground!.timeout_ms).toBe(WIZARD_STEPS.find((s) => s.id === 'web-search')!.timeoutMs);
  });

  test('SW-WIZARD-LOOP-DECL: recipesYamlFor 는 approval 노드를 approval: 문구로 낸다', () => {
    const yaml = recipesYamlFor(
      [{ nodeId: 'approve', recipe: 'approval:approve' }],
      { approve: { label: '그래프 승인' } },
      'elanous',
    );
    const parsed = parseYaml(yaml) as Record<string, { approval?: string; command?: string; timeout_ms?: number }>;
    expect(parsed.approve!.approval).toBe('그래프 승인 — 승인할까요?');
    expect(parsed.approve!.command).toBeUndefined();
    expect(parsed.approve!.timeout_ms).toBeUndefined();
  });

  test('SW-WIZARD-LOOP-DECL: recipesYamlFor 는 retries 만큼 timeout_ms 를 늘리고 --retries 를 붙인다', () => {
    const yaml = recipesYamlFor(
      [{ nodeId: 'verify', recipe: 'cmd:verify' }],
      { verify: { step: 'check', arg: '기준', retries: 2 } },
      'elanous',
    );
    const parsed = parseYaml(yaml) as Record<string, { command?: string; timeout_ms?: number }>;
    expect(parsed.verify!.command).toBe(`elanous graph step check --arg '기준' --retries 2`);
    expect(parsed.verify!.timeout_ms).toBe(WIZARD_STEPS.find((s) => s.id === 'check')!.timeoutMs * 3);
  });

  test('SW-WIZARD-LOOP-DECL: recipesYamlFor 는 none·중복·레시피 없는 노드를 내지 않는다', () => {
    const yaml = recipesYamlFor(
      [
        { nodeId: 'intake', recipe: 'none' },
        { nodeId: 'classify', recipe: 'cmd:shared' },
        { nodeId: 'ground', recipe: 'cmd:shared' },
      ],
      { classify: { step: 'llm', arg: '분류' }, ground: { step: 'web-search', arg: '검색' } },
      'elanous',
    );
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['shared']);
    expect(recipesYamlFor([{ nodeId: 'intake', recipe: 'none' }], {}, 'elanous')).toBe('{}\n');
  });

  test('SW-WIZARD-LOOP-DECL: recipesSiblingOf 는 그래프 옆 recipes.yaml 을 읽고 없으면 undefined 다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wizard-recipes-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'wizard-loop.yaml'), 'graph_id: x\n');
    expect(recipesSiblingOf(join(dir, 'wizard-loop.yaml'))).toBeUndefined();
    writeFileSync(join(dir, 'recipes.yaml'), 'ground:\n  command: elanous graph step web-search\n');
    expect(recipesSiblingOf(join(dir, 'wizard-loop.yaml'))).toContain('graph step web-search');
  });
});

describe('SW-WIZARD-LOOP-DECL step library contract', () => {
  test('SW-WIZARD-LOOP-DECL: WIZARD_STEPS 의 outcomes 가 간선 map 키로 쓰일 수 있고 id 가 유일하다', () => {
    expect(WIZARD_STEP_IDS.size).toBe(WIZARD_STEPS.length);
    for (const spec of WIZARD_STEPS) {
      expect(spec.outcomes.length).toBeGreaterThan(0);
      for (const outcome of spec.outcomes) expect(outcome).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(spec.timeoutMs).toBeGreaterThan(0);
    }
    expect(WIZARD_MAX_RETRIES).toBeGreaterThanOrEqual(1);
  });

  test('SW-WIZARD-LOOP-DECL: runWizardStep 은 마지막 줄 JSON {outcome} 계약을 지키고 미지 단계는 fail 이다', () => {
    const unknown = runWizardStep('no-such-step', undefined, {});
    expect(unknown.outcome).toBe('fail');
    expect(typeof unknown.error).toBe('string');
    expect(runWizardStep('custom', '노션 업로드', {}).outcome).toBe('fail');
  });

  test('SW-WIZARD-LOOP-DECL: runWizardStepWithRetries 는 실패를 retries 만큼 다시 시도하고 ok 에서 멈춘다', () => {
    let calls = 0;
    const flaky = (() => {
      calls += 1;
      return calls < 3 ? { outcome: 'fail' as const, error: 'boom' } : { outcome: 'ok' as const, text: '됐다' };
    }) as typeof runWizardStep;
    const result = runWizardStepWithRetries('check', '기준', 5, flaky);
    expect(result.outcome).toBe('ok');
    expect(result.text).toBe('됐다');
    expect(result.tries).toBe(3);
  });
});
