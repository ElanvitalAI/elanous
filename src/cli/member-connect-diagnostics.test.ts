import { beforeAll, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerMemberConnectCommands } from './member-connect-cli.js';
import { tuiMemberSessionPath } from '../tui/member-session-contract.js';

// Regression for TC48851: registered-command diagnostics and private failure boundaries.
// Runs the registered command and all real local consumers. Only the upstream
// fetch boundary, poll clock and sleep are substituted. No global/module mocks.
// Dynamic session expiry is required: the command does not inject its clock into
// its handoff consumer. It stays future-relative rather than using a fixed date.
const names = ['happy', 'start-503', 'start-network', 'poll-network', 'poll-401', 'poll-410',
  'poll-deadline', 'exchange-unconfigured', 'exchange-outage', 'owner-401', 'owner-network'] as const;
type Name = typeof names[number];
const canary = 'SYNTHETIC_PRIVATE_DETAIL_DO_NOT_PRINT';
const token = 'aps_synthetic_mq04_never_real';
const id = 'M'.repeat(24);
const code = 'C'.repeat(43);
interface Observation {
  name: Name; exits: number[]; calls: string[]; errors: string[];
  successPrinted: boolean; secretPrinted: boolean; persisted: boolean;
  envelopeValid: boolean; temporaryFiles: string[];
}
const rows: Observation[] = [];

beforeAll(async () => {
  for (const name of names) {
    const root = mkdtempSync(join(tmpdir(), 'mq04-connect-diagnostic-'));
    const logs: string[] = [], errors: string[] = [], exits: number[] = [], calls: string[] = [];
    let state = '', fakeNow = 1000, secrets: string[] = [token, canary, code];
    try {
      const program = new Command();
      registerMemberConnectCommands(program, {
        configDir: () => root,
        output: { log: line => logs.push(line), error: line => errors.push(line) },
        exit: value => exits.push(value),
        now: () => fakeNow,
        sleep: async ms => { fakeNow += name === 'poll-deadline' ? 120001 : ms; },
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          const target = new URL(String(url));
          if (target.origin !== 'https://api.elanous.ai') throw new Error('unexpected upstream');
          calls.push(target.pathname);
          if (target.pathname.endsWith('/connect/start')) {
            const request = JSON.parse(String(init?.body));
            state = request.state;
            secrets.push(request.state, request.pollSecret);
            if (name === 'start-network') throw new Error(canary + token);
            if (name === 'start-503') return Response.json({ error: 'members-unavailable', detail: canary }, { status: 503 });
            return Response.json({ id, userCode: 'ABCD-EFGH',
              approvalUrl: `https://api.elanous.ai/v1/members/connect/approve?id=${id}` }, { status: 201 });
          }
          if (target.pathname.endsWith('/connect/poll')) {
            if (name === 'poll-network') throw new Error(canary + token);
            if (name === 'poll-401' || name === 'poll-410') return Response.json({ error: canary }, { status: name === 'poll-401' ? 401 : 410 });
            if (name === 'poll-deadline') return Response.json({ pending: true }, { status: 202 });
            return Response.json({ code, state });
          }
          if (target.pathname.endsWith('/app-slot/exchange')) {
            const request = JSON.parse(String(init?.body));
            secrets.push(request.codeVerifier);
            expect(request.code).toBe(code);
            expect(request.state).toBe(state);
            if (name.startsWith('exchange-')) return Response.json({
              error: name === 'exchange-unconfigured' ? 'members-not-configured' : 'members-unavailable', detail: canary,
            }, { status: 503 });
            return Response.json({ sessionToken: token, expiresAt: new Date(Date.now() + 60000).toISOString(), appSlot: { appSlug: 'mq04-synthetic-app' } });
          }
          if (target.pathname.endsWith('/members/owner')) {
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
            if (name === 'owner-network') throw new Error(canary + token);
            if (name === 'owner-401') return Response.json({ error: canary }, { status: 401 });
            return Response.json({ memberId: 'mq04-synthetic-owner' });
          }
          if (target.pathname === '/v1/member/keys') {
            const key = 'emk_syntheticMq04'; secrets.push(key);
            return Response.json({ id: '11111111-1111-4111-8111-111111111111', key }, { status: 201 });
          }
          throw new Error('unexpected product request');
        }) as typeof fetch,
      });
      await program.parseAsync(['member', 'connect'], { from: 'user' });
      const files = readdirSync(root);
      const persisted = files.includes('member-session.json');
      const envelopeValid = persisted && JSON.parse(readFileSync(tuiMemberSessionPath(root), 'utf8')).sessionToken === token;
      const visible = [...logs, ...errors].join('\n');
      rows.push({ name, exits, calls, errors, successPrinted: visible.includes('회원 앱 세션을 연결했습니다.'),
        secretPrinted: secrets.some(value => value && visible.includes(value)), persisted, envelopeValid,
        temporaryFiles: files.filter(file => file.startsWith('.member-connect-') || file.startsWith('.member-session-')) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  if (process.env.MQ04_OBSERVATIONS) writeFileSync(process.env.MQ04_OBSERVATIONS, JSON.stringify(rows, null, 2));
});

test('registered member connect happy path exchanges, verifies and persists the actual private envelope', () => {
  const row = rows[0];
  expect(row.exits).toEqual([0]);
  expect(row.calls).toEqual(['/v1/members/connect/start', '/v1/members/connect/poll', '/v1/members/app-slot/exchange', '/v1/members/owner', '/v1/member/keys']);
  expect(row.envelopeValid).toBe(true);
  expect(row.successPrinted).toBe(true);
});

test('all ten real command failures stop at the injected stage without publishing or exposing private details', () => {
  for (const row of rows) {
    expect(row.secretPrinted).toBe(false);
    expect(row.temporaryFiles).toEqual([]);
    if (row.name === 'happy') continue;
    expect(row.exits).toEqual([1]);
    expect(row.persisted).toBe(false);
    expect(row.successPrinted).toBe(false);
    const expectedCalls = row.name.startsWith('start-') ? 1 : row.name.startsWith('poll-') ? 2 : row.name.startsWith('exchange-') ? 3 : 4;
    expect(row.calls).toHaveLength(expectedCalls);
  }
});

test('CONNECT-APPROVE-ROBUST: start, approval, configuration and owner failures give distinct useful reasons', () => {
  // TC owns wording. This only requires these materially different remediation
  // classes to remain distinguishable; it does not prescribe an error catalog.
  const representatives = ['start-network', 'poll-410', 'exchange-unconfigured', 'owner-401'];
  const messages = representatives.map(name => rows.find(row => row.name === name)!.errors.join('\n'));
  expect(messages).not.toContain('');
  expect(new Set(messages).size).toBe(4);
  const remedies = ['네트워크', '만료', '설정', '소유자'];
  messages.forEach((message, index) => expect(message).toContain(remedies[index]));
  expect(rows.find(row => row.name === 'poll-network')!.errors.join('\n')).toContain('승인 상태');
});

test('existing session and concurrent writer survive with an existing-connection remedy', async () => {
  for (const concurrent of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'mq04-connect-writer-'));
    const handoff = join(root, 'approved.json');
    const destination = tuiMemberSessionPath(root);
    const previous = JSON.stringify({ synthetic: 'preserve-existing-session-bytes' });
    const errors: string[] = [], exits: number[] = [], calls: string[] = [];
    try {
      writeFileSync(handoff, JSON.stringify({ code: 'synthetic-code', state: 'synthetic-state', codeVerifier: 'synthetic-verifier' }), { mode: 0o600 });
      if (!concurrent) writeFileSync(destination, previous, { mode: 0o600 });
      const program = new Command();
      registerMemberConnectCommands(program, { configDir: () => root,
        output: { log: () => {}, error: line => errors.push(line) }, exit: value => exits.push(value),
        fetchImpl: (async (url: string | URL | Request) => {
          calls.push(String(url));
          if (String(url).endsWith('/exchange')) return Response.json({ sessionToken: token,
            expiresAt: new Date(Date.now() + 60000).toISOString(), appSlot: { appSlug: 'mq04-synthetic-app' } });
          // Another writer wins after the SDK's initial absence check and before publication.
          writeFileSync(destination, previous, { flag: 'wx', mode: 0o600 });
          return Response.json({ memberId: 'mq04-synthetic-owner' });
        }) as typeof fetch });
      await program.parseAsync(['member', 'connect', '--handoff-file', handoff], { from: 'user' });
      expect(exits).toEqual([1]);
      expect(calls).toHaveLength(concurrent ? 2 : 0);
      expect(readFileSync(destination, 'utf8')).toBe(previous);
      expect(errors.join('\n')).toContain('이미 회원 연결');
      expect(errors.join('\n')).not.toContain(token);
      expect(readdirSync(root).filter(file => file.startsWith('.member-session-'))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('unknown local exceptions keep the generic fallback and do not expose arbitrary error messages', async () => {
  const errors: string[] = [], exits: number[] = [];
  const program = new Command();
  registerMemberConnectCommands(program, { configDir: () => { throw new Error(canary + token); },
    output: { log: () => {}, error: line => errors.push(line) }, exit: value => exits.push(value) });
  await program.parseAsync(['member', 'connect'], { from: 'user' });
  expect(exits).toEqual([1]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('회원 연결을 완료하지 못했습니다.');
  expect(errors[0]).not.toContain(canary);
  expect(errors[0]).not.toContain(token);
});
