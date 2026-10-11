import { describe, expect, test } from 'bun:test';
import { podDelegatedChildLlm, podJobManifest } from './self-implement-pod.js';

// CHILD-LLM-PIN-POD (0.2.24) — the delegated in-Pod `harness say` / `harness ask` lines carry the child LLM pair.
const CHILD = ['--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/openai/gpt-6-luna'] as const;
const CARRIED = ` '--child-llm-provider' 'openrouter' '--child-llm-model' 'openrouter/openai/gpt-6-luna'`;

const scriptOf = (args: readonly string[], extra: Record<string, unknown>) =>
  (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args, passEnv: [], deadlineSeconds: 60, ...extra }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
const lineOf = (script: string, needle: string) => script.split('\n').find((line) => line.includes(needle));

describe('CHILD-LLM-PIN-POD — delegated Pod commands carry the child LLM', () => {
  test('(a) authorSentence: harness say carries --child-llm-provider and --child-llm-model', () => {
    const script = scriptOf(['--open-pr', '--base', 'main', ...CHILD], { authorSentence: true });
    expect(script).toContain(`elanous harness say --substrate local --json '--base' 'main' --no-auto-merge${CARRIED} -- "$(cat /creds/feature)"`);
    expect(script).not.toContain('--child-llm-effort');
  });

  test('(b) goalDoc: harness ask carries --child-llm-provider and --child-llm-model', () => {
    const script = scriptOf(['--open-pr', '--base', 'main', ...CHILD], { goalDoc: 'docs/goals/X.md' });
    expect(script).toContain(`elanous harness ask 'docs/goals/X.md' --json '--base' 'main' --no-auto-merge${CARRIED} > /tmp/si.out`);
  });

  test('(c) no child-llm args: delegated lines are unchanged and carry no child-llm flag', () => {
    const say = scriptOf(['--open-pr', '--base', 'main'], { authorSentence: true });
    expect(lineOf(say, 'elanous harness say')).toContain(`elanous harness say --substrate local --json '--base' 'main' --no-auto-merge -- "$(cat /creds/feature)" > /tmp/si.out 2>&1 & si_pid=$!; wait "$si_pid"; rc=$?;`);
    expect(say).not.toContain('--child-llm');
    const ask = scriptOf(['--open-pr', '--base', 'main'], { goalDoc: 'docs/goals/X.md' });
    expect(lineOf(ask, 'elanous harness ask')).toStartWith(`elanous harness ask 'docs/goals/X.md' --json '--base' 'main' --no-auto-merge > /tmp/si.out 2>&1 & si_pid=$!; wait "$si_pid"; rc=$?;`);
    expect(ask).not.toContain('--child-llm');
  });

  test('(d) legacy self implement line is unchanged — args pass through once, never doubled', () => {
    const script = scriptOf(['--open-pr', '--base', 'main', ...CHILD], {});
    expect(script).toContain(`elanous self implement "$(cat /creds/feature)" --json '--open-pr' '--base' 'main' '--child-llm-provider' 'openrouter' '--child-llm-model' 'openrouter/openai/gpt-6-luna' > /tmp/si.out 2>&1 & si_pid=$!; wait "$si_pid"; rc=$?`);
    expect(script.split('--child-llm-provider').length - 1).toBe(1);
    expect(script).not.toContain('elanous harness say');
    expect(script).not.toContain('elanous harness ask');
  });

  test('values are shell-quoted like --base', () => {
    const script = scriptOf(['--base', 'main', '--child-llm-provider', 'grok', '--child-llm-model', "it's"], { authorSentence: true });
    expect(script).toContain(` '--child-llm-provider' 'grok' '--child-llm-model' 'it'\\''s' -- "$(cat /creds/feature)"`);
  });

  test('podDelegatedChildLlm reads only a well-formed pair', () => {
    expect(podDelegatedChildLlm([...CHILD])).toEqual({ provider: 'openrouter', model: 'openrouter/openai/gpt-6-luna' });
    expect(podDelegatedChildLlm(['--child-llm-provider', 'openai-codex'])).toEqual({ provider: 'openai-codex' });
    expect(podDelegatedChildLlm(['--base', 'main'])).toBeUndefined();
    expect(podDelegatedChildLlm(['--child-llm-provider'])).toBeUndefined();
    expect(podDelegatedChildLlm(['--child-llm-provider', '--base'])).toBeUndefined();
  });
});
