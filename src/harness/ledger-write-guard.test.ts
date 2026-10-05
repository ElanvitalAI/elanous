import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { refuseProductionLedgerWriteInTest } from './ledger-write-guard.js';
import { recordRunExit } from './harness-incidents.js';
import { appendRunLedgerEntry, loadRunLedger } from '../self-implement/run-ledger.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ledger-write-guard-'));
  roots.push(root);
  return root;
}

test('test markers refuse production root and observe each refused ledger write', () => {
  const production = temporaryRoot();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    for (const env of [{ NODE_ENV: 'test' }, { ELANOUS_TEST_HOME: '/test/home' }]) {
      expect(refuseProductionLedgerWriteInTest(`${production}/.`, 'run-ledger', env, production, production)).toBe(true);
    }
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('harness.incidents', 'write-refused', {
      store: 'run-ledger', root: production, effectiveInstanceRoot: production,
    });
    expect(readdirSync(production)).toEqual([]);
  } finally { log.mockRestore(); }
});

test('both writers refuse the effective production root in a test child before creating ledger files', () => {
  const home = temporaryRoot();
  const production = join(home, '.elanous');
  for (const marker of ['NODE_ENV', 'ELANOUS_TEST_HOME']) {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, ELANOUS_STATE_DIR: production, NODE_ENV: '', ELANOUS_TEST_HOME: '' };
    env[marker] = marker === 'NODE_ENV' ? 'test' : home;
    const child = Bun.spawnSync(['bun', 'src/harness/ledger-write-guard-child.fixture.ts'], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(new TextDecoder().decode(child.stderr)).toBe('');
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(new TextDecoder().decode(child.stdout));
    expect(result.env).toMatchObject({ HOME: home, ELANOUS_STATE_DIR: production, [marker]: env[marker] });
    expect(result.root).toBe(production);
    expect(result.effectiveInstanceRoot).toBe(result.root);
    expect(result.after).toEqual(result.before);
    expect(result.after).not.toContain('incidents');
    expect(result.after).not.toContain('run-ledger');
    expect(result.after).not.toContain('.incident-write-lock.sqlite');
  }
});

test('actual writers refuse nested paths, symlink aliases and missing descendants without creating files', () => {
  const home = temporaryRoot();
  const production = join(home, '.elanous');
  mkdirSync(production);
  const alias = join(home, 'prod-alias');
  symlinkSync(production, alias, 'dir');
  const sibling = join(home, '.elanous-other');
  mkdirSync(sibling);
  const env = { ...process.env, HOME: home, ELANOUS_STATE_DIR: production, NODE_ENV: 'test', ELANOUS_TEST_HOME: '' };
  const cases = [
    [production, production],
    [join(production, 'nested'), join(production, 'nested', 'run-ledger')],
    [alias, join(alias, 'run-ledger')],
    [join(alias, 'missing', 'incident-root'), join(alias, 'missing', 'run-ledger')],
  ];
  for (const [incidentRoot, ledgerDir] of cases) {
    const child = Bun.spawnSync(['bun', 'src/harness/ledger-write-guard-child.fixture.ts', incidentRoot!, ledgerDir!], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(new TextDecoder().decode(child.stderr)).toBe('');
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(new TextDecoder().decode(child.stdout));
    expect(result.after).toEqual(result.before);
  }
  expect(readdirSync(production)).not.toContain('incidents');
  expect(readdirSync(production)).not.toContain('run-ledger');
  expect(readdirSync(production)).not.toContain('nested');
  expect(readdirSync(production)).not.toContain('missing');
  const isolatedChild = Bun.spawnSync(['bun', 'src/harness/ledger-write-guard-child.fixture.ts', sibling, join(sibling, 'run-ledger')], { env, stdout: 'pipe', stderr: 'pipe' });
  expect(isolatedChild.exitCode).toBe(0);
  expect(existsSync(join(sibling, 'run-ledger', 'run-test.jsonl'))).toBe(true);
  expect(existsSync(join(sibling, 'incidents'))).toBe(true);
});

test('non-test process and isolated test root are not refused', () => {
  const production = temporaryRoot();
  const isolated = temporaryRoot();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    expect(refuseProductionLedgerWriteInTest(production, 'run-ledger', {}, production, production)).toBe(false);
    expect(refuseProductionLedgerWriteInTest(isolated, 'run-ledger', { NODE_ENV: 'test' }, production, isolated)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

test('real incident and run-ledger writers retain isolated-root writes in a test process', () => {
  const root = temporaryRoot();
  const runId = 'run-00000000-0000-4000-8000-000000000001';
  recordRunExit({ runId, reason: 'signal', status: 143, signal: 'SIGTERM', at: '2026-10-02T13:49:07Z' }, root);
  appendRunLedgerEntry({ runId, event: 'start', data: {} }, join(root, 'run-ledger'));
  expect(existsSync(join(root, 'incidents', '2026-10-02.jsonl'))).toBe(true);
  expect(loadRunLedger(runId, join(root, 'run-ledger'))).toEqual([{ runId, event: 'start', data: {} }]);
});
