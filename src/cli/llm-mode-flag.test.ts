import { afterEach, expect, test } from 'bun:test';
import { extractLlmModeFlag, applyLlmModeFlagFromArgv } from './llm-mode-flag.js';

const priorArgv = process.argv;
const priorMode = process.env.ELANOUS_LLM_MODE;
const priorFake = process.env.ELANOUS_TEST_FAKE_LLM;

afterEach(() => {
  process.argv = priorArgv;
  if (priorMode === undefined) delete process.env.ELANOUS_LLM_MODE;
  else process.env.ELANOUS_LLM_MODE = priorMode;
  if (priorFake === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM;
  else process.env.ELANOUS_TEST_FAKE_LLM = priorFake;
});

test('global LLM mode flag is removed before command parsing and last override wins', () => {
  expect(extractLlmModeFlag(['bun', 'elanous', '--fake-llm', 'chat', '--real-llm', 'hello'])).toEqual({
    mode: 'real', argv: ['bun', 'elanous', 'chat', 'hello'],
  });
});

test('no global LLM mode flag leaves argv unchanged', () => {
  expect(extractLlmModeFlag(['bun', 'elanous', 'chat'])).toEqual({
    mode: undefined, argv: ['bun', 'elanous', 'chat'],
  });
});

test('mode-like values after -- remain literal command arguments', () => {
  expect(extractLlmModeFlag(['bun', 'elanous', 'chat', '--', '--real-llm'])).toEqual({
    mode: undefined, argv: ['bun', 'elanous', 'chat', '--', '--real-llm'],
  });
});

test('global --test keeps real LLM despite inherited test fake env; explicit fake flag wins', () => {
  process.argv = ['bun', 'elanous', '--test', 'dev'];
  delete process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  applyLlmModeFlagFromArgv(true);
  expect(String(process.env.ELANOUS_LLM_MODE)).toBe('real');

  process.argv = ['bun', 'elanous', '--test', 'dev', '--fake-llm'];
  delete process.env.ELANOUS_LLM_MODE;
  applyLlmModeFlagFromArgv(true);
  expect(String(process.env.ELANOUS_LLM_MODE)).toBe('fake');
  expect(process.argv).toEqual(['bun', 'elanous', '--test', 'dev']);
});
