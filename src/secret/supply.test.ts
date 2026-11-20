import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  SUPPLY_LEDGER_FILE, SUPPLY_POLICY_FILE, checkSupplyAllowed, listLiveLeases, loadSupplyPolicy, parseSupplyTarget,
  readSupplyLedger, revokeSupply, supply, validateSupplyPolicy, type SupplyDelegates, type SupplyDeps,
} from './supply.js';
import { registerSecretSupplyCommand } from '../cli/secret-supply-cli.js';

const CANARY = 'SUPPLY-CANARY-VALUE-zz91'; // 델리게이트가 절대 돌려주지 않는 값 — 출력에 나오면 실패
let dir: string;
let calls: string[];
const NOW = Date.parse('2026-11-20T00:00:00Z');

function policy(body: unknown, mode = 0o600): void {
  const p = join(dir, SUPPLY_POLICY_FILE);
  writeFileSync(p, JSON.stringify(body)); chmodSync(p, mode);
}
function delegates(over: Partial<SupplyDelegates> = {}): SupplyDelegates {
  return {
    oauthIssue: async (to) => { calls.push(`oauth:${to}`); return { leaseId: 'lease-oauth-1', expiresAt: NOW + 3_600_000 }; },
    staticIssue: async (item, to) => { calls.push(`static:${item}:${to}`); return { ok: true, leaseId: 'static-lease-1', expiresAt: NOW + 7_200_000 }; },
    oauthRevoke: async (id) => id === 'lease-oauth-1',
    staticRevoke: async (id) => id === 'static-lease-1',
    ...over,
  };
}
const deps = (over: Partial<SupplyDelegates> = {}): SupplyDeps => ({ configDir: dir, delegates: delegates(over), now: () => NOW, who: () => 'tester' });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'supply-')); calls = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('parseSupplyTarget', () => {
  test('4 shapes', () => {
    expect(parseSupplyTarget('pod:job-1')).toEqual({ kind: 'pod', name: 'job-1' });
    expect(parseSupplyTarget('ta:card-7')).toEqual({ kind: 'ta', name: 'card-7' });
    expect(parseSupplyTarget('host:node-b')).toEqual({ kind: 'host', name: 'node-b' });
    expect(parseSupplyTarget('/tmp/x')).toEqual({ kind: 'config-dir', name: '/tmp/x' });
  });
  test('bare name / traversal / bad chars refused', () => {
    for (const bad of ['node-b', 'pod:', 'pod:a b', '/a/../b', 'host:;rm', '']) expect(parseSupplyTarget(bad)).toBeNull();
  });
});

describe('policy schema (비밀 0 · owner 만)', () => {
  test('valid', () => expect(validateSupplyPolicy({ version: 1, allow: [{ item: 'codex', targets: ['host:node-b', 'config-dir'] }] }).ok).toBe(true));
  test.each([
    ['sk-', 'sk-abcdef'], ['ghp_', 'ghp_abc'], ['ems_', 'ems_abc'], ['emt_', 'emt_abc'], ['eyJ', 'eyJhbGci'],
  ])('rejects key shape %s as item', (_n, item) => expect(validateSupplyPolicy({ version: 1, allow: [{ item, targets: ['host'] }] }).ok).toBe(false));
  test('rejects long random token and unknown keys', () => {
    expect(validateSupplyPolicy({ version: 1, allow: [{ item: 'a'.repeat(50), targets: ['host'] }] }).ok).toBe(false);
    expect(validateSupplyPolicy({ version: 1, allow: [], token: 'x' }).ok).toBe(false);
    expect(validateSupplyPolicy({ version: 1, allow: [{ item: 'codex', targets: ['host'], note: 'x' }] }).ok).toBe(false);
    expect(validateSupplyPolicy({ version: 2, allow: [] }).ok).toBe(false);
  });
  test('missing file = policy-missing', () => expect(loadSupplyPolicy(dir)).toMatchObject({ ok: false, reason: 'policy-missing' }));
  test('group/other readable = policy-not-owner', () => {
    policy({ version: 1, allow: [] }, 0o644);
    expect(loadSupplyPolicy(dir)).toMatchObject({ ok: false, reason: 'policy-not-owner' });
  });
  test('other uid = policy-not-owner', () => {
    policy({ version: 1, allow: [] });
    expect(loadSupplyPolicy(dir, (statSync(join(dir, SUPPLY_POLICY_FILE)).uid) + 1)).toMatchObject({ ok: false, reason: 'policy-not-owner' });
  });
  test('corrupt = policy-invalid', () => {
    writeFileSync(join(dir, SUPPLY_POLICY_FILE), '{nope', { mode: 0o600 });
    expect(loadSupplyPolicy(dir)).toMatchObject({ ok: false, reason: 'policy-invalid' });
  });
});

describe('checkSupplyAllowed', () => {
  const p = { allow: [{ item: 'codex', targets: ['host', 'pod:job-1'] }, { item: 'claude-acp', targets: ['host', 'pod', 'ta'] }] };
  test('kind and exact label', () => {
    expect(checkSupplyAllowed(p, 'codex', { kind: 'host', name: 'x' }).ok).toBe(true);
    expect(checkSupplyAllowed(p, 'codex', { kind: 'pod', name: 'job-1' }).ok).toBe(true);
    expect(checkSupplyAllowed(p, 'codex', { kind: 'pod', name: 'job-2' })).toEqual({ ok: false, reason: 'target-not-allowed' });
    expect(checkSupplyAllowed(p, 'nope', { kind: 'host', name: 'x' })).toEqual({ ok: false, reason: 'item-not-allowed' });
  });
  test('code constant: claude-acp host only even if policy says pod', () => {
    expect(checkSupplyAllowed(p, 'claude-acp', { kind: 'pod', name: 'j' })).toEqual({ ok: false, reason: 'host-only-item' });
    expect(checkSupplyAllowed(p, 'claude-acp', { kind: 'ta', name: 'c' })).toEqual({ ok: false, reason: 'host-only-item' });
    expect(checkSupplyAllowed(p, 'claude-acp', { kind: 'host', name: 'h' }).ok).toBe(true);
  });
});

describe('supply (default deny · delegate · ledger)', () => {
  test('no policy file = refuse, nothing delegated, ledger row', async () => {
    const r = await supply({ item: 'codex', to: 'host:node-b' }, deps());
    expect(r).toMatchObject({ ok: false, reason: 'policy-missing' });
    expect(calls).toEqual([]);
    expect(readSupplyLedger(dir)[0]).toMatchObject({ action: 'refused', reason: 'policy-missing', who: 'tester' });
  });
  test('empty allow = refuse', async () => {
    policy({ version: 1, allow: [] });
    expect(await supply({ item: 'codex', to: 'host:node-b' }, deps())).toMatchObject({ ok: false, reason: 'item-not-allowed' });
    expect(calls).toEqual([]);
  });
  test('codex to host → oauth delegate; ledger has who/item/target/when, no value', async () => {
    policy({ version: 1, allow: [{ item: 'codex', targets: ['host:node-b'] }] });
    const r = await supply({ item: 'codex', to: 'host:node-b', ttlMs: 60_000 }, deps());
    expect(r).toMatchObject({ ok: true, via: 'oauth-lease', target: 'host:node-b', leaseId: 'lease-oauth-1' });
    expect(calls).toEqual(['oauth:node-b']);
    const rows = readSupplyLedger(dir);
    expect(rows[0]).toMatchObject({ action: 'supply', who: 'tester', item: 'codex', target: 'host:node-b', at: new Date(NOW).toISOString() });
    expect(statSync(join(dir, SUPPLY_LEDGER_FILE)).mode & 0o777).toBe(0o600);
  });
  test('static key to config-dir → static delegate', async () => {
    policy({ version: 1, allow: [{ item: 'zai', targets: ['config-dir'] }] });
    const r = await supply({ item: 'zai', to: '/tmp/cfg' }, deps());
    expect(r).toMatchObject({ ok: true, via: 'static-lease' });
    expect(calls).toEqual(['static:zai:/tmp/cfg']);
  });
  test('host not in exact list refused', async () => {
    policy({ version: 1, allow: [{ item: 'codex', targets: ['host:node-b'] }] });
    expect(await supply({ item: 'codex', to: 'host:gcp1' }, deps())).toMatchObject({ ok: false, reason: 'target-not-allowed' });
    expect(calls).toEqual([]);
  });
  test('claude-acp to pod refused even when policy allows pod', async () => {
    policy({ version: 1, allow: [{ item: 'claude-acp', targets: ['pod', 'host'] }] });
    expect(await supply({ item: 'claude-acp', to: 'pod:job-1' }, deps())).toMatchObject({ ok: false, reason: 'host-only-item' });
  });
  test('pod allowed but injector unwired = refuse; wired = delegate', async () => {
    policy({ version: 1, allow: [{ item: 'codex', targets: ['pod'] }] });
    expect(await supply({ item: 'codex', to: 'pod:job-1' }, deps())).toMatchObject({ ok: false, reason: 'handler-unwired' });
    const r = await supply({ item: 'codex', to: 'pod:job-1' }, deps({ podSupply: async () => ({ leaseId: 'pod-lease-1', expiresAt: NOW + 1000 }) }));
    expect(r).toMatchObject({ ok: true, via: 'pod', target: 'pod:job-1' });
  });
  test('delegate refusal / throw → refuse, error text never carried', async () => {
    policy({ version: 1, allow: [{ item: 'zai', targets: ['host'] }, { item: 'codex', targets: ['host'] }] });
    expect(await supply({ item: 'zai', to: 'host:h1' }, deps({ staticIssue: async () => ({ ok: false, reason: 'not-allowlisted' }) }))).toMatchObject({ ok: false, reason: 'delegate-refused', detail: 'static-lease: not-allowlisted' });
    const r = await supply({ item: 'codex', to: 'host:h1' }, deps({ oauthIssue: async () => { throw new Error(CANARY); } }));
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(r.ok).toBe(false);
    expect(readFileSync(join(dir, SUPPLY_LEDGER_FILE), 'utf8')).not.toContain(CANARY);
  });
  test('invalid target / item refused before policy', async () => {
    expect(await supply({ item: 'codex', to: 'node-b' }, deps())).toMatchObject({ ok: false, reason: 'invalid-target' });
    expect(await supply({ item: 'bad item', to: 'host:x' }, deps())).toMatchObject({ ok: false, reason: 'invalid-item' });
  });
  test('revoke: static, oauth, unknown', async () => {
    expect(await revokeSupply('static-lease-1', deps())).toEqual({ ok: true });
    expect(await revokeSupply('lease-oauth-1', deps())).toEqual({ ok: true });
    expect(await revokeSupply('nope-lease', deps())).toEqual({ ok: false });
    expect(readSupplyLedger(dir).map((x) => x.action)).toEqual(['revoke', 'revoke', 'revoke']);
  });
});

describe('listLiveLeases', () => {
  test('only live rows · remaining TTL · name · no value column', () => {
    const rows = listLiveLeases({
      oauth: [{ leaseId: 'o1', account: 'a', target: 'host:h:d', expiresAt: NOW + 600_000 }, { leaseId: 'o2', account: 'a', target: 't', expiresAt: NOW - 1 }, { leaseId: 'o3', account: 'a', target: 't', expiresAt: NOW + 5, revokedAt: NOW }],
      statics: [{ leaseId: 's1', id: 'zai', target: '/c', expiresAt: new Date(NOW + 60_000).toISOString() }, { leaseId: 's2', id: 'zai', target: '/c', expiresAt: new Date(NOW + 60_000).toISOString(), revokePending: true }],
    }, NOW);
    expect(rows).toEqual([{ leaseId: 's1', item: 'zai', target: '/c', remainingMs: 60_000 }, { leaseId: 'o1', item: 'codex', target: 'host:h:d', remainingMs: 600_000 }]);
  });
});

describe('CLI', () => {
  test('refusal exits 1 and prints no value; usage exits 2; list uses supplied deps', async () => {
    const lines: string[] = []; const errs: string[] = []; let code = -1;
    const secret = new Command('secret').exitOverride();
    registerSecretSupplyCommand(secret, { output: { log: (l) => lines.push(l), error: (l) => errs.push(l) }, setExitCode: (c) => { code = c; }, supplyDeps: async () => deps(), now: () => NOW });
    await secret.parseAsync(['supply', 'codex', '--to', 'host:node-b'], { from: 'user' });
    expect(code).toBe(1); expect(errs.join('\n')).toContain('policy-missing');
    await secret.parseAsync(['supply'], { from: 'user' });
    expect(code).toBe(2);
    policy({ version: 1, allow: [{ item: 'codex', targets: ['host'] }] });
    await secret.parseAsync(['supply', 'codex', '--to', 'host:node-b'], { from: 'user' });
    expect(code).toBe(0); expect(lines.join('\n')).toContain('supply ok · codex → host:node-b');
    expect(lines.join('\n') + errs.join('\n')).not.toContain(CANARY);
  });
});
