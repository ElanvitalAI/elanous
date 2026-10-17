import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { registerImportCommand } from './import-cli.js';

function importHelp(): { help: string; command: Command } {
  const program = new Command();
  registerImportCommand(program);
  const command = program.commands.find((entry) => entry.name() === 'import')!;
  let help = '';
  command.configureOutput({ writeOut: (text) => { help += text; } });
  command.outputHelp();
  return { help, command };
}

function cliHelp(...args: string[]): string {
  const root = resolve(import.meta.dir, '../..');
  const result = spawnSync(process.execPath, [resolve(root, 'bin/elanous.mjs'), '--test', ...args, '--help'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('import public contribution help', () => {
  test('is wired into the import help path', () => {
    const { help, command } = importHelp();
    expect(help).toContain('CB1 contribution entry');
    expect(help).toContain('https://github.com/ElanvitalAI/elanous');
    expect(help).toContain('Show HN / community');
    expect(help).toContain('Marketplace plugins:');
    expect(help).toContain('reviewed, not automatic');
    expect(command.options.map((option) => option.long)).toEqual(['--json', '--apply', '--mode', '--pick', '--undo']);
  });

  test('real CLI keeps contribution guidance in import help only', () => {
    const importOutput = cliHelp('import');
    const rootOutput = cliHelp();
    const doctorOutput = cliHelp('doctor');
    expect(importOutput).toContain('CB1 contribution entry');
    expect(importOutput).toContain('Marketplace plugins:');
    expect(rootOutput).toContain('import');
    expect(rootOutput).not.toContain('CB1 contribution entry');
    expect(doctorOutput).toContain('Usage: elanous doctor');
    expect(doctorOutput).not.toContain('CB1 contribution entry');
  }, 30_000);

  test('marks drafts and dated adoption figures as historical, not current results', () => {
    const { help } = importHelp();
    expect(help).toContain('EC1 · 10-28 update; moved from 0.2.8 in the 10-01 release split');
    expect(help).toContain('Remaining drafts (not published): Show HN · 긱뉴스 · 3-minute');
    expect(help).toContain('docs/marketing/DRAFT-ec1-show-hn-geeknews-and-3min-video-2026-10-01.md');
    expect(help).toContain('GitHub stars · installs · npm downloads');
    expect(help).toContain('Historical positioning (§4, 2026-10-01; not current counts): elanous ★0 · OpenClaw ~390k · Hermes ~250k · Codex ~127k');
    expect(help).toContain('10-03 baseline (not current results): stars 0 · npm 7-day downloads 790 (includes our own installs)');
  });
});
