import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalHarnessCommand } from './local-harness-command.js';

test('harness ask streams start, progress, and result through its CLI boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-harness-'));
  const cli = join(dir, 'fake-cli.ts');
  writeFileSync(cli, `
    if (process.argv.slice(2).join('|') !== 'harness|say|--no-auto-merge|a bounded goal') process.exit(3);
    console.log('run started');
    await Bun.sleep(20);
    console.log('stage gate');
    await Bun.sleep(20);
    console.log('run complete');
  `);
  const lines: string[] = [];
  try {
    await runLocalHarnessCommand('ask', 'a bounded goal', new AbortController().signal, (line) => lines.push(line), cli);
    expect(lines).toEqual(['run started', 'stage gate', 'run complete']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('harness runs uses the read-only progress command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-runs-'));
  const cli = join(dir, 'fake-cli.ts');
  writeFileSync(cli, `
    if (process.argv.slice(2).join('|') !== 'harness|progress') process.exit(3);
    console.log('active runs: 0');
  `);
  const lines: string[] = [];
  try {
    await runLocalHarnessCommand('runs', '', new AbortController().signal, (line) => lines.push(line), cli);
    expect(lines).toEqual(['active runs: 0']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('harness ask dry run keeps the CLI safety flag outside the objective', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-harness-dry-'));
  const cli = join(dir, 'fake-cli.ts');
  writeFileSync(cli, `
    if (process.argv.slice(2).join('|') !== 'harness|say|--no-auto-merge|--dry-run|a bounded goal') process.exit(3);
    console.log('dry run complete');
  `);
  const lines: string[] = [];
  try {
    await runLocalHarnessCommand('ask', '--dry-run a bounded goal', new AbortController().signal, (line) => lines.push(line), cli);
    expect(lines).toEqual(['dry run complete']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('large run listings do not redraw thousands of rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-tui-runs-many-'));
  const cli = join(dir, 'fake-cli.ts');
  writeFileSync(cli, `
    for (let i = 0; i < 100; i++) console.log('run ' + i);
  `);
  const lines: string[] = [];
  try {
    await runLocalHarnessCommand('runs', '', new AbortController().signal, (line) => lines.push(line), cli);
    expect(lines).toHaveLength(17);
    expect(lines.at(-1)).toContain('추가 84행 생략');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
