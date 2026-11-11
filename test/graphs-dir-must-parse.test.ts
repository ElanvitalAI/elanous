/**
 * 🚨 `graphs/` 에 «파싱 안 되는» 파일이 하나라도 있으면 하니스가 YAML 을 «전부» 버린다.
 *
 * ⛔ 2026-09-10 사고: 마케팅 파이프라인 «선언 문서»를 `graphs/` 에 뒀다.
 *   스키마가 달라 오류 32건 → 로더가 `builtin-fallback` 으로 접혀 템플릿이 **4개 → 2개**가 됐고,
 *   `default-loop`·`plan-loop` 이 «보이지 않게» 됐다(다른 트랙이 튜닝한 예산 선언이 전부 무시).
 *
 * ⛔⛔ 변경파일 스코프 게이트는 이것을 «원리상 못 잡는다» — 사고를 낸 판은 test 파일을 «하나도» 안 바꿨다.
 *   ⇒ 그래서 이 시험은 「내 변경」이 아니라 ***「그 디렉토리의 상태」***를 문다.
 *
 * 🔑 이 시험이 무는 것은 «개수»가 아니라 ***「로더가 YAML 을 쓰고 있나」***다 —
 *   개수를 박으면 그래프를 정당하게 늘릴 때 거짓 빨강이 난다.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraphTemplates, parseGraphTemplateYaml } from '../src/self-implement/graph-yaml.js';
import { loadGraphTemplatesFrom, defaultGraphsDir } from '../src/self-implement/graph-templates.js';

describe('graphs/ 디렉토리는 «전부» 파싱돼야 한다', () => {
  test('⛔ 파싱 오류가 하나라도 있으면 로더가 YAML 을 통째로 버린다', () => {
    const loaded = loadGraphTemplates(defaultGraphsDir());
    // ⛔ 오류를 «세지» 말고 «이름을 대라» — 빨강일 때 어느 파일인지 바로 보이게.
    expect(loaded.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([]);
  });

  test('⛔ 그래서 source 가 «yaml» 이어야 한다 — builtin-fallback 은 「선언이 안 읽힌다」는 뜻이다', () => {
    expect(loadGraphTemplatesFrom(defaultGraphsDir()).source).toBe('yaml');
  });

  test('📏 스캔은 했나 — 「0개 읽었다」와 「디렉토리가 없다」를 가른다', () => {
    expect(loadGraphTemplates(defaultGraphsDir()).scannedFiles).toBeGreaterThan(0);
  });

  test('WORK-COMPOSE-WEBAPP 선언은 작업 그래프 로더가 읽는다', () => {
    const file = join(import.meta.dir, '../graphs/work/web-app.yaml');
    const parsed = parseGraphTemplateYaml(readFileSync(file, 'utf8'), 'graphs/work/web-app.yaml');
    expect(parsed.errors).toEqual([]);
    expect(parsed.template?.graphId).toBe('work-web-app');
    expect(parsed.template?.nodes.find((node) => node.nodeId === 'compose-web-app')).toMatchObject({
      kind: 'subgraph',
      call: 'web-app@1',
      contract: { inputs: ['ask', 'context', 'prior'], tools: 'harness-say', outputs: ['result', 'evidence'] },
    });
  });
});
