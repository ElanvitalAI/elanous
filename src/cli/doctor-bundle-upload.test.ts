import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { uploadDoctorBundle } from './doctor-bundle-upload.js';
import { registerDoctorCommand } from './doctor-cli.js';
import { buildUserConfig, parseDiagnosticsConfig, saveUserConfig, type UserConfig } from '../user-config.js';

const root = mkdtempSync(join(tmpdir(), 'doctor-upload-'));
const path = join(root, 'temporary.tar.gz');
writeFileSync(path, 'bundle fixture');
let requests = 0;
let serverError = false;
const received: Buffer[] = [];
const events: string[] = [];
const server = Bun.serve({ port: 0, fetch: async (request) => {
  requests++;
  events.push('POST');
  expect(request.method).toBe('POST');
  expect(request.headers.get('content-type')).toBe('application/gzip');
  const body = Buffer.from(await request.arrayBuffer());
  received.push(body);
  expect(body.byteLength).toBeGreaterThan(0);
  if (serverError) return new Response('failure', { status: 500 });
  return Response.json({ code: 'DX-TEST-1' });
} });
const configuredUrl = 'https://diagnostics.example.test/upload';
const localFetch: typeof fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
  expect(String(url)).toBe(configuredUrl);
  return fetch(`http://127.0.0.1:${server.port}/`, init);
}) as typeof fetch;
afterAll(() => { server.stop(true); rmSync(root, { recursive: true, force: true }); });

describe('doctor bundle upload', () => {
  test('absent destination skips without asking or contacting the server', async () => {
    requests = 0;
    const result = await uploadDoctorBundle({ path, files: ['doctor.json'], confirm: async () => { throw Error('must not prompt'); }, fetch: localFetch });
    expect(result).toMatchObject({ uploaded: false, exitCode: 0, reason: 'no-recipient' });
    expect(result.message).toContain('수신처가 아직 정해지지 않았습니다');
    expect(result.message).toContain(path);
    expect(requests).toBe(0);
  });

  test('declined consent shows contents and size, sends zero requests', async () => {
    requests = 0;
    events.length = 0;
    const result = await uploadDoctorBundle({ path, files: ['doctor.json'], uploadUrl: configuredUrl,
      announce: (contents) => { expect(contents).toContain('doctor.json'); expect(contents).toContain('14 bytes'); events.push('inventory'); },
      confirm: async (message) => { expect(message).toContain('올릴까요? (y/N)'); events.push('prompt'); return false; }, fetch: localFetch });
    expect(events).toEqual(['inventory', 'prompt']);
    expect(result).toMatchObject({ uploaded: false, exitCode: 0, reason: 'consent-declined' });
    expect(requests).toBe(0);
  });

  test('unreadable bundle size is not reported as zero', async () => {
    requests = 0;
    let inventory = '';
    const result = await uploadDoctorBundle({ path: join(root, 'missing.tar.gz'), files: ['doctor.json'], uploadUrl: configuredUrl,
      announce: (contents) => { inventory = contents; }, confirm: async () => false, fetch: localFetch });
    expect(inventory).toContain('doctor.json');
    expect(inventory).toContain('크기 확인 불가');
    expect(inventory).not.toContain('0 bytes');
    expect(result).toMatchObject({ uploaded: false, exitCode: 0, reason: 'consent-declined' });
    expect(requests).toBe(0);
  });

  test('consent POSTs one archive and shows only the returned diagnostic code', async () => {
    requests = 0;
    received.length = 0;
    events.length = 0;
    const result = await uploadDoctorBundle({ path, files: ['doctor.json'], uploadUrl: configuredUrl,
      announce: (contents) => { expect(contents).toContain('doctor.json'); expect(contents).toContain('14 bytes'); events.push('inventory'); },
      confirm: async (message) => { expect(message).toContain('올릴까요? (y/N)'); events.push('prompt'); return true; }, fetch: localFetch });
    expect(events).toEqual(['inventory', 'prompt', 'POST']);
    expect(requests).toBe(1);
    expect(received[0]).toEqual(readFileSync(path));
    expect(result).toMatchObject({ uploaded: true, code: 'DX-TEST-1', exitCode: 0 });
    expect(result.message).toContain('진단 코드: DX-TEST-1');
    expect(result.message).not.toContain(configuredUrl);
  });

  test('--yes prints the inventory before POST without asking', async () => {
    requests = 0;
    events.length = 0;
    const result = await uploadDoctorBundle({ path, files: ['doctor.json'], uploadUrl: configuredUrl, yes: true,
      announce: (contents) => { expect(contents).toContain('doctor.json'); expect(contents).toContain('14 bytes'); events.push('inventory'); },
      confirm: async () => { throw Error('must not prompt'); }, fetch: localFetch });
    expect(events).toEqual(['inventory', 'POST']);
    expect(requests).toBe(1);
    expect(result).toMatchObject({ uploaded: true, code: 'DX-TEST-1', exitCode: 0 });
  });

  test('HTTP 500 fails, retains the local file path, and suggests retry', async () => {
    requests = 0;
    serverError = true;
    try {
      const result = await uploadDoctorBundle({ path, files: ['doctor.json'], uploadUrl: configuredUrl,
        confirm: async () => true, fetch: localFetch });
      expect(requests).toBe(1);
      expect(result).toMatchObject({ uploaded: false, exitCode: 1, reason: 'HTTP 500' });
      expect(result.message).toContain(path);
      expect(result.message).toContain('다시 시도');
    } finally { serverError = false; }
  });

  test('network errors and HTTP 4xx keep the archive and suggest retry', async () => {
    for (const [transport, reason] of [
      [async () => { throw new Error('sensitive network detail'); }, '네트워크 또는 파일 읽기 오류'],
      [async () => new Response('bad request', { status: 400 }), 'HTTP 400'],
    ] as const) {
      const result = await uploadDoctorBundle({ path, files: ['doctor.json'], uploadUrl: configuredUrl, yes: true,
        announce: () => {}, confirm: async () => { throw Error('must not prompt'); }, fetch: transport as unknown as typeof fetch });
      expect(result).toMatchObject({ uploaded: false, exitCode: 1, reason });
      expect(result.message).toContain(path);
      expect(result.message).toContain('다시 시도');
      expect(result.message).not.toContain('sensitive network detail');
    }
  });

  test('rejects insecure destinations and does not follow redirect to another receiver', async () => {
    requests = 0;
    const invalid = await uploadDoctorBundle({ path, files: [], uploadUrl: `http://127.0.0.1:${server.port}/`, yes: true,
      confirm: async () => true, fetch: localFetch });
    expect(invalid).toMatchObject({ uploaded: false, exitCode: 0, reason: 'invalid-recipient' });
    expect(requests).toBe(0);
    let redirects: RequestRedirect | undefined;
    const redirected = await uploadDoctorBundle({ path, files: [], uploadUrl: configuredUrl, yes: true,
      confirm: async () => true, fetch: (async (_url, init) => { redirects = init?.redirect; return Response.redirect('https://elsewhere.example.test/'); }) as typeof fetch });
    expect(redirects).toBe('manual');
    expect(redirected).toMatchObject({ uploaded: false, exitCode: 1, reason: 'HTTP 302' });
  });

  test('config is sparse, HTTPS-only, and survives save/load', () => {
    expect(parseDiagnosticsConfig({ uploadUrl: configuredUrl })).toEqual({ uploadUrl: configuredUrl });
    for (const value of ['', 'http://localhost/upload', 'https://user:pass@example.test/upload', 'file:///tmp/archive']) {
      expect(parseDiagnosticsConfig({ uploadUrl: value })).toBeUndefined();
    }
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, '{}');
    expect(buildUserConfig(configPath).diagnostics).toBeUndefined();
    writeFileSync(configPath, JSON.stringify({ diagnostics: { uploadUrl: configuredUrl } }));
    const config = buildUserConfig(configPath);
    expect(config.diagnostics?.uploadUrl).toBe(configuredUrl);
    saveUserConfig(config, configPath);
    expect(buildUserConfig(configPath).diagnostics?.uploadUrl).toBe(configuredUrl);
  });

  test('CLI reports config lookup failure rather than claiming the recipient is absent', async () => {
    requests = 0;
    const output: string[] = [];
    const errors: string[] = [];
    const codes: number[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      getUserConfig: () => { throw new Error('config lookup failed'); },
      readiness: { provider: 'auto' }, localLlmInventory: async () => ({ nodes: [], models: [], at: 0, cached: false, warnings: [] }),
      out: { log: (line) => output.push(line) }, err: { error: (line) => errors.push(line) },
      setExitCode: (code) => codes.push(code), uploadFetch: localFetch,
      confirmBundleUpload: async () => { throw Error('must not prompt'); },
    });
    await program.parseAsync(['doctor', '--bundle', '--upload', '--yes', '--json', '--out', join(root, 'config-failure')], { from: 'user' });
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ path: expect.stringContaining('config-failure'), uploaded: false, reason: '설정을 읽을 수 없습니다' });
    expect(output.at(-1)).not.toContain('수신처가 아직 정해지지 않았습니다');
    expect(errors).toEqual([]);
    expect(codes).toEqual([1]);
    await program.parseAsync(['doctor', '--bundle', '--upload', '--yes', '--out', join(root, 'config-failure-human')], { from: 'user' });
    expect(errors.at(-1)).toContain('설정을 읽을 수 없습니다');
    expect(errors.at(-1)).toContain('config-failure-human');
    expect(errors.at(-1)).toContain('다시 시도');
    expect(errors.at(-1)).not.toContain('수신처가 아직 정해지지 않았습니다');
    expect(codes).toEqual([1, 1]);
    expect(requests).toBe(0);
  });

  test('CLI requires --bundle, skips without config and emits structured success/failure', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const codes: number[] = [];
    const program = new Command();
    registerDoctorCommand(program, {
      userConfig: { registry: { discovery: { firecrawl: {} } } } as UserConfig,
      readiness: { provider: 'auto' }, localLlmInventory: async () => ({ nodes: [], models: [], at: 0, cached: false, warnings: [] }),
      out: { log: (line) => output.push(line) }, err: { error: (line) => errors.push(line) },
      setExitCode: (code) => codes.push(code), uploadFetch: localFetch,
    });
    await program.parseAsync(['doctor', '--upload'], { from: 'user' });
    expect(errors).toEqual(['--upload requires --bundle']);
    expect(codes).toEqual([1]);
    requests = 0;
    await program.parseAsync(['doctor', '--bundle', '--upload', '--yes', '--json', '--out', root], { from: 'user' });
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ uploaded: false, reason: 'no-recipient' });
    expect(requests).toBe(0);
    const successDir = join(root, 'cli-success');
    const success = new Command();
    const accepted: string[] = [];
    registerDoctorCommand(success, {
      userConfig: { registry: { discovery: { firecrawl: {} } }, diagnostics: { uploadUrl: configuredUrl } } as UserConfig,
      readiness: { provider: 'auto' }, localLlmInventory: async () => ({ nodes: [], models: [], at: 0, cached: false, warnings: [] }),
      out: { log: (line) => output.push(line) }, err: { error: (line) => { errors.push(line); events.push('inventory'); } },
      setExitCode: (code) => codes.push(code), uploadFetch: localFetch,
      confirmBundleUpload: async (message) => { accepted.push(message); events.push('prompt'); return true; },
    });
    received.length = 0;
    events.length = 0;
    await success.parseAsync(['doctor', '--bundle', '--upload', '--json', '--out', successDir], { from: 'user' });
    expect(events).toEqual(['inventory', 'prompt', 'POST']);
    expect(accepted[0]).toContain('올릴까요? (y/N)');
    expect(errors.at(-1)).toContain('내용 목록 (');
    expect(errors.at(-1)).toContain('doctor.json');
    expect(requests).toBe(1);
    const successResult = JSON.parse(output.at(-1)!) as { path: string; uploaded: boolean; code: string };
    expect(successResult).toEqual({ path: expect.stringContaining(successDir), uploaded: true, code: 'DX-TEST-1' });
    expect(received[0]).toEqual(readFileSync(successResult.path));
    events.length = 0;
    serverError = true;
    try {
      await success.parseAsync(['doctor', '--bundle', '--upload', '--yes', '--json', '--out', join(root, 'cli-failure')], { from: 'user' });
      expect(events).toEqual(['inventory', 'POST']);
      expect(requests).toBe(2);
      expect(errors.at(-1)).toContain('내용 목록 (');
      expect(errors.at(-1)).toContain('doctor.json');
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ uploaded: false, reason: 'HTTP 500', path: expect.stringContaining('cli-failure') });
      expect(codes).toEqual([1, 1]);
    } finally { serverError = false; }
  });
});
