import { test, expect } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerDecisionsCommands } from './decisions-cli.js';

const root = () => mkdtempSync(join(tmpdir(), 'decisions-cli-'));
test('CLI raises, filters, shows and records human/AUTO decisions; validation errors do not append', () => {
  const stateDir = root();
  const lines: string[] = [];
  const program = new Command();
  registerDecisionsCommands(program, { stateDir, releaseRoot: join(stateDir, 'missing'), repoRoot: join(stateDir, 'missing') }, { log: s => lines.push(s) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return lines[0]!; };
  const raise = ['raise', '--agent', 'codex', '--title', 'Publish?', '--category', 'publish', '--s', 'Draft exists.', '--c', 'Decision needed.', '--option', 'a=Publish:Public', '--option', 'b=Hold:Private', '--skip-recommend', 'Research takes time', '--json'];
  const entry = JSON.parse(run(...raise));
  expect(entry.id).toMatch(/^D-\d{8}-01$/);
  expect(JSON.parse(run('list', '--json'))).toHaveLength(1);
  expect(run('list')).toContain('권고 생략');
  expect(run('show', entry.id)).toContain('선택지 | 결과');
  expect(() => run('decide', entry.id, 'b', '--auto')).toThrow('delegation');
  expect(JSON.parse(run('decide', entry.id, 'b', '--auto', '--agent', 'codex', '--delegation', '대표 S 위임', '--json')).decidedBy).toMatchObject({ kind: 'auto', agent: 'codex' });
  expect(JSON.parse(run('list', '--status', 'decided', '--decided-by', 'auto', '--json'))).toHaveLength(1);
  expect(() => run('raise', ...raise.slice(1, -3), '--skip-recommend', ' ', '--json')).toThrow();
  expect(readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});

test('unknown actor is never silently attributed to elanous; historical options can be supplied through CLI', () => {
  const stateDir = root();
  const lines: string[] = [];
  const program = new Command();
  registerDecisionsCommands(program, { stateDir, resolveVersion: () => ({ released: '0.2.5', dev: '0.2.6-dev.0', codename: null }) }, { log: s => lines.push(s) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return lines[0]!; };
  const oldAgent = process.env.AI_AGENT;
  try {
    delete process.env.AI_AGENT;
    expect(() => run('raise', '--title', 'Publish?', '--category', 'publish', '--s', 'Draft.', '--c', 'Decision.', '--option', 'a=Publish:Public', '--option', 'b=Hold:Private', '--skip-recommend', 'Unclear')).toThrow('agent unknown');
    expect(() => readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'))).toThrow();
    const { DecisionLedger } = require('../decisions/decision-ledger.js') as typeof import('../decisions/decision-ledger.js');
    const normal = new DecisionLedger({ stateDir, resolveVersion: () => ({ released: null, dev: null, codename: null }) }).raise({ title: 'Normal', category: 'scope', scqa: { s: 'Draft.', c: 'Choice.' }, options: [{ key: 'a', label: 'Yes', consequence: 'Proceed' }, { key: 'b', label: 'No', consequence: 'Hold' }], recommendation: { skipped: true, reason: 'Unknown' }, raisedBy: { agent: 'codex' } });
    expect(() => run('decide', normal.id, 'a', '--auto', '--delegation', 'Delegated', '--json')).toThrow('agent unknown');
    expect(run('show', normal.id)).toContain('codex');
    const item = new DecisionLedger({ stateDir }).importPending({ title: 'Historical', category: 'scope', scqa: { s: 'Original request.', c: 'No options recorded.' }, options: [], recommendation: { skipped: true, reason: 'Unknown' }, raisedBy: { agent: 'codex' }, refs: ['historical#H1'] });
    expect(() => run('add-options', item.id, '--option', 'a=Approve:Proceed', '--option', 'b=Decline:Stop')).toThrow('agent unknown');
    expect(JSON.parse(run('add-options', item.id, '--agent', 'codex', '--option', 'a=Approve:Proceed', '--option', 'b=Decline:Stop', '--json')).options).toHaveLength(2);
    expect(JSON.parse(run('decide', item.id, 'a', '--json')).choice).toBe('a');
  } finally { if (oldAgent === undefined) delete process.env.AI_AGENT; else process.env.AI_AGENT = oldAgent; }
});

test('actual CLI child reads an item raised in an isolated state directory', () => {
  const stateDir = root();
  const raise = spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', 'raise', '--agent', 'codex', '--title', 'CLI child decision', '--category', 'scope', '--s', 'Scope requested.', '--c', 'Choice required.', '--option', 'a=Accept:Expands scope', '--option', 'b=Decline:Keeps scope', '--skip-recommend', 'Needs investigation', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 240000,
  });
  expect(raise.status, raise.stderr.slice(0, 500)).toBe(0);
  const id = JSON.parse(raise.stdout.trim()).id;
  expect(readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8')).toContain(id);
  const result = spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', 'list', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 240000,
  });
  expect(result.status, result.stderr.slice(0, 500)).toBe(0);
  expect(JSON.parse(result.stdout.trim()).map((entry: { id: string }) => entry.id)).toContain(id);
}, 500000);
