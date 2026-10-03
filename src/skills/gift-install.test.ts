import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { debug } from '../debug/log.js';
import { registerSkillsCommands } from '../cli/skills-cli.js';
import { installGiftPack } from './gift-install.js';
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
