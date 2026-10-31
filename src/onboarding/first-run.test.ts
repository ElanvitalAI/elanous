import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { orderProviderChoices, parseMenuAnswer, promptProviderMenu, runFirstRun } from './first-run.js';
import { debug } from '../debug/log.js';
import { unattendedNextStepLine } from './entry-hints.js';
import { buildUserConfig, saveUserConfig } from '../user-config.js';
import { needsFirstRun, needsOnboarding } from '../onboarding.js';
import type { DetectedProvider } from '../llm/provider-detect.js';
import { FIRST_RUN_PROVIDER_SETUP_MENU_MAX_MISSES } from '../cli/setup-keys.js';
import {
  FIRST_RUN_MENU_ANSWERS,
  FIRST_RUN_MENU_CHOICE_MARKERS,
  FIRST_RUN_MENU_CHOICES,
  FIRST_RUN_MENU_MARKERS,
  FIRST_RUN_SETUP_HINT,
  countFirstRunMenuRenders,
  driveFirstRunMenu,
  firstRunPtySupport,
} from '../ux-sim/onboarding-first-run-device.js';

// FIRST-RUN-EN-LOCALE / must-fix 3: 기존 한국어 단언은 제품의 ko 문면을 기록한다.
// 러너 환경 locale 과 무관하게 워딩 결정 입력을 고정한다 — 전역 process.env 를 쓰지
// 않고 runFirstRun 의 deps.locale 로 주입한다(bun test 가 process.env 를 파일 간
// 공유하므로 모듈 top-level env 설정은 다른 로케일 민감 테스트로 누수된다). 실물 CLI
// 를 띄우는 시험은 자식 env 에만 ELANOUS_LANG 을 고정한다. 아래 FIRST-RUN-EN-LOCALE
// 회귀는 자식 환경에 ELANOUS_LANG 을 지우고 LANG 을 명시해 LANG 자체를 시험한다.

const detected = (provider: string, auth: DetectedProvider['auth'] = 'oauth'): DetectedProvider =>
  ({ provider, auth, source: 'test', available: true, rank: 0 });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onb1-first-run-'));
  return { dir, path: join(dir, 'config.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('first run', () => {
  test('DEMO1104 first-run stores and probes a missing chosen key without marking the runtime ready', async () => {
    const f = fixture();
    const secret = 'first-run-secret-must-not-render';
    const stored = new Map<string, string>();
    const output: string[] = [];
    try {
      const result = await runFirstRun({
        path: f.path,
        config: buildUserConfig(f.path),
        isTTY: true,
        locale: 'ko',
        detectProviders: async () => [],
        chooseProvider: async () => 'anthropic',
        promptSecret: async () => `ANTHROPIC_API_KEY=${secret}`,
        getSecretAsync: async (id) => stored.get(id),
        setSecretAsync: async (id, value) => { stored.set(id, value); },
        probeKey: async () => ({ success: true, durationMs: 0, model: 'mock' }),
        print: (line) => output.push(line),
      });
      expect(result).toEqual({ outcome: 'needs-llm', inputs: 1 });
      expect(stored).toEqual(new Map([['ANTHROPIC_API_KEY', secret]]));
      expect(output.join('\n')).toContain('✅ Anthropic');
      expect(output.join('\n')).toContain('키를 저장하고 검증했지만 첫 실행에서 사용할 provider 연결은 아직 완료되지 않았습니다.');
      expect(output.join('\n')).not.toContain(secret);
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
      expect(buildUserConfig(f.path).llm.provider).toBe('auto');
    } finally { f.cleanup(); }
  });

  test('DEMO1104 first-run hides SecretStore exception text and returns a safe setup failure', async () => {
    const f = fixture();
    const secret = 'secret-store-error-must-not-render';
    const output: string[] = [];
    try {
      const result = await runFirstRun({
        path: f.path,
        config: buildUserConfig(f.path),
        isTTY: true,
        locale: 'ko',
        detectProviders: async () => [],
        chooseProvider: async () => 'anthropic',
        promptSecret: async () => `ANTHROPIC_API_KEY=${secret}`,
        getSecretAsync: async () => undefined,
        setSecretAsync: async () => { throw new Error(secret); },
        print: (line) => output.push(line),
      });
      expect(result).toEqual({ outcome: 'needs-llm', inputs: 1 });
      expect(output.join('\n')).toContain('키 설정을 완료하지 못했습니다. 비밀 값을 표시하지 않고 중단했습니다.');
      expect(output.join('\n')).not.toContain(secret);
    } finally { f.cleanup(); }
  });

  test('ready is optional and survives parsing and saving without completing detailed onboarding', () => {
    const f = fixture();
    try {
      writeFileSync(f.path, JSON.stringify({ onboarding: { completed: false, version: 4, ready: true } }));
      const cfg = buildUserConfig(f.path);
      expect(cfg.onboarding).toMatchObject({ completed: false, version: 4, ready: true });
      saveUserConfig(cfg, f.path);
      expect(buildUserConfig(f.path).onboarding).toMatchObject({ completed: false, version: 4, ready: true });
      writeFileSync(f.path, JSON.stringify({ onboarding: { completed: false, version: 4 } }));
      const legacy = buildUserConfig(f.path);
      expect(legacy.onboarding.ready).toBeUndefined();
      saveUserConfig(legacy, f.path);
      expect(JSON.parse(readFileSync(f.path, 'utf8')).onboarding).not.toHaveProperty('ready');
    } finally { f.cleanup(); }
  });

  test('input 0: a single detected subscription (codex beside Claude agent-cli) saves ready without asking', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      let asked = 0;
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: true,
        detectProviders: async () => [detected('claude-code', 'agent-cli'), detected('openai-codex')],
        chooseProvider: async () => { asked++; return 'grok'; },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'openai-codex', inputs: 0 });
      expect(asked).toBe(0);
      expect(buildUserConfig(f.path).llm.provider).toBe('openai-codex');
      expect(buildUserConfig(f.path).onboarding.ready).toBe(true);
      expect(buildUserConfig(f.path).onboarding.completed).toBe(false);
      expect(needsFirstRun(buildUserConfig(f.path))).toBe(false);
      expect(needsOnboarding(buildUserConfig(f.path))).toBe(true);
    } finally { f.cleanup(); }
  });

  test('grok subscription takes priority over available Claude agent-cli', async () => {
    const f = fixture();
    try {
      const result = await runFirstRun({ path: f.path, isTTY: false,
        detectProviders: async () => [detected('claude-code', 'agent-cli'), detected('grok')],
        chooseProvider: async () => { throw new Error('prompted'); },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'grok', inputs: 0 });
      expect(buildUserConfig(f.path).llm.provider).toBe('grok');
    } finally { f.cleanup(); }
  });

  test('input 1: TTY chooses LLM once without other steps', async () => {
    const f = fixture();
    try {
      let calls = 0;
      const cfg = buildUserConfig(f.path);
      cfg.llm.rotation = [{ provider: 'grok', apiKey: 'chosen-provider-key' }];
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: true, detectProviders: async () => [],
        chooseProvider: async () => { calls++; return 'grok'; },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'grok', inputs: 1 });
      expect(calls).toBe(1);
      expect(buildUserConfig(f.path).onboarding.ready).toBe(true);
      expect(buildUserConfig(f.path).llm.apiKey).toBe('chosen-provider-key');
    } finally { f.cleanup(); }
  });

  test('chosen rotation credential is saved for the chosen provider', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      cfg.llm.rotation = [{ provider: 'grok', apiKey: 'rotation-secret' }];
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: true,
        detectProviders: async () => [], chooseProvider: async () => 'grok',
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'grok', inputs: 1 });
      expect(buildUserConfig(f.path).llm.apiKey).toBe('rotation-secret');
      expect(buildUserConfig(f.path).onboarding.completed).toBe(false);
    } finally { f.cleanup(); }
  });

  test('TTY choice without a usable credential does not save ready', async () => {
    const f = fixture();
    try {
      const lines: string[] = [];
      let calls = 0;
      const result = await runFirstRun({ path: f.path, isTTY: true, locale: 'ko', detectProviders: async () => [],
        chooseProvider: async () => { calls++; return 'grok'; },
        promptSecret: async () => '',
        print: (line) => lines.push(line),
      });
      expect(result).toEqual({ outcome: 'needs-llm', inputs: 1 });
      expect(calls).toBe(1);
      expect(lines).toContain('건너뜀 Grok');
      expect(lines).toContain('eln setup llm 으로 고르세요');
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('SETUP-FIRST-RUN-NO-PROVIDER-FLOW: provider setup returns to first-run and saves the selected default', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      cfg.llm.rotation = [{ provider: 'grok', apiKey: 'selected-key' }];
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: true,
        detectProviders: async () => [], setupWhenNoProvider: async () => 'grok',
        chooseProvider: async () => { throw new Error('old chooser must not run'); },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'grok', inputs: 1 });
      expect(buildUserConfig(f.path).llm).toMatchObject({ provider: 'grok', apiKey: 'selected-key' });
      expect(buildUserConfig(f.path).onboarding.ready).toBe(true);
    } finally { f.cleanup(); }
  });

  test('SETUP-FIRST-RUN-NO-PROVIDER-FLOW: skip explains unavailable LLM features and keeps the first screen reachable', async () => {
    const f = fixture();
    try {
      const lines: string[] = [];
      const result = await runFirstRun({ path: f.path, isTTY: true, detectProviders: async () => [],
        setupWhenNoProvider: async () => null, print: line => lines.push(line),
      });
      expect(result).toEqual({ outcome: 'ready', inputs: 1 });
      expect(lines.join('\n')).toContain('LLM 기능은 사용할 수 없습니다');
      expect(lines.join('\n')).toContain('elanous setup keys');
      expect(buildUserConfig(f.path).onboarding.ready).toBe(true);
    } finally { f.cleanup(); }
  });

  test('existing Anthropic key and model survive a detected Codex subscription', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      cfg.llm.provider = 'anthropic';
      cfg.llm.apiKey = 'old-provider-secret';
      cfg.llm.model = 'claude-sonnet-4';
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: false,
        detectProviders: async () => [detected('openai-codex')],
        chooseProvider: async () => { throw new Error('prompted'); },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'anthropic', inputs: 0 });
      const saved = buildUserConfig(f.path);
      expect(saved.llm.apiKey).toBe('old-provider-secret');
      expect(saved.llm.model).toBe('claude-sonnet-4');
      expect(saved.llm.provider).toBe('anthropic');
      expect(saved.onboarding).toMatchObject({ ready: true, completed: false });
    } finally { f.cleanup(); }
  });

  test('existing API key without a detected subscription is ready on non-TTY', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      cfg.llm.provider = 'anthropic';
      cfg.llm.apiKey = 'existing-api-key';
      cfg.llm.model = 'claude-sonnet-4';
      const lines: string[] = [];
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: false,
        detectProviders: async () => [],
        chooseProvider: async () => { throw new Error('prompted'); },
        print: (line) => lines.push(line),
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'anthropic', inputs: 0 });
      expect(lines).toEqual([]);
      expect(buildUserConfig(f.path).llm).toMatchObject({ provider: 'anthropic', apiKey: 'existing-api-key', model: 'claude-sonnet-4' });
      expect(buildUserConfig(f.path).onboarding).toMatchObject({ ready: true, completed: false });
    } finally { f.cleanup(); }
  });

  test('claude-code-only detection never saves provider anthropic silently', async () => {
    const f = fixture();
    try {
      const lines: string[] = [];
      const result = await runFirstRun({ path: f.path, isTTY: false, locale: 'ko',
        detectProviders: async () => [detected('claude-code', 'agent-cli')],
        chooseProvider: async () => { throw new Error('prompted'); }, print: (line) => lines.push(line),
      });
      expect(result).toEqual({ outcome: 'needs-llm', inputs: 0 });
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
      expect(buildUserConfig(f.path).llm.provider).not.toBe('anthropic');
      expect(lines.join('\n')).toContain('claude-code 구독');
      expect(lines).toContain('eln setup llm 으로 고르세요');
    } finally { f.cleanup(); }
  });

  test('claude-code-only detection on a TTY asks once and never pre-picks anthropic', async () => {
    const f = fixture();
    try {
      const seen: Array<readonly string[]> = [];
      const result = await runFirstRun({ path: f.path, isTTY: true, print: () => {},
        detectProviders: async () => [detected('claude-code', 'agent-cli')],
        chooseProvider: async (list) => { seen.push(list); return null; },
      });
      expect(result).toEqual({ outcome: 'cancelled', inputs: 1 });
      expect(seen).toEqual([[]]);
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('two detected subscriptions on a TTY ask once with detected first', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      cfg.llm.rotation = [{ provider: 'grok', apiKey: 'grok-key' }];
      const seen: Array<readonly string[]> = [];
      const result = await runFirstRun({ path: f.path, config: cfg, isTTY: true, print: () => {},
        detectProviders: async () => [detected('claude-code', 'agent-cli'), detected('grok'), detected('openai-codex')],
        chooseProvider: async (list) => { seen.push(list); return 'grok'; },
        setupWhenNoProvider: async () => { throw new Error('detected subscriptions must keep the existing provider chooser'); },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'grok', inputs: 1 });
      expect(seen).toEqual([['openai-codex', 'grok']]);
      expect(orderProviderChoices(['openai-codex', 'grok'])).toEqual(['openai-codex', 'grok', 'anthropic', 'openrouter', 'glm']);
      expect(orderProviderChoices(['grok'])).toEqual(['grok', 'openai-codex', 'anthropic', 'openrouter', 'glm']);
      expect(buildUserConfig(f.path).llm.provider).toBe('grok');
    } finally { f.cleanup(); }
  });

  test('two detected subscriptions on non-TTY stop at needs-llm and name them', async () => {
    const f = fixture();
    try {
      const lines: string[] = [];
      const result = await runFirstRun({ path: f.path, isTTY: false, locale: 'ko',
        detectProviders: async () => [detected('grok'), detected('openai-codex')],
        chooseProvider: async () => { throw new Error('prompted'); }, print: (line) => lines.push(line),
      });
      expect(result).toEqual({ outcome: 'needs-llm', inputs: 0 });
      expect(lines.join('\n')).toContain('감지: grok 구독 · codex 구독 → 둘 이상 감지되어 고르세요');
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('detection line names what was detected and chosen', async () => {
    const f = fixture();
    try {
      const lines: string[] = [];
      const result = await runFirstRun({ path: f.path, isTTY: false, locale: 'ko', print: (line) => lines.push(line),
        detectProviders: async () => [detected('openai-codex'), detected('claude-code', 'agent-cli')],
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'openai-codex', inputs: 0 });
      expect(lines).toEqual(['감지: codex 구독 · claude-code 구독 → openai-codex']);
    } finally { f.cleanup(); }
  });

  test('codex-only detection still becomes ready with zero inputs', async () => {
    const f = fixture();
    try {
      const result = await runFirstRun({ path: f.path, isTTY: true, print: () => {},
        detectProviders: async () => [detected('openai-codex')],
        chooseProvider: async () => { throw new Error('prompted'); },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'openai-codex', inputs: 0 });
      expect(buildUserConfig(f.path).llm.provider).toBe('openai-codex');
      expect(buildUserConfig(f.path).onboarding.ready).toBe(true);
    } finally { f.cleanup(); }
  });

  test('ledger event format is unchanged: onboarding.first-run detected → ready with {providers, inputs}', async () => {
    const f = fixture();
    const logged: Array<{ event: string; data: unknown }> = [];
    const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => {
      if (category === 'onboarding.first-run') logged.push({ event, data });
    });
    try {
      await runFirstRun({ path: f.path, isTTY: false, print: () => {},
        detectProviders: async () => [detected('openai-codex'), detected('claude-code', 'agent-cli')],
      });
      expect(logged).toEqual([
        { event: 'detected', data: { providers: ['openai-codex', 'claude-code'], inputs: 0 } },
        { event: 'ready', data: { providers: ['openai-codex', 'claude-code'], inputs: 0 } },
      ]);
    } finally { spy.mockRestore(); f.cleanup(); }
  });

  test('unavailable agent-cli is not adopted', async () => {
    const f = fixture();
    try {
      const unavailable = { ...detected('claude-code', 'agent-cli'), available: false };
      const result = await runFirstRun({ path: f.path, isTTY: false,
        detectProviders: async () => [unavailable],
        chooseProvider: async () => { throw new Error('prompted'); }, print: () => {},
      });
      expect(result).toEqual({ outcome: 'needs-llm', inputs: 0 });
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('needs-llm: non-TTY never prompts or writes config', async () => {
    const f = fixture();
    try {
      const lines: string[] = [];
      const result = await runFirstRun({ path: f.path, isTTY: false, locale: 'ko', detectProviders: async () => [],
        chooseProvider: async () => { throw new Error('prompted'); }, print: (line) => lines.push(line),
      });
      expect(result).toEqual({ outcome: 'needs-llm', inputs: 0 });
      expect(lines).toEqual(['eln setup llm 으로 고르세요', unattendedNextStepLine()]);
      expect(lines[1]).toBe('next: unattended: `elanous onboarding --non-interactive --config <answers.json>`');
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  });

  // must-fix 3 red witness: 한국어 문면은 전역 ELANOUS_LANG 없이 deps.locale 만으로
  // 결정되고, 호출은 공유 process.env 를 건드리지 않는다. deps.locale 을 지원하지
  // 않는 제품(base)은 ELANOUS_LANG 이 지워진 러너에서 영어 fallback 을 내 이 단언과
  // 어긋나 실패한다 — deps 주입 수정이 env 우연이 아닌 인과임을 증명한다.
  test('ko wording comes from deps.locale and the shared process env stays untouched', async () => {
    const saved = process.env.ELANOUS_LANG;
    delete process.env.ELANOUS_LANG;
    try {
      const f = fixture();
      try {
        const lines: string[] = [];
        const result = await runFirstRun({ path: f.path, isTTY: false, locale: 'ko',
          detectProviders: async () => [detected('openai-codex')], print: (line) => lines.push(line) });
        expect(result).toEqual({ outcome: 'ready', provider: 'openai-codex', inputs: 0 });
        expect(lines).toEqual(['감지: codex 구독 → openai-codex']);
      } finally { f.cleanup(); }
      expect(process.env.ELANOUS_LANG).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ELANOUS_LANG;
      else process.env.ELANOUS_LANG = saved;
    }
  });

  test('completed stays unchanged, including existing settings', async () => {
    const f = fixture();
    try {
      const cfg = buildUserConfig(f.path);
      cfg.onboarding.completed = true;
      cfg.onboarding.completedAt = '2026-01-01T00:00:00Z';
      cfg.telegram.allowedUsers = [12];
      expect(needsFirstRun(cfg)).toBe(false);
      await runFirstRun({ config: cfg, path: f.path, detectProviders: async () => [detected('grok')] });
      const saved = buildUserConfig(f.path);
      expect(saved.onboarding.completed).toBe(true);
      expect(saved.onboarding.completedAt).toBe(cfg.onboarding.completedAt);
      expect(saved.telegram.allowedUsers).toEqual([12]);
    } finally { f.cleanup(); }
  });

  test('an available other OAuth subscription is adopted without a prompt', async () => {
    const f = fixture();
    try {
      const result = await runFirstRun({ path: f.path, isTTY: false,
        detectProviders: async () => [detected('gemini')],
        chooseProvider: async () => { throw new Error('prompted'); },
      });
      expect(result).toEqual({ outcome: 'ready', provider: 'gemini', inputs: 0 });
      expect(buildUserConfig(f.path).llm.provider).toBe('gemini');
    } finally { f.cleanup(); }
  });

  test('cancelled does not save ready', async () => {
    const f = fixture();
    try {
      expect(await runFirstRun({ path: f.path, isTTY: true, detectProviders: async () => [],
        chooseProvider: async () => null })).toEqual({ outcome: 'cancelled', inputs: 1 });
      expect(buildUserConfig(f.path).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('menu answer: empty cancels, a valid index chooses, whitespace trims like before', () => {
    const choices = orderProviderChoices(['grok']);
    expect(parseMenuAnswer('', choices)).toEqual({ kind: 'cancel' });
    expect(parseMenuAnswer('   ', choices)).toEqual({ kind: 'cancel' });
    expect(parseMenuAnswer('1', choices)).toEqual({ kind: 'chosen', provider: 'grok' });
    expect(parseMenuAnswer(' 2 ', choices)).toEqual({ kind: 'chosen', provider: 'openai-codex' });
  });

  // FIRST10-FIX 판정선: 오타가 first-run 전체를 취소(구 동작)하는지, 재질문(신 동작)하는지.
  test('a menu typo no longer cancels the first run — every miss re-asks instead of cancelling', () => {
    const choices = orderProviderChoices(['grok']);
    expect(parseMenuAnswer('6', choices).kind).toBe('miss'); // out of range
    expect(parseMenuAnswer('0', choices).kind).toBe('miss'); // not an offered index
    expect(parseMenuAnswer('-1', choices).kind).toBe('miss');
    expect(parseMenuAnswer('grok', choices).kind).toBe('miss'); // provider names are not menu input
    expect(parseMenuAnswer('1.5', choices).kind).toBe('miss');
    expect(parseMenuAnswer('1e1', choices).kind).toBe('miss');
    expect(parseMenuAnswer('１', choices).kind).toBe('miss'); // full-width digit
    // 0.2.35 재측정: Number() 가 정수로 강제 변환해 'chosen' 으로 샜던 수식 표기 — 전부 miss
    expect(parseMenuAnswer('1e0', choices).kind).toBe('miss');
    expect(parseMenuAnswer('0x1', choices).kind).toBe('miss');
    expect(parseMenuAnswer('0b1', choices).kind).toBe('miss');
    expect(parseMenuAnswer('+1', choices).kind).toBe('miss');
    expect(parseMenuAnswer('２', choices).kind).toBe('miss'); // full-width in-range digit
  });

  test('promptProviderMenu re-asks the same menu until a real choice or an explicit cancel', async () => {
    const prompts: string[] = [];
    const ask = async (prompt: string): Promise<string> => {
      prompts.push(prompt);
      return ['6', 'abc', ' 2 '][prompts.length - 1] ?? '';
    };
    await expect(promptProviderMenu(ask, ['grok'])).resolves.toBe('openai-codex');
    expect(prompts).toHaveLength(3);
    expect(new Set(prompts).size).toBe(1); // the menu never changes between re-asks
    expect(prompts[0]).toContain('Enter to cancel');
    expect(prompts[0]).toContain('1 Grok');
    await expect(promptProviderMenu(async () => '', ['grok'])).resolves.toBeNull();
  });

  // 0.2.35 재측정: 수식 표기('1e0'·'0x1'·'+1')와 전각 숫자('２')도 miss 로 되물음을 돌리고,
  // 그 뒤의 진짜 선택은 한 번에 끝난다 — 메뉴 문면은 매번 같다.
  test('promptProviderMenu turns numeric-notation and full-width misses into re-asks, then resolves', async () => {
    const answers = ['1e0', '0x1', '+1', '２', '2'];
    const prompts: string[] = [];
    const ask = async (prompt: string): Promise<string> => {
      prompts.push(prompt);
      return answers[prompts.length - 1] ?? '';
    };
    await expect(promptProviderMenu(ask, [])).resolves.toBe('grok');
    expect(prompts).toHaveLength(5);
    expect(new Set(prompts).size).toBe(1); // the menu never changes between re-asks
    expect(prompts[0]).toContain(FIRST_RUN_MENU_CHOICES);
    expect(prompts[0]).toContain('Enter to cancel');
  });

  // ⚠️ util-linux `script -q -e -c` 문법이다 — 맥(BSD script)은 이 문법도, 파이프 입력으로 PTY 를 세우는 것도 못 한다
  //  (10-02 0.2.9 게이트에서 같은 원인으로 first-screen-band-wiring 이 깨졌다 · #22750). 리눅스(하니스 파드)에서는 돈다.
  test.skipIf(process.platform === 'darwin')('bare process: detected Codex subscription saves ready before dashboard', async () => {
    const f = fixture();
    try {
      const home = join(f.dir, 'home');
      const configDir = join(f.dir, 'cfg');
      const codexHome = join(home, '.codex');
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(configDir);
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fake-token' } }));
      const env = { ...process.env, HOME: home, CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: '',
        ELANOUS_LANG: 'ko', ELANOUS_LLM_PROVIDER: '', ELANOUS_ESCALATE_PROVIDER: '',
        ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', XAI_API_KEY: '', GROK_API_KEY: '',
        GROK_CODE_XAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '',
        LOCAL_LLM_URL: '',
      };
      // `script` 로 파이프 입력 위에 세운 PTY 는 창 크기가 0×0 이라 TUI 가 «requires at least 20 columns and 6 rows» 로 죽는다 —
      // 대시보드 진입을 보는 시험이므로 PTY 크기를 먼저 고정한다.
      const processChild = spawn('sh', ['-c', 'script -q -e -c "$1" /dev/null', 'sh',
        `stty rows 40 cols 120; exec ${process.execPath} ${resolve(import.meta.dir, '../../bin/elanous.mjs')} --test --config-dir ${configDir}`],
        { cwd: resolve(import.meta.dir, '../..'), env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let sentQuit = false;
      processChild.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        if (!sentQuit && stdout.includes('\x1b[?1049h')) {
          sentQuit = true;
          setTimeout(() => processChild.stdin.write('\x11'), 300);
        }
      });
      processChild.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; processChild.kill('SIGTERM'); }, 45000);
      const status = await new Promise<number | null>((resolve, reject) => {
        processChild.once('error', reject);
        processChild.once('close', (code) => resolve(code));
      }).finally(() => clearTimeout(timeout));
      const child = { status, stdout, stderr };
      expect(sentQuit).toBe(true);
      expect(timedOut).toBe(false);
      expect(child.status).toBe(0);
      expect(child.stdout).toContain('[elanous] provider: openai-codex');
      expect(child.stdout).toContain('오프라인 모드');
      expect(child.stdout).toContain('오류 보고 안내:');
      expect(child.stdout.indexOf('오류 보고 안내:')).toBeLessThan(child.stdout.indexOf('\x1b[?1049h'));
      expect(child.stdout.indexOf('오프라인 모드')).toBeLessThan(child.stdout.indexOf('\x1b[?1049h'));
      expect(child.stdout.indexOf('\x1b[?1049h')).toBeGreaterThan(child.stdout.indexOf('[elanous] provider: openai-codex'));
      expect(child.stdout + child.stderr).not.toContain('eln setup llm');
      expect(child.stdout + child.stderr).not.toContain('Step 1');
      expect(child.stdout + child.stderr).not.toContain('fake-token');
      const saved = buildUserConfig(join(configDir, 'config.json'));
      expect(saved.onboarding).toMatchObject({ ready: true, completed: false });
      expect(saved.llm.provider).toBe('openai-codex');
      expect(saved.errorReports?.noticeShown).toBe(true);
    } finally { f.cleanup(); }
  }, 60000);

  // 칸 판정선 실물: bin/elanous.mjs bare 진입 → src/index.ts main() →
  // runFirstRun → runFirstRunProviderSetup 생산 경로 그대로 — 빈 기계 메뉴에서
  // 범위 밖·수식 표기·전각 오타를 재질문하고 miss 상한 뒤 needs-llm 안내로 끝난다.
  test.skipIf(process.platform === 'darwin')('bare process: real menu re-asks every miss on the production path before the first run lands', async () => {
    const f = fixture();
    try {
      const home = join(f.dir, 'home');
      const configDir = join(f.dir, 'cfg');
      mkdirSync(home);
      mkdirSync(configDir);
      const env = { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: '',
        ELANOUS_LANG: 'ko', ELANOUS_LLM_PROVIDER: '', ELANOUS_ESCALATE_PROVIDER: '',
        ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', XAI_API_KEY: '', GROK_API_KEY: '',
        GROK_CODE_XAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '',
        LOCAL_LLM_URL: '',
      };
      const cli = `${process.execPath} ${resolve(import.meta.dir, '../../bin/elanous.mjs')} --test --config-dir ${configDir}`;
      // Warm Bun's transpile cache for this HOME once; the budget is elanous's own path, not a cold compile.
      spawnSync(process.execPath, [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir, '--version'],
        { cwd: resolve(import.meta.dir, '../..'), env, input: '', encoding: 'utf8', timeout: 30000 });
      const processChild = spawn('sh', ['-c', 'script -q -e -c "$1" /dev/null', 'sh', 'stty rows 40 cols 120; exec ' + cli],
        { cwd: resolve(import.meta.dir, '../..'), env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const answers = ['4\n', '1e0\n', '１\n']; // 범위 밖 → 수식 표기 → 전각 miss 상한
      let menus = 0;
      let sent = 0;
      let keyPasteAnswered = false;
      let timedOut = false;
      processChild.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        const shown = countFirstRunMenuRenders(stdout);
        if (shown > menus) {
          menus = shown;
          const answer = answers[sent++];
          if (answer !== undefined) setTimeout(() => processChild.stdin.write(answer), 300);
        }
        if (!keyPasteAnswered && stdout.includes('.env 형식 키를 붙여 넣고 빈 줄로 끝내세요')) {
          keyPasteAnswered = true;
          setTimeout(() => processChild.stdin.write('\n'), 300);
        }
      });
      processChild.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      const timeout = setTimeout(() => { timedOut = true; processChild.kill('SIGTERM'); }, 45000);
      const status = await new Promise<number | null>((resolve, reject) => {
        processChild.once('error', reject);
        processChild.once('close', (code) => resolve(code));
      }).finally(() => clearTimeout(timeout));
      expect(timedOut).toBe(false);
      expect(status).toBe(0);
      // 판정선: miss 한도까지 메뉴를 재질문한 뒤 안내로 끝나고 onboarding.ready 를 쓰지 않는다.
      expect(countFirstRunMenuRenders(stdout)).toBe(3);
      expect(FIRST_RUN_MENU_MARKERS.some((marker) => stdout.includes(marker))).toBe(true);
      expect(FIRST_RUN_MENU_CHOICE_MARKERS.some((choices) => stdout.includes(choices))).toBe(true);
      // needs-llm 착지: 유효한 선택 없이 miss 상한에 도달했으므로 ready 는 기록되지 않는다
      expect(stdout).toContain('eln setup llm 으로 고르세요');
      expect(buildUserConfig(join(configDir, 'config.json')).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  }, 60000);

  test('spawned CLI: bare first run with no daemon reaches the first-screen gate within 3s and does not mark the notice shown without a TTY', async () => {
    const f = fixture();
    try {
      const home = join(f.dir, 'home');
      const configDir = join(f.dir, 'cfg');
      mkdirSync(home);
      mkdirSync(configDir);
      const env = { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: '',
        ELANOUS_LANG: 'ko', ELANOUS_LLM_PROVIDER: '', ELANOUS_ESCALATE_PROVIDER: '', LOCAL_LLM_URL: '' };
      const cli = [process.execPath, resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir];
      const cwd = resolve(import.meta.dir, '../..');
      // Warm Bun's transpile cache for this HOME once; the budget is elanous's own path, not a cold compile.
      spawnSync(cli[0]!, [...cli.slice(1), '--version'], { cwd, env, input: '', encoding: 'utf8', timeout: 30000 });
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        llm: { provider: 'anthropic', apiKey: 'timing-cli-secret', model: 'claude-sonnet-4' },
        onboarding: { completed: false },
        errorReports: { identity: true, email: 'person@example.org' },
      }));
      const began = Date.now();
      let offlineAt = -1;
      const proc = spawn(cli[0]!, cli.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const run = { stdout: '', stderr: '', status: null as number | null, error: undefined as Error | undefined };
      proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        run.stdout += chunk;
        if (offlineAt < 0 && run.stdout.includes('오프라인 모드')) offlineAt = Date.now() - began;
      });
      proc.stderr.setEncoding('utf8').on('data', (chunk: string) => { run.stderr += chunk; });
      const killer = setTimeout(() => proc.kill('SIGTERM'), 30000);
      run.status = await new Promise<number | null>((done, fail) => { proc.once('error', fail); proc.once('close', done); })
        .finally(() => clearTimeout(killer));
      const elapsed = Date.now() - began;
      expect(run.error).toBeUndefined();
      // Exit 1 at the stdin-TTY gate = the point where the dashboard would draw its first screen.
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('stdin TTY');
      // The daemon decision (the old 12s health wait) is made within 3s of spawn.
      expect(offlineAt).toBeGreaterThanOrEqual(0);
      expect(offlineAt).toBeLessThanOrEqual(3000);
      // Whole path to the first-screen gate: far below the old 12s wait (measured 1.3–3.2s at load 12;
      // the variance is first-run provider detection after the decision, outside this cell).
      expect(elapsed).toBeLessThan(6000);
      expect(run.stdout).toContain('오프라인 모드');
      expect(run.stdout + run.stderr).not.toContain('웹 셋업을 위해 데몬을 시작');
      // No TTY → no dashboard → nobody saw a notice: it is neither printed nor recorded as shown.
      expect(run.stdout).not.toContain('오류 보고 안내:');
      expect(buildUserConfig(join(configDir, 'config.json')).errorReports?.noticeShown).toBeUndefined();
    } finally { f.cleanup(); }
  }, 70000);

  test('spawned CLI: empty HOME and closed stdin take real bare entry without Step 1', () => {
    const f = fixture();
    try {
      const home = join(f.dir, 'home');
      const configDir = join(f.dir, 'cfg');
      mkdirSync(home);
      mkdirSync(configDir);
      const env = { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: '',
        ELANOUS_LANG: 'ko', ELANOUS_LLM_PROVIDER: '', ELANOUS_ESCALATE_PROVIDER: '',
        ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', XAI_API_KEY: '', GROK_API_KEY: '',
        GROK_CODE_XAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '',
        LOCAL_LLM_URL: '',
      };
      const child = spawnSync(process.execPath,
        [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir],
        { cwd: resolve(import.meta.dir, '../..'), env, input: '', encoding: 'utf8', timeout: 20000 });
      const text = child.stdout + child.stderr;
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(text).toContain('eln setup llm');
      expect(text).toContain(unattendedNextStepLine());
      expect(text).not.toContain('Step 1');

      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ onboarding: { completed: true } }));
      const completed = spawnSync(process.execPath,
        [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir],
        { cwd: resolve(import.meta.dir, '../..'), env, input: '', encoding: 'utf8', timeout: 20000 });
      expect(completed.error).toBeUndefined();
      expect(completed.status).toBe(1);
      expect(completed.stderr).toContain('stdin TTY');
      expect(completed.stdout + completed.stderr).not.toContain('eln setup llm');
      expect(completed.stdout + completed.stderr).not.toContain('Step 1');

      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        llm: { provider: 'anthropic', apiKey: 'existing-cli-secret', model: 'claude-sonnet-4' },
        onboarding: { completed: false },
      }));
      const configured = spawnSync(process.execPath,
        [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir],
        { cwd: resolve(import.meta.dir, '../..'), env, input: '', encoding: 'utf8', timeout: 20000 });
      expect(configured.error).toBeUndefined();
      expect(configured.status).toBe(1);
      expect(configured.stderr).toContain('stdin TTY');
      expect(configured.stdout + configured.stderr).not.toContain('eln setup llm');
      expect(configured.stdout + configured.stderr).not.toContain('existing-cli-secret');
      expect(buildUserConfig(join(configDir, 'config.json')).llm).toMatchObject({
        provider: 'anthropic', apiKey: 'existing-cli-secret', model: 'claude-sonnet-4',
      });
      expect(buildUserConfig(join(configDir, 'config.json')).onboarding).toMatchObject({ ready: true, completed: false });
    } finally { f.cleanup(); }
  }, 65000);

  // 완료 경계 실물: src/ux-sim first-run device — 격리 HOME/config 아래 생산 CLI 를 util-linux PTY 로 띄워
  // 4 → 1e0 → １ 을 넣고, miss 상한에서 종료하는 생산 메뉴·최종 `eln setup llm 으로 고르세요`·
  // ready 미기록을 잰다. Darwin skip 이유: BSD `script` 는 util-linux `script -q -e -c` 와 플래그가 달라
  // 이 PTY 무대를 못 만든다(firstRunPtySupport().reason 이 같은 뜻을 반환한다).
  test.skipIf(!firstRunPtySupport().available)(
    'FIRST10-FIX-FU: PTY re-asks invalid answers and stops at the miss cap',
    async () => {
      const observed = await driveFirstRunMenu();
      // 생산 프롬프트 문면(promptProviderMenu) — 메뉴 문면 동일성은 이 줄 전체로 잰다.
      const recognizedMenuRenders = countFirstRunMenuRenders(observed.stdout);
      // 실측 기록(보고서 행): 실행한 정확한 명령과 stdout/stderr 발췌를 남긴다.
      console.log(JSON.stringify({
        command: `script -q -e -c '${observed.childCommand.join(' ')}' /dev/null`,
        menuRenderCount: observed.menuRenderCount,
        recognizedMenuRenders,
        status: observed.status,
        stdoutExcerpt: observed.stdout.slice(-420),
        stderrExcerpt: observed.stderr.slice(-240),
      }));
      expect(observed.timedOut).toBe(false);
      expect(observed.status).toBe(0);
      // 입력 순서: 4(범위 밖) → 1e0(수식 표기) → １(전각). 세 번째 miss에서 끝난다.
      expect(observed.answersSent).toEqual([...FIRST_RUN_MENU_ANSWERS]);
      // 동일 메뉴는 입력을 받기 전에 miss cap=3회 렌더된다.
      expect(observed.menuRenderCount).toBe(FIRST_RUN_PROVIDER_SETUP_MENU_MAX_MISSES);
      expect(recognizedMenuRenders).toBe(FIRST_RUN_PROVIDER_SETUP_MENU_MAX_MISSES);
      // 최종 needs-llm/next-step 안내.
      expect(observed.finalPhrase).toBe(FIRST_RUN_SETUP_HINT);
      // 격리 config 에 onboarding.ready 부재.
      expect(observed.readyRecorded).toBe(false);
      // 생산 진입 형태: bin/elanous.mjs --test --config-dir <격리> — 테스트 전용 chooser 흉내가 아니다.
      expect(observed.childCommand.slice(2)).toEqual(['--test', '--config-dir', dirname(observed.configPath)]);
      // util-linux `script` 가 실제로 불렸다는 fake-bin 기록.
      expect(observed.scriptCall).not.toBeNull();
    },
    120_000,
  );

  // FIRST-RUN-EN-LOCALE 완료 경계 실물: 격리 HOME/config 아래 실제 CLI 를 LANG 로 띄우면
  // 사용자 대면 fallback 문구가 기존 detectLocale 결정을 따른다. ELANOUS_LANG 을 자식
  // 환경에서 지워 LANG 자체가 실제로 시험되게 한다.
  const localeEnv = (home: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: '',
      ELANOUS_LLM_PROVIDER: '', ELANOUS_ESCALATE_PROVIDER: '', LOCAL_LLM_URL: '' };
    delete env.ELANOUS_LANG;
    return env;
  };

  test('FIRST-RUN-EN-LOCALE: LANG=en_US.UTF-8 real CLI (no ELANOUS_LANG) prints English offline + LLM next step', () => {
    const f = fixture();
    try {
      const home = join(f.dir, 'home');
      const configDir = join(f.dir, 'cfg');
      mkdirSync(home);
      mkdirSync(configDir);
      const env = { ...localeEnv(home), LANG: 'en_US.UTF-8', LC_ALL: '', LC_MESSAGES: '' };
      const child = spawnSync(process.execPath,
        [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir],
        { cwd: resolve(import.meta.dir, '../..'), env, input: '', encoding: 'utf8', timeout: 60000 });
      const text = child.stdout + child.stderr;
      expect(child.error).toBeUndefined();
      expect(text).toContain('offline mode');
      expect(text).toContain('pick a provider via eln setup llm');
      expect(text).not.toContain('오프라인 모드');
      expect(text).not.toContain('eln setup llm 으로 고르세요');
      expect(buildUserConfig(join(configDir, 'config.json')).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  }, 120_000);

  test('FIRST-RUN-EN-LOCALE: LANG=ko_KR.UTF-8 control keeps Korean offline + LLM next step', () => {
    const f = fixture();
    try {
      const home = join(f.dir, 'home');
      const configDir = join(f.dir, 'cfg');
      mkdirSync(home);
      mkdirSync(configDir);
      const env = { ...localeEnv(home), LANG: 'ko_KR.UTF-8', LC_ALL: '', LC_MESSAGES: '' };
      const child = spawnSync(process.execPath,
        [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir],
        { cwd: resolve(import.meta.dir, '../..'), env, input: '', encoding: 'utf8', timeout: 60000 });
      const text = child.stdout + child.stderr;
      expect(child.error).toBeUndefined();
      expect(text).toContain('오프라인 모드');
      expect(text).toContain('eln setup llm 으로 고르세요');
      expect(text).not.toContain('offline mode');
      expect(text).not.toContain('pick a provider via eln setup llm');
      expect(buildUserConfig(join(configDir, 'config.json')).onboarding.ready).toBeUndefined();
    } finally { f.cleanup(); }
  }, 120_000);
});
