import { describe, expect, test } from 'bun:test';
import { buildEvalPromptToolSurface, evalToolDispatchKind, isEvalPromptToolSurface, runEvalPrompt } from './eval-prompt-cli.js';
import type { UserConfig } from './user-config/types.js';

const cfg = {
  chat: { toolDeny: [] },
  finance: { enabled: false },
} as unknown as UserConfig;

describe('eval prompt CLI preservation', () => {
  test('tool surfaces remain constructible while runEvalPrompt keeps its cwd option on the exported contract', () => {
    expect(isEvalPromptToolSurface('cli')).toBe(true);
    expect(buildEvalPromptToolSurface('cli', 'claude', cfg).specs.map((tool) => tool.name)).toContain('Bash');
    type CwdOption = Parameters<typeof runEvalPrompt>[0]['cwd'];
    const cwd: CwdOption = '/tmp/eval-prompt-cwd-contract';
    expect(cwd).toBe('/tmp/eval-prompt-cwd-contract');
  });

  test('tool deny takes precedence over measurement stubs at dispatch', () => {
    expect(evalToolDispatchKind('ReleaseStatus', new Set(['ReleaseStatus']), new Set(['ReleaseStatus']))).toBe('denied');
    expect(evalToolDispatchKind('Read', new Set(), new Set(['Read']))).toBe('measurement-only');
    expect(evalToolDispatchKind('Read', new Set(), new Set())).toBe('live');
    expect(evalToolDispatchKind('UnlistedTool', new Set(), new Set(['Read']), true)).toBe('measurement-blocked');
    expect(evalToolDispatchKind('ToolSearch', new Set(), new Set(['Read']), true)).toBe('measurement-search');
    expect(evalToolDispatchKind('ToolSearch', new Set(['ToolSearch']), new Set(['Read']), true)).toBe('denied');
  });
});
