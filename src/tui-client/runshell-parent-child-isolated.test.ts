import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { closeLocalChatSession, runLocalChatTurn, setNextRunShellCardHandler } from './local-chat-turn.js';

// Real LocalChatSession parent + real Bun IPC, but a deterministic REPL stand-in.
// The fixture uses the production child IPC client and verifies the parent's signature.
test('parent sends fresh key and gates child IPC on approval and session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runshell-ipc-'));
  const session = 'isolated-runshell-ipc';
  const old = { ...process.env };
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_SESSION_ROOT = join(dir, 'sessions');
  process.env.ELANOUS_LLM_PROVIDER = 'local';
  process.env.ELANOUS_TRACK = 'test-seat';
  process.env.ELANOUS_RUNSHELL_APPROVAL_PUBLIC_KEY = 'inherited-untrusted-key';
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ llm: { provider: 'local' }, onboarding: { completed: true } }));
  setElanousConfigDir(dir);
  const fixture = join(dir, 'child.ts');
  const wire = join(import.meta.dir, 'next-runshell-approval.ts');
  const signing = join(import.meta.dir, '..', 'shell-primitive', 'runshell-approval.ts');
  writeFileSync(fixture, `
import { createInterface } from 'node:readline';
import { verify } from 'node:crypto';
import { requestRunShellApproval, RUNSHELL_PUBLIC_KEY_ENV } from ${JSON.stringify(wire)};
import { runShellApprovalSigningBytes, runShellArgvHash } from ${JSON.stringify(signing)};
const session = ${JSON.stringify(session)};
for await (const line of createInterface({ input: process.stdin })) {
  const { id, prompt } = JSON.parse(line);
  const req = { argv: ['/bin/echo', 'literal argument'], cwd: '/tmp', bytesSha256: 'a'.repeat(64), callerSeat: prompt === 'wrong-seat' ? 'other-seat' : 'test-seat', sessionId: prompt === 'wrong-session' ? 'other-session' : session };
  const key = process.env[RUNSHELL_PUBLIC_KEY_ENV] || '';
  const approval = await requestRunShellApproval(process, req, undefined, 3000);
  const valid = !!approval && verify(null, runShellApprovalSigningBytes(approval.payload), key, Buffer.from(approval.signature, 'base64'));
  const bound = !!approval && approval.payload.argvHash === runShellArgvHash(req.argv) && approval.payload.cwd === req.cwd && approval.payload.bytesSha256 === req.bytesSha256 && approval.payload.sessionId === req.sessionId && approval.payload.callerSeat === req.callerSeat;
  console.log(JSON.stringify({ event: 'delta', turnId: id, text: JSON.stringify({ key, valid, bound, received: !!approval }) }));
  console.log(JSON.stringify({ event: 'result', turnId: id }));
}
`);
  const cards: string[] = [];
  const run = async (prompt: string) => {
    let response = '';
    await runLocalChatTurn(session, prompt, new AbortController().signal, fixture, undefined, s => { response += s; });
    return JSON.parse(response) as { key: string; valid: boolean; bound: boolean; received: boolean };
  };
  try {
    setNextRunShellCardHandler(async card => { cards.push(card); return { approved: true }; });
    const yes = await run('approved');
    expect(yes.key).toContain('BEGIN PUBLIC KEY');
    expect(yes.key).not.toBe('inherited-untrusted-key');
    expect(yes.received && yes.valid && yes.bound).toBe(true);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain('literal argument');
    const wrong = await run('wrong-session');
    expect(wrong.received).toBe(false);
    const wrongSeat = await run('wrong-seat');
    expect(wrongSeat.received).toBe(false);
    expect(cards).toHaveLength(1);
    setNextRunShellCardHandler(async card => { cards.push(card); return { approved: false, reason: 'declined' }; });
    const no = await run('denied');
    expect(no.received).toBe(false);
    expect(no.key).toBe(yes.key);
    expect(cards).toHaveLength(2);
    console.log(JSON.stringify({ evidence: 'real-parent-child-ipc', approved: yes, wrongSession: wrong, denied: no, cards: cards.length }));
  } finally {
    setNextRunShellCardHandler(null);
    await closeLocalChatSession(session);
    resetElanousConfigDir();
    for (const k of ['ELANOUS_STATE_DIR', 'ELANOUS_SESSION_ROOT', 'ELANOUS_LLM_PROVIDER', 'ELANOUS_TRACK', 'ELANOUS_RUNSHELL_APPROVAL_PUBLIC_KEY']) {
      if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
