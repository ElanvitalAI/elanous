import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadGraphTemplates, parseGraphTemplateYaml } from '../self-implement/graph-yaml';
import { dryRunWizardGraph, generateGraphFromPrompt, listWizardTemplates } from './generate';

const root = join(import.meta.dir, '..', '..');
const wizardDir = join(root, 'graphs', 'wizard');
const wizardLoopPath = join(wizardDir, 'wizard-loop.yaml');
const recipesPath = join(wizardDir, 'recipes.yaml');

const LOOP_ORDER = [
  'intake', 'classify', 'ground', 'gap', 'approve', 'acquire', 'generate',
  'compose', 'verify', 'store', 'run', 'improve',
] as const;

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('SW-WIZARD-LOOP-DECL', () => {
  test('SW-WIZARD-LOOP-DECL: wizard-loop 선언 파일 두 개가 graphs/wizard/ 아래에 있다', () => {
    expect(existsSync(wizardLoopPath)).toBe(true);
    expect(existsSync(recipesPath)).toBe(true);
  });

  test('SW-WIZARD-LOOP-DECL: 로더 불변식 검사가 오류 0건이고 순서·W1~W4 구조를 담는다', () => {
    const parsed = parseGraphTemplateYaml(read(wizardLoopPath), 'graphs/wizard/wizard-loop.yaml');
    expect(parsed.errors).toEqual([]);
    const template = parsed.template!;
    expect(template.graphId).toBe('wizard-loop');
    expect(template.entryNode).toBe('intake');
    expect([...template.terminalNodes].sort()).toEqual(['done', 'failed']);
    expect(template.nodes.map((n) => n.nodeId)).toEqual([...LOOP_ORDER, 'done', 'failed']);

    // W1 — approve 는 사람 승인 포인트(hitl · approval: 레시피 · 실제 유입 간선).
    const approve = template.nodes.find((n) => n.nodeId === 'approve')!;
    expect(approve.kind).toBe('hitl');
    expect(approve.recipe.startsWith('approval:')).toBe(true);
    const intoApprove = template.edges.filter((e) => Object.values(e.map ?? {}).includes('approve') || e.to === 'approve');
    expect(intoApprove.length).toBeGreaterThanOrEqual(1);

    // W2 — gap 은 outcome 기반 분기(map 키 ≥ 2)를 갖는다.
    const gapEdges = template.edges.filter((e) => e.from === 'gap');
    expect(gapEdges.length).toBe(1);
    expect(gapEdges[0]!.on).toBe('outcome');
    expect(Object.keys(gapEdges[0]!.map ?? {}).length).toBeGreaterThanOrEqual(2);

    // W3 — verify 실패(rework)는 이전 노드로 돌아가고 그 노드는 max_visits ≥ 2.
    const verifyEdge = template.edges.find((e) => e.from === 'verify')!;
    const back = verifyEdge.map!.rework!;
    const backIndex = LOOP_ORDER.indexOf(back as (typeof LOOP_ORDER)[number]);
    expect(backIndex).toBeGreaterThanOrEqual(0);
    expect(backIndex).toBeLessThan(LOOP_ORDER.indexOf('verify'));
    expect(template.nodes.find((n) => n.nodeId === back)!.maxVisits).toBeGreaterThanOrEqual(2);

    // W4 — terminal 은 done/failed 만.
    expect(template.terminalNodes).toEqual(['done', 'failed']);
    expect(template.nodes.filter((n) => n.kind === 'gate').map((n) => n.nodeId).sort()).toEqual(['done', 'failed']);
  });

  test('SW-WIZARD-LOOP-DECL: 그래프 디렉토리 로더가 wizard-loop 를 읽고 recipes.yaml 은 템플릿으로 읽지 않는다', () => {
    const loaded = loadGraphTemplates(wizardDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.scannedFiles).toBe(1);
    expect(loaded.templates['wizard-loop']).toBeDefined();
  });

  test('SW-WIZARD-LOOP-DECL: recipes.yaml 이 모든 cmd/approval 노드의 항목을 담는다', () => {
    const parsed = parseGraphTemplateYaml(read(wizardLoopPath), 'wizard-loop');
    const catalog = (parseYaml(read(recipesPath)) ?? {}) as Record<string, Record<string, unknown>>;
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
    for (const node of parsed.template!.nodes) {
      if (node.recipe === 'none') continue;
      const id = node.recipe.split(':')[1]!;
      const entry = catalog[id];
      expect(entry, `recipes.yaml 에 '${id}' 항목이 없다`).toBeDefined();
      if (node.recipe.startsWith('cmd:')) {
        expect(typeof entry!.command).toBe('string');
        expect(String(entry!.command)).toContain('graph step');
        expect(typeof entry!.timeout_ms).toBe('number');
      } else {
        expect(String(entry!.approval ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  test('SW-WIZARD-LOOP-DECL: 생산 진입점 listWizardTemplates 가 graphs/wizard/ 선언을 소비한다', () => {
    const templates = listWizardTemplates(join(root, 'graphs'));
    const entry = templates.find((t) => t.id === 'wizard-loop');
    expect(entry).toBeDefined();
    expect(entry!.runnable).toBe(true);
    expect(String(entry!.recipes ?? '')).toContain('graph step');
  });

  test('SW-WIZARD-LOOP-DECL: dryRunWizardGraph 드라이런 경로가 intake→…→done 까지 끝난다', async () => {
    const result = await dryRunWizardGraph(read(wizardLoopPath), read(recipesPath));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('done');
    expect(result.path[0]).toBe('intake');
    expect(result.path.at(-1)).toBe('done');
  }, 120_000);

  test('SW-WIZARD-LOOP-DECL: 생산 경로 generateGraphFromPrompt 가 recipes 카탈로그를 프롬프트로 소비한다', async () => {
    let seen = '';
    await generateGraphFromPrompt(
      { kind: 'harness', prompt: 'wizard loop 마법사 루프' },
      {
        graphsDir: wizardDir,
        existingIds: () => new Set<string>(),
        maxAttempts: 1,
        callLLM: async (text: string) => {
          seen = text;
          return 'SLUG: x\nSUMMARY: y\n```yaml\n```';
        },
      },
    );
    expect(seen).toContain('recipes.yaml');
    expect(seen).toContain('graph step llm');
  }, 120_000);
});
