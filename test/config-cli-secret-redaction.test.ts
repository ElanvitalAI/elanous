import { setDefaultTimeout, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../src/mss/logging/log-store.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

let configDir: string;
let runDir: string;
let stateDir: string;
const REPO_ROOT = join(import.meta.dir, '..');
const ENTRY = join(REPO_ROOT, 'src/index.ts');
const API_KEY = `sk-ant-api03-${'a'.repeat(93)}AA`;
const EMBEDDED_TOKEN = `token=${API_KEY}`;

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[\d?;<>=]*[a-zA-Z]/g, '');
}

function runConfigGet(args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync('bun', [ENTRY, '--config-dir', configDir, 'config', 'get', ...args], {
    cwd: runDir,
    env: { ...process.env, NODE_ENV: 'development', ELANOUS_STATE_DIR: stateDir, ELANOUS_SUPPRESS_XDG_WARNING: '1' },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return {
    stdout: stripAnsi(result.stdout ?? ''),
    stderr: stripAnsi(result.stderr ?? ''),
    code: result.status ?? -1,
  };
}

function revealAuditRows() {
  return [configDir, stateDir].flatMap((root) => new LogStore(join(root, 'logs', 'logs.db'))
    .query({ exactCategories: ['config.get'], events: ['reveal'], surfaces: ['config-cli'] }));
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'config-cli-secret-redaction-'));
  runDir = mkdtempSync(join(tmpdir(), 'config-cli-secret-redaction-run-'));
  stateDir = mkdtempSync(join(tmpdir(), 'config-cli-secret-redaction-state-'));
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    version: 1,
    tabs: {},
    llm: { provider: 'anthropic', apiKey: API_KEY },
    custom: { embedded: EMBEDDED_TOKEN, ordinary: 'plain-value', [API_KEY]: 'secret-path-value' },
  }));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('elanous config get secret redaction', () => {
  test('help exposes the opt-in reveal flag', () => {
    const result = spawnSync('bun', [ENTRY, 'config', 'get', '--help'], {
      cwd: runDir,
      env: { ...process.env, NODE_ENV: 'development', ELANOUS_STATE_DIR: stateDir, ELANOUS_SUPPRESS_XDG_WARNING: '1' },
      encoding: 'utf-8',
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    expect(stripAnsi(result.stdout ?? '')).toContain('--reveal');
  });

  test('default full-config output applies key and embedded-text redaction without changing the stored file', () => {
    const result = runConfigGet([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"apiKey": "sk-a…aaAA"');
    expect(result.stdout).toContain('token=***');
    expect(result.stdout).not.toContain(API_KEY);
    expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toContain(API_KEY);
  });

  test('default targeted secret primitive is redacted while an ordinary string remains unquoted', () => {
    const secret = runConfigGet(['llm.apiKey']);
    const ordinary = runConfigGet(['custom.ordinary']);
    expect(secret.code).toBe(0);
    expect(secret.stdout.trim()).toBe('sk-a…aaAA');
    expect(secret.stdout).not.toContain(API_KEY);
    expect(ordinary.code).toBe(0);
    expect(ordinary.stdout.trim()).toBe('plain-value');
  });

  test('default targeted text-pattern value is redacted', () => {
    const result = runConfigGet(['custom.embedded']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('token=***');
    expect(result.stdout).not.toContain(API_KEY);
  });

  test('missing paths retain the error and exit-1 contract', () => {
    const result = runConfigGet(['llm.missing']);
    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('config path not found');
  });

  test('explicit reveal prints the actual value and records a secret-free audit event in logs.db', () => {
    const result = runConfigGet(['llm.apiKey', '--reveal']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(API_KEY);

    const audit = revealAuditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toBe(JSON.stringify({ path: 'llm.apiKey' }));
    expect(audit[0]?.data).not.toContain(API_KEY);
    expect(audit[0]?.data).not.toContain(result.stdout.trim());
  });

  test('explicit reveal audit redacts a secret pattern supplied inside the path', () => {
    const result = runConfigGet([`custom.${API_KEY}`, '--reveal']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('secret-path-value');

    const audit = revealAuditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toContain('sk-ant-');
    expect(audit[0]?.data).toContain('***');
    expect(audit[0]?.data).not.toContain(API_KEY);
    expect(audit[0]?.data).not.toContain(result.stdout.trim());
  });

  test('explicit reveal fails closed when the persistent audit sink cannot register', () => {
    writeFileSync(join(configDir, 'logs'), 'blocked');
    const result = runConfigGet(['llm.apiKey', '--reveal']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain(API_KEY);
    expect(result.stderr).not.toContain(API_KEY);
    expect(`${result.stdout}${result.stderr}`).toContain('persistent audit sink unavailable');
  });
});
