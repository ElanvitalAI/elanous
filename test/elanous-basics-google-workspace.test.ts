import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPluginSecurity, type PluginSecurityDecision } from '../src/plugins/core/capability-policy.js';
import { loadPluginManifestFromDir } from '../src/plugins/core/manifest.js';
import { installPlugin, listInstalledPlugins, type InstallEvent } from '../src/plugins/install/plugin-install.js';
import { publishMarket } from '../src/market/publish.js';
import { generateIndexKeyPair } from '../src/market/signed-index.js';

const root = join(import.meta.dir, '..');
const skillDir = join(root, 'skills/google-workspace');
const packDir = join(root, 'packs/elanous-basics');
const temporary: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-gws-pack-'));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The official bundle runs processes, so «install after consent» (caution) is the honest verdict.
// executable-code is an accurate classification and is not hidden — the install screen shows it as is.
// License labelling is decided in the 0.2.24 MK cell. Anything dangerous, or any other caution reason, still fails.
const OFFICIAL_CAUTION_REASONS: ReadonlySet<string> = new Set(['private-only-license', 'executable-code']);
const acceptableOfficialScan = (decision: Pick<PluginSecurityDecision, 'scan' | 'findings'>): boolean =>
  decision.scan !== 'dangerous' && decision.findings.every(finding => finding.level === 'caution' && OFFICIAL_CAUTION_REASONS.has(finding.code));

test('official bundle scan acceptance: only the license and executable-code cautions pass; anything else fails', () => {
  const caution = (code: string) => ({ level: 'caution' as const, code });
  expect(acceptableOfficialScan({ scan: 'safe', findings: [] })).toBe(true);
  expect(acceptableOfficialScan({ scan: 'caution', findings: [caution('private-only-license'), caution('executable-code')] })).toBe(true);
  expect(acceptableOfficialScan({ scan: 'caution', findings: [caution('private-only-license'), caution('hooks-disabled')] })).toBe(false);
  expect(acceptableOfficialScan({ scan: 'dangerous', findings: [caution('private-only-license'), { level: 'dangerous', code: 'embedded-secret' }] })).toBe(false);
  // Real scanner, real bundle skill plus one planted problem: still rejected.
  const dir = temp();
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), readFileSync(join(packDir, 'plugin.json')));
  mkdirSync(join(dir, 'skills/google-workspace/scripts'), { recursive: true });
  writeFileSync(join(dir, 'skills/google-workspace/SKILL.md'), readFileSync(join(skillDir, 'SKILL.md')));
  expect(acceptableOfficialScan(inspectPluginSecurity(dir))).toBe(true);
  writeFileSync(join(dir, 'skills/google-workspace/scripts/leak.ts'), 'export const apiKey = "superlongprivatevalue123456";\n');
  expect(acceptableOfficialScan(inspectPluginSecurity(dir))).toBe(false);
});

const rawManifest = () => JSON.parse(readFileSync(join(packDir, 'plugin.json'), 'utf8')) as {
  extensions: { 'ai.elanous': { bundle: string[] } };
};

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});

test('elanous-basics declares and parses the bundled skill and its process permission', () => {
  const raw = rawManifest();
  const { manifest, inferred } = loadPluginManifestFromDir(packDir, { id: 'elanous-basics' });
  expect(inferred).toBe(false);
  expect(raw.extensions['ai.elanous'].bundle).toContain('skills/google-workspace');
  expect(manifest.id).toBe('elanous-basics');
  expect(manifest.version).toBe('0.1.3');
  expect(manifest.capabilities).toContainEqual({ kind: 'proc:bash' });
});

test('portable skill frontmatter, bundled wrapper bytes and public text', () => {
  const text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  expect(text.match(/^---\n([\s\S]*?)\n---/)?.[1]).toMatch(/^name: google-workspace$/m);
  expect(text).toContain('bash scripts/gws-safe.sh');
  expect(text).toContain('gws auth login');
  expect(text).toContain('save an approved draft in Gmail');
  expect(text).toContain('create events after confirming their details');
  expect(text).toContain('ELANOUS_GWS_ALLOW_WRITE=1 bash scripts/gws-safe.sh');
  expect(text).toContain('wait for their explicit approval');
  expect(text).toContain('run the same command yourself');
  expect(text).toContain('If the user does not approve, do not execute the write.');
  expect(readFileSync(join(skillDir, 'scripts/gws-safe.sh')).equals(readFileSync(join(root, 'scripts/google/gws-safe.sh')))).toBe(true);
  for (const file of walk(skillDir)) {
    const bytes = readFileSync(file);
    for (const forbidden of ['/Users/', '<repo>', '$REPO']) expect(bytes.includes(Buffer.from(forbidden))).toBe(false);
  }
  expect(readFileSync(join(root, 'release/public/docs/plugins.md'), 'utf8')).toContain('Gmail and Calendar for your own account, plus Drive and Sheets reads (`google-workspace`)');
});

test('installed plugin registers the skill and its wrapper emits JSON after the keyring banner', async () => {
  const dir = temp();
  const pluginsDir = join(dir, 'plugins');
  const outDir = join(dir, 'market');
  const installedRoot = join(dir, 'installed');
  mkdirSync(join(pluginsDir, 'elanous-basics'), { recursive: true });
  writeFileSync(join(pluginsDir, 'elanous-basics', 'plugin.json'), readFileSync(join(packDir, 'plugin.json')));
  const pair = generateIndexKeyPair();
  const published = publishMarket({ pluginsDir, bundleRoot: root, outDir,
    market: { name: 'elanous', displayName: 'Elanous' }, key: pair,
  });
  expect(published.skipped).toEqual([]);
  expect(published.published).toHaveLength(1);
  expect(published.published).toContainEqual(expect.objectContaining({
    name: 'elanous-basics', version: '0.1.3', bundled: expect.arrayContaining(['google-workspace']),
  }));
  const index = JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8')) as {
    plugins: Array<{ name: string; artifact: { key: string } }>;
  };
  const artifact = index.plugins.find(entry => entry.name === 'elanous-basics')?.artifact;
  expect(artifact).toBeDefined();
  const archive = readFileSync(join(outDir, artifact!.key));
  expect(archive.length).toBeGreaterThan(0);
  expect(createHash('sha256').update(archive).digest('hex')).toBe(published.published[0]?.sha256);
  const events: InstallEvent[] = [];
  const fetchArtifact = (async (url: URL | RequestInfo) => {
    const path = new URL(String(url)).pathname.replace(/^\/elanous-plugins\//, '');
    return new Response(readFileSync(join(outDir, path)));
  }) as typeof fetch;
  const installed = await installPlugin('elanous-basics@elanous', {
    root: installedRoot, marketDir: join(dir, 'markets'), configPath: join(dir, 'empty-config.json'),
    trustedKeys: [{ keyId: pair.keyId, publicKey: pair.publicKey }],
    fetcher: fetchArtifact,
    yes: true, onEvent: event => events.push(event),
  });
  expect(events.find(event => event.event === 'resolve')).toMatchObject({ plugin: 'elanous-basics', version: '0.1.3', sha256: published.published[0]?.sha256 });
  const verify = events.find(event => event.event === 'verify');
  expect(verify).toMatchObject({ signature: 'ok' });
  expect(['safe', 'caution'].includes(String((verify as { scan?: string } | undefined)?.scan))).toBe(true);
  expect(installed.version).toBe('0.1.3');
  expect(installed.sha256).toBe(published.published[0]?.sha256);
  expect(listInstalledPlugins(installedRoot)).toContainEqual(installed);
  const security = inspectPluginSecurity(installed.path);
  expect(security.findings.filter(finding => !OFFICIAL_CAUTION_REASONS.has(finding.code))).toEqual([]);
  expect(acceptableOfficialScan(security)).toBe(true);
  expect(events.find(event => event.event === 'registered')).toMatchObject({ skills: expect.arrayContaining(['google-workspace']) });
  expect(readFileSync(join(installed.path, 'skills/google-workspace/SKILL.md'))).toEqual(readFileSync(join(skillDir, 'SKILL.md')));
  expect(readFileSync(join(installed.path, 'skills/google-workspace/scripts/gws-safe.sh'))).toEqual(readFileSync(join(root, 'scripts/google/gws-safe.sh')));

  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'gws'), `#!/usr/bin/env bash
if [ "$1" = "schema" ]; then
  if [ "$2" = "gmail.users.messages.send" ] || [ "$2" = "calendar.events.insert" ]; then
    echo '{"httpMethod":"POST"}'
  else
    echo '{"httpMethod":"GET"}'
  fi
else
  echo 'Using keyring backend: file'
  echo '{"ok":1}'
fi
`, { mode: 0o755 });
  const result = spawnSync('bash', ['scripts/gws-safe.sh', 'gmail', 'users', 'messages', 'list'], {
    cwd: join(installed.path, 'skills/google-workspace'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, ELANOUS_GWS_BIN: join(binDir, 'gws'), ELANOUS_GWS_ALLOW_WRITE: '' },
  });
  expect(result.status).toBe(0);
  expect(result.stdout.startsWith('{')).toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({ ok: 1 });
  const blocked = spawnSync('bash', ['scripts/gws-safe.sh', 'gmail', 'users', 'messages', 'send'], {
    cwd: join(installed.path, 'skills/google-workspace'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, ELANOUS_GWS_BIN: join(binDir, 'gws'), ELANOUS_GWS_ALLOW_WRITE: '' },
  });
  expect(blocked.status).toBe(4);
  expect(blocked.stdout).toBe('');
  const approved = spawnSync('bash', ['scripts/gws-safe.sh', 'calendar', 'events', 'insert', '--json', '{}'], {
    cwd: join(installed.path, 'skills/google-workspace'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, ELANOUS_GWS_BIN: join(binDir, 'gws'), ELANOUS_GWS_ALLOW_WRITE: '1' },
  });
  expect(approved.status).toBe(0);
  expect(JSON.parse(approved.stdout)).toEqual({ ok: 1 });
});
