import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { ensureAdminToken, resolveToken } from '../auth/token-store.js';
import { listMcpPats, matchMcpPat } from '../mcp-gateway/pat-store.js';
import { registerMcpGatewayCommands, issueMcpNexusToken } from './mcp-gateway-cli.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mcp-cli-')); setElanousConfigDir(root); });
afterEach(() => { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); process.exitCode = 0; });

const command = () => {
  const program = new Command();
  const mcp = program.command('mcp');
  registerMcpGatewayCommands(mcp);
  return program;
};

test('issue prints PAT once; list prints only name and timestamps, revoke disables it', async () => {
  const program = command();
  const output: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => { output.push(chunk); return true; }) as typeof process.stdout.write;
  try {
    await program.parseAsync(['mcp', 'token', 'issue', 'demo', '--expires', '30d'], { from: 'user' });
    const token = output.join('').trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(matchMcpPat(token, Date.now(), root)?.name).toBe('demo');
    output.length = 0;
    await program.parseAsync(['mcp', 'token', 'list'], { from: 'user' });
    expect(output.join('')).toContain('demo');
    expect(output.join('')).not.toContain(token);
    await program.parseAsync(['mcp', 'token', 'revoke', 'demo'], { from: 'user' });
    expect(matchMcpPat(token, Date.now(), root)).toBeNull();
  } finally { process.stdout.write = original; }
});

test('nexus token issue writes a private scoped token file without printing it', async () => {
  ensureAdminToken({ configDir: root });
  const target = join(root, 'gateway-nexus-token');
  const output: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => { output.push(chunk); return true; }) as typeof process.stdout.write;
  try { await command().parseAsync(['mcp', 'nexus-token', 'issue', '--file', target], { from: 'user' }); }
  finally { process.stdout.write = original; }
  const raw = readFileSync(target, 'utf8').trim();
  expect(raw.length).toBeGreaterThan(30);
  expect(output.join('')).toBe('');
  expect(statSync(target).mode & 0o777).toBe(0o600);
  expect(resolveToken(raw, { configDir: root })?.scope).toBe('mcp-public');
  expect(listMcpPats(root)).toEqual([]);
  expect(() => issueMcpNexusToken(target)).toThrow();
});

test('gateway startup refuses missing PAT store before binding a public listener', async () => {
  const tokenFile = join(root, 'nexus-token');
  writeFileSync(tokenFile, 'scoped-test-token\n', { mode: 0o600 });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    await command().parseAsync(['mcp', 'gateway', '--nexus-url', 'http://127.0.0.1:1', '--nexus-token-file', tokenFile, '--port', '0'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(errors.join(' ')).toContain('invalid gateway port');
    process.exitCode = 0;
    await command().parseAsync(['mcp', 'gateway', '--nexus-url', 'http://127.0.0.1:1', '--nexus-token-file', tokenFile], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(errors.join(' ')).toContain('--public-url');
    process.exitCode = 0;
    await command().parseAsync(['mcp', 'gateway', '--nexus-url', 'http://127.0.0.1:1', '--nexus-token-file', tokenFile, '--public-url', 'https://mcp.elanous.ai'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(errors.join(' ')).toContain('pats.json');
  } finally { console.error = original; }
});

test('gateway rejects an insecure nexus token file before startup', async () => {
  const tokenFile = join(root, 'nexus-token');
  writeFileSync(tokenFile, 'scoped-test-token\n', { mode: 0o644 });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    await command().parseAsync(['mcp', 'gateway', '--nexus-url', 'http://127.0.0.1:1', '--nexus-token-file', tokenFile, '--public-url', 'https://mcp.elanous.ai'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(errors.join(' ')).toContain('0600');
  } finally { console.error = original; }
});

test('gateway help accepts token file or stdin but never token argv', () => {
  const gateway = command().commands[0]!.commands.find((entry) => entry.name() === 'gateway')!;
  const flags = gateway.options.map((option) => option.long);
  expect(flags).toContain('--nexus-token-file');
  // 데몬 주소는 통합관제가 푼다 — 명시는 덮어쓰기일 뿐 필수가 아니다.
  const nexusUrl = gateway.options.find((option) => option.long === '--nexus-url')!;
  expect(nexusUrl.mandatory).toBe(false);
  expect(nexusUrl.description).toContain('Default: the current daemon');
  expect(flags).not.toContain('--nexus-token');
});
