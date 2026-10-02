import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { LogStore } from '../mss/logging/log-store.js';
import { buildDoctorBundle, redactForBundle } from './doctor-bundle.js';
import { registerDoctorCommand, runDoctor } from './doctor-cli.js';
import type { UserConfig } from '../user-config.js';

const now = new Date('2026-10-01T12:34:56.000Z');
const report = { ok: true, credentials: [{ name: 'BOT_TOKEN', resolved: false, source: 'unresolved' as const, note: 'not configured' }], externalCommands: [] };

function unpack(path: string, root: string): Record<string, string> {
  const extracted = join(root, 'extracted');
  mkdirSync(extracted);
  const result = spawnSync('tar', ['-xzf', path, '-C', extracted], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  const files: Record<string, string> = {};
  for (const name of ['summary.json', 'doctor.json', 'config.redacted.json', 'credentials.json', 'logs-recent.jsonl', 'onboarding.json']) {
    try { files[name] = readFileSync(join(extracted, name), 'utf8'); } catch { /* optional onboarding */ }
  }
  return files;
}

describe('doctor diagnostics bundle', () => {
  test('redacts named fields and embedded token shapes recursively', () => {
    expect(redactForBundle({ nested: { botToken: '123:abc', apiKey: 'sk-abcdef', password: 'password' },
      text: 'Bearer eyJabc.def.ghi ghp_abcdef ghs_abcdef xoxb-abcdef sk-abcdef eyJabc.def.ghi /Users/alice/work' }, '/Users/alice'))
      .toEqual({ nested: { botToken: '<redacted>', apiKey: '<redacted>', password: '<redacted>' },
        text: 'Bearer <redacted> <redacted> <redacted> <redacted> <redacted> <redacted> ~/work' });
  });

  test('real archive has redacted config, logs, onboarding, doctor, universe and metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-bundle-'));
    const home = join(root, 'Users', 'someone');
    const configDir = join(home, '.elanous');
    mkdirSync(join(configDir, 'logs'), { recursive: true });
    const secret = '123:abc';
    const bearer = 'Bearer eyJabcdef.eyJabcdef.abcdef';
    const basic = 'Authorization: Basic dXNlcjpwYXNz';
    const githubPat = 'github_pat_11AABBccDD_abcdef1234567890';
    const cookie = 'Cookie: session=abc123secret';
    const setCookie = 'Set-Cookie: sid=zzz999secret; Path=/';
    const urlCreds = 'https://user:hunter2pass@registry.example.com/x';
    const otherTokens = 'gho_ABCDEFGH12345678 AKIAABCDEFGHIJKLMNOP';
    const old = new Date(now.getTime() - 86_400_001).toISOString();
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ botToken: secret, misc: `installed at ${home}/bin`, diagnostic: `${basic} ${githubPat}` }));
    writeFileSync(join(configDir, 'onboarding.json'), JSON.stringify({ step: 2, accessToken: secret }));
    const dbPath = join(configDir, 'logs', 'logs.db');
    const store = new LogStore(dbPath);
    try {
      store.insertBatch([
        { surface: 'tui', rec: { ts: old, level: 'error', category: 'setup', event: 'old', data: 'older than one day' } },
        ...Array.from({ length: 497 }, (_, i) => ({ surface: 'tui', rec: { ts: now.toISOString(), level: 'info' as const, category: 'setup', event: 'sample', data: { index: i } } })),
        { surface: 'tui', rec: { ts: now.toISOString(), level: 'error', category: 'setup', event: 'structured', data: { botToken: secret, reason: 'expired' } } },
        { surface: 'tui', rec: { ts: now.toISOString(), level: 'error', category: 'setup', event: 'failed', data: `${bearer} ${basic} ${githubPat} botToken=${secret} ${home}/bin` } },
        { surface: 'tui', rec: { ts: now.toISOString(), level: 'error', category: 'setup', event: 'cookies', data: `${otherTokens} fetch ${urlCreds}\n${cookie}\n${setCookie}` } },
      ]);
    } finally { store.close(); }
    try {
      const previousUmask = process.umask(0o022);
      let bundle;
      try {
        bundle = buildDoctorBundle({ outDir: root, now, home, configDir, logDbPath: dbPath, doctorReport: report });
      } finally {
        process.umask(previousUmask);
      }
      expect(bundle.path).toBe(join(root, 'elanous-diagnostics-20261001-123456.tar.gz'));
      expect(bundle.files).toEqual(['summary.json', 'doctor.json', 'config.redacted.json', 'credentials.json', 'logs-recent.jsonl', 'onboarding.json']);
      expect(bundle.bytes).toBeGreaterThan(0);
      expect(statSync(bundle.path).mode & 0o777).toBe(0o600);
      const files = unpack(bundle.path, root);
      const contents = Object.values(files).join('\n');
      expect(contents).not.toContain(secret);
      expect(contents).not.toContain(bearer);
      expect(contents).not.toContain(basic);
      expect(contents).not.toContain('dXNlcjpwYXNz');
      expect(contents).not.toContain(githubPat);
      expect(contents).not.toContain(home);
      for (const leak of ['abc123secret', 'zzz999secret', 'hunter2pass', 'gho_ABCDEFGH12345678', 'AKIAABCDEFGHIJKLMNOP']) expect(contents).not.toContain(leak);
      expect(files['logs-recent.jsonl']).toContain('registry.example.com');
      expect(files['logs-recent.jsonl']).toContain('setup');
      expect(files['logs-recent.jsonl']).not.toContain('older than one day');
      expect(files['logs-recent.jsonl']!.trim().split('\n')).toHaveLength(500);
      expect(files['logs-recent.jsonl']).toContain('Bearer <redacted>');
      expect(files['logs-recent.jsonl']).toContain('Authorization: <redacted>');
      expect(files['config.redacted.json']).toContain('Authorization: <redacted>');
      expect(JSON.parse(JSON.parse(files['logs-recent.jsonl']!.split('\n').find((line) => line.includes('structured'))!).data)).toEqual({ botToken: '<redacted>', reason: 'expired' });
      expect(JSON.parse(files['config.redacted.json']!)).toEqual({ botToken: '<redacted>', misc: 'installed at ~/bin', diagnostic: 'Authorization: <redacted>' });
      expect(JSON.parse(files['onboarding.json']!)).toEqual({ step: 2, accessToken: '<redacted>' });
      expect(JSON.parse(files['summary.json']!)).toMatchObject({
        version: expect.any(String), sha: expect.any(String), os: expect.any(String), arch: expect.any(String),
        node: expect.any(String), installPath: expect.any(String), createdAt: now.toISOString(), logs: 'ok',
        universe: { kind: expect.any(String), root: expect.any(String) },
      });
      expect(JSON.parse(files['doctor.json']!)).toEqual(report);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('empty HOME and missing log store still create the bundle without credential values', () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-empty-'));
    try {
      const doctorOptions = {
        repositoryRoot: process.cwd(), env: {}, cacheDir: join(root, 'empty-cache'), tavilyEnvFile: join(root, 'missing'),
        userConfig: { registry: { discovery: { firecrawl: {} } } } as UserConfig,
        readiness: { provider: 'auto' as const }, commandExists: () => false,
      };
      const doctor = runDoctor(doctorOptions);
      expect(doctor.ok).toBe(true);
      expect(doctor.credentials.length).toBeGreaterThan(0);
      expect(doctor.credentials.every(({ resolved }) => !resolved)).toBe(true);
      const bundle = buildDoctorBundle({ outDir: root, now, home: root, configDir: join(root, '.elanous'), logDbPath: join(root, 'missing.db'), doctorReport: doctor });
      const files = unpack(bundle.path, root);
      expect(files['logs-recent.jsonl']).toBe('');
      expect(JSON.parse(files['summary.json']!).logs).toBe('no-store');
      expect(JSON.parse(files['credentials.json']!).every((entry: { present: boolean; source: string }) => !entry.present && entry.source === 'unresolved')).toBe(true);
      expect(files['onboarding.json']).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('CLI --bundle --out --json prints path, files, bytes; ordinary doctor JSON and exit code remain identical', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-cli-bundle-'));
    try {
      const output: string[] = [];
      const codes: number[] = [];
      const program = new Command();
      const deps = {
        repositoryRoot: process.cwd(), env: {}, cacheDir: join(root, 'cache'),
        userConfig: { registry: { discovery: { firecrawl: {} } } } as UserConfig,
        readiness: { provider: 'auto' as const }, commandExists: () => false,
        // The machine's real local LLM servers must not make two doctor runs differ.
        localLlmInventory: async () => ({ nodes: [], models: [], at: 0, cached: false, warnings: [] }),
        out: { log: (text: string) => output.push(text) }, setExitCode: (code: number) => codes.push(code),
      };
      registerDoctorCommand(program, deps);
      await program.parseAsync(['doctor', '--json'], { from: 'user' });
      const original = JSON.parse(output.at(-1)!);
      await program.parseAsync(['doctor', '--bundle', '--out', root, '--json'], { from: 'user' });
      const bundled = JSON.parse(output.at(-1)!);
      expect(Object.keys(bundled)).toEqual(['path', 'files', 'bytes']);
      expect(bundled.files).toContain('doctor.json');
      expect(JSON.parse(unpack(bundled.path, root)['doctor.json']!)).toEqual(original);
      await program.parseAsync(['doctor', '--bundle', '--out', join(root, 'human')], { from: 'user' });
      expect(output.at(-1)).toContain('Contents:\n  summary.json\n  doctor.json');
      expect(output.at(-1)).toContain(join(root, 'human', 'elanous-diagnostics-'));
      await program.parseAsync(['doctor', '--json'], { from: 'user' });
      expect(JSON.parse(output.at(-1)!)).toEqual(original);
      expect(codes).toEqual([1, 1]); // Missing required commands retain the ordinary doctor exit code; bundle does not add one.
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
