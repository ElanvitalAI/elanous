import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalTaskEvent } from '../connectors/types.js';
import { registerCardCommand, type CardCliDeps } from './card-cli.js';
import { CardStore } from './card-store.js';

const roots: string[] = [];
function fixture(deps: Pick<CardCliDeps, 'getApiKey' | 'fetchIssues'> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'card-cli-'));
  roots.push(root);
  const store = new CardStore(root);
  const output: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerCardCommand(program, {
    createStore: () => new CardStore(root),
    write: (text) => { output.push(text); },
    ...deps,
  });
  const run = (...args: string[]) => program.parse(['node', 'elanous', 'card', ...args]);
  return { store, output, run, runAsync: (...args: string[]) => program.parseAsync(['node', 'elanous', 'card', ...args]) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('linear-scan creates cards and returns text and JSON counts; --label reaches fetchIssues', async () => {
  const calls: Array<{ apiKey: string; teamKey: string; labelOrPrefix?: string }> = [];
  const issue: ExternalTaskEvent = {
    provider: 'linear', eventId: '1', kind: 'updated', ref: 'id', identifier: 'UX-7',
    title: 'A wish', body: 'Details', url: 'https://linear.app/UX-7', priority: null, occurredAt: '2026-10-04T00:00:00Z',
  };
  const { store, output, runAsync } = fixture({
    getApiKey: async () => 'secret',
    fetchIssues: async (args) => { calls.push(args); return [issue]; },
  });
  try {
    await runAsync('linear-scan', '--team', 'UX');
    expect(output).toEqual(['추가 1 · 중복 0 · 실패 0\n']);
    await runAsync('linear-scan', '--team', 'UX', '--label', 'idea', '--json');
    expect(output[1]).toBe('{"added":0,"duplicate":1,"failed":0}\n');
    expect(calls).toEqual([
      { apiKey: 'secret', teamKey: 'UX', labelOrPrefix: 'wish' },
      { apiKey: 'secret', teamKey: 'UX', labelOrPrefix: 'idea' },
    ]);
    expect(store.listCards().map(card => card.goalId)).toEqual(['wish:linear:UX-7']);
  } finally { store.close(); }
});

test('linear-scan --suggest shows label proposals in text and JSON without opening a card store', async () => {
  const calls: unknown[] = [];
  const root = mkdtempSync(join(tmpdir(), 'card-suggest-'));
  roots.push(root);
  const output: string[] = [];
  const program = new Command();
  registerCardCommand(program, {
    createStore: () => { throw new Error('suggest must not open a card store'); },
    write: text => { output.push(text); },
    getApiKey: async () => 'secret',
    fetchIssues: async args => { calls.push(args); return [{
      provider: 'linear', eventId: '1', kind: 'updated', ref: 'id', identifier: 'UX-7',
      title: '만들어 줘', body: 'private body', url: 'https://linear.app/UX-7', priority: null,
      occurredAt: '2026-10-04T00:00:00Z',
    }]; },
  });
  await program.parseAsync(['node', 'elanous', 'card', 'linear-scan', '--team', 'UX', '--suggest']);
  await program.parseAsync(['node', 'elanous', 'card', 'linear-scan', '--team', 'UX', '--suggest', '--label', 'idea', '--json']);
  expect(calls).toEqual([
    { apiKey: 'secret', teamKey: 'UX', excludeLabel: 'wish' },
    { apiKey: 'secret', teamKey: 'UX', excludeLabel: 'wish' },
  ]);
  expect(output).toEqual(['UX-7\t만들어 줘\t제작\n', '[{"identifier":"UX-7","title":"만들어 줘","reason":"제작"}]\n']);
});

test('linear-scan --suggest without a key uses existing guidance and exit 2 without reading Linear or cards', async () => {
  let fetched = false;
  const program = new Command();
  registerCardCommand(program, {
    createStore: () => { throw new Error('card store opened'); },
    getApiKey: async () => undefined,
    fetchIssues: async () => { fetched = true; return []; },
  });
  const lines: string[] = [];
  const original = process.stderr.write;
  const exitCode = process.exitCode;
  process.stderr.write = ((text: string) => { lines.push(text); return true; }) as typeof process.stderr.write;
  try {
    await program.parseAsync(['node', 'elanous', 'card', 'linear-scan', '--team', 'UX', '--suggest', '--json']);
    expect(lines).toEqual(['Linear 키가 없습니다 — elanous connector linear 로 먼저 등록하세요\n']);
    expect(process.exitCode).toBe(2);
    expect(fetched).toBe(false);
  } finally { process.stderr.write = original; process.exitCode = exitCode ?? 0; }
});

test('linear-scan requires --team before reading the key', async () => {
  let readKey = false;
  const { store, runAsync } = fixture({ getApiKey: async () => { readKey = true; return 'secret'; } });
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((text: string) => { lines.push(text); return true; }) as typeof process.stderr.write;
  try {
    await expect(runAsync('linear-scan')).rejects.toThrow();
    expect(lines.join('')).toContain("required option '--team <key>' not specified");
    expect(readKey).toBe(false);
  } finally { process.stderr.write = original; store.close(); }
});

test('linear-scan with no key prints registration guidance and exits 2 without fetching', async () => {
  let fetched = false;
  const { store, output, runAsync } = fixture({
    getApiKey: async () => undefined,
    fetchIssues: async () => { fetched = true; return []; },
  });
  const lines: string[] = [];
  const original = process.stderr.write;
  const exitCode = process.exitCode;
  process.stderr.write = ((text: string) => { lines.push(text); return true; }) as typeof process.stderr.write;
  try {
    await runAsync('linear-scan', '--team', 'UX');
    expect(lines).toEqual(['Linear 키가 없습니다 — elanous connector linear 로 먼저 등록하세요\n']);
    expect(process.exitCode).toBe(2);
    expect(output).toEqual([]);
    expect(fetched).toBe(false);
  } finally { process.stderr.write = original; process.exitCode = exitCode ?? 0; store.close(); }
});

test('linear-scan lookup failure prints only the first line and exits 1 without leaking the key', async () => {
  const { store, output, runAsync } = fixture({
    getApiKey: async () => 'private-key',
    fetchIssues: async () => { throw new Error('Linear lookup failed private-key\nextra details'); },
  });
  const lines: string[] = [];
  const original = process.stderr.write;
  const exitCode = process.exitCode;
  process.stderr.write = ((text: string) => { lines.push(text); return true; }) as typeof process.stderr.write;
  try {
    await runAsync('linear-scan', '--team', 'UX');
    expect(lines).toEqual(['Linear lookup failed [redacted]\n']);
    expect(process.exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(store.listCards()).toEqual([]);
  } finally { process.stderr.write = original; process.exitCode = exitCode ?? 0; store.close(); }
});

test('intake-scan imports folder before Linear, prints one line and JSON counts, and is repeatable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-intake-'));
  roots.push(dir);
  writeFileSync(join(dir, 'sample.md'), '# Wish title\n');
  const calls: string[] = [];
  const issue: ExternalTaskEvent = {
    provider: 'linear', eventId: '1', kind: 'updated', ref: 'id', identifier: 'UX-7',
    title: 'A wish', body: 'Details', url: 'https://linear.app/UX-7', priority: null, occurredAt: '2026-10-04T00:00:00Z',
  };
  const { store, output, runAsync } = fixture({
    getApiKey: async () => 'secret',
    fetchIssues: async (args) => {
      expect(args).toEqual({ apiKey: 'secret', teamKey: 'UX', labelOrPrefix: 'idea' });
      expect(store.listCards().map(card => card.goalId)).toContain('wish:sample.md');
      calls.push('linear');
      return [issue];
    },
  });
  try {
    await runAsync('intake-scan', '--dir', dir, '--team', 'UX', '--label', 'idea');
    expect(output).toEqual(['폴더 추가 1 · Linear 추가 1 · 건너뜀(없음)\n']);
    await runAsync('intake-scan', '--dir', dir, '--team', 'UX', '--label', 'idea', '--json');
    expect(JSON.parse(output[1]!)).toEqual({
      folder: { added: 0, updated: 0, skipped: 1 },
      linear: { added: 0, duplicate: 1, failed: 0 }, skipped: [], failed: [],
    });
    expect(calls).toEqual(['linear', 'linear']);
    expect(store.listCards().map(card => card.goalId).sort()).toEqual(['wish:linear:UX-7', 'wish:sample.md']);
  } finally { store.close(); }
});

test('intake-scan skips missing Linear key without fetching or leaking it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-intake-'));
  roots.push(dir);
  writeFileSync(join(dir, 'sample.md'), '# Wish title\n');
  let fetched = false;
  const { store, output, runAsync } = fixture({
    getApiKey: async () => undefined,
    fetchIssues: async () => { fetched = true; return []; },
  });
  const exitCode = process.exitCode;
  try {
    await runAsync('intake-scan', '--dir', dir, '--team', 'UX');
    expect(output).toEqual(['폴더 추가 1 · Linear 추가 0 · 건너뜀(Linear 키 없음)\n']);
    expect(process.exitCode).toBe(exitCode);
    expect(fetched).toBe(false);
    await runAsync('intake-scan', '--dir', dir, '--team', 'UX', '--json');
    expect(JSON.parse(output[1]!)).toEqual({
      folder: { added: 0, updated: 0, skipped: 1 },
      linear: { added: 0, duplicate: 0, failed: 0 }, skipped: ['Linear 키 없음'], failed: [],
    });
  } finally { process.exitCode = exitCode ?? 0; store.close(); }
});

test('intake-scan isolates folder and Linear failures and never prints a secret from errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-intake-'));
  roots.push(dir);
  writeFileSync(join(dir, 'sample.md'), '# Wish title\n');
  const missing = join(dir, 'missing');
  const { store, output, runAsync } = fixture({
    getApiKey: async () => 'private-key',
    fetchIssues: async () => { throw new Error('private-key lookup failed\nprivate-key details'); },
  });
  const exitCode = process.exitCode;
  try {
    await runAsync('intake-scan', '--dir', missing, '--team', 'UX', '--json');
    expect(JSON.parse(output[0]!)).toEqual({
      folder: { added: 0, updated: 0, skipped: 0 },
      linear: { added: 0, duplicate: 0, failed: 0 }, skipped: [],
      failed: ['Wish 폴더 스캔 실패', 'Linear 스캔 실패'],
    });
    expect(output.join('')).not.toContain('private-key');
    expect(process.exitCode).toBe(1);
    process.exitCode = exitCode ?? 0;
    await runAsync('intake-scan', '--dir', dir, '--team', 'UX');
    expect(output[1]).toBe('폴더 추가 1 · Linear 추가 0 · 건너뜀(없음) · 실패(Linear 스캔 실패)\n');
    expect(store.listCards().map(card => card.goalId)).toEqual(['wish:sample.md']);
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = exitCode ?? 0; store.close(); }
});

test('intake-scan still adds Linear cards when the Wish folder is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-intake-'));
  roots.push(dir);
  const issue: ExternalTaskEvent = {
    provider: 'linear', eventId: '2', kind: 'updated', ref: 'id', identifier: 'UX-8',
    title: 'Linear wish', body: 'Details', url: 'https://linear.app/UX-8', priority: null, occurredAt: '2026-10-04T00:00:00Z',
  };
  const { store, output, runAsync } = fixture({
    getApiKey: async () => 'secret', fetchIssues: async () => [issue],
  });
  const exitCode = process.exitCode;
  try {
    await runAsync('intake-scan', '--dir', join(dir, 'missing'), '--team', 'UX');
    expect(output).toEqual(['폴더 추가 0 · Linear 추가 1 · 건너뜀(없음) · 실패(Wish 폴더 스캔 실패)\n']);
    expect(store.listCards().map(card => card.goalId)).toEqual(['wish:linear:UX-8']);
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = exitCode ?? 0; store.close(); }
});

test('intake-scan without team scans Wish and marks Linear skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-intake-'));
  roots.push(dir);
  writeFileSync(join(dir, 'sample.md'), '# Wish title\n');
  let readKey = false;
  const { store, output, runAsync } = fixture({ getApiKey: async () => { readKey = true; return 'secret'; } });
  try {
    await runAsync('intake-scan', '--dir', dir);
    expect(output).toEqual(['폴더 추가 1 · Linear 추가 0 · 건너뜀(Linear 팀 미지정)\n']);
    expect(readKey).toBe(false);
  } finally { store.close(); }
});

test('card list --json emits an empty array, not a wrapper or human text', () => {
  const { store, output, run } = fixture();
  run('list', '--json');
  expect(output).toEqual(['[]\n']);
  store.close();
});

test('card show renders stored sections, and --json returns the complete stored card', () => {
  const { store, output, run } = fixture();
  const created = store.createCard({ goalId: 'goal-1', title: 'Implement parser' });
  const card = store.appendSection(created.id, { key: 'landing', owner: 'landing-loop', content: 'Passed\nchecks' });
  run('show', card.id);
  expect(output.join('')).toContain(`ID: ${card.id}`);
  expect(output.join('')).toContain('Goal: goal-1');
  expect(output.join('')).toContain('Status: open');
  expect(output.join('')).toContain('landing (landing-loop,');
  expect(output.join('')).toContain('Passed\nchecks');
  output.length = 0;
  run('show', card.id, '--json');
  expect(output).toEqual([`${JSON.stringify(card)}\n`]);
  store.close();
});

test('card list --open filters closed cards in both text and JSON; unfiltered list preserves both', () => {
  const { store, output, run } = fixture();
  const opened = store.createCard({ goalId: 'open-goal', title: 'Open title' });
  const closed = store.closeCard(store.createCard({ goalId: 'closed-goal', title: 'Closed title' }).id);
  run('list', '--open', '--json');
  expect(JSON.parse(output.join(''))).toEqual([opened]);
  output.length = 0;
  run('list', '--json');
  expect(JSON.parse(output.join(''))).toEqual(store.listCards());
  expect(JSON.parse(output.join('')).map((card: { id: string }) => card.id)).toContain(closed.id);
  output.length = 0;
  run('list', '--open');
  expect(output.join('')).toContain(`Open title\t${opened.goalId}`);
  expect(output.join('')).not.toContain(closed.id);
  output.length = 0;
  run('list');
  expect(output.join('')).toContain(closed.id);
  store.close();
});

test('missing card fails rather than displaying an invented card', () => {
  const { store, output, run } = fixture();
  expect(() => run('show', 'missing', '--json')).toThrow('Card not found: missing');
  expect(output).toEqual([]);
  store.close();
});

test('wish-scan --dir emits counts in text or JSON and makes cards visible to list', () => {
  const { store, output, run } = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'card-wish-'));
  roots.push(dir);
  writeFileSync(join(dir, 'sample.md'), '# Wish title\n');
  run('wish-scan', '--dir', dir);
  expect(output).toEqual(['추가 1 · 갱신 0 · 건너뜀 0\n']);
  output.length = 0;
  run('wish-scan', '--dir', dir, '--json');
  expect(output).toEqual(['{"added":0,"updated":0,"skipped":1}\n']);
  output.length = 0;
  run('list', '--json');
  expect(JSON.parse(output.join(''))[0]).toMatchObject({ goalId: 'wish:sample.md', title: 'Wish title' });
  store.close();
});

test('wish-scan defaults to OBSIDIAN_VAULT_ROOT Wish directory; --dir takes precedence', () => {
  const { store, output, run } = fixture();
  const vault = mkdtempSync(join(tmpdir(), 'card-vault-'));
  roots.push(vault);
  const wishDir = join(vault, '00. Inbox', '00. Wish');
  mkdirSync(wishDir, { recursive: true });
  writeFileSync(join(wishDir, 'vault.md'), '# From vault');
  const alternate = join(vault, 'other');
  mkdirSync(alternate);
  writeFileSync(join(alternate, 'other.md'), '# From option');
  const previous = process.env.OBSIDIAN_VAULT_ROOT;
  try {
    process.env.OBSIDIAN_VAULT_ROOT = vault;
    run('wish-scan', '--json');
    expect(JSON.parse(output.pop()!)).toEqual({ added: 1, updated: 0, skipped: 0 });
    run('wish-scan', '--dir', alternate, '--json');
    expect(JSON.parse(output.pop()!)).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect(store.listCards().map(card => card.goalId).sort()).toEqual(['wish:other.md', 'wish:vault.md']);
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_VAULT_ROOT;
    else process.env.OBSIDIAN_VAULT_ROOT = previous;
    store.close();
  }
});

test('wish-scan missing directory prints attempted path and sets exit code 2', () => {
  const { store, output, run } = fixture();
  const missing = join(mkdtempSync(join(tmpdir(), 'card-wish-missing-')), 'missing');
  roots.push(join(missing, '..'));
  const lines: string[] = [];
  const original = process.stderr.write;
  const exitCode = process.exitCode;
  process.stderr.write = ((text: string) => { lines.push(text); return true; }) as typeof process.stderr.write;
  try {
    run('wish-scan', '--dir', missing);
    expect(lines).toEqual([`Wish 폴더를 찾지 못했습니다: ${missing}\n`]);
    expect(process.exitCode).toBe(2);
    expect(output).toEqual([]);
    expect(store.listCards()).toEqual([]);
  } finally {
    process.stderr.write = original;
    process.exitCode = exitCode ?? 0;
    store.close();
  }
});
