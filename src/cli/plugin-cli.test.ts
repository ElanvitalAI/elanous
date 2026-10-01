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
function fixture(dir: string, withNodes = false): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'sample-test', version: '1.0.0', main: './plugin.ts',
    capabilities: ['fs:read'], contributes: { connectors: [{ id: 'service', userConfig: [{ key: 'API_KEY', secret: true }] }],
      ...(withNodes ? { nodes: ['./nodes/action.yaml'] } : {}) } }));
  if (withNodes) {
    mkdirSync(join(dir, 'nodes'));
    writeFileSync(join(dir, 'nodes', 'action.yaml'), 'kind: action\ngraph: workflow\ninputs:\n  type: object\nrun:\n  bash: echo ok\n');
  }
  writeFileSync(join(dir, 'plugin.ts'), `export default { name: 'sample-test', initialState: () => ({}), panes: {} };`);
  return dir;
}
async function cli(root: string, args: string[], preload?: string, input?: string) {
  const proc = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), 'bin/elanous.mjs', `--test=${root}`, 'plugin', ...args], {
    cwd: repo, env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root }, stdin: input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  if (input !== undefined && proc.stdin) { proc.stdin.write(input); proc.stdin.end(); }
  const [code, output, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, output, stderr };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('CLI add NDJSON order, list, remove and secret-free connector names', async () => {
  const root = temp();
  const source = fixture(join(temp(), 'source'), true);
  const result = await cli(root, ['add', source, '--yes', '--json', '--refresh']);
  expect(result.code).toBe(0);
  const events = result.output.trim().split('\n').map(line => JSON.parse(line));
  expect(events.map(event => event.event)).toEqual(['resolve', 'verify', 'consent', 'credentials', 'registered', 'done']);
  expect(events.at(-1)).toMatchObject({ event: 'done', plugin: 'sample-test' });
  expect(events[3]).toEqual({ event: 'credentials', connectors: [{ id: 'service', fields: ['API_KEY'] }] });
  expect(events[4]).toEqual({ event: 'registered', kinds: [], nodes: ['sample-test:action'], nodeErrors: 0, graphs: [], skills: [] });
  expect(result.output).not.toContain('secret":true');
  expect(result.output).not.toContain('"value"');
  const list = await cli(root, ['list', '--json']);
  expect(list.code).toBe(0);
  const [item] = JSON.parse(list.output) as Array<{ name: string; installedAt?: string }>;
  expect(item?.name).toBe('sample-test');
  expect(item?.installedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect((await cli(root, ['list'])).output).toContain(`sample-test@1.0.0 (local) — installed ${item?.installedAt}`);
  expect((await cli(root, ['remove', 'sample-test'])).code).toBe(0);
  expect(JSON.parse((await cli(root, ['list', '--json'])).output)).toEqual([]);
}, 20_000);

test('human add reports installed node count and legacy list omits installation time', async () => {
  const root = temp();
  const source = fixture(join(temp(), 'source'), true);
  const result = await cli(root, ['add', source, '--yes']);
  expect(result.code).toBe(0);
  expect(result.output).toContain('Installed sample-test@1.0.0 (1 nodes)');
  const ledger = join(root, 'plugins', 'installed.json');
  const [entry] = JSON.parse(readFileSync(ledger, 'utf8')) as Array<Record<string, unknown>>;
  expect(entry?.installedAt).toBeDefined();
  delete entry!.installedAt;
  writeFileSync(ledger, JSON.stringify([entry]));
  expect(JSON.parse((await cli(root, ['list', '--json'])).output)[0].installedAt).toBeUndefined();
  expect((await cli(root, ['list'])).output.trim()).toBe('sample-test@1.0.0 (local)');
}, 20_000);

test('CLI reports staged node count even if a previous version registered the kind', async () => {
  const root = temp();
  const source = fixture(join(temp(), 'source'), true);
  const preload = join(root, 'register-existing.ts');
  writeFileSync(preload, `import { registerNodeKind, getNodeKind } from ${JSON.stringify(new URL('../graph-kinds/registry.ts', import.meta.url).href)};
    const result = registerNodeKind({ graph: 'workflow', kind: 'sample-test:action', plugin: 'sample-test', core: false,
      description: 'previous version', schema: { type: 'object' }, run: { bash: 'echo old' } });
    if (!result.ok || !getNodeKind('workflow', 'sample-test:action')) throw new Error('preload registration failed');
    console.error('preloaded sample-test:action');`);
  const human = await cli(root, ['add', source, '--yes'], preload);
  expect(human.stderr).toContain('preloaded sample-test:action');
  expect(human.code).toBe(0);
  expect(human.output).toContain('Installed sample-test@1.0.0 (1 nodes)');
  const json = await cli(temp(), ['add', source, '--yes', '--json'], preload);
  expect(json.stderr).toContain('preloaded sample-test:action');
  expect(json.code).toBe(0);
  expect(json.output.trim().split('\n').map(line => JSON.parse(line)).find(event => event.event === 'registered'))
    .toMatchObject({ nodes: ['sample-test:action'], nodeErrors: 0 });
}, 20_000);

test('elanous-hwp pack exposes both node kinds and install time through the isolated CLI', async () => {
  const root = temp();
  const added = await cli(root, ['add', './packs/elanous-hwp', '--yes', '--json']);
  expect(added.code).toBe(0);
  const events = added.output.trim().split('\n').map(line => JSON.parse(line));
  expect(events.find(event => event.event === 'registered')?.nodes).toEqual(['elanous-hwp:to-md', 'elanous-hwp:from-md']);
  const listed = await cli(root, ['list', '--json']);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.output)[0].installedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
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

test('market CLI registers, lists and refreshes signed indices using the configured trust', async () => {
  const root = temp();
  const marketUrl = 'https://example.org/market/';
  const keys = generateIndexKeyPair();
  const index = Buffer.from(JSON.stringify({ name: 'community', interface: { displayName: 'Community' }, sequence: 1, plugins: [] }));
  const signature = signIndex(index, keys.privateKeyPem, keys.keyId);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ market: { trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] } }));
  const added = await cli(root, ['market', 'add', 'community', marketUrl]);
  expect(added.code).toBe(0);
  const listed = await cli(root, ['market', 'list', '--json']);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.output)).toContainEqual({ name: 'community', url: marketUrl });
  expect((await cli(root, ['market', 'list'])).output).toContain('community (https://example.org/market/)');
  expect((await cli(root, ['market', 'add', 'community', marketUrl])).code).toBe(1);
  expect((await cli(root, ['market', 'add', 'unsafe', 'http://example.org/'])).code).toBe(1);
  expect(JSON.parse(listed.output).map((entry: { name: string }) => entry.name)).toContain('elanous');
  const preload = join(root, 'fetch-preload.js');
  writeFileSync(preload, `globalThis.fetch = async input => {
    const url = String(input);
    if (!url.startsWith(${JSON.stringify(marketUrl)})) throw new Error('unexpected market URL');
    return new Response(url.endsWith('/index.sig') ? ${JSON.stringify(signature)} : ${JSON.stringify(index.toString())}, { status: 200 });
  };`);
  const updated = await cli(root, ['market', 'update', 'community'], preload);
  expect(updated.code).toBe(0);
  expect(updated.output).toContain('sequence 1');
  expect(readFileSync(join(root, 'plugins', 'markets', 'community', 'marketplace.json'))).toEqual(index);
  const nextIndex = Buffer.from(JSON.stringify({ name: 'community', interface: { displayName: 'Community' }, sequence: 2, plugins: [] }));
  const nextSignature = signIndex(nextIndex, keys.privateKeyPem, keys.keyId);
  writeFileSync(preload, `globalThis.fetch = async input => {
    const url = String(input);
    if (!url.startsWith(${JSON.stringify(marketUrl)})) throw new Error('unexpected market URL');
    return new Response(url.endsWith('/index.sig') ? ${JSON.stringify(nextSignature)} : ${JSON.stringify(nextIndex.toString())}, { status: 200 });
  };`);
  const refreshed = await cli(root, ['market', 'update', 'community'], preload);
  expect(refreshed.code).toBe(0);
  expect(refreshed.output).toContain('sequence 2');
  expect(readFileSync(join(root, 'plugins', 'markets', 'community', 'marketplace.json'))).toEqual(nextIndex);
  expect((await cli(root, ['market', 'update', 'unknown'], preload)).code).toBe(1);
}, 20_000);

test('market CLI without a name continues to configured markets after a failed built-in fetch', async () => {
  const root = temp();
  const config = join(root, 'config.json');
  const preload = join(root, 'fetch-preload.js');
  const keys = generateIndexKeyPair();
  const index = Buffer.from(JSON.stringify({ name: 'community', interface: { displayName: 'Community' }, sequence: 1, plugins: [] }));
  writeFileSync(config, JSON.stringify({ market: { markets: [{ name: 'community', url: 'https://example.org/community/' }],
    trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] } }));
  const signature = signIndex(index, keys.privateKeyPem, keys.keyId);
  writeFileSync(preload, `globalThis.fetch = async input => String(input).startsWith('https://example.org/community/')
    ? new Response(String(input).endsWith('/index.sig') ? ${JSON.stringify(signature)} : ${JSON.stringify(index.toString())}, { status: 200 })
    : new Response('service unavailable', { status: 503 });`);
  const result = await cli(root, ['market', 'update'], preload);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('HTTP 503');
  expect(result.stderr).toContain('marketplace.json');
  expect(result.stderr).toContain('plugin market update elanous failed');
  expect(result.output).toContain('Updated market community (sequence 1)');
  expect(readFileSync(join(root, 'plugins', 'markets', 'community', 'marketplace.json'))).toEqual(index);
}, 20_000);

test('CLI reports the original failure cause with URL credentials redacted, preserving consent output', async () => {
  const root = temp();
  const source = fixture(join(temp(), 'source'));
  const consent = await cli(root, ['add', source, '--json']);
  expect(JSON.parse(consent.output.trim().split('\n').at(-1)!)).toEqual({ event: 'failed', reason: 'consent-denied', detail: 'plugin capabilities require consent' });
  const failed = await cli(root, ['add', 'https://user:secret@example.org/private', '--json']);
  expect(failed.code).toBe(1);
  const event = JSON.parse(failed.output.trim().split('\n').at(-1)!);
  expect(event).toMatchObject({ event: 'failed', reason: 'io' });
  expect(typeof event.cause).toBe('string');
  expect(event.cause).toContain('unsupported plugin source');
  expect(JSON.stringify(event)).not.toContain('user:secret');
  expect(failed.output).not.toContain('user:secret');
}, 20_000);

test('credentials CLI sets, reads stdin, unsets and never prints values', async () => {
  const root = temp();
  const source = fixture(join(temp(), 'source'));
  expect((await cli(root, ['add', source, '--yes'])).code).toBe(0);
  const set = await cli(root, ['credentials', 'sample-test', '--set', 'API_KEY=dummy-secret', '--json']);
  expect(set.code).toBe(0);
  expect(JSON.parse(set.output)).toEqual({ fields: [{ name: 'API_KEY', env: 'ELANOUS_PLUGIN_SAMPLE_TEST_API_KEY', set: true }] });
  const table = await cli(root, ['credentials', 'sample-test']);
  expect(table.output).toContain('API_KEY\tELANOUS_PLUGIN_SAMPLE_TEST_API_KEY\tset');
  const stdinSet = await cli(root, ['credentials', 'sample-test', '--stdin', 'API_KEY', '--json'], undefined, 'stdin-secret\nignored');
  expect(JSON.parse(stdinSet.output).fields[0].set).toBe(true);
  const emptyStdin = await cli(root, ['credentials', 'sample-test', '--stdin', 'API_KEY', '--json'], undefined, '');
  expect(emptyStdin.code).toBe(1);
  const rejected = await cli(root, ['credentials', 'sample-test', '--set', 'UNKNOWN=reject-secret', '--json']);
  expect(rejected.code).toBe(1);
  const unset = await cli(root, ['credentials', 'sample-test', '--unset', 'API_KEY', '--json']);
  expect(JSON.parse(unset.output).fields[0].set).toBe(false);
  for (const result of [set, table, stdinSet, emptyStdin, rejected, unset]) {
    expect(result.output + result.stderr).not.toMatch(/dummy-secret|stdin-secret|reject-secret/);
  }
}, 20_000);

test('plugin make help exposes name, dir, run, input and json', async () => {
  const result = await cli(temp(), ['make', '--help']);
  expect(result.code).toBe(0);
  for (const flag of ['--name', '--dir', '--run', '--input', '--json']) expect(result.output).toContain(flag);
});

test('plugin make rejects an existing --name before invoking codex and reports JSON failure', async () => {
  const root = temp();
  mkdirSync(join(root, 'plugins-local', 'taken'), { recursive: true });
  const result = await cli(root, ['make', 'something', '--name', 'taken', '--json']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.output)).toMatchObject({ status: 'failed', errors: [expect.stringContaining('already exists')] });
});

test('plugin node add CLI dispatches to addAndInstallNode with --kind and one-line --json', async () => {
  const help = await cli(temp(), ['node', 'add', '--help']);
  expect(help.code).toBe(0);
  expect(help.output).toContain('--kind');
  expect(help.output).toContain('--json');
  const root = temp();
  const source = fixture(join(temp(), 'source'));
  const result = await cli(root, ['node', 'add', source, 'a node', '--kind', 'INVALID', '--json']);
  expect(result.code).toBe(1);
  expect(result.output.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.output)).toEqual({ status: 'failed', errors: ['invalid node request or kind: INVALID'] });
  expect(JSON.parse((await cli(root, ['list', '--json'])).output)).toEqual([]);
  expect((await cli(root, ['add', '--help'])).output).toContain('--allow-unsigned');
}, 20_000);

test('index registers the plugin CLI command', () => {
  const index = readFileSync(join(repo, 'src', 'index.ts'), 'utf8');
  expect(index).toContain('registerPluginCommands(program);');
});
