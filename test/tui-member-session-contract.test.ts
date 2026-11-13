import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTuiMemberSession } from '../src/tui/member-session-contract.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('private Nexus app session is the only accepted TUI owner credential source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-member-session-'));
  roots.push(root);
  const file = join(root, 'session.json');
  const now = Date.parse('2026-11-14T01:00:00.000Z');
  const valid = { nexusUrl: 'https://nexus.example.test/ignored', sessionToken: 'aps_simulatedIssuerToken',
    expiresAt: '2026-11-14T02:00:00.000Z', appSlug: 'kaist-demo' };
  const put = (value: unknown) => { writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); chmodSync(file, 0o600); };
  put(valid);
  expect(readTuiMemberSession(file, now)).toEqual({ nexusUrl: 'https://nexus.example.test',
    sessionToken: valid.sessionToken, appSlug: 'kaist-demo' });
  expect(readTuiMemberSession(file, Date.parse(valid.expiresAt))).toBeUndefined();
  expect(readTuiMemberSession(undefined, now)).toBeUndefined();
  expect(readTuiMemberSession('session.json', now)).toBeUndefined();
  chmodSync(file, 0o644);
  expect(readTuiMemberSession(file, now)).toBeUndefined();
  chmodSync(file, 0o600);
  const link = join(root, 'link.json');
  symlinkSync(file, link);
  expect(readTuiMemberSession(link, now)).toBeUndefined();
  put({ ...valid, memberId: 'unverified-owner' });
  expect(readTuiMemberSession(file, now)).toBeUndefined();
  put({ ...valid, nexusUrl: 'http://remote.example.test' });
  expect(readTuiMemberSession(file, now)).toBeUndefined();
  put({ ...valid, sessionToken: 'admin-token' });
  expect(readTuiMemberSession(file, now)).toBeUndefined();
  put({ ...valid, nexusUrl: 'http://127.0.0.1:3000' });
  expect(readTuiMemberSession(file, now)?.nexusUrl).toBe('http://127.0.0.1:3000');
});
