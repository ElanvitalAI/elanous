import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerIntakeSourceCommands } from './intake-source-cli.js';
import { registerIntakeCommands } from './intake-cli.js';
import { addSource, listSources, runDue } from '../intake-plane/intake-sources.js';
import { ingestIntakeItems, listIntakeItems } from '../intake-plane/items.js';

async function cli(root: string, args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const oldLog = console.log, oldError = console.error, oldExit = process.exitCode;
  console.log = (...values) => { lines.push(values.join(' ')); };
  console.error = (...values) => { errors.push(values.join(' ')); };
  process.exitCode = 0;
  try {
    const cmd = new Command().name('elanous').exitOverride();
    registerIntakeSourceCommands(cmd.command('intake'), () => root);
    await cmd.parseAsync(['intake', 'source', ...args], { from: 'user' });
    return { lines, errors, exitCode: process.exitCode };
  } finally { console.log = oldLog; console.error = oldError; process.exitCode = oldExit ?? 0; }
}

test('invalid 90m cadence has exit code 2, one-line diagnostic and no stack or registry change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-source-cli-'));
  try {
    const out = await cli(root, ['add', '--seat', 'MK', '--kind', 'command', '--spec', 'elanous x', '--every', '90m']);
    expect(out.exitCode).toBe(2);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain('--every');
    expect(out.errors.join('\n')).not.toContain(' at ');
    expect(listSources({}, root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('add -> list --json canonicalizes T to MK; dry-run lists only due sources without writes; remove works', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-source-cli-'));
  try {
    expect((await cli(root, ['add', '--seat', 'T', '--kind', 'rss', '--spec', 'https://example.com/rss', '--every', '1h', '--id', 'mk'])).exitCode).toBe(0);
    addSource({ id: 'expired', seat: 'UX', kind: 'command', spec: 'elanous ok', every: '1h', until: '2020-01-01' }, root);
    const listed = await cli(root, ['list', '--json']);
    expect(JSON.parse(listed.lines[0]!)).toMatchObject([{ id: 'mk', seat: 'MK', expired: false }, { id: 'expired', expired: true }]);
    expect((await cli(root, ['list'])).lines.join('\n')).toContain('만료');
    const dry = await cli(root, ['run-due', '--dry-run', '--json']);
    expect(JSON.parse(dry.lines[0]!).map((source: { id: string }) => source.id)).toEqual(['mk']);
    expect(listSources({}, root)[0]!.lastRunAt).toBeUndefined();
    expect((await cli(root, ['remove', 'mk'])).exitCode).toBe(0);
    expect(listSources({}, root).map((source) => source.id)).toEqual(['expired']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('intake ingest aliases merge with canonical seat, and unknown seats fail with code 2 without a stack', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-source-cli-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    const file = join(root, 'input.jsonl');
    const program = new Command().name('elanous');
    registerIntakeCommands(program);
    writeFileSync(file, '{"seat":"T","url":"https://example.com/seat"}\n');
    await program.parseAsync(['intake', 'ingest', '--source', 'github', '--file', file], { from: 'user' });
    writeFileSync(file, '{"seat":"MK","url":"https://example.com/seat"}\n');
    await program.parseAsync(['intake', 'ingest', '--source', 'youtube', '--file', file], { from: 'user' });
    expect(listIntakeItems(root, { seat: 'MK' })).toMatchObject([{ seat: 'MK', sources: ['github', 'youtube'] }]);
    writeFileSync(file, '{"seat":"INVALID","url":"https://example.com/other"}\n');
    const errors: string[] = [];
    const original = console.error, oldExit = process.exitCode;
    console.error = (...parts) => { errors.push(parts.join(' ')); };
    process.exitCode = 0;
    try {
      await program.parseAsync(['intake', 'ingest', '--source', 'github', '--file', file], { from: 'user' });
      expect(process.exitCode).toBe(2);
      expect(errors).toEqual(['알 수 없는 자리: INVALID']);
      expect(listIntakeItems(root)).toHaveLength(1);
    } finally { console.error = original; process.exitCode = oldExit; }
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('production intake items --seat includes registered command output, excludes legacy and other seats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-source-cli-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    addSource({ id: 'mk', seat: 'MK', kind: 'command', spec: 'elanous fake', every: '1h' }, root);
    addSource({ id: 'ux', seat: 'UX', kind: 'command', spec: 'elanous fake', every: '1h' }, root);
    await runDue({ now: new Date('2026-10-01T12:00:00Z'), deps: { stateDir: root,
      runCommand: async () => '{"url":"https://example.com/mk","title":"Shared"}\n' } });
    ingestIntakeItems(root, 'memo', [{ text: 'legacy' }]);
    const program = new Command().name('elanous');
    registerIntakeCommands(program);
    const lines: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.();
      return true;
    }) as typeof process.stdout.write;
    try {
      await program.parseAsync(['intake', 'items', '--seat', 'MK', '--json'], { from: 'user' });
      expect(JSON.parse(lines.join('\n'))).toMatchObject({ total: 1, items: [{ seat: 'MK', url: 'https://example.com/mk' }] });
      lines.length = 0;
      await program.parseAsync(['intake', 'items', '--seat', 'T', '--json'], { from: 'user' });
      expect(JSON.parse(lines.join('\n'))).toMatchObject({ total: 1, items: [{ seat: 'MK', url: 'https://example.com/mk' }] });
      lines.length = 0;
      await program.parseAsync(['intake', 'items', '--seat', 'UX', '--json'], { from: 'user' });
      expect(JSON.parse(lines.join('\n'))).toMatchObject({ total: 1, items: [{ seat: 'UX', url: 'https://example.com/mk' }] });
    } finally { process.stdout.write = original; }
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
