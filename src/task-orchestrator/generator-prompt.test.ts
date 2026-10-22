import { test, expect, describe } from 'bun:test';
import { buildDecomposePrompt } from './generator-prompt.js';
import { TaskGenerator } from './generator.js';
import type { DecomposeInput } from './generator.js';

const baseInput: DecomposeInput = { objective: '적응형 투자 코디네이터를 구현하라' };

describe('buildDecomposePrompt — G1 분해기 근본(정의/배선 분리·한 관심사)', () => {
  test('기본 구조 — STRICT JSON·single-responsibility 지시 포함', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 7 });
    expect(p).toContain('single-responsibility');
    expect(p).toContain('## Output (STRICT JSON)');
    expect(p).toContain('## Objective');
    expect(p).toContain(baseInput.objective);
  });

  test('goal-author coarse 프로필 없이 기본 미션 패브릭 규칙을 유지한다', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 7 });
    expect(p).toContain('Break the objective into 3-7 concrete, single-responsibility tasks.');
    expect(p).toContain('ONE CONCERN PER PHASE');
    expect(p).toContain('SEPARATE DEFINE FROM WIRE');
    expect(p).not.toContain('Goal-author coarse slicing');
  });

  test('goal-author 프로필은 조각 수보다 중·하 크기와 선행 관계를 우선한다', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 15, profile: 'goal-author-coarse' });
    expect(p).toContain('Split by slice size, not a target number of slices');
    expect(p).toContain('Goal-author size-bounded slicing');
    expect(p).toContain('at most 4 target files, change at most 2 behaviors, and create at most 2 files');
    expect(p).toContain('Add dependent slices whenever one slice would exceed medium size');
    expect(p).not.toContain('Prefer fewer, larger implementation slices');
    expect(p).not.toContain('Break the objective into 1-6');
    expect(p).toContain('Every slice title MUST name at least one actual file path or function name because only the title is passed to the next stage');
    expect(p).toContain('"files":1,"behaviours":1,"newFiles":0,"tier":"low"');
    expect(p).toContain('"대상 경로:"');
    expect(p).not.toContain('title or description MUST name at least one actual file path or function name');
    expect(p).toContain('Fold non-code investigation or design into the implementation slice that needs it');
    expect(p).toContain('definition before dependent runtime wiring');
    expect(p).not.toContain('ONE CONCERN PER PHASE');
    expect(p).not.toContain('SEPARATE DEFINE FROM WIRE');
    expect(p).not.toContain('keep each task ≈≤250 LOC');
  });

  test('arcCount 배선 — 아크 구조 가이드(하한 완화·padding 금지·P4c 2026-07-21)', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 25, arcCount: 5 });
    expect(p).toContain('arcCount: 5 arcs');
    expect(p).toContain('20~25 total'); // 타겟은 유지
    expect(p).toContain('guidance, NOT a hard floor'); // ★ 하한 완화(가치 무관 padding 압력 제거)
    expect(p).toContain('Do NOT invent low-value phases'); // padding 금지 명시
    expect(p).toContain('integration acceptance'); // 아크 통합 계약은 유지
    expect(p).not.toContain('arc collapse'); // 死 게이트 참조 死신호 제거
  });

  test('arcCount 미지정 — 아크 제약 없음(종전 LLM 재량)', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 7 });
    expect(p).not.toContain('arcCount:');
  });

  test('G1 — ONE CONCERN PER PHASE 원칙 명시', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 7 });
    expect(p).toContain('ONE CONCERN PER PHASE');
    // 관심사 클래스 열거(스킬-카운트 정합)
    expect(p).toMatch(/investigate.*design.*add-one-unit.*wire-into-existing.*verify/);
  });

  test('G1 — SEPARATE DEFINE FROM WIRE 원칙 명시(dead-code 예방)', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 7 });
    expect(p).toContain('SEPARATE DEFINE FROM WIRE');
    expect(p).toContain('dead-code');
  });

  test('B0 dependsOn 완결성 — 소비 심볼의 산출 페이즈를 dependsOn에 강제(ungrounded 미충족의존 방지)', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 7 });
    expect(p).toContain('DEPENDENCY COMPLETENESS');
    // 소비 심볼→산출 페이즈 추적·wire/verify 는 모든 define 페이즈 dependsOn·자가검증
    expect(p).toContain('the CREATING phase MUST appear in this phase');
    expect(p).toContain('wire/verify phase MUST dependsOn EVERY define phase');
    expect(p).toContain('Self-check before returning');
  });

  test('B0 축① — 페이즈 kind별 리지드 명세 bar(critique와 shared rubric)', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 7 });
    expect(p).toContain('Phase kind-specific spec bar');
    // 설계=항목 열거·구현=구체 결정 강제(호스트/스킴)·상류 계약 의존 명시
    expect(p).toContain('ENUMERATES every item the design must decide');
    expect(p).toContain('DECIDE the concrete inputs the code needs');
    expect(p).toMatch(/hosts\/schemes|hosts\|.*youtu/);
    expect(p).toContain('Upstream contracts');
  });

  test('G1 — few-shot 에 bundled define+wire BAD 예시 + 분리된 GOOD 예시', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 7 });
    expect(p).toContain('BAD (bundled define+wire');
    expect(p).toContain('define/wire separated');
    // GOOD 예시가 정의(구현+단위테스트)와 배선을 별 task 로 나눔
    expect(p).toContain('no wiring yet');
    expect(p).toMatch(/Wire .* into existing/);
  });

  test('maxTasks / budget / depth 제약 반영', () => {
    const p = buildDecomposePrompt(
      { ...baseInput, depth: 1, constraints: { budgetUsdRemaining: 12.5 } },
      { maxTasks: 5 },
    );
    expect(p).toContain('maxTasks: 5');
    expect(p).toContain('budgetUsdRemaining: $12.50');
    expect(p).toContain('depth: 1');
  });
});

describe('TaskGenerator maxTasks — 아크 붕괴 근본수복(B0 축①·2026-07-18)', () => {
  test('arcCount 확정 시 낮은 maxTasks 를 arcCount*4 로 끌어올린다(모순 제거)', async () => {
    let seen = '';
    const gen = new TaskGenerator({ callable: async ({ prompt }: { prompt: string }) => { seen = prompt; throw new Error('STOP'); } });
    try { await gen.decompose({ objective: 'x', constraints: { maxTasks: 8, arcCount: 5 } }); } catch { /* STOP */ }
    // maxTasks=8(기본급) 이지만 arcCount=5 → max(8, 20)=20 으로 상향(붕괴 방지).
    expect(seen).toContain('maxTasks: 20');
    expect(seen).toContain('arcCount: 5 arcs');
  });

  test('arcCount 미지정 시 사용자 maxTasks 존중(종전)', async () => {
    let seen = '';
    const gen = new TaskGenerator({ callable: async ({ prompt }: { prompt: string }) => { seen = prompt; throw new Error('STOP'); } });
    try { await gen.decompose({ objective: 'x', constraints: { maxTasks: 7 } }); } catch { /* STOP */ }
    expect(seen).toContain('maxTasks: 7');
    expect(seen).not.toContain('arcCount:');
    expect(seen).not.toContain('Goal-author coarse slicing');
  });

  test('goal-author 프로필은 초기와 validation 재시도 프롬프트 모두에 전달된다', async () => {
    const prompts: string[] = [];
    const gen = new TaskGenerator({ callable: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return { text: 'not JSON' };
    } });
    await expect(gen.decompose({ objective: 'x', promptProfile: 'goal-author-coarse' })).rejects.toThrow('VALIDATION_FAILED');
    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) => prompt.includes('Goal-author size-bounded slicing'))).toBe(true);
  });
});

describe('buildDecomposePrompt — DEVICE-FIRST-AUTHORING 장치 우선 분해(장치 확인 두 갈래)', () => {
  test('두 갈래 ① — 장치가 있으면 그 이름이 검증 계획에 들어간다', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 15, profile: 'goal-author-coarse' });
    expect(p).toContain('## Device-first decomposition (DEVICE-FIRST-AUTHORING — follow strictly)');
    expect(p).toContain('CHECK whether the mock device or injected event definition that this verification plan needs ALREADY EXISTS');
    expect(p).toContain('src/ux-sim/*');
    expect(p).toContain('docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md');
    expect(p).toContain('event-monkey');
    expect(p).toContain('Device EXISTS: its name MUST go into the verification plan wording');
    expect(p).toContain('never re-create it');
    expect(p).toContain('src/ux-sim files:');
    expect(p).toContain('interaction.ts');
    expect(p).toContain('event-monkey kinds: child-error-long');
    expect(p).toContain('manual §1:');
  });

  test('두 갈래 ② — 장치가 없으면 첫 조각이 장치 조각이다', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 15, profile: 'goal-author-coarse' });
    expect(p).toContain('Device MISSING: the FIRST slice MUST be a device slice that develops that device feature first');
    expect(p).toContain('every slice that tests the feature depends on it');
  });

  test('장치 확인 단계는 검증 계획(TDD) 절의 무대·층 선택에서 작동한다', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 15, profile: 'goal-author-coarse' });
    expect(p).toContain("The objective's verification plan (검증 계획/TDD) section picks a stage and ladder tier (무대·층)");
    expect(p).toContain('L2 (fake-llm·fake-bin·fake-clock)');
    expect(p).toContain('the §1 device table of `docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md`');
  });

  test('경계 — 장치 자체는 만들지 않고 크기·초록 규칙은 불변이다', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 15, profile: 'goal-author-coarse' });
    expect(p).toContain('장치 자체는 만들지 않는다');
    expect(p).toContain('the size rules (TIER-SIZED-DECOMPOSE) and the green-judgment rules are UNCHANGED');
    // TIER-SIZED-DECOMPOSE 크기 규칙 원문 불변(기존 절이 그대로 남는다)
    expect(p).toContain('## Goal-author size-bounded slicing (follow strictly)');
    expect(p).toContain('at most 4 target files, change at most 2 behaviors, and create at most 2 files');
  });

  test('프로필 없으면 장치 우선 규칙이 없다(미션 패브릭 기본 유지)', () => {
    const p = buildDecomposePrompt(baseInput, { maxTasks: 7 });
    expect(p).not.toContain('Device-first decomposition');
    expect(p).not.toContain('Device MISSING');
    expect(p).not.toContain('Device EXISTS');
  });

  test('프롬프트 전달 — 장치 목록·두 갈래 지침이 실제 분해 호출에 도달한다', async () => {
    const objective =
      '기능 골: 대시보드 카드 흔들기 실행취소 제스처 구현. 검증 계획(TDD): 무대: 새 무대 — bun test -- src/ux-sim/<관련 시험 파일>.test.ts · L2 (src/ux-sim fake-llm·fake-bin·fake-clock)';
    // 장치 우선 규칙을 따르는 fake-llm 대본: 흔들기 제스처 mock 장치가 어디에도 없으므로
    // 첫 조각을 장치 조각(src/ux-sim 장치 정의)으로, 소비 조각을 그 뒤에 둔다.
    const script = {
      rationale: '장치 없음 — 첫 조각이 장치 조각이다.',
      tasks: [
        {
          index: 0,
          title: '대상 경로: src/ux-sim/shake-gesture-device.ts · 동작: 흔들기 제스처 mock 장치 신규 정의(장치 조각)',
          description: '검증 계획(TDD)이 요구하는 mock 장치가 src/ux-sim/* · §1 표 · event-monkey 사건 종류 어디에도 없으므로 첫 조각이 장치 조각이다.',
          surface: { kind: 'llm-direct', prompt: 'add shake gesture mock device under src/ux-sim' },
          dependsOn: [],
          priority: 'high',
          isolation: 'shared',
          estimateMs: 1000,
          estimateTokens: 1000,
          estimateUsd: 0.01,
          timeoutMs: 1000,
          acceptance: { criteria: ['장치 조각: src/ux-sim/shake-gesture-device.ts 가 생긴다'], checks: [] },
          files: 1,
          behaviours: 1,
          newFiles: 1,
          tier: 'low',
        },
        {
          index: 1,
          title: '대상 경로: src/dashboard/card.ts · 동작: 흔들기 제스처 실행취소 배선',
          description: '장치 조각(0)이 정의한 mock 장치를 재사용해 카드 제스처를 배선한다.',
          surface: { kind: 'llm-direct', prompt: 'wire shake gesture into dashboard card' },
          dependsOn: [0],
          priority: 'medium',
          isolation: 'shared',
          estimateMs: 1000,
          estimateTokens: 1000,
          estimateUsd: 0.01,
          timeoutMs: 1000,
          acceptance: { criteria: ['카드 흔들기가 실행취소를 호출한다'], checks: [] },
          files: 1,
          behaviours: 1,
          newFiles: 0,
          tier: 'low',
        },
      ],
    };
    const prompts: string[] = [];
    const fakeLlm = async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return { text: JSON.stringify(script) };
    };
    const gen = new TaskGenerator({ callable: fakeLlm });
    const result = await gen.decompose({ objective, promptProfile: 'goal-author-coarse' });
    const sliceTitles = result.proposal.tasks.map((t) => t.title);
    // 대본이 받은 실제 분해 프롬프트에 두 갈래 규칙이 실렸다(배선 — TaskGenerator.decompose → buildDecomposePrompt).
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('## Device-first decomposition (DEVICE-FIRST-AUTHORING — follow strictly)');
    expect(prompts[0]).toContain('Device MISSING: the FIRST slice MUST be a device slice');
    expect(prompts[0]).toContain('src/ux-sim files:');
    expect(prompts[0]).toContain('event-monkey kinds:');
    // 고정 대본이 분해 파서에서 보존되는지 확인한다. LLM의 선택을 증명하는 시험은 아니다.
    expect(sliceTitles[0]).toBe('대상 경로: src/ux-sim/shake-gesture-device.ts · 동작: 흔들기 제스처 mock 장치 신규 정의(장치 조각)');
    expect(sliceTitles[1]).toBe('대상 경로: src/dashboard/card.ts · 동작: 흔들기 제스처 실행취소 배선');
  });

  test('경계 — 새 무대 문구만으로 일반 골을 장치 조각에 강제하지 않는다', async () => {
    const prompts: string[] = [];
    const script = { rationale: '장치 조각을 건너뛴 잘못된 대본', tasks: [{
      index: 0, title: '대상 경로: docs/manual/demo.md · 동작: 문서 문구 대조',
      surface: { kind: 'llm-direct', prompt: 'check manual wording' }, dependsOn: [],
      acceptance: { criteria: ['문서 문구가 요청과 일치한다'], checks: [] },
    }] };
    const gen = new TaskGenerator({ callable: async ({ prompt }) => {
      prompts.push(prompt);
      return { text: JSON.stringify(script) };
    } });
    const result = await gen.decompose({ objective: '문서 전용 골. 검증 계획(TDD): 무대: 새 무대: 문서 문구 대조',
      promptProfile: 'goal-author-coarse' });
    expect(result.proposal.tasks[0].title).toContain('docs/manual/demo.md');
    expect(prompts).toHaveLength(1);
  });
});
