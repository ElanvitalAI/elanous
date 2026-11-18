// 대표 11-17: the sim device source of truth is the Nexus ledger (catalog/ux-sim/mock-scenario-catalog-fragments).
// A fake TUI / PTY / render / scripted-LLM device that lives outside it is invisible to the next person who needs
// one, so they build another. This test keeps every device-shaped file accounted for: registered (device
// implementation or source module), a candidate, or excluded with a written reason.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..', '..');
const fragments = join(repo, 'catalog/ux-sim/mock-scenario-catalog-fragments');

const rows = (collection: string): Record<string, unknown>[] => {
  const dir = join(fragments, collection);
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>)
    : [];
};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : [];

const exclusions = rows('source-exclusions');
const ledgerPaths = new Set<string>([
  ...rows('devices').flatMap((device) => strings(device.implementation)),
  ...rows('source-modules').flatMap((module) => strings(module.path)),
  ...rows('candidates').flatMap((candidate) => strings(candidate.path)),
  ...exclusions.flatMap((exclusion) => strings(exclusion.path)),
]);

/** Tracked files under the given roots (git ls-files keeps build output and scratch files out). */
function tracked(...roots: string[]): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z', '--', ...roots], { cwd: repo });
  return result.stdout.toString().split('\0').filter(Boolean);
}
const isRuntimeSource = (path: string) => /\.(ts|mjs|sh)$/u.test(path) && !/\.(test|spec)\.ts$/u.test(path) && !path.endsWith('.d.ts');

// What makes a file a device: it turns the fakes on, drives a real PTY, or launches the TUI.
// Tests are consumers of devices and are out of scope; production readers of the switches are consumers too.
const DEVICE_SIGNALS: readonly [string, RegExp][] = [
  ['sets the scripted fake LLM', /ELANOUS_TEST_FAKE_LLM\w*['"]?\s*[:=]\s*['"`{(]|ELANOUS_TEST_FAKE_LLM\w*=\S/u],
  ['drives a real PTY', /mockSeatPtySequence\(|runPtyKeyModifiersDevice\(/u],
  ['opens a PTY', /from ['"](?:node-pty|@lydell\/node-pty|bun-pty)['"]/u],
  ['launches the TUI', /['"]--tui['"]/u],
];

const remedy = 'register it in catalog/ux-sim/mock-scenario-catalog-fragments (devices/ + source-modules/), or add a source-exclusions/ row with the reason it is not a device';

test('every runtime file under src/ux-sim is in the device ledger', () => {
  const missing = tracked('src/ux-sim').filter((path) => path.endsWith('.ts') && isRuntimeSource(path) && !ledgerPaths.has(path));
  expect(missing.map((path) => `${path} — ${remedy}`)).toEqual([]);
});

test('device-shaped files in scripts/ and test/ are in the device ledger', () => {
  const missing = tracked('scripts', 'test').filter(isRuntimeSource).flatMap((path) => {
    if (ledgerPaths.has(path)) return [];
    const text = readFileSync(join(repo, path), 'utf8');
    const signals = DEVICE_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
    return signals.length > 0 ? [`${path} (${signals.join(', ')}) — ${remedy}`] : [];
  });
  expect(missing).toEqual([]);
});

test('every source exclusion names a file that still exists and says why', () => {
  const stale = exclusions.filter((exclusion) => {
    const path = strings(exclusion.path)[0];
    return !path || !existsSync(join(repo, path)) || strings(exclusion.reason).join('').trim() === '';
  }).map((exclusion) => String(exclusion.path));
  expect(stale).toEqual([]);
});

test('the device signals catch the shapes they name and leave consumers alone', () => {
  const caught = (text: string) => DEVICE_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  expect(caught("env: { ELANOUS_TEST_FAKE_LLM: '1' }")).toEqual(['sets the scripted fake LLM']);
  expect(caught('ELANOUS_TEST_FAKE_LLM=1 bun bin/elanous.mjs')).toEqual(['sets the scripted fake LLM']);
  expect(caught("await mockSeatPtySequence({ args: ['--tui', 'next'] })")).toEqual(['drives a real PTY', 'launches the TUI']);
  // Reading the switch (a production consumer) is not a device.
  expect(caught("if (process.env.ELANOUS_TEST_FAKE_LLM === '1') return fake;")).toEqual([]);
});
