import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const fixture = new URL('./__fixtures__/agent-help-before/', import.meta.url);

describe('agent CLI extraction', () => {
  for (const name of ['root', 'agent', 'registry', 'tier'] as const) {
    test(`${name} --help remains byte-identical`, () => {
      const result = spawnSync(process.execPath, ['bin/elanous.mjs', '--test', ...(name === 'root' ? [] : [name]), '--help'], {
        cwd: root,
        env: { ...process.env, NODE_ENV: 'test' },
      });
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(result.stdout.equals(readFileSync(new URL(`${name}.txt`, fixture)))).toBe(true);
    });
  }

  test('registration stays at the original slot, outside local, without an index import cycle', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const agent = readFileSync(new URL('./agent-cli.ts', import.meta.url), 'utf8');
    expect(index).toContain('registerAgentCommands(program);');
    expect(index.indexOf('registerAgentCommands(program);')).toBeLessThan(index.indexOf(".command('local')"));
    expect(index).not.toMatch(/\.command\('(agent|registry|tier)'\)/);
    expect(agent).not.toMatch(/from ['"]\.\.\/index\.js['"]/);
    expect(index).toContain("export { runChatTurnCli, buildCliAgentTools, setCliAgentDispatchForTesting");
  });
});
