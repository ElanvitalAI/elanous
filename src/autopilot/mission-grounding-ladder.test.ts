import { describe, it, expect } from 'bun:test';
import { preflightArc } from './mission-arc-preflight.js';
import {
  adaptiveGround, extractSymbols, isImplementationFile, parseAssess, GROUNDING_TIERS,
  normalizeExternalCompletion, deriveReuseBoundary,
  type GroundingDeps,
} from './mission-grounding-ladder.js';

// 결정론 deps — 각 티어를 스텁하고 assess 로 에스컬레이션을 통제.
const baseDeps = (over: Partial<GroundingDeps> = {}): GroundingDeps => ({
  ground: async () => ({ grounded: true, context: 'docs/FEATURE.md 헤더', files: ['docs/FEATURE.md'] }),
  readFiles: (files) => files.map((f) => `### ${f}\ncode`).join('\n'),
  gitProbe: async () => 'git log 이력',
  callSites: async () => '호출부 3건',
  research: async () => '외부조사',
  repoRoot: '/repo',
  ...over,
});

describe('extractSymbols', () => {
  it('camelCase/PascalCase 식별자만 추출', () => {
    const s = extractSymbols('applyCurationProposal 와 buildCurationProposal 을 the and 수정');
    expect(s).toContain('applyCurationProposal');
    expect(s).toContain('buildCurationProposal');
    expect(s).not.toContain('and'); // 소문자 단어 제외
  });
});

describe('parseAssess', () => {
  it('high → 정지(nextTierIdx null)', () => {
    expect(parseAssess('{"confidence":"high","nextTier":"none"}', 0)).toEqual({ confidence: 'high', nextTierIdx: null });
  });
  it('low + nextTier 점프(더 깊은 티어)', () => {
    // cur=skim(0), nextTier=verify(3) → 점프
    expect(parseAssess('{"confidence":"low","nextTier":"verify"}', 0)).toEqual({ confidence: 'low', nextTierIdx: 3 });
  });
  it('nextTier 가 현재보다 얕으면 +1 로', () => {
    expect(parseAssess('{"confidence":"low","nextTier":"skim"}', 2).nextTierIdx).toBe(3);
  });
  it('파싱 실패 → medium + 1', () => {
    expect(parseAssess('잡음', 1)).toEqual({ confidence: 'medium', nextTierIdx: 2 });
  });
});

describe('isImplementationFile', () => {
  it('persistent grounding 확장자의 구현 파일을 인식한다', () => {
    for (const file of [
      'src/service.ts', 'src/view.tsx', 'src/script.js', 'src/module.mjs', 'src/config.cjs',
      'apps/android/app/src/main/kotlin/com/elanous/Main.kt', 'apps/android/build.gradle.kts',
      'apps/ios/ElanousiOSKit/Sources/Elanous/App.swift', 'scripts/tool.py',
      'scripts/coord-post.sh', 'scripts/rooted.bash',
    ]) expect(isImplementationFile(file)).toBe(true);
  });

  it('JavaScript·Kotlin·Swift 시험 파일을 배제한다', () => {
    for (const file of [
      'src/service.test.ts', 'src/service.test.js',
      'apps/android/app/src/test/kotlin/com/elanous/MainTest.kt',
      'apps/android/app/src/main/kotlin/com/elanous/MainTest.kt',
      'apps/ios/ElanousiOSKitTests/AppTests.swift', 'apps/ios/ElanousiOSKit/Sources/Elanous/AppTests.swift',
    ]) expect(isImplementationFile(file)).toBe(false);
  });
});

describe('adaptiveGround — 자기인지 에스컬레이션', () => {
  it('shell implementation seed는 기존 사다리 경로에서 grounded로 판정한다', async () => {
    const r = await adaptiveGround('q', { seedFiles: ['scripts/coord-post.sh'] }, baseDeps({
      assess: async () => '{"confidence":"high"}',
      maxTier: 1,
    }));
    expect(r.grounded).toBe(true);
    expect(r.files).toContain('scripts/coord-post.sh');
  });

  it('high 나오면 즉시 멈춤(skim 만)', async () => {
    const r = await adaptiveGround('q', { acceptance: ['a'] }, baseDeps({
      assess: async () => '{"confidence":"high"}',
    }));
    expect(r.tiersUsed).toEqual(['skim']);
    expect(r.confidence).toBe('high');
  });

  it('low 반복 → 사다리 타고 깊어짐(read→git→verify)', async () => {
    let n = 0;
    const seq = ['low', 'low', 'low', 'high']; // skim→read→git→verify 후 high
    const r = await adaptiveGround('q', { acceptance: ['a'] }, baseDeps({
      assess: async () => `{"confidence":"${seq[n++] ?? 'high'}","nextTier":"none"}`,
    }));
    expect(r.tiersUsed).toEqual(['skim', 'read', 'git', 'verify']);
    expect(r.confidence).toBe('high');
  });

  it('maxTier 로 깊이 상한(verify 이후 external 안 감·external 스텁)', async () => {
    const r = await adaptiveGround('q', { acceptance: ['a'] }, baseDeps({
      maxTier: 4, // verify 까지
      assess: async () => '{"confidence":"low","nextTier":"external"}', // 계속 더 파려 해도
    }));
    expect(r.tiersUsed).not.toContain('external');
    expect(r.tiersUsed[r.tiersUsed.length - 1]).toBe('verify');
  });

  it('nextTier 점프 — skim 에서 바로 verify 로', async () => {
    let n = 0;
    const r = await adaptiveGround('q', { acceptance: ['a'] }, baseDeps({
      assess: async () => n++ === 0 ? '{"confidence":"low","nextTier":"verify"}' : '{"confidence":"high"}',
    }));
    expect(r.tiersUsed).toEqual(['skim', 'verify']); // read·git 건너뜀
  });
});

describe('adaptiveGround — external 티어(G3)', () => {
  it('assess 가 external 지목하면 웹조사 도달(기본 maxTier 5)', async () => {
    let n = 0;
    const r = await adaptiveGround('q', { acceptance: ['a'] }, baseDeps({
      research: async () => '웹 조사 결과',
      assess: async () => (n++ === 0 ? '{"confidence":"low","nextTier":"external"}' : '{"confidence":"high"}'),
    }));
    expect(r.tiersUsed).toContain('external');
  });

  it('external 만으론 grounded false(우리 코드 아님) — impl 파일 없으면', async () => {
    const r = await adaptiveGround('q', {}, baseDeps({
      ground: async () => ({ grounded: false, context: '', files: [] }), // 내부 코드 못 찾음
      readFiles: () => '',
      research: async () => '외부 지식',
      assess: async () => '{"confidence":"medium","nextTier":"external"}',
      maxTier: 5,
    }));
    // 외부 지식이 있어도 impl 실독 없으면 grounded false(false-ground 방지)
    expect(r.grounded).toBe(false);
  });
});

describe('adaptiveGround — 휴리스틱 폴백(assess 미주입)', () => {
  it('문서만 읽으면 low → grounded false(못 봄)', async () => {
    const r = await adaptiveGround('q', {}, baseDeps({
      assess: undefined,
      ground: async () => ({ grounded: true, context: 'doc', files: ['docs/X.md'] }),
      readFiles: () => '', // seed 없음
      maxTier: 1, // skim 만
    }));
    expect(r.confidence).toBe('low');
    expect(r.grounded).toBe(false);
  });

  it('impl 파일 + git/verify 티어 도달 → high → grounded true', async () => {
    const r = await adaptiveGround('q', { seedFiles: ['src/doc-curation.ts'] }, baseDeps({
      assess: undefined,
      ground: async () => ({ grounded: true, context: 'doc', files: ['src/doc-curation.ts'] }),
    }));
    // 휴리스틱: impl 있고 아직 git/verify 전이면 medium → +1 계속 → git/verify 도달 시 high
    expect(r.grounded).toBe(true);
    expect(r.confidence).toBe('high');
    expect(r.files).toContain('src/doc-curation.ts');
  });
});

describe('adaptiveGround — fail-soft', () => {
  it('티어 오류는 스킵하고 계속', async () => {
    const r = await adaptiveGround('q', { acceptance: ['a'] }, baseDeps({
      gitProbe: async () => { throw new Error('git down'); },
      assess: async () => '{"confidence":"medium","nextTier":"none"}',
      maxTier: 3,
    }));
    // git 티어가 던져도 crash 없이 결과 반환
    expect(r.tiersUsed.length).toBeGreaterThanOrEqual(1);
    expect(GROUNDING_TIERS).toContain(r.tiersUsed[0]!);
  });
});

describe('normalizeExternalCompletion / deriveReuseBoundary — AA4/AA5(phase 7·외부 수습 2026-07-16)', () => {
  const g = { grounded: true, files: ['src/autopilot/mission-multiphase-executor.ts'] };

  it('출처+grounded+범위 일치 → 완성 인정', () => {
    const c = normalizeExternalCompletion(g, { source: 'PR #4358', claimedScope: ['mission-multiphase-executor'] });
    expect(c.complete).toBe(true);
    expect(c.source).toBe('PR #4358');
  });
  it('출처 없음 → 미인정(허위 완성 방지)', () => {
    expect(normalizeExternalCompletion(g, { source: null, claimedScope: ['mission-multiphase-executor'] }).complete).toBe(false);
  });
  it('grounded=false → 미인정(근거 부족)', () => {
    expect(normalizeExternalCompletion({ ...g, grounded: false }, { source: 'PR #1', claimedScope: ['mission-multiphase-executor'] }).complete).toBe(false);
  });
  it('범위 불일치 → 미인정', () => {
    const c = normalizeExternalCompletion(g, { source: 'PR #1', claimedScope: ['some-other-file'] });
    expect(c.complete).toBe(false);
    expect(c.evidence).toContain('범위 불일치');
  });
  it('완성 → reuseBoundary fresh(범위 전달)', () => {
    const c = normalizeExternalCompletion(g, { source: 'PR #1', claimedScope: ['mission-multiphase-executor'] });
    const b = deriveReuseBoundary(c, g);
    expect(b.freshness).toBe('fresh');
    expect(b.scope).toEqual(g.files);
  });
  it('미완성 → reuseBoundary stale(적용 안 함·결정론)', () => {
    const c = normalizeExternalCompletion(g, { source: null, claimedScope: ['x'] });
    expect(deriveReuseBoundary(c, g).freshness).toBe('stale');
  });
});

describe('MISSION-RM-SHARED-EXTRACT: existing production caller uses shared grounding', () => {
  it('preflightArc uses the compatibility path backed by the extracted implementation', async () => {
    let observedPrompt = '';
    const groundingDeps = {
      searchTerms: async () => [],
      codebaseGrounding: {
        persistent: false as const,
        seedPaths: ['src/autopilot/mission-grounding-ladder.ts'],
        skillIndex: () => [],
        pickSkills: async () => [],
        recallMemory: () => [],
        recallSelf: async () => [],
        refDigest: () => '',
        listCapsules: () => [],
      },
      assess: async () => '{"confidence":"high","nextTier":"none"}',
      maxTier: 1,
    };
    expect('ground' in groundingDeps).toBe(false);
    const result = await preflightArc(
      {
        arcId: 'grounding-shared-extract',
        name: 'shared grounding extraction',
        intent: 'verify src/autopilot/mission-grounding-ladder.ts grounding',
        phaseIds: ['task:grounding'],
        dependsOnArcs: [],
        acceptance: ['grounded evidence is visible'],
        status: 'pending',
      },
      [{ id: 'task:grounding', title: 'grounding', description: 'inspect src/autopilot/mission-grounding-ladder.ts' }],
      {
        groundingDeps,
        judge: async (prompt) => {
          observedPrompt = prompt;
          return JSON.stringify({ verdict: 'founded', reason: 'grounded evidence supplied', action: 'keep' });
        },
        repoRoot: process.cwd(),
      },
    );

    expect(result.verdict).toBe('founded');
    expect(observedPrompt).toContain('src/autopilot/mission-grounding-ladder.ts');
    expect(observedPrompt).toContain('adaptiveGround');
  });
});
