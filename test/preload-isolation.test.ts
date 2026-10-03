import { setDefaultTimeout, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

test('preload clears inherited LLM and escalation selection env in every startup state', () => {
  const root = mkdtempSync(join(tmpdir(), 'preload-isolation-'));
  const fixture = join(root, 'inherited-llm-env.test.ts');
  const inheritedSelection = {
    ELANOUS_LLM_PROVIDER: 'openai-codex',
    ELANOUS_LLM_MODEL: 'gpt-5.6-terra',
    ELANOUS_ESCALATE_PROVIDER: 'grok',
    ELANOUS_ESCALATE_MODEL: 'grok-4.6',
  };
  writeFileSync(fixture, `
    import { expect, test } from 'bun:test';
    test('preload clears inherited selection and permits test-local setup', () => {
      expect(process.env.ELANOUS_LLM_PROVIDER).toBeUndefined();
      expect(process.env.ELANOUS_LLM_MODEL).toBeUndefined();
      expect(process.env.ELANOUS_ESCALATE_PROVIDER).toBeUndefined();
      expect(process.env.ELANOUS_ESCALATE_MODEL).toBeUndefined();

      process.env.ELANOUS_LLM_PROVIDER = 'grok';
      process.env.ELANOUS_LLM_MODEL = 'grok-4.6';
      process.env.ELANOUS_ESCALATE_PROVIDER = 'openai-codex';
      process.env.ELANOUS_ESCALATE_MODEL = 'gpt-5.6-terra';
      expect(process.env.ELANOUS_LLM_PROVIDER).toBe('grok');
      expect(process.env.ELANOUS_LLM_MODEL).toBe('grok-4.6');
      expect(process.env.ELANOUS_ESCALATE_PROVIDER).toBe('openai-codex');
      expect(process.env.ELANOUS_ESCALATE_MODEL).toBe('gpt-5.6-terra');

      delete process.env.ELANOUS_LLM_PROVIDER;
      delete process.env.ELANOUS_LLM_MODEL;
      delete process.env.ELANOUS_ESCALATE_PROVIDER;
      delete process.env.ELANOUS_ESCALATE_MODEL;
      expect(process.env.ELANOUS_LLM_PROVIDER).toBeUndefined();
      expect(process.env.ELANOUS_LLM_MODEL).toBeUndefined();
      expect(process.env.ELANOUS_ESCALATE_PROVIDER).toBeUndefined();
      expect(process.env.ELANOUS_ESCALATE_MODEL).toBeUndefined();
    });
  `);

  const childEnv = { ...process.env };
  delete childEnv.ELANOUS_RUN_ID;
  delete childEnv.ELANOUS_HARNESS_SPACE;
  delete childEnv.ELANOUS_HARNESS_SPACE_ID;
  delete childEnv.ELANOUS_CONTROL_INBOX_DIR;
  delete childEnv.ELANOUS_STATE_DIR;
  delete childEnv.ELANOUS_STATE_DIR_SOURCE;

  const startupStates = [
    { name: 'inherited harness', env: { ELANOUS_RUN_ID: 'inherited-harness-run' } },
    { name: 'no harness or state directory', env: {} },
    { name: 'configured state directory without harness', env: { ELANOUS_STATE_DIR: join(root, 'state-dir') } },
  ];

  try {
    for (const startupState of startupStates) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, 'test', fixture],
        cwd: process.cwd(),
        env: { ...childEnv, ...inheritedSelection, ...startupState.env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      const diagnostics = `${startupState.name}\nchild stderr:\n${stderr}\nchild stdout:\n${stdout}`;
      expect(result.exitCode, diagnostics).toBe(0);

      const passSummary = stderr.match(/\b(\d+)\s+pass\b/);
      expect(passSummary, `${diagnostics}\nchild test pass count is unmeasurable`).not.toBeNull();
      expect(Number(passSummary![1]), diagnostics).toBeGreaterThanOrEqual(1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
