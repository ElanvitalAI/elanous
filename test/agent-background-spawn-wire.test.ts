import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repoRoot = resolve(import.meta.dir, '..');
const agentTool = resolve(repoRoot, 'src/skills/tools/agent.ts');
const registry = resolve(repoRoot, 'src/agent/registry.ts');

describe('Agent background spawn notification wire', () => {
  test('importing the background-spawn producer installs exactly one global task-done listener', () => {
    const probe = `
      await import(${JSON.stringify(agentTool)});
      const { globalAgentRegistry } = await import(${JSON.stringify(registry)});
      console.log((globalAgentRegistry as any).taskDoneListeners.size);
    `;
    const result = Bun.spawnSync(['bun', '--eval', probe], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(Number(new TextDecoder().decode(result.stdout).trim())).toBe(1);
  });
});
