// DEMO-ONBOARD-EN-COPY · DEMO-ZEROBASE-FIXES (11-25 demo check): first run on a new machine shows English, names the
// next step when no LLM is set up, and never stops an els-driven eln tab at a prompt `els send` cannot answer.
// Expected text is written out here as literals, independent of the product constants.
import { expect, test } from 'bun:test';
import { NextTuiAuthError, NEXT_TUI_AUTH_FAILURE_TEXT, preflightNextTuiLlmRoute } from '../tui-client/next-auth-preflight.js';
import { nextTuiErrorCard } from '../tui/chat/error-card.js';
import { turnReplyFailureMessage } from '../tui/core/next-public-reply.js';
import { FIRST_RUN_PROVIDER_SETUP_MENU_CHOICES, FIRST_RUN_PROVIDER_SETUP_MENU_HEADING, FIRST_RUN_PROVIDER_SETUP_MENU_PROMPT } from '../cli/setup-keys.js';
import { FIRST_RUN_NO_LLM_LINE } from './first-run.js';
import { runWebFirstSetup } from './web-first.js';
import { configureFirecrawlKey } from '../setup/firecrawl-key.js';
import { getUserConfig } from '../user-config.js';
import { classifyLocalTurnFailure } from '../tui-client/local-chat-turn.js';

const HANGUL = /[가-힣]/u;

test('auto with no usable route refuses the turn with the llm-unset kind before the child starts', () => {
  let thrown: unknown;
  try { preflightNextTuiLlmRoute('auto', () => false); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(NextTuiAuthError);
  expect((thrown as NextTuiAuthError).kind).toBe('llm-unset');
  expect((thrown as Error).message).toBe('No LLM is set up yet. Run `elanous login openai-codex` (ChatGPT plan) or add an API key with `elanous setup keys`, then resend.');
});

test('a found route, another provider, or a judge that throws never blocks the turn', () => {
  expect(() => preflightNextTuiLlmRoute('auto', () => true)).not.toThrow();
  expect(() => preflightNextTuiLlmRoute('openrouter', () => false)).not.toThrow();
  expect(() => preflightNextTuiLlmRoute(undefined, () => false)).not.toThrow();
  expect(() => preflightNextTuiLlmRoute('auto', () => { throw new Error('selector broke'); })).not.toThrow();
});

test('the first-chat failure card names the next step in English instead of a bare failure', () => {
  expect(nextTuiErrorCard('anything', 'llm-unset')).toEqual([
    '✘ No LLM is set up yet.',
    '  Next: run `elanous login openai-codex` or `elanous setup keys` → ↑ recall input → Enter resend',
  ]);
  expect(turnReplyFailureMessage('t1', true, 'llm-unset', 'raw child error'))
    .toBe('No LLM is set up yet. Run `elanous login openai-codex` (ChatGPT plan) or add an API key with `elanous setup keys`, then resend.');
  expect(nextTuiErrorCard('요청을 처리하지 못했습니다.')[0]).toBe('✘ Could not process the request.');
  for (const kind of Object.keys(NEXT_TUI_AUTH_FAILURE_TEXT) as (keyof typeof NEXT_TUI_AUTH_FAILURE_TEXT)[]) {
    expect(nextTuiErrorCard('x', kind).join('\n')).not.toMatch(HANGUL);
  }
});

test('first-run LLM menu, prompt and skip line are English', () => {
  expect(FIRST_RUN_PROVIDER_SETUP_MENU_HEADING).toBe('First run: set up an LLM');
  expect(FIRST_RUN_PROVIDER_SETUP_MENU_CHOICES).toBe('1 Codex login with a ChatGPT plan (recommended) · 2 Use my OpenRouter key · 3 Enter another API key · Enter to skip');
  expect(FIRST_RUN_PROVIDER_SETUP_MENU_PROMPT).toBe('Choice: ');
  expect(FIRST_RUN_NO_LLM_LINE).toBe('Opening without an LLM; chat will not answer yet. Set one up: `elanous login openai-codex` or `elanous setup keys`.');
});

test('Firecrawl skip during first setup is English and points to the resumable command', async () => {
  const printed: string[] = [];
  const prompts: string[] = [];
  const result = await configureFirecrawlKey({ promptSecret: async (m) => { prompts.push(m); return ''; }, print: (l) => printed.push(l), setSecret: async () => { throw new Error('must not write'); } });
  expect(result).toBe('skipped');
  expect(prompts).toEqual(['Optional Firecrawl API key for web search (Enter to skip; later: elanous setup firecrawl): ']);
  expect(printed).toEqual(['Firecrawl skipped · set it any time with `elanous setup firecrawl`']);
});

const baseConfig = () => { const c = getUserConfig(); return { ...c, onboarding: { ...c.onboarding, webFirst: true } }; };

test('inside an els pane the «Choose setup» prompt is never shown, so `els send` is not met by a line prompt', async () => {
  const printed: string[] = [];
  let asked = 0;
  const result = await runWebFirstSetup({
    config: baseConfig(), locale: 'en', print: (l) => printed.push(l),
    browserEnv: { ELANOUS_ELS_PANE: 'p-demo' },
    chooseSetupMode: async () => { asked += 1; return '2'; },
    showNexus: async () => { throw new Error('must not inspect the daemon'); },
  });
  expect(result).toBe('fallback');
  expect(asked).toBe(0);
  expect(printed.join('\n')).not.toContain('Choose setup');
});

test('answering Terminal at «Choose setup» is remembered once so it does not come back every run', async () => {
  const printed: string[] = [];
  let remembered = 0;
  const result = await runWebFirstSetup({
    config: baseConfig(), locale: 'en', print: (l) => printed.push(l),
    browserEnv: {}, browserPlatform: 'darwin', isHeadless: () => false,
    chooseSetupMode: async () => '1',
    rememberTerminalChoice: () => { remembered += 1; },
  });
  expect(result).toBe('fallback');
  expect(remembered).toBe(1);
  expect(printed).toContain('Choose setup: 1) Terminal  2) Web (browser) (recommended)');
});

test('a failing remember step does not change the terminal choice', async () => {
  const result = await runWebFirstSetup({
    config: baseConfig(), locale: 'en', print: () => undefined,
    browserEnv: {}, browserPlatform: 'darwin', isHeadless: () => false,
    chooseSetupMode: async () => '1',
    rememberTerminalChoice: () => { throw new Error('config write failed'); },
  });
  expect(result).toBe('fallback');
});

test('a failed turn is re-labelled llm-unset only for auto with no route; a failing classifier keeps the original error', async () => {
  const original = new Error('child failed: original detail');
  const live = new AbortController().signal;
  const unset = await classifyLocalTurnFailure(original, live, async () => ({ provider: 'auto', hasRoute: () => false }));
  expect((unset as NextTuiAuthError).kind).toBe('llm-unset');
  expect((unset as Error).message).toBe('child failed: original detail');
  expect(await classifyLocalTurnFailure(original, live, async () => ({ provider: 'auto', hasRoute: () => true }))).toBe(original);
  expect(await classifyLocalTurnFailure(original, live, async () => ({ provider: 'openai-codex', hasRoute: () => false }))).toBe(original);
  expect(await classifyLocalTurnFailure(original, live, async () => { throw new Error('config read failed'); })).toBe(original);
  expect(await classifyLocalTurnFailure(original, live, async () => ({ provider: 'auto', hasRoute: () => { throw new Error('selector broke'); } }))).toBe(original);
  const aborted = new AbortController(); aborted.abort();
  expect(await classifyLocalTurnFailure(original, aborted.signal, async () => ({ provider: 'auto', hasRoute: () => false }))).toBe(original);
});

test('a typo at «Choose setup» is not remembered, so the prompt shows again next run', async () => {
  let remembered = 0;
  const run = async (answer: string, printed: string[]) => runWebFirstSetup({
    config: baseConfig(), locale: 'en', print: (l) => printed.push(l),
    browserEnv: {}, browserPlatform: 'darwin', isHeadless: () => false,
    chooseSetupMode: async () => answer,
    rememberTerminalChoice: () => { remembered += 1; },
  });
  const first: string[] = [];
  expect(await run('x', first)).toBe('fallback');
  expect(remembered).toBe(0);
  const next: string[] = [];
  await run('1', next);
  expect(next).toContain('Choose setup: 1) Terminal  2) Web (browser) (recommended)');
  expect(remembered).toBe(1);
});
