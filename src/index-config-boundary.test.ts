import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from './ux-sim/in-process-cli.js';

// 출처: node-b synthetic current-main integration run observed 5.872s under host load,
// above Bun's 5s default; this bound leaves room for a cold CLI module import.
test('config set reads the persisted value after writing within the CLI process', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'config-boundary-'));
  const configPath = join(stateRoot, 'config.json');
  const options = { stateRoot, allowPaths: [['config', 'set'], ['config', 'get']] } as const;
  writeFileSync(configPath, JSON.stringify({ llm: { provider: 'openai-codex', model: 'before' } }));
  try {
    const before = await simCli(['config', 'get', 'llm.model'], options);
    expect(before.exitCode).toBe(0);
    expect(before.stdout.trim()).toBe('before');

    const set = await simCli(['config', 'set', 'llm.model', 'after', '--no-backup'], options);
    expect(set.exitCode, `${set.stderr}\n${set.stdout}`).toBe(0);
    expect((JSON.parse(readFileSync(configPath, 'utf8')) as { llm: { model: string } }).llm.model).toBe('after');

    const after = await simCli(['config', 'get', 'llm.model'], options);
    expect(after.exitCode).toBe(0);
    expect(after.stdout.trim()).toBe('after');

    // A second writer changes the persisted file after the CLI action. The next
    // command must read disk again instead of reusing the entry's old snapshot.
    writeFileSync(configPath, JSON.stringify({ llm: { provider: 'openai-codex', model: 'external' } }));
    const external = await simCli(['config', 'get', 'llm.model'], options);
    expect(external.exitCode).toBe(0);
    expect(external.stdout.trim()).toBe('external');
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
}, 30_000);
