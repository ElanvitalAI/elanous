import { expect, test } from 'bun:test';
import { taskParentRoleEnv } from './task-parent-role-llm.js';
import { getUserConfig, resolveRoleLlm } from '../user-config.js';

test('TA-PARENT-ROLE-LLM: exhausted Codex subscription can pin parent audit/classify to credit GLM without changing the child', () => {
  const glm = 'openrouter/z-ai/glm-5.3';
  const env = taskParentRoleEnv([
    `audit={"provider":"openrouter","model":"${glm}"}`,
    `classify={"provider":"openrouter","model":"${glm}"}`,
  ]);
  expect(JSON.parse(env.ELANOUS_ROLE_LLM_AUDIT!)).toEqual({ provider: 'openrouter', model: glm });
  expect(JSON.parse(env.ELANOUS_ROLE_LLM_CLASSIFY!)).toEqual({ provider: 'openrouter', model: glm });
  expect(env.ELANOUS_ROLE_LLM_IMPLEMENT).toBeUndefined();
  const baseline = getUserConfig();
  const config = { ...baseline, llm: { ...baseline.llm, provider: 'openai-codex' as const }, roleLlm: {} };
  expect(resolveRoleLlm('audit', { config, env: {} }).provider).toBe('openai-codex');
  expect(resolveRoleLlm('audit', { config, env })).toMatchObject({ provider: 'openrouter', model: glm, source: 'environment' });
});

test('TA-PARENT-ROLE-LLM: malformed or non-parent role pins fail before launch', () => {
  expect(() => taskParentRoleEnv(['audit={bad-json}'])).toThrow('--role-llm');
  expect(() => taskParentRoleEnv(['implement=openrouter'])).toThrow('--role-llm');
  expect(() => taskParentRoleEnv(['research=openrouter'])).toThrow('--role-llm');
  expect(() => taskParentRoleEnv(['guardian=openrouter'])).toThrow('--role-llm');
  expect(() => taskParentRoleEnv(['audit=unknown'])).toThrow('--role-llm');
  expect(() => taskParentRoleEnv(['audit='])).toThrow('--role-llm');
  expect(() => taskParentRoleEnv(['audit=openrouter', 'audit=anthropic'])).toThrow('--role-llm');
});
