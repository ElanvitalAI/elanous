import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { promptForPhase } from '../src/impl-discipline/index.js';
import { buildDashboardTurnPreamble } from '../src/dashboard/turn-preamble.js';
import { getUserConfig } from '../src/user-config.js';

function userConfig(nativeStructureEnabled: boolean): Parameters<typeof buildDashboardTurnPreamble>[0]['userConfig'] {
  // Reuse the normalized repository default rather than enumerate UserConfig fields.
  // The fixture must satisfy the required contract; preamble tolerance remains for existing partial runtime doubles.
  const config = getUserConfig();
  return {
    ...config,
    // ⛔ provider 를 못 박는다 — 기본값이 `'auto'` 면 resolveActiveProvider 가 «환경 탐색»으로 가고
    //   이 시험의 산출이 그 기계의 사정에 묶인다. 여기서 재려는 것은 그 축이 아니다.
    llm: { ...config.llm, provider: 'grok' },
    chat: {
      ...config.chat,
      conciseness: {
        ...config.chat.conciseness,
        enabled: false,
        finalMessageMaxLines: 6,
        preambleMaxWords: 12,
        flatBullets: false,
      },
    },
    tools: {
      ...config.tools,
      nativeStructure: { enabled: nativeStructureEnabled },
    },
  };
}

function implementationDisciplineContent(preamble: ReturnType<typeof buildDashboardTurnPreamble>): string {
  const message = preamble.find(item => typeof item.content === 'string'
    && item.content.includes('# 명시적 구현 요청 감지'));
  expect(message).toBeDefined();
  return message!.content as string;
}

describe('dashboard turn-preamble implementation-discipline wiring', () => {
  test('index buildTurnPreamble callback passes runtime config and active tool names to the production builder', () => {
    const source = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8');
    const callbackStart = source.indexOf('buildTurnPreamble: (args) => {');
    const callbackEnd = source.indexOf('\n            runAutoCompact:', callbackStart);
    expect(callbackStart).toBeGreaterThanOrEqual(0);
    expect(callbackEnd).toBeGreaterThan(callbackStart);
    const callback = source.slice(callbackStart, callbackEnd);
    // B7 (TUI /persona): persona messages are prepended, so the builder is spread into the returned array.
    expect(callback).toContain('...buildDashboardTurnPreamble({');
    expect(callback).toContain('userConfig: args.userConfig,');
    expect(callback).toContain('enabledTools: tools.map(t => t.name),');
  });

  test('production builder preserves static bytes when config is off even with tools present', () => {
    const content = implementationDisciplineContent(buildDashboardTurnPreamble({
      userText: 'login 폼 구현해줘',
      cwd: '/tmp',
      userConfig: userConfig(false),
      enabledTools: ['Grep', 'Glob', 'Read'],
    }));
    expect(content).toBe(promptForPhase('implementation-ready'));
  });

  test('production builder omits search+edit directives for an absent active-tool list when config is on', () => {
    const content = implementationDisciplineContent(buildDashboardTurnPreamble({
      userText: 'login 폼 구현해줘',
      cwd: '/tmp',
      userConfig: userConfig(true),
    }));
    expect(content).not.toContain('surface 를 먼저 조사');
    expect(content).not.toContain('1~2 파일의 명확한 수정');
    expect(content).toContain('EnterPlanMode');
  });

  test('production builder renders active kinds through the real catalog when config is on', () => {
    const content = implementationDisciplineContent(buildDashboardTurnPreamble({
      userText: 'login 폼 구현해줘',
      cwd: '/tmp',
      userConfig: userConfig(true),
      enabledTools: ['Grep', 'Glob', 'Read'],
    }));
    expect(content).toContain('Grep/Glob/Read 로 surface 를 먼저 조사');
    expect(content).not.toContain('1~2 파일의 명확한 수정');
    expect(content).toContain('EnterPlanMode');
  });
});

// 리뷰 must-fix(2026-08-14) — 도입부의 Edit/Write 도 «이름»이므로 종류로 간다.
describe('implementation-ready 도입부의 편집 툴 참조', () => {
  test('편집 종류가 없으면 도입부에서 그 이름이 사라진다', () => {
    const content = implementationDisciplineContent(buildDashboardTurnPreamble({
      userText: 'login 폼 구현해줘',
      cwd: '/tmp',
      userConfig: userConfig(true),
      enabledTools: ['Grep', 'Glob', 'Read'],
    }));
    expect(content).toContain('실제 코드 편집까지 진행하세요');
    expect(content).not.toContain('Edit/Write');
  });

  test('편집·쓰기 종류가 있으면 그 실제 이름이 도입부에 들어간다', () => {
    const content = implementationDisciplineContent(buildDashboardTurnPreamble({
      userText: 'login 폼 구현해줘',
      cwd: '/tmp',
      userConfig: userConfig(true),
      enabledTools: ['Read', 'Edit', 'Write'],
    }));
    expect(content).toContain('실제 코드 편집(Edit/Write)까지 진행하세요');
  });
});

// ⭐ 이 절이 «프로덕션 가드»를 문다 — turn-preamble.ts 의 주석이
//   *"설정 블록 자체가 «없을 수» 있다(부분 config·테스트 더블) ⇒ 없으면 종전대로 «꺼짐»"* 이라
//   약속하는데, 그 약속을 재는 자가 «없었다»(2026-08-28 실측: 가드를 빼도 157 pass 0 fail).
//   ⛔ 그래서 여기서는 픽스처를 «일부러» 계약보다 좁게 준다. 다른 시험처럼 getUserConfig() 를
//      쓰면 llm 이 늘 채워져 이 자리를 «영영 못 잰다».
describe('llm 블록이 없는 부분 config — 터지지 않고 «꺼진다»', () => {
  function partialConfig(): Parameters<typeof buildDashboardTurnPreamble>[0]['userConfig'] {
    const full = getUserConfig();
    const partial = {
      ...full,
      chat: { ...full.chat, conciseness: { ...full.chat.conciseness, enabled: false, finalMessageMaxLines: 6, preambleMaxWords: 12, flatBullets: false } },
      tools: { ...full.tools, nativeStructure: { enabled: true } },
    };
    // ⛔ 여기서만 계약을 «일부러» 어긴다 — 이 절이 재려는 것이 바로 「계약보다 좁은 config」이기 때문이다.
    //   다른 자리에 이 형태를 복사하지 마라(그것이 이 파일을 5 fail 로 만들었던 그 형태다).
    delete (partial as { llm?: unknown }).llm;
    return partial;
  }

  test('llm 이 없어도 도입부가 만들어진다(예외로 죽지 않는다)', () => {
    const content = implementationDisciplineContent(buildDashboardTurnPreamble({
      userText: 'login 폼 구현해줘', cwd: '/tmp', userConfig: partialConfig(), enabledTools: ['Read', 'Edit', 'Write'],
    }));
    expect(content).toContain('실제 코드 편집(Edit/Write)까지 진행하세요');
  });

  test('llm 이 없으면 native-structure 는 «꺼진» 쪽으로 간다', () => {
    // 켜졌으면 native tool 카탈로그가 도입부를 바꾼다. 꺼짐이면 llm 을 갖춘 «꺼진» config 와 같아야 한다.
    const withoutLlm = implementationDisciplineContent(buildDashboardTurnPreamble({
      userText: 'login 폼 구현해줘', cwd: '/tmp', userConfig: partialConfig(), enabledTools: ['Read', 'Edit', 'Write'],
    }));
    const disabled = implementationDisciplineContent(buildDashboardTurnPreamble({
      userText: 'login 폼 구현해줘', cwd: '/tmp', userConfig: userConfig(false), enabledTools: ['Read', 'Edit', 'Write'],
    }));
    expect(withoutLlm).toBe(disabled);
  });
});
