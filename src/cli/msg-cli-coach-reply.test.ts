// COACH-REPLY-AS-MAIL (OP #180740 re-ask loop · 11-26) — a CLAUDE-OP answer to OP's own ask is mail (closes OP's
// `mail-from:CLAUDE-OP` watch · no re-ask); an unsolicited CLAUDE-OP post stays a coach note. Independent literals.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from '../msg/msg-store.js';
import { registerMsgCommands } from './msg-cli.js';
import { pendingDiverted } from '../msg/diverted-mail.js';
import { measurePredicate } from '../msg/self-timer-watch.js';
import { routeBlockedRequirements } from '../op-requirements/turn-end.js';
import { seedRequirements, type Requirement } from '../op-requirements/requirement-loop.js';

const dirs: string[] = [];
let prevState: string | undefined;
beforeAll(() => { prevState = process.env.ELANOUS_STATE_DIR; const d = mkdtempSync(join(tmpdir(), 'coach-reply-state-')); dirs.push(d); process.env.ELANOUS_STATE_DIR = d; });
afterAll(() => { if (prevState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prevState; });
afterEach(() => { for (const d of dirs.splice(1)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reply-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path),
    out: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
    readStdin: async () => '',
    setExitCode: () => {},
    registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    callerSeat: () => null,
    saveAckDigest: async () => {},
  });
  return {
    run: async (...args: string[]) => { await program.parseAsync(['msg', ...args], { from: 'user' }); },
    store: () => new MsgStore(path), stdout, stderr, divertedRoot: join(dir, 'diverted'),
  };
}

/** The production mail-from probe's query, on the fixture ledger. */
function mailFromProbe(store: MsgStore) {
  return async (from: string, to: string, sinceIso: string) => {
    const row = store.db.query('SELECT id FROM msg_messages WHERE sender = ? AND recipient = ? AND created_at >= ? ORDER BY id ASC LIMIT 1').get(from, to, sinceIso) as { id: number } | null;
    return row ? row.id : null;
  };
}

describe('COACH-REPLY-AS-MAIL', () => {
  test('a --reply-to answer to an OP question is delivered as mail and satisfies OP\'s mail-from:CLAUDE-OP watch', async () => {
    const f = fixture();
    const armedAt = new Date(Date.now() - 60_000).toISOString();
    const seed = f.store();
    const ask = seed.post({ from: 'OP', to: 'CLAUDE-OP', kind: 'question', needsAck: true, body: 'Watch mail-from:CLAUDE-OP — is the rail restarted?' });
    seed.close();
    await f.run('post', 'yes, restarted 12:41', '--from', 'CLAUDE-OP', '--to', 'OP', '--reply-to', String(ask.id), '--kind', 'status', '--no-needs-reply', '--json');
    expect(f.stdout.at(-1)).not.toContain('coach injection');
    const posted = JSON.parse(f.stdout.at(-1)!);
    expect([posted.from, posted.to, posted.replyTo, posted.body]).toEqual(['CLAUDE-OP', 'OP', 1, 'yes, restarted 12:41']);
    expect(pendingDiverted('coach-note', 'OP', f.divertedRoot)).toEqual([]);
    const store = f.store();
    try {
      expect(store.list('OP').map((m) => m.body)).toEqual(['yes, restarted 12:41']);
      const verdict = await measurePredicate('mail-from:CLAUDE-OP', { seat: 'OP', sinceIso: armedAt }, { probes: { mailFrom: mailFromProbe(store) } as never });
      expect(verdict).toEqual({ kind: 'met', evidence: 'mail #2 from CLAUDE-OP' });
    } finally { store.close(); }
  });

  test('an answer auto-threaded onto OP\'s open question (no --reply-to) is also mail', async () => {
    const f = fixture();
    const seed = f.store();
    seed.post({ from: 'OP', to: 'CLAUDE-OP', kind: 'question', needsAck: true, body: '[OP · re-ask · req:msg:7] No reply yet to #7' });
    seed.close();
    await f.run('post', 'answered in #7 thread: done', '--from', 'CLAUDE-OP', '--to', 'OP', '--kind', 'status', '--json');
    const posted = JSON.parse(f.stdout.at(-1)!);
    expect([posted.id, posted.replyTo]).toEqual([2, 1]);
    expect(pendingDiverted('coach-note', 'OP', f.divertedRoot)).toEqual([]);
  });

  test('an unsolicited CLAUDE-OP post still becomes a coach note (no row · watch not met)', async () => {
    const f = fixture();
    const armedAt = new Date(Date.now() - 60_000).toISOString();
    await f.run('post', 'board looks fine', '--from', 'CLAUDE-OP', '--to', 'OP', '--kind', 'info');
    expect(f.stdout.at(-1)).toBe('msg post: coach injection → coach note for OP (one line per 30 min in its next turn · not mail)');
    expect(pendingDiverted('coach-note', 'OP', f.divertedRoot).map((e) => e.body)).toEqual(['board looks fine']);
    // a --reply-to pointing at a mail OP did NOT send is not an answer to OP's ask
    const seed = f.store();
    const other = seed.post({ from: 'TC', to: 'CLAUDE-OP', kind: 'question', needsAck: true, body: 'TC asks' });
    seed.close();
    await f.run('post', 'fyi for OP', '--from', 'CLAUDE-OP', '--to', 'OP', '--reply-to', String(other.id), '--kind', 'info');
    expect(f.stdout.at(-1)).toBe('msg post: coach injection → coach note for OP (one line per 30 min in its next turn · not mail)');
    const store = f.store();
    try {
      expect(store.list('OP')).toEqual([]);
      const verdict = await measurePredicate('mail-from:CLAUDE-OP', { seat: 'OP', sinceIso: armedAt }, { probes: { mailFrom: mailFromProbe(store) } as never });
      expect(verdict.kind).toBe('not-met');
    } finally { store.close(); }
  });

  test('no re-ask is emitted after the reply: the watch evidence closes the blocked requirement', async () => {
    const f = fixture();
    const armedAt = new Date(Date.now() - 60_000).toISOString();
    const seed = f.store();
    const ask = seed.post({ from: 'OP', to: 'CLAUDE-OP', kind: 'question', needsAck: true, body: 'Watch mail-from:CLAUDE-OP' });
    seed.close();
    const at = '2026-11-26T03:40:00.000Z';
    const reqs: { requirements: Requirement[] } = { requirements: [] };
    const delegated = { commitmentId: 'c-1', msgId: String(ask.id), text: 'Watch mail-from:CLAUDE-OP', peer: 'CLAUDE-OP' };
    seedRequirements(reqs as never, { delegated: [{ ...delegated, status: 'open' }] }, at);
    reqs.requirements[0]!.status = 'blocked';
    const posts: Array<{ to: string; body: string }> = [];
    const noLog = (): void => {};
    const deps = { seat: 'OP', postMail: (m: { to: string; body: string }) => { posts.push(m); return 99; }, coordinatorOf: () => undefined };
    // control: without an answer the blocked requirement re-asks CLAUDE-OP
    const control = structuredClone(reqs);
    routeBlockedRequirements(control, [], deps as never, new Date(at), noLog);
    expect(posts.map((p) => p.body)).toEqual([`[OP · re-ask · req:msg:${ask.id}] No reply yet to #${ask.id}: Watch mail-from:CLAUDE-OP — reply to #${ask.id} with the result, or say what blocks it.`]);
    posts.length = 0;

    await f.run('post', 'done: rail restarted', '--from', 'CLAUDE-OP', '--to', 'OP', '--reply-to', String(ask.id), '--kind', 'status', '--no-needs-reply', '--json');
    const store = f.store();
    let evidence = '';
    try {
      const verdict = await measurePredicate('mail-from:CLAUDE-OP', { seat: 'OP', sinceIso: armedAt }, { probes: { mailFrom: mailFromProbe(store) } as never });
      expect(verdict.kind).toBe('met');
      evidence = verdict.kind === 'met' ? verdict.evidence : '';
    } finally { store.close(); }
    seedRequirements(reqs as never, { delegated: [{ ...delegated, status: 'done', doneEvidence: evidence }] }, at);
    expect(String(reqs.requirements[0]!.status)).toBe('closed');
    routeBlockedRequirements(reqs, [], deps as never, new Date(at), noLog);
    expect(posts).toEqual([]);
  });
});
