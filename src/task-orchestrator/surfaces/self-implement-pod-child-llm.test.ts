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

  test('(c) no child-llm args: delegated lines carry no child-llm flag alongside the deadline marker', () => {
    const say = scriptOf(['--open-pr', '--base', 'main'], { authorSentence: true });
    const sayLine = lineOf(say, 'elanous harness say')!;
    expect(sayLine).toContain(`elanous harness say --substrate local --json '--base' 'main' --no-auto-merge -- "$(cat /creds/feature)"`);
    expect(sayLine).not.toContain('--child-llm');
    expect(say).toContain('/tmp/si.deadline-marker');
    const ask = scriptOf(['--open-pr', '--base', 'main'], { goalDoc: 'docs/goals/X.md' });
    const askLine = lineOf(ask, 'elanous harness ask')!;
    expect(askLine).toContain(`elanous harness ask 'docs/goals/X.md' --json '--base' 'main' --no-auto-merge`);
    expect(askLine).not.toContain('--child-llm');
    expect(ask).toContain('/tmp/si.deadline-marker');
  });

  test('(d) legacy self implement args pass through once beside the deadline marker', () => {
    const script = scriptOf(['--open-pr', '--base', 'main', ...CHILD], {});
    const legacyLine = lineOf(script, 'elanous self implement')!;
    expect(legacyLine).toContain(`elanous self implement "$(cat /creds/feature)" --json '--open-pr' '--base' 'main' '--child-llm-provider' 'openrouter' '--child-llm-model' 'openrouter/openai/gpt-6-luna'`);
    expect(legacyLine.split('--child-llm-provider').length - 1).toBe(1);
    expect(script).toContain('/tmp/si.deadline-marker');
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
