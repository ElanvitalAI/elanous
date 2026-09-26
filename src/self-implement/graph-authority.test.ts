import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildDocumentGuardianIndex } from './document-guardian-index.js';
import {
  activeImplementTemplate, activeTemplate, auditTestConsumedDocumentCoverage, discardedNodeFieldsSummary, frontObservationTemplate, graphAuthorityFields,
  graphTemplateIssuesObservation, nodeNameForStage, repositoryTestSources, resolveGraphAuthority, resolveGraphAuthorityForUserConfig, routeGate, templateHasNode,
} from './graph-authority.js';
import { GRAPH_SPECS, GRAPH_TEMPLATES, compileGraphTemplate, type GraphTemplate } from './graph-templates.js';
import { buildUserConfig } from '../user-config.js';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dir, '../..');

// ⛔ 이름을 «갈라» 둔다 — 같은 모듈이 export 하는 `repositoryTestSources`(경로→내용 맵)와
//   이 지역 함수(경로 목록)는 «다른 값»이고, 한 이름이면 지역이 import 를 가려 조용히 틀린 모양이 흐른다.
function testFilePaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFilePaths(path);
    return entry.name.endsWith('.test.ts') ? [relative(REPO, path)] : [];
  });
}

describe('exported document-coverage audit — current repository callers', () => {
  test('test/rules-contract.test.ts causes docs to be covered', () => {
    const documents = ['AGENTS.md', 'CLAUDE.md'];
    const index = buildDocumentGuardianIndex(REPO, testFilePaths(join(REPO, 'test')), documents);

    for (const document of documents) {
      expect(index.guardiansByDocument.get(document)).toContain('test/rules-contract.test.ts');
    }
    expect(index.unreadableTests).toBe(0);
  }, 15_000);
});

describe('2026-09-26 설정 졸업 — 선언은 항상 실행 권위', () => {
  test('운영 매뉴얼은 끄는 옵션을 더는 안내하지 않는다', () => {
    const manual = readFileSync(join(REPO, 'docs/manual/MANUAL-graph-operations-2026-09-10.md'), 'utf8');
    expect(manual).toContain('2026-09-26 설정 졸업 — 그래프 권위는 항상 켬');
    expect(manual).not.toContain('--no-graph');
    expect(manual).not.toContain('graphAuthoritative: false');
  });

  test('config/flag가 false여도 두 resolver는 항상 켜진 default를 반환한다', () => {
    const expected = { enabled: true, source: 'default' as const };
    for (const input of [{}, { config: false }, { flag: false, config: true }, { flag: true, config: false }]) {
      expect(resolveGraphAuthority(input)).toEqual(expected);
    }
    const dir = mkdtempSync(join(tmpdir(), 'graph-authority-'));
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ tools: { selfImplement: { graphAuthoritative: false } } }));
      const config = buildUserConfig(path);
      expect(config.tools.selfImplement).not.toHaveProperty('graphAuthoritative');
      expect(resolveGraphAuthorityForUserConfig()).toEqual(expected);
      expect(resolveGraphAuthorityForUserConfig(config)).toEqual(expected);
      expect(resolveGraphAuthorityForUserConfig(config, false)).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('종류를 모르면 implement-loop을 선택한다', () => {
    expect(activeTemplate(undefined, resolveGraphAuthority({})).graphId).toBe('self-implement');
  });

  test('앞단 관측은 implement 골의 활성 YAML 템플릿 정체성을 쓴다', () => {
    expect(activeImplementTemplate().graphId).toBe(activeTemplate('implement', resolveGraphAuthority({})).graphId);
    expect(activeImplementTemplate().graphId).toBe('self-implement');
  });

  test('앞단 관측은 implement로 확인된 경우에만 활성 구현 그래프를 기록한다', () => {
    expect(frontObservationTemplate('implement').graphId).toBe('self-implement');
    expect(frontObservationTemplate('research').graphId).toBe('default-loop');
    expect(frontObservationTemplate(undefined).graphId).toBe('default-loop');
  });

  test('항상 켜진 권위는 골 종류에 맞는 템플릿을 고른다', () => {
    const on = resolveGraphAuthority({});
    expect(on).toEqual({ enabled: true, source: 'default' });
    expect(activeTemplate('research', on).graphId).toBe('research-loop');
    expect(activeTemplate('implement', on).graphId).toBe('self-implement');
    // ⛔ 템플릿이 «없는» 종류는 implement-loop 으로 떨어진다 — 없는 길로 보내지 않는다.
    // ⛔ 옛 사실: 템플릿이 «없어서» 구현 루프로 접혔다. 이제 document 는 자기 그래프가 있다.
    expect(activeTemplate('document', on).graphId).toBe('document-loop');
    expect(activeTemplate('operate', on).graphId).toBe('operate-loop');
  });

  test('⭐ 켠 implement 런도 여덟 단계 이름과 두 gate 를 그대로 갖는다', () => {
    const template = activeTemplate('implement', resolveGraphAuthority({ config: true }));
    for (const stage of ['implement', 'gate', 'review', 'rework', 'main-sync', 'regate', 'open-pr', 'merge']) {
      expect(nodeNameForStage(stage, template)).toBe(stage);
    }
    expect(templateHasNode(template, 'gate')).toBe(true);
    expect(templateHasNode(template, 'regate')).toBe(true);
  });

  test('⭐ 둘째 반증 — 켠 research 런은 gate 를 «조건부로» 갖고 착지 경로를 «전부» 갖는다', () => {
    // 🚨 2026-09-08 정정: gate 를 «아예 빼면» research 골이 코드를 만져도 시험이 안 돈다(구멍 ⓐ).
    //   ⇒ 노드는 갖되 «조건부»다 — 들를지는 routeGate 가 코드로 판정한다(아래 라우터 describe).
    const template = activeTemplate('research', resolveGraphAuthority({ config: true }));
    expect(templateHasNode(template, 'gate')).toBe(true);
    // 📏 YAML 이 실물이 되면서 착지 경로가 선언에 들어왔다(첫 승격 런이 밟았다).
    expect(templateHasNode(template, 'regate')).toBe(true);
    expect(templateHasNode(template, 'merge')).toBe(true);      // 대표: 연구 문서가 «남아야» 한다
    expect(templateHasNode(template, 'open-pr')).toBe(true);
  });

  test('켠 research 런은 단계 이름이 갈린다 — 그리고 모르는 단계는 그대로 둔다', () => {
    const template = activeTemplate('research', resolveGraphAuthority({ config: true }));
    expect(nodeNameForStage('implement', template)).toBe('investigate');
    expect(nodeNameForStage('rework', template)).toBe('investigate');
    expect(nodeNameForStage('review', template)).toBe('judge');
    expect(nodeNameForStage('merge', template)).toBe('merge');
    expect(nodeNameForStage('무엇인지-모름', template)).toBe('무엇인지-모름');
  });

  test('그래프 템플릿 이슈 관측은 빈 목록과 사용 불가를 구분하고 상한에서 절단을 명시한다', () => {
    expect(graphTemplateIssuesObservation([])).toEqual({ graphTemplatesIssues: [], graphTemplatesIssuesTruncated: false });
    expect(graphTemplateIssuesObservation(undefined)).toEqual({ graphTemplatesIssues: null, graphTemplatesIssuesTruncated: false });

    const issues = Array.from({ length: 21 }, (_, index) => ({ path: `template-${index}.yaml`, message: `issue-${index}` }));
    expect(graphTemplateIssuesObservation(issues)).toEqual({
      graphTemplatesIssues: issues.slice(0, 20),
      graphTemplatesIssuesTruncated: true,
    });
  });

  test('원장 칸 — 기존 권위 칸, 템플릿 이슈 내용, 선택된 스펙의 버려진 선언 필드를 함께 싣는다', () => {
    const on = resolveGraphAuthority({ config: true });
    const researchTemplate = activeTemplate('research', on);
    const fields = graphAuthorityFields(on, researchTemplate);
    expect(fields)
      .toEqual({
        graphAuthoritative: true,
        graphAuthoritativeSource: 'default',
        activeGraphId: 'research-loop',
        graphTemplatesSource: 'yaml',
        graphTemplatesIssueCount: 4,
        graphTemplatesIssues: [
          { path: 'plan-loop.yaml/nodes/0/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
          { path: 'plan-loop.yaml/nodes/1/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
          { path: 'plan-loop.yaml/nodes/2/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
          { path: 'plan-loop.yaml/nodes/3/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
        ],
        graphTemplatesIssuesTruncated: false,
        discardedNodeFields: compileGraphTemplate(GRAPH_SPECS['research-loop']!).discardedNodeFields,
      });
    expect(JSON.stringify(fields)).toContain('계약(inputs·tools·outputs)이 없다');
    const unknownTemplate = activeTemplate(undefined, on);
    expect(graphAuthorityFields(on, unknownTemplate))
      .toEqual({
        graphAuthoritative: true,
        graphAuthoritativeSource: 'default',
        activeGraphId: 'self-implement',
        graphTemplatesSource: 'yaml',
        graphTemplatesIssueCount: 4,
        graphTemplatesIssues: [
          { path: 'plan-loop.yaml/nodes/0/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
          { path: 'plan-loop.yaml/nodes/1/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
          { path: 'plan-loop.yaml/nodes/2/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
          { path: 'plan-loop.yaml/nodes/3/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
        ],
        graphTemplatesIssuesTruncated: false,
        discardedNodeFields: compileGraphTemplate(GRAPH_SPECS['self-implement']!).discardedNodeFields,
      });
  });

  test('기존 실행 모듈 orchestrator.ts는 payload factory를 그대로 호출한다', () => {
    const orchestratorSource = readFileSync(join(import.meta.dir, 'orchestrator.ts'), 'utf8');

    expect(orchestratorSource).toContain("observe('graph-authority-resolved', graphAuthorityFields(graphAuthority, graphTemplate));");
  });

  test('대응 스펙이 없으면 던지지 않고 null로 남겨 빈 선언 손실과 구별한다', () => {
    const authority = resolveGraphAuthority({});
    const missingSpecTemplate: GraphTemplate = {
      ...GRAPH_TEMPLATES['self-implement']!,
      graphId: 'no-such-graph',
    };

    expect(graphAuthorityFields(authority, missingSpecTemplate)).toEqual({
      graphAuthoritative: true,
      graphAuthoritativeSource: 'default',
      activeGraphId: 'no-such-graph',
      graphTemplatesSource: 'yaml',
      graphTemplatesIssueCount: 4,
      graphTemplatesIssues: [
        { path: 'plan-loop.yaml/nodes/0/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
        { path: 'plan-loop.yaml/nodes/1/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
        { path: 'plan-loop.yaml/nodes/2/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
        { path: 'plan-loop.yaml/nodes/3/contract', message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' },
      ],
      graphTemplatesIssuesTruncated: false,
      discardedNodeFields: null,
    });
  });

  test('버려진 선언 필드 요약은 계약을 보존하며 실물 스펙을 다시 컴파일한다', () => {
    const original = GRAPH_SPECS['self-implement']!;
    const nodeWithContract = original.nodes.find((node) => node.contract !== undefined)!;
    const withoutContract = {
      ...original,
      nodes: original.nodes.map((node) => node.nodeId === nodeWithContract.nodeId
        ? (() => {
            const { contract: _contract, ...nodeWithoutContract } = node;
            return nodeWithoutContract;
          })()
        : node),
    };

    const originalSummary = discardedNodeFieldsSummary(original);
    const withoutContractSummary = discardedNodeFieldsSummary(withoutContract);
    const originalNode = originalSummary.find((entry) => entry.nodeId === nodeWithContract.nodeId)!;
    const withoutContractNode = withoutContractSummary.find((entry) => entry.nodeId === nodeWithContract.nodeId)!;

    expect(originalSummary).toEqual(compileGraphTemplate(original).discardedNodeFields);
    expect(withoutContractSummary).toEqual(compileGraphTemplate(withoutContract).discardedNodeFields);
    expect(originalNode.fields).not.toContain('contract');
    expect(withoutContractNode.fields).not.toContain('contract');
    expect(originalSummary).toEqual(withoutContractSummary);
  });
});

describe('시험 문서 소비 범위 감사 — 목록을 자동으로 고치지 않고 누락만 보고한다', () => {
  test('덮인 접두사는 제외하고, 실제 읽는 정확 경로만 위반으로 낸다', () => {
    const audit = auditTestConsumedDocumentCoverage({
      'test/reader.test.ts': "readFileSync('docs/manual/uncovered.md', 'utf8'); readFileSync('docs/goals/covered.md', 'utf8');",
    }, ['docs/goals/']);
    expect(audit).toEqual({ uncoveredPaths: ['docs/manual/uncovered.md'], violationCount: 1 });
  });

  test('주석·문자열 가짜 호출과 재할당된 바인딩은 실행 읽기가 아니다', () => {
    const audit = auditTestConsumedDocumentCoverage({
      'test/reader.test.ts': [
        "// readFileSync('docs/manual/comment.md')",
        "const example = \"readFileSync('docs/manual/string.md')\";",
        "let path = 'docs/manual/not-read.md'; path = 'data.json'; readFileSync(path);",
        "let changed = 'docs/manual/not-read-either.md'; changed += '.json'; readFileSync(changed);",
      ].join('\n'),
    });
    expect(audit).toEqual({ uncoveredPaths: [], violationCount: 0 });
  });

  test('읽기 지점의 const 바인딩만 쓰며 동명 지역 바인딩은 바깥 경로를 오염시키지 않는다', () => {
    const audit = auditTestConsumedDocumentCoverage({
      'test/reader.test.ts': [
        "const path = 'docs/manual/outer.md';",
        "function readLocal() { const path = 'data.json'; readFileSync(path); }",
        "readFileSync(path);",
      ].join('\n'),
    });
    expect(audit).toEqual({ uncoveredPaths: ['docs/manual/outer.md'], violationCount: 1 });
  });

  test('함수 매개변수는 바깥 정적 바인딩을 가려 실행 읽기로 추측하지 않는다', () => {
    const audit = auditTestConsumedDocumentCoverage({
      'test/reader.test.ts': [
        "const path = 'docs/manual/outer.md';",
        "function readLocal(path: string) { readFileSync(path); }",
      ].join('\n'),
    });
    expect(audit).toEqual({ uncoveredPaths: [], violationCount: 0 });
  });

  test('정적 join과 resolve는 최종 경로만 보고하고, 문서가 아닌 최종값은 제외한다', () => {
    const audit = auditTestConsumedDocumentCoverage({
      'test/reader.test.ts': [
        "readFileSync(join('docs/manual', 'guide.md'), 'utf8');",
        "readFileSync(resolve('docs/goals/covered.md', 'data.json'), 'utf8');",
      ].join('\n'),
    });
    expect(audit).toEqual({ uncoveredPaths: ['docs/manual/guide.md'], violationCount: 1 });
  });

  test('공급한 범위가 알려진 양성을 덮으면 위반이 사라진다', () => {
    const sources = { 'test/rules-contract.test.ts': "readFileSync('docs/manual/MANUAL-goal-authoring-method-2026-08-03.md', 'utf8');" };
    expect(auditTestConsumedDocumentCoverage(sources).uncoveredPaths)
      .toEqual(['docs/manual/MANUAL-goal-authoring-method-2026-08-03.md']);
    expect(auditTestConsumedDocumentCoverage(sources, ['docs/manual/']))
      .toEqual({ uncoveredPaths: [], violationCount: 0 });
  });

  test('repositoryTestSources 호출자가 저장소의 알려진 양성과 다섯 기존 범위를 실제로 감사한다', () => {
    const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
    const sources = repositoryTestSources(repositoryRoot);
    expect(sources['test/rules-contract.test.ts']).toContain('MANUAL-goal-authoring-method-2026-08-03.md');
    const audit = auditTestConsumedDocumentCoverage(sources);
    const knownPositive = 'docs/manual/MANUAL-goal-authoring-method-2026-08-03.md';
    expect(audit.uncoveredPaths).toContain(knownPositive);
    expect(audit.violationCount).toBeGreaterThan(0);
    expect(audit.uncoveredPaths.some((path) => ['.rules/', 'docs/goals/', 'docs/design/craft/', 'docs/mission-requests/', 'DESIGN.md'].some((prefix) => path.startsWith(prefix)))).toBe(false);
    expect(auditTestConsumedDocumentCoverage(sources, [
      '.rules/', 'docs/goals/', 'docs/design/craft/', 'docs/mission-requests/', 'DESIGN.md', 'docs/manual/',
    ]).uncoveredPaths).not.toContain(knownPositive);
  }, 15_000);
});

describe('⭐ 게이트 라우터 — 값은 «코드»가 낸다 (RFC §4.3 ⑵ · 승격 구멍 ⓐ 를 닫는다)', () => {
  const implement = GRAPH_TEMPLATES['self-implement'] as GraphTemplate;
  const research = GRAPH_TEMPLATES['research-loop'] as GraphTemplate;

  test('implement-loop 은 «언제나» 돈다 — 문서만 바뀌어도', () => {
    expect(routeGate(implement, ['a.ts'])).toEqual({ runsGate: true, reason: 'template-has-gate' });
    expect(routeGate(implement, ['docs/a.md'])).toEqual({ runsGate: true, reason: 'template-has-gate' });
  });

  test('문서 전용 건너뛰기 정책을 선언한 템플릿만 일반 문서에서 안 돈다', () => {
    expect(routeGate(research, ['docs/a.md', 'README.txt'])).toEqual({ runsGate: false, reason: 'documents-only' });
    expect(routeGate({ ...research, docsOnlyGateSkip: undefined }, ['docs/a.md'])).toEqual({ runsGate: true, reason: 'template-has-gate' });
    expect(routeGate({ ...implement, graphId: 'research-loop' }, ['docs/a.md'])).toEqual({ runsGate: true, reason: 'template-has-gate' });
  });

  test('research-loop ⊕ 시험이 소비하는 문서는 게이트를 돈다', () => {
    for (const file of [
      '.rules/00-core/first-principle.md',
      'docs/goals/GOAL-x.md',
      'docs/design/craft/x.md',
      'docs/mission-requests/r.md',
      'DESIGN.md',
    ]) {
      expect(routeGate(research, [file])).toEqual({ runsGate: true, reason: 'code-changed' });
    }
  });

  test('🚨 research-loop 인데 «코드»가 섞이면 «돈다» — 이것이 구멍 ⓐ 다', () => {
    expect(routeGate(research, ['docs/a.md', 'src/x.ts'])).toEqual({ runsGate: true, reason: 'code-changed' });
    expect(routeGate(research, ['src/x.ts'])).toEqual({ runsGate: true, reason: 'code-changed' });
    // 확장자가 «없는» 파일도 코드로 센다 — 모르면 돌린다.
    expect(routeGate(research, ['Makefile'])).toEqual({ runsGate: true, reason: 'code-changed' });
  });

  test('⛔ 「못 셌다」와 「변경이 없다」는 모두 돌리되 사유를 가른다', () => {
    const unknown = routeGate(research, undefined);
    const empty = routeGate(research, []);
    expect(unknown).toEqual({ runsGate: true, reason: 'changed-files-unknown' });
    expect(empty).toEqual({ runsGate: true, reason: 'changed-files-empty' });
    expect(unknown.reason).not.toBe(empty.reason);
  });

  test('⛔ 사유가 「돌았나」와 «따로» 남는다 — 같은 false 라도 이유가 다르다', () => {
    const withoutGate = routeGate({ ...research, nodes: research.nodes.filter((node) => node.nodeId !== 'gate') }, ['src/x.ts']);
    const documentsOnly = routeGate(research, ['docs/a.md']);
    const unknown = routeGate(research, undefined);
    expect(withoutGate).toEqual({ runsGate: false, reason: 'template-has-no-gate' });
    expect(documentsOnly).toEqual({ runsGate: false, reason: 'documents-only' });
    expect(withoutGate.runsGate).toBe(false);
    expect(documentsOnly.runsGate).toBe(false);
    expect(withoutGate.reason).not.toBe(documentsOnly.reason);
    expect(unknown.runsGate).toBe(true);
    expect(documentsOnly.reason).not.toBe(unknown.reason);
  });
});
