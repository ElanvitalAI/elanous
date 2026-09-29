import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { generateIndexKeyPair, signIndex } from '../market/signed-index.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dirs: string[] = [];
const repo = resolve(import.meta.dir, '../..');
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'elanous-plugin-cli-')); dirs.push(dir); return dir; }
function fixture(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'sample-test', version: '1.0.0', main: './plugin.ts',
    capabilities: ['fs:read'], contributes: { connectors: [{ id: 'service', userConfig: [{ key: 'API_KEY', secret: true }] }] } }));
  writeFileSync(join(dir, 'plugin.ts'), `export default { name: 'sample-test', initialState: () => ({}), panes: {} };`);
  return dir;
}
async function cli(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, 'bin/elanous.mjs', `--test=${root}`, 'plugin', ...args], {
    cwd: repo, env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [code, output, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, output, stderr };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('CLI add NDJSON order, list, remove and secret-free connector names', async () => {
  const root = temp();
  const source = fixture(join(temp(), 'source'));
  const result = await cli(root, ['add', source, '--yes', '--json']);
  expect(result.code).toBe(0);
  const events = result.output.trim().split('\n').map(line => JSON.parse(line));
  expect(events.map(event => event.event)).toEqual(['resolve', 'verify', 'consent', 'credentials', 'registered', 'done']);
  expect(events.at(-1)).toMatchObject({ event: 'done', plugin: 'sample-test' });
  expect(events[3]).toEqual({ event: 'credentials', connectors: [{ id: 'service', fields: ['API_KEY'] }] });
  expect(result.output).not.toContain('secret":true');
  expect(result.output).not.toContain('"value"');
  const list = await cli(root, ['list', '--json']);
  expect(list.code).toBe(0);
  expect(JSON.parse(list.output).map((item: { name: string }) => item.name)).toEqual(['sample-test']);
  expect((await cli(root, ['remove', 'sample-test'])).code).toBe(0);
  expect(JSON.parse((await cli(root, ['list', '--json'])).output)).toEqual([]);
}, 20_000);

test('non-interactive install without --yes fails consent and leaves no installation', async () => {
  const root = temp();
  const source = fixture(join(temp(), 'source'));
  const result = await cli(root, ['add', source, '--json']);
  expect(result.code).toBe(1);
  const events = result.output.trim().split('\n').map(line => JSON.parse(line));
  expect(events.at(-1)).toEqual({ event: 'failed', reason: 'consent-denied', detail: 'plugin capabilities require consent' });
  expect(events.map(event => event.event)).toEqual(['resolve', 'verify', 'consent', 'failed']);
  expect(JSON.parse((await cli(root, ['list', '--json'])).output)).toEqual([]);
}, 20_000);

test('job-coach installs through public CLI and appears in list', async () => {
  const root = temp();
  const installed = await cli(root, ['add', './plugins/job-coach', '--yes', '--json']);
  expect(installed.code).toBe(0);
  expect(JSON.parse(installed.output.trim().split('\n').at(-1)!)).toMatchObject({ event: 'done', plugin: 'job-coach' });
  expect(JSON.parse((await cli(root, ['list', '--json'])).output).map((item: { name: string }) => item.name)).toContain('job-coach');
}, 20_000);

test('signed market index uses configured trustedKeys and rejects tampered signatures', async () => {
  const root = temp();
  const source = fixture(join(temp(), 'source'));
  const market = join(root, 'plugins', 'markets', 'test-market');
  mkdirSync(market, { recursive: true });
  const archive = join(market, 'sample.tgz');
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  const bytes = readFileSync(archive);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const index = Buffer.from(JSON.stringify({ name: 'test-market', interface: { displayName: 'Test' }, sequence: 1,
    plugins: [{ name: 'sample-test', version: '1.0.0', source: { source: 'local', path: 'source' },
      artifact: { sha256: hash, bytes: bytes.length, key: 'sample.tgz' },
      'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } }] }));
  const keys = generateIndexKeyPair();
  writeFileSync(join(market, 'marketplace.json'), index);
  writeFileSync(join(market, 'index.sig'), signIndex(index, keys.privateKeyPem, keys.keyId));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ market: { trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] } }));
  const installed = await cli(root, ['add', 'sample-test@test-market', '--yes', '--json']);
  expect(installed.code).toBe(0);
  expect(installed.output.trim().split('\n').map(line => JSON.parse(line).event)).toEqual(['resolve', 'verify', 'consent', 'credentials', 'registered', 'done']);
  writeFileSync(join(market, 'marketplace.json'), Buffer.concat([index, Buffer.from(' ')]));
  const rejected = await cli(root, ['add', 'sample-test@test-market', '--yes', '--json']);
  expect(rejected.code).toBe(1);
  expect(JSON.parse(rejected.output.trim().split('\n').at(-1)!)).toMatchObject({ event: 'failed', reason: 'signature' });
}, 20_000);

test('index registers the plugin CLI command', () => {
  const index = readFileSync(join(repo, 'src', 'index.ts'), 'utf8');
  expect(index).toContain('registerPluginCommands(program);');
});
