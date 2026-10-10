import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { packDirDeterministic } from '../market/tgz.js';
import { generateIndexKeyPair, signIndex } from '../market/signed-index.js';
import { KgsSqliteStore } from '../knowledge/kgs/sqlite-store.js';
import { listInstalledPacks, queryInstalledPack } from '../knowledge/query.js';
import { runWizardStep } from '../graph-wizard/steps.js';
import { dispatchKnowledgeQuery } from '../knowledge/tools/knowledge-query.js';
import { knowledgeQueryRuntime } from '../tool-runtime/knowledge-runtimes.js';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { debug } from '../debug/log.js';
import { registerSkillsCommands } from '../cli/skills-cli.js';
import { installGiftPack, installMarketKnowledgePack } from './gift-install.js';
import { getUserConfig, reloadUserConfig, saveUserConfig } from '../user-config.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const email = 'secret-gift-email@example.invalid';
const bundle = (JSON.parse(readFileSync(join(import.meta.dir, '../../packs/elanous-essentials/plugin.json'), 'utf8')) as {
  extensions: { 'ai.elanous': { bundle: string[] } };
}).extensions['ai.elanous'].bundle;
const essentialNames = bundle.map((entry) => entry.replace(/^skills\//, ''));

function fixture(names = essentialNames) {
  const root = mkdtempSync(join(tmpdir(), 'gift-test-'));
  dirs.push(root);
  const zip = join(root, 'gift.zip');
  execFileSync('python3', ['-c', `import os, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    for name in sys.argv[3:]:
        skill = os.path.join(sys.argv[2], name)
        for base, dirs, files in os.walk(skill):
            dirs[:] = [d for d in dirs if d not in ('.venv', 'node_modules', '__pycache__')]
            for file in files:
                if file == '.env' or os.path.islink(os.path.join(base, file)):
                    continue
                path = os.path.join(base, file)
                archive.write(path, os.path.join('essential', os.path.relpath(path, sys.argv[2])))
`, zip, join(import.meta.dir, '../../skills'), ...names]);
  const bytes = readFileSync(zip);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const targets = [join(root, 'agents'), join(root, 'claude')];
  mkdirSync(join(targets[0]!, 'omni-digest'), { recursive: true });
  const old = Buffer.from('original skill bytes\n');
  writeFileSync(join(targets[0]!, 'omni-digest', 'SKILL.md'), old);
  return { root, bytes, sha256, targets, old };
}

test('local gift API: success, used-up, checksum mismatch and missing consent never leak email', async () => {
  const f = fixture();
  const logs: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { if (category === 'skills.gift') logs.push([category, event, data]); });
  let requests = 0;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({ port: 0, fetch(request): Response | Promise<Response> {
    requests++;
    const url = new URL(request.url);
    if (url.pathname === '/gift.zip') return new Response(f.bytes);
    if (url.pathname === '/api/gift') return (async () => {
      const body = await request.json() as Record<string, unknown>;
      expect(body).toMatchObject({ email, consent: true });
      if (body.code === 'used') return Response.json({ ok: false, reason: 'used-up' }, { status: 409 });
      return Response.json({ ok: true, pack: 'essential', installLine: 'elanous skills install essential',
        zipUrl: `http://127.0.0.1:${server.port}/gift.zip`, zipExpiresAt: new Date().toISOString(),
        sha256: body.code === 'bad' ? '0'.repeat(64) : f.sha256 });
    })();
    return new Response(null, { status: 404 });
  } });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const args = { pack: 'essential', email, agree: true, endpoint, targets: f.targets };
  try {
    const ok = await installGiftPack({ ...args, code: 'good-secret-suffix' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect([...ok.names].sort()).toEqual([...essentialNames].sort());
    expect(ok.paths).toHaveLength(essentialNames.length * f.targets.length);
    expect(readFileSync(join(f.targets[0]!, 'omni-digest', 'SKILL.md'))).toEqual(f.old);
    expect(readdirSync(f.targets[0]!)).toContain(`omni-digest.gift-${new Date().toISOString().slice(0, 10)}`);
    expect(existsSync(join(f.targets[0]!, 'omni-digest.gift-' + new Date().toISOString().slice(0, 10), 'SKILL.md'))).toBe(true);
    for (const target of f.targets) {
      for (const name of essentialNames) {
        const installed = target === f.targets[0] && name === 'omni-digest'
          ? join(target, `omni-digest.gift-${new Date().toISOString().slice(0, 10)}`, 'SKILL.md')
          : join(target, name, 'SKILL.md');
        expect(readFileSync(installed)).toEqual(readFileSync(join(import.meta.dir, '../../skills', name, 'SKILL.md')));
      }
    }
    expect(ok.message.split('\n').at(-1)).toBe(`설치한 스킬: ${essentialNames.join(', ')}`);
    const before = f.targets.map((target) => readdirSync(target).join(','));
    const used = await installGiftPack({ ...args, code: 'used' });
    expect(used).toMatchObject({ ok: false, reason: 'used-up' });
    expect(used.message).toContain('이미 다 쓴 코드');
    const bad = await installGiftPack({ ...args, code: 'bad' });
    expect(bad).toMatchObject({ ok: false, reason: 'checksum-mismatch' });
    expect(f.targets.map((target) => readdirSync(target).join(','))).toEqual(before);
    const count = requests;
    const missing = await installGiftPack({ ...args, code: 'good-secret-suffix', agree: false });
    expect(missing).toMatchObject({ ok: false, reason: 'consent-required' });
    expect(missing.message).toContain('보관');
    expect(requests).toBe(count);
    expect(JSON.stringify([ok, used, bad, missing, logs])).not.toContain(email);
    expect(logs.map((entry) => (entry as unknown[])[1])).toEqual(['installed', 'rejected', 'checksum-mismatch', 'rejected']);
    expect(logs.every((entry) => !JSON.stringify(entry).includes('good-secret-suffix'))).toBe(true);
  } finally {
    log.mockRestore();
    server.stop(true);
  }
});

test('gift API HTTP status selects 404, 409 and 410 guidance even without a matching reason body', async () => {
  const f = fixture();
  let requests = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    requests++;
    expect(new URL(request.url).pathname).toBe('/api/gift');
    const { code } = await request.json() as { code: string };
    if (code === '409') return Response.json({ ok: false, reason: 'not-the-contract-reason' }, { status: 409 });
    if (code === '410') return new Response('not JSON', { status: 410 });
    return Response.json(null, { status: 404 });
  } });
  try {
    for (const [status, reason, message] of [
      [404, 'unknown-code', '코드를 다시 확인해 주세요'],
      [409, 'used-up', '이미 다 쓴 코드'],
      [410, 'expired', '만료된 코드예요'],
    ] as const) {
      const result = await installGiftPack({ pack: 'essential', code: String(status), email, agree: true,
        endpoint: `http://127.0.0.1:${server.port}`, targets: f.targets });
      expect(result).toMatchObject({ ok: false, reason });
      expect(result.message).toContain(message);
      expect(JSON.stringify(result)).not.toContain(email);
    }
    expect(requests).toBe(3);
    expect(readdirSync(f.targets[0]!)).toEqual(['omni-digest']);
    expect(existsSync(f.targets[1]!)).toBe(false);
  } finally {
    server.stop(true);
  }
});

test('local gift API missing one GK1 skill refuses installation before copying', async () => {
  const f = fixture(essentialNames.filter((name) => name !== 'diagram-master'));
  let requests = 0;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({ port: 0, fetch(request): Response {
    requests++;
    if (new URL(request.url).pathname === '/gift.zip') return new Response(f.bytes);
    return Response.json({ ok: true, pack: 'essential', installLine: 'elanous skills install essential',
      zipUrl: `http://127.0.0.1:${server.port}/gift.zip`, zipExpiresAt: new Date().toISOString(), sha256: f.sha256 });
  } });
  try {
    const result = await installGiftPack({ pack: 'essential', code: 'missing', email, agree: true,
      endpoint: `http://127.0.0.1:${server.port}`, targets: f.targets });
    expect(requests).toBe(2);
    expect(result).toMatchObject({ ok: false, reason: 'invalid-pack' });
    expect(result.message).toContain('필수 스킬 다섯');
    expect(readdirSync(f.targets[0]!)).toEqual(['omni-digest']);
    expect(readFileSync(join(f.targets[0]!, 'omni-digest', 'SKILL.md'))).toEqual(f.old);
    expect(existsSync(f.targets[1]!)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(email);
  } finally { server.stop(true); }
});

test('verified essential zip containing only an unrelated skill refuses installation before copying', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gift-single-'));
  dirs.push(root);
  const skill = join(root, 'single-skill');
  mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), 'name: single-skill\n');
  const zip = join(root, 'single.zip');
  execFileSync('python3', ['-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z: z.write(sys.argv[2], "single-skill/SKILL.md")', zip, join(skill, 'SKILL.md')]);
  const bytes = readFileSync(zip);
  const target = join(root, 'target');
  const fetchImpl = (async (url: string) => url.endsWith('/api/gift')
    ? Response.json({ ok: true, pack: 'essential', zipUrl: 'https://example.invalid/single.zip',
      sha256: createHash('sha256').update(bytes).digest('hex') })
    : new Response(bytes)) as typeof fetch;
  const result = await installGiftPack({ pack: 'essential', code: 'single-code', email, agree: true, fetch: fetchImpl, targets: [target] });
  expect(result).toMatchObject({ ok: false, reason: 'invalid-pack' });
  expect(result.message).toContain('필수 스킬 다섯');
  expect(existsSync(target)).toBe(false);
});

test('verified pack with five folders but a missing SKILL.md refuses installation', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'gift-broken-'));
  dirs.push(root);
  const zip = join(root, 'broken.zip');
  execFileSync('python3', ['-c', `import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], 'w') as output:
    for entry in source.infolist():
        if entry.filename != 'essential/diagram-master/SKILL.md':
            output.writestr(entry, source.read(entry))
`, join(f.root, 'gift.zip'), zip]);
  const bytes = readFileSync(zip);
  const fetchImpl = (async (url: string) => url.endsWith('/api/gift')
    ? Response.json({ ok: true, pack: 'essential', zipUrl: 'https://example.invalid/broken.zip',
      sha256: createHash('sha256').update(bytes).digest('hex') })
    : new Response(bytes)) as typeof fetch;
  const result = await installGiftPack({ pack: 'essential', code: 'broken', email, agree: true,
    fetch: fetchImpl, targets: f.targets });
  expect(result).toMatchObject({ ok: false, reason: 'invalid-pack' });
  expect(readdirSync(f.targets[0]!)).toEqual(['omni-digest']);
  expect(readFileSync(join(f.targets[0]!, 'omni-digest', 'SKILL.md'))).toEqual(f.old);
  expect(existsSync(f.targets[1]!)).toBe(false);
});

test('a skill with .env.example prompts for keys from its guide', async () => {
  const f = fixture();
  const zip = join(f.root, 'keys.zip');
  execFileSync('python3', ['-c', `import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], 'w') as output:
    for entry in source.infolist():
        output.writestr(entry, source.read(entry))
    output.writestr('essential/youtube-master/.env.example', 'OPTIONAL_KEY=\\n')
`, join(f.root, 'gift.zip'), zip]);
  const bytes = readFileSync(zip);
  const fetchImpl = (async (url: string) => url.endsWith('/api/gift')
    ? Response.json({ ok: true, pack: 'essential', zipUrl: 'https://example.invalid/keys.zip',
      sha256: createHash('sha256').update(bytes).digest('hex') })
    : new Response(bytes)) as typeof fetch;
  const result = await installGiftPack({ pack: 'essential', code: 'keys', email, agree: true,
    fetch: fetchImpl, targets: [f.targets[1]!] });
  expect(result).toMatchObject({ ok: true, needsKeys: true });
  expect(result.message).toContain('키는 가이드대로');
  expect(existsSync(join(f.targets[1]!, 'youtube-master', '.env.example'))).toBe(true);
});

test('CLI sends consent and email to an explicit endpoint and reports used-up without leaking email', async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    requests.push([new URL(request.url).pathname, request.method, await request.json()]);
    return Response.json({ ok: false, reason: 'used-up' }, { status: 409 });
  } });
  const lines: string[] = [];
  const stdout = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const originalExit = process.exitCode;
  try {
    const program = new Command();
    registerSkillsCommands(program);
    await program.parseAsync(['skills', 'install', 'essential', '--code', 'ABCD-secret', '--email', email,
      '--agree', '--endpoint', `http://127.0.0.1:${server.port}`, '--json'], { from: 'user' });
    expect(requests).toEqual([['/api/gift', 'POST', { code: 'ABCD-secret', email, consent: true }]]);
    expect(process.exitCode).toBe(1);
    expect(lines.join(' ')).toContain('이미 다 쓴 코드');
    expect(lines.join(' ')).not.toContain(email);
  } finally {
    process.exitCode = originalExit ?? 0;
    stdout.mockRestore();
    server.stop(true);
  }
});

test('CLI market install branch rejects an unlisted knowledge pack without redeeming a gift', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gift-market-cli-'));
  dirs.push(root);
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ market: { markets: [{ name: 'sample', url: 'https://sample.example/market/' }] } }));
  const lines: string[] = [];
  const stdout = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const originalExit = process.exitCode;
  const previousConfig = process.env.ELANOUS_CONFIG_DIR;
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    const program = new Command();
    registerSkillsCommands(program);
    await program.parseAsync(['skills', 'install', 'not-in-market', '--market', 'sample', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(lines.join(''))).toMatchObject({ ok: false });
    expect(lines.join('')).not.toContain('email-required');
  } finally {
    process.exitCode = originalExit ?? 0;
    if (previousConfig === undefined) delete process.env.ELANOUS_CONFIG_DIR;
    else process.env.ELANOUS_CONFIG_DIR = previousConfig;
    stdout.mockRestore();
  }
});

test('skills.giftEndpoint defaults and survives a config save/reload', () => {
  const root = mkdtempSync(join(tmpdir(), 'gift-config-'));
  dirs.push(root);
  const path = join(root, 'config.json');
  const defaults = getUserConfig(path);
  expect(defaults.skills.giftEndpoint).toBe('https://elanous.ai');
  saveUserConfig({ ...defaults, skills: { ...defaults.skills, giftEndpoint: 'http://127.0.0.1:1234' } }, path);
  expect(reloadUserConfig(path).skills.giftEndpoint).toBe('http://127.0.0.1:1234');
});

test('email, unknown-code, expired and network failures are sanitized and do not install', async () => {
  const f = fixture();
  let calls = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls++;
    const code = (JSON.parse(String(init?.body)) as { code: string }).code;
    const reason = code === 'unknown' ? 'unknown-code' : 'expired';
    return Response.json({ ok: false, reason }, { status: code === 'unknown' ? 404 : 410 });
  }) as typeof fetch;
  const args = { pack: 'essential', code: 'unknown', email, agree: true, fetch: fetchImpl, targets: f.targets };
  const noEmail = await installGiftPack({ ...args, email: '' });
  expect(noEmail).toMatchObject({ ok: false, reason: 'email-required' });
  expect(noEmail.message).toContain('보관');
  expect(calls).toBe(0);
  expect((await installGiftPack(args)).message).toContain('코드를 다시 확인해 주세요');
  expect((await installGiftPack({ ...args, code: 'expired' })).message).toContain('만료된 코드예요');
  expect(calls).toBe(2);
  const offline = await installGiftPack({ ...args, fetch: (async () => { throw new Error(email); }) as unknown as typeof fetch });
  expect(offline).toMatchObject({ ok: false, reason: 'network-error' });
  expect(offline.message).toContain('다시 시도');
  expect(JSON.stringify([noEmail, offline])).not.toContain(email);
  expect(existsSync(f.targets[1]!)).toBe(false);
});

test('a second target failure rolls back every new skill while preserving pre-existing bytes', async () => {
  const f = fixture();
  const blocked = join(f.root, 'blocked-target');
  writeFileSync(blocked, 'not a directory');
  const fetchImpl = (async (url: string) => url.endsWith('/api/gift')
    ? Response.json({ ok: true, pack: 'essential', zipUrl: 'https://example.invalid/gift.zip', sha256: f.sha256 })
    : new Response(f.bytes)) as typeof fetch;
  const result = await installGiftPack({ pack: 'essential', code: 'ABCD-secret', email, agree: true,
    fetch: fetchImpl, targets: [f.targets[0]!, blocked] });
  expect(result).toMatchObject({ ok: false, reason: 'invalid-pack' });
  expect(result.message).toContain('설치하지 않았습니다');
  expect(readdirSync(f.targets[0]!)).toEqual(['omni-digest']);
  expect(readFileSync(join(f.targets[0]!, 'omni-digest', 'SKILL.md'))).toEqual(f.old);
  expect(readFileSync(blocked, 'utf8')).toBe('not a directory');
  expect(JSON.stringify(result)).not.toContain(email);
});

test('CLI handles a successful HTTP response with JSON null as invalid-response', async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(null) });
  const lines: string[] = [];
  const stdout = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const originalExit = process.exitCode;
  try {
    const program = new Command();
    registerSkillsCommands(program);
    await program.parseAsync(['skills', 'install', 'essential', '--code', 'ABCD-secret', '--email', email,
      '--agree', '--endpoint', `http://127.0.0.1:${server.port}`, '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(lines.join(''))).toMatchObject({ ok: false, reason: 'invalid-response' });
    expect(lines.join(' ')).not.toContain(email);
  } finally {
    process.exitCode = originalExit ?? 0;
    stdout.mockRestore();
    server.stop(true);
  }
});

test('CLI refuses an unconsented gift without an API request or email in output', async () => {
  const program = new Command();
  registerSkillsCommands(program);
  const lines: string[] = [];
  const stdout = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const request = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('network must not be called'); }) as unknown as typeof fetch);
  const originalExit = process.exitCode;
  try {
    await program.parseAsync(['skills', 'install', 'essential', '--code', 'ABCD-secret', '--email', email, '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(request).not.toHaveBeenCalled();
    expect(lines.join(' ')).toContain('보관');
    expect(lines.join(' ')).not.toContain(email);
  } finally {
    process.exitCode = originalExit ?? 0;
    request.mockRestore();
    stdout.mockRestore();
  }
});

function fakeGiftFetch(zipBytes: Buffer, sha256: string, zipHeaders: Record<string, string> = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/gift')) {
      return Response.json({ ok: true, pack: 'essential', installLine: 'x', zipUrl: 'http://gift.invalid/gift.zip', zipExpiresAt: new Date().toISOString(), sha256 });
    }
    return new Response(new Blob([new Uint8Array(zipBytes)]), { headers: zipHeaders });
  }) as typeof fetch;
}

function zipOf(build: string): { bytes: Buffer; sha256: string } {
  const root = mkdtempSync(join(tmpdir(), 'gift-cap-'));
  dirs.push(root);
  const zip = join(root, 'g.zip');
  execFileSync('python3', ['-c', build, zip, ...essentialNames]);
  const bytes = readFileSync(zip);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('a zip whose SKILL.md entries are directories installs nothing', async () => {
  const z = zipOf(`import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as a:
    for name in sys.argv[2:]:
        a.writestr(name + '/SKILL.md/', '')
        a.writestr(name + '/SKILL.md/x.txt', 'not a skill')
`);
  const root = mkdtempSync(join(tmpdir(), 'gift-dir-'));
  dirs.push(root);
  const targets = [join(root, 'agents')];
  const r = await installGiftPack({ pack: 'essential', code: 'CODE-1', email, agree: true, endpoint: 'http://gift.invalid', fetch: fakeGiftFetch(z.bytes, z.sha256), targets });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe('invalid-pack');
  expect(existsSync(targets[0]!) ? readdirSync(targets[0]!) : []).toEqual([]);
});

test('download and unpack caps reject before anything is installed', async () => {
  const z = zipOf(`import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as a:
    for name in sys.argv[2:]:
        a.writestr(name + '/SKILL.md', '# ' + name + '\\n' + 'x' * 200000)
`);
  const root = mkdtempSync(join(tmpdir(), 'gift-cap2-'));
  dirs.push(root);
  const targets = [join(root, 'agents')];
  const base = { pack: 'essential', code: 'CODE-2', email, agree: true, endpoint: 'http://gift.invalid', targets };
  // Declared Content-Length over the cap.
  const declared = await installGiftPack({ ...base, fetch: fakeGiftFetch(z.bytes, z.sha256, { 'content-length': String(50 * 1024 * 1024) }) });
  expect(declared.ok === false && declared.reason).toBe('too-large');
  // Received bytes over a small download cap.
  const received = await installGiftPack({ ...base, maxDownloadBytes: 100, fetch: fakeGiftFetch(z.bytes, z.sha256) });
  expect(received.ok === false && received.reason).toBe('too-large');
  // Small compressed zip, but its unpacked total (5 × ~200KB) is over the unpack cap.
  const unpacked = await installGiftPack({ ...base, maxUnpackedBytes: 300_000, fetch: fakeGiftFetch(z.bytes, z.sha256) });
  expect(unpacked.ok === false && unpacked.reason).toBe('too-large');
  // Entry count cap.
  const entries = await installGiftPack({ ...base, maxEntries: 2, fetch: fakeGiftFetch(z.bytes, z.sha256) });
  expect(entries.ok === false && entries.reason).toBe('too-large');
  expect(existsSync(targets[0]!) ? readdirSync(targets[0]!) : []).toEqual([]);
  // Within the caps the same zip installs.
  const ok = await installGiftPack({ ...base, fetch: fakeGiftFetch(z.bytes, z.sha256) });
  expect(ok.ok).toBe(true);
});

test('internal market sample download requires enterprise-bound signing key and tenant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-internal-'));
  dirs.push(root);
  const keys = generateIndexKeyPair();
  const source = join(import.meta.dir, '../../packs/b2b-sales-public');
  const stage = join(root, 'b2b-sales-public');
  cpSync(source, stage, { recursive: true });
  const manifestPath = join(stage, 'knowledge-pack.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { signature: { keyId: string }; visibility: string };
  manifest.signature.keyId = keys.keyId;
  manifest.visibility = 'internal';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const archive = packDirDeterministic(stage);
  const index = Buffer.from(JSON.stringify({ name: 'private', interface: { displayName: 'Private' }, sequence: 1, plugins: [],
    knowledgePacks: [{ name: 'b2b-sales-public', version: '0.1.0', visibility: 'internal', enterpriseId: 'tenant-a',
      artifact: { sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length, key: 'sales.tgz' } }] }));
  const signature = signIndex(index, keys.privateKeyPem, keys.keyId);
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ market: { internalMarkets: [{ name: 'private',
    url: 'https://private.example/market/', enterpriseIds: ['tenant-a'], trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] }] } }));
  const fetcher = (async (url: string) => {
    const path = new URL(url).pathname.split('/').at(-1);
    if (path === 'marketplace.json') return new Response(index);
    if (path === 'index.sig') return new Response(signature);
    return path === 'sales.tgz' ? new Response(new Uint8Array(archive)) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const store = new KgsSqliteStore(':memory:');
  try {
    const input = { pack: 'b2b-sales-public', market: 'private', marketOptions: { configPath, root, fetcher }, fetch: fetcher, store };
    expect(await installMarketKnowledgePack({ ...input, enterpriseId: 'tenant-b' })).toMatchObject({ ok: false, reason: 'knowledge-pack-install-failed' });
    expect(await installMarketKnowledgePack(input)).toMatchObject({ ok: false, reason: 'knowledge-pack-install-failed' });
    expect(store.readPack('b2b-sales-public', '0.1.0')).toBeNull();
    expect(await installMarketKnowledgePack({ ...input, enterpriseId: 'tenant-a' }))
      .toMatchObject({ ok: true, packId: 'pack:b2b-sales-public@0.1.0' });
    expect(queryInstalledPack('pack:b2b-sales-public@0.1.0', 'CARD1', store)[0]?.ref)
      .toContain('pack:b2b-sales-public@0.1.0#');
  } finally { store.close(); }
});

test('two signed market sample packs install into the knowledge store and chat/graph retrieval cite both', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-market-'));
  dirs.push(root);
  const key = generateIndexKeyPair();
  const packs = ['semiconductor-process-public', 'b2b-sales-public'] as const;
  const artifacts = new Map<string, Uint8Array>();
  const entries = packs.map(name => {
    const source = join(import.meta.dir, '../../packs', name);
    const stage = join(root, name);
    cpSync(source, stage, { recursive: true });
    const manifestPath = join(stage, 'knowledge-pack.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { signature: { keyId: string }; version: string; description: string; content: Array<{ path: string }> };
    manifest.signature.keyId = key.keyId;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    for (const content of manifest.content) expect(existsSync(join(stage, content.path))).toBe(true);
    const archive = packDirDeterministic(stage);
    artifacts.set(`${name}.tgz`, archive);
    return { name, version: manifest.version, description: manifest.description, visibility: 'public' as const,
      artifact: { sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length, key: `${name}.tgz` } };
  });
  const index = Buffer.from(JSON.stringify({ name: 'sample', interface: { displayName: 'Sample' }, sequence: 1, plugins: [], knowledgePacks: entries }));
  const signature = signIndex(index, key.privateKeyPem, key.keyId);
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ market: { markets: [{ name: 'sample', url: 'https://sample.example/market/' }],
    trustedKeys: [{ keyId: key.keyId, publicKey: key.publicKey }] } }));
  const fetcher = (async (url: string) => {
    const path = new URL(url).pathname.split('/').at(-1)!;
    if (path === 'marketplace.json') return new Response(index);
    if (path === 'index.sig') return new Response(signature);
    const archive = artifacts.get(path);
    return archive ? new Response(new Uint8Array(archive)) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const graphDb = join(root, 'kgs.db');
  const store = new KgsSqliteStore(graphDb);
  try {
    const options = { market: 'sample', marketOptions: { configPath, root, fetcher }, fetch: fetcher, store };
    const rejected = await installMarketKnowledgePack({ ...options, pack: 'not-in-market' });
    expect(rejected).toMatchObject({ ok: false, reason: 'pack-not-in-verified-market' });
    expect(store.readPack(packs[0], '0.1.0')).toBeNull();
    const original = artifacts.get(`${packs[0]}.tgz`)!;
    artifacts.set(`${packs[0]}.tgz`, Buffer.from('tampered'));
    expect(await installMarketKnowledgePack({ ...options, pack: packs[0] })).toMatchObject({ ok: false, reason: 'artifact-mismatch' });
    expect(store.readPack(packs[0], '0.1.0')).toBeNull();
    artifacts.set(`${packs[0]}.tgz`, original);
    const mismatched = join(root, packs[0]);
    const manifestPath = join(mismatched, 'knowledge-pack.json');
    const correctManifest = readFileSync(manifestPath);
    const forged = JSON.parse(correctManifest.toString()) as { signature: { keyId: string } };
    forged.signature.keyId = 'deadbeef';
    writeFileSync(manifestPath, JSON.stringify(forged));
    const forgedArchive = packDirDeterministic(mismatched);
    const firstEntry = entries[0]!;
    const correctArtifact = { ...firstEntry.artifact };
    firstEntry.artifact = { ...firstEntry.artifact, sha256: createHash('sha256').update(forgedArchive).digest('hex'), bytes: forgedArchive.length };
    artifacts.set(`${packs[0]}.tgz`, forgedArchive);
    const forgedIndex = Buffer.from(JSON.stringify({ name: 'sample', interface: { displayName: 'Sample' }, sequence: 2, plugins: [], knowledgePacks: entries }));
    const forgedSignature = signIndex(forgedIndex, key.privateKeyPem, key.keyId);
    // A signed artifact with the wrong manifest key must still be rejected.
    const forgedFetch = (async (url: string) => {
      const path = new URL(url).pathname.split('/').at(-1)!;
      if (path === 'marketplace.json') return new Response(forgedIndex);
      if (path === 'index.sig') return new Response(forgedSignature);
      const archive = artifacts.get(path);
      return archive ? new Response(new Uint8Array(archive)) : new Response(null, { status: 404 });
    }) as typeof fetch;
    expect(await installMarketKnowledgePack({ ...options, pack: packs[0], marketOptions: { ...options.marketOptions, fetcher: forgedFetch, refresh: true } }))
      .toMatchObject({ ok: false, reason: 'invalid-manifest' });
    expect(store.readPack(packs[0], '0.1.0')).toBeNull();
    writeFileSync(manifestPath, correctManifest);
    firstEntry.artifact = correctArtifact;
    artifacts.set(`${packs[0]}.tgz`, original);
    const restoredIndex = Buffer.from(JSON.stringify({ name: 'sample', interface: { displayName: 'Sample' }, sequence: 3, plugins: [], knowledgePacks: entries }));
    const restoredSignature = signIndex(restoredIndex, key.privateKeyPem, key.keyId);
    const restoredFetch = (async (url: string) => {
      const path = new URL(url).pathname.split('/').at(-1)!;
      if (path === 'marketplace.json') return new Response(restoredIndex);
      if (path === 'index.sig') return new Response(restoredSignature);
      const archive = artifacts.get(path);
      return archive ? new Response(new Uint8Array(archive)) : new Response(null, { status: 404 });
    }) as typeof fetch;
    for (const name of packs) {
      expect(() => queryInstalledPack(`pack:${name}@0.1.0`, '식각', store)).toThrow('pack not installed');
      const result = await installMarketKnowledgePack({ ...options, marketOptions: { ...options.marketOptions, fetcher: restoredFetch, refresh: true }, pack: name });
      expect(result).toMatchObject({ ok: true, packId: `pack:${name}@0.1.0` });
      if (result.ok) expect(result.citations).toContain(`pack:${name}@0.1.0#${name === packs[0] ? 'content/questions.md' : 'content/playbook.md'}`);
    }
    expect(listInstalledPacks(store).map(item => item.id).sort()).toEqual(packs.map(name => `pack:${name}@0.1.0`).sort());
    expect(store.readPack('not-in-market', '0.1.0')).toBeNull();
    for (const name of packs) {
      const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../packs', name, 'knowledge-pack.json'), 'utf8')) as {
        distribution: { internalMarketDownload: string }; sale: { targetDate: string; pricing: { model: string } };
      };
      expect(manifest.distribution.internalMarketDownload).toContain('enterprise-signed index');
      expect(manifest.sale).toMatchObject({ targetDate: '2026-10-28', pricing: { model: 'free' } });
    }
    expect(JSON.parse(readFileSync(join(import.meta.dir, '../../packs', packs[0], 'knowledge-pack.json'), 'utf8')).sale.paid)
      .toBe('not-enabled-pending-merchant-payment-terms-approval');
    expect(readFileSync(join(import.meta.dir, '../../packs', packs[0], 'content/process-overview.md'), 'utf8'))
      .toContain('https://www.semi.org/en/products-services/standards');
    expect(JSON.parse(readFileSync(join(import.meta.dir, '../../packs', packs[1], 'knowledge-pack.json'), 'utf8')).distribution)
      .toMatchObject({ standalone: true, pluginCombination: true });
    const semiconductor = queryInstalledPack(`pack:${packs[0]}@0.1.0`, '식각', store);
    const sales = queryInstalledPack(`pack:${packs[1]}@0.1.0`, 'CARD1', store);
    expect(semiconductor.some(hit => hit.ref.includes('#content/questions.md') && hit.body.includes('[S4]'))).toBe(true);
    expect(sales.some(hit => hit.ref.includes('#content/playbook.md') && hit.body.includes('CS1'))).toBe(true);
    const chat = (id: string, question: string) => dispatchKnowledgeQuery({ pack_id: id, question },
      { searchPack: (packId, query) => queryInstalledPack(packId, query, store) });
    for (const [id, question] of [[packs[0], '식각'], [packs[1], 'CARD1']] as const) {
      const answer = await chat(`pack:${id}@0.1.0`, question);
      expect(answer.output).toContain(`[pack:${id}@0.1.0#content/`);
      expect(answer.pack_hits?.some(hit => hit.body.includes(question))).toBe(true);
    }
    expect((await chat('pack:missing-sample@0.1.0', '식각')).pack_hits).toEqual([]);
    const vaultResult = await dispatchKnowledgeQuery({ fulltext: 'no-such-sample-word' }, {
      vault: { root, label: 'sample-test', isSimulated: false } });
    expect(vaultResult.pack_hits).toBeUndefined();
    expect(vaultResult.output).toContain('vault=sample-test');
    // Chat's registered runtime and the graph step both read the installed-store path.
    const { setKgsDbPathOverride, _resetKgsStoreSingleton } = await import('../knowledge/kgs/sqlite-store.js');
    try {
      _resetKgsStoreSingleton();
      setKgsDbPathOverride(graphDb);
      for (const [id, query] of [[packs[0], '식각'], [packs[1], 'CARD1']] as const) {
        const runtime = await knowledgeQueryRuntime.run({ pack_id: `pack:${id}@0.1.0`, question: query }, { surface: 'dashboard' });
        expect(runtime.output).toContain(`[pack:${id}@0.1.0#content/`);
        const graph = runWizardStep('knowledge-rag', `pack:${id}@0.1.0`, { input: { query } });
        expect(graph.outcome).toBe('ok');
        expect(graph.text).toContain(`[pack:${id}@0.1.0#content/`);
      }
    } finally { _resetKgsStoreSingleton(); setKgsDbPathOverride(null); }
  } finally { store.close(); }
});
