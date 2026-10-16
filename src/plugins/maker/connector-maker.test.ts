import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadPluginManifestFromDir } from '../core/manifest.js';
import { makeConnector } from './connector-maker.js';

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'connector-maker-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'sample-plugin', version: '1.2.3',
    extensions: { 'ai.elanous': { graphs: ['./graphs/main.yaml'], capabilities: ['fs:workdir'],
      connectors: [{ id: 'existing', fields: [{ name: 'EXISTING_TOKEN', secret: true }] }] } } }, null, 2) + '\n');
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const gap = { name: 'Ticket API', use: 'Sync tickets', evidence: ['https://example.org/api'],
  missingCredentials: ['TICKET_API_KEY', '자격 확인 필요'] };

test('one gap appends one wizard-format connector with credential names only', () => {
  const dir = fixture();
  const file = join(dir, 'plugin.json');
  const before = JSON.parse(readFileSync(file, 'utf8'));
  expect(makeConnector({ dir, gap, id: 'tickets' })).toBe(file);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  expect(manifest.version).toBe(before.version);
  expect(manifest.extensions['ai.elanous'].graphs).toEqual(before.extensions['ai.elanous'].graphs);
  expect(manifest.extensions['ai.elanous'].capabilities).toEqual(before.extensions['ai.elanous'].capabilities);
  expect(manifest.extensions['ai.elanous'].connectors).toEqual([
    { id: 'existing', fields: [{ name: 'EXISTING_TOKEN', secret: true }] },
    { id: 'tickets', fields: [{ name: 'TICKET_API_KEY', secret: true }] },
  ]);
  expect(JSON.stringify(manifest)).not.toContain('https://example.org/api');
  expect(loadPluginManifestFromDir(dir, { id: 'local-plugin' }).manifest.contributes.connectors).toEqual(manifest.extensions['ai.elanous'].connectors);
  const bytes = readFileSync(file);
  expect(() => makeConnector({ dir, gap, id: 'tickets' })).toThrow('already exists');
  expect(readFileSync(file)).toEqual(bytes);
});

test('two gaps append two connectors without replacing existing contributions', () => {
  const dir = fixture();
  makeConnector({ dir, gap, id: 'tickets' });
  makeConnector({ dir, gap: { ...gap, name: 'Weather API', missingCredentials: ['WEATHER_TOKEN'] }, id: 'weather' });
  expect(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')).extensions['ai.elanous'].connectors.map((entry: { id: string }) => entry.id))
    .toEqual(['existing', 'tickets', 'weather']);
});

test('a linked ancestor is accepted without accepting a linked plugin directory', () => {
  const dir = fixture();
  const aliasRoot = mkdtempSync(join(tmpdir(), 'connector-maker-alias-'));
  dirs.push(aliasRoot);
  symlinkSync(dirname(dir), join(aliasRoot, 'parent'), 'dir');
  const aliasDir = join(aliasRoot, 'parent', basename(dir));
  const path = makeConnector({ dir: aliasDir, gap, id: 'tickets' });
  expect(path).toBe(join(aliasDir, 'plugin.json'));
  expect(loadPluginManifestFromDir(aliasDir, { id: 'local-plugin' }).manifest.contributes.connectors?.at(-1)?.id).toBe('tickets');
  const linkedDir = join(aliasRoot, 'linked-plugin');
  symlinkSync(dir, linkedDir, 'dir');
  expect(() => makeConnector({ dir: linkedDir, gap, id: 'another-connector' })).toThrow('unsafe');
});

test('preflight refuses missing manifest, unconfirmed gap, invalid id and duplicate credentials without writing', () => {
  const missing = mkdtempSync(join(tmpdir(), 'connector-maker-'));
  dirs.push(missing);
  expect(() => makeConnector({ dir: missing, gap, id: 'tickets' })).toThrow('plugin.json');
  const dir = fixture();
  const before = readFileSync(join(dir, 'plugin.json'));
  expect(() => makeConnector({ dir, gap: { ...gap, name: '미확인' }, id: 'tickets' })).toThrow('invalid connector gap');
  expect(() => makeConnector({ dir, gap, id: '../escape' })).toThrow('invalid connector gap');
  expect(() => makeConnector({ dir, gap: { ...gap, missingCredentials: ['TOKEN', 'TOKEN'] }, id: 'tickets' })).toThrow('duplicate');
  expect(readFileSync(join(dir, 'plugin.json'))).toEqual(before);
  const outside = mkdtempSync(join(tmpdir(), 'connector-maker-outside-'));
  dirs.push(outside);
  symlinkSync(join(dir, 'plugin.json'), join(outside, 'plugin.json'));
  expect(() => makeConnector({ dir: outside, gap, id: 'tickets' })).toThrow('unsafe');
});
