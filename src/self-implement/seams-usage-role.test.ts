import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as llm from '../llm.js';
import { resolveRoleLlm } from '../user-config.js';
import { defaultSeams } from './seams.js';

test('goal summary passes classify usage role alongside the unchanged resolved model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-summary-usage-role-'));
  const goalFile = join(root, 'goal.md');
  writeFileSync(goalFile, '# Existing goal\n\nSummarize this goal.\n');
  const resolved = resolveRoleLlm('classify');
  const calls: Array<{ model?: string; provider?: { name: string }; reasoningEffort?: string; signal?: AbortSignal; usageRole?: string }> = [];
  const stream = spyOn(llm, 'streamLLM').mockImplementation(async (_messages, _onChunk, opts) => {
    calls.push(opts ?? {});
    return 'A concise summary.';
  });
  try {
    expect(await defaultSeams().synthesizeGoalContext!({ goalFile })).toEqual({
      goalTitle: 'Existing goal',
      goalDescription: 'A concise summary.',
      goalDescriptionSource: 'generated',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      usageRole: 'classify', model: resolved.model, provider: { name: resolved.provider }, reasoningEffort: 'low',
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  } finally {
    stream.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
