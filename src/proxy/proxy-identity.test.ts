// CLAUDE-OP-PROXY-IDENTITY — process-bound proxy grant: issue (TTY ⊕ no agent ancestor ⊕ claude runtime), verify
// (kernel ancestry pid ⊕ start), authority table (allow · deny), audit rows ⊕ OP notice. Independent literals; a fake
// process table stands in for proc_pidinfo.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeRequest } from '../els/server-auth.js';
import {
  grantPreflight, proxyAuthority, proxyPeerAuthority, readProxyGrant, resolveProxyActor, revokeProxyGrant, verifyProxyCaller, writeProxyGrant,
  type ProcInfo, type ProcLookup,
} from './proxy-identity.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function root(): string { const d = mkdtempSync(join(tmpdir(), 'proxy-id-')); dirs.push(d); return d; }

const UID = 501;
/** herdr → zsh(10) → claude(100, Claude OP) → zsh(101) → bun eln(102); herdr → zsh(20) → codex(200) → zsh(201) → bun eln(202);
 *  herdr → zsh(30) (a person) → bun eln(302); tmux(40) → zsh(41) → bun eln(42). */
function table(extra: ProcInfo[] = []): { lookup: ProcLookup; procs: Map<number, ProcInfo> } {
  const procs = new Map<number, ProcInfo>();
  const add = (pid: number, ppid: number, name: string, start = `${1000 + pid}:0`, uid = UID) => procs.set(pid, { pid, ppid, uid, start, name });
  add(5, 1, 'herdr');
  add(10, 5, '-zsh'); add(100, 10, 'claude'); add(101, 100, 'zsh'); add(102, 101, 'bun');
  add(20, 5, '-zsh'); add(200, 20, 'codex'); add(201, 200, 'zsh'); add(202, 201, 'bun');
  add(30, 5, '-zsh'); add(302, 30, 'bun');
  add(40, 1, 'tmux'); add(41, 40, 'zsh'); add(42, 41, 'bun');
  for (const p of extra) procs.set(p.pid, p);
  return { lookup: (pid) => procs.get(pid), procs };
}
const T0 = Date.parse('2026-11-26T19:00:00Z');

describe('grant preflight — only a person at a terminal grants a live claude process', () => {
  const { lookup } = table();
  test('a person in a herdr shell grants pid 100 (claude)', () => {
    const v = grantPreflight({ selfPid: 302, stdinIsTTY: true, runtimePid: 100, lookup, selfUid: UID });
    expect(v.ok && v.runtime.pid).toBe(100);
  });
  test('refusals: not a TTY · inside codex · inside claude · inside tmux · not claude · gone', () => {
    expect(grantPreflight({ selfPid: 302, stdinIsTTY: false, runtimePid: 100, lookup }).ok === false && 'not-a-terminal').toBe('not-a-terminal');
    const codex = grantPreflight({ selfPid: 202, stdinIsTTY: true, runtimePid: 100, lookup });
    expect(codex.ok === false && [codex.reason, codex.line]).toEqual(['agent-ancestor', 'eln proxy grant: refused — this terminal runs inside codex (pid 200); open your own terminal']);
    const inClaude = grantPreflight({ selfPid: 102, stdinIsTTY: true, runtimePid: 100, lookup });
    expect(inClaude.ok === false && inClaude.reason).toBe('agent-ancestor');
    const tmux = grantPreflight({ selfPid: 42, stdinIsTTY: true, runtimePid: 100, lookup });
    expect(tmux.ok === false && tmux.reason).toBe('agent-ancestor');
    const notClaude = grantPreflight({ selfPid: 302, stdinIsTTY: true, runtimePid: 200, lookup });
    expect(notClaude.ok === false && notClaude.reason).toBe('runtime-not-claude');
    expect(grantPreflight({ selfPid: 302, stdinIsTTY: true, runtimePid: 999, lookup }).ok === false).toBe(true);
  });
});

describe('Terra r1 — fail closed', () => {
  test('preflight: an unobservable hop, or a bun runtime above the grant process itself, refuses', () => {
    const { lookup } = table([{ pid: 60, ppid: 61, uid: UID, start: '60:0', name: '-zsh' }, { pid: 62, ppid: 60, uid: UID, start: '62:0', name: 'bun' },
      { pid: 70, ppid: 5, uid: UID, start: '70:0', name: 'bun' }, { pid: 71, ppid: 70, uid: UID, start: '71:0', name: 'zsh' }, { pid: 72, ppid: 71, uid: UID, start: '72:0', name: 'bun' },
      { pid: 80, ppid: 81, uid: UID, start: '80:0', name: '-zsh' }, { pid: 81, ppid: 1, uid: 0, start: '81:0', name: 'login' }, { pid: 82, ppid: 80, uid: UID, start: '82:0', name: 'bun' }]);
    const gap = grantPreflight({ selfPid: 62, stdinIsTTY: true, runtimePid: 100, lookup }); // 61 is missing
    expect(gap.ok === false && gap.reason).toBe('ancestry-unknown');
    const nested = grantPreflight({ selfPid: 72, stdinIsTTY: true, runtimePid: 100, lookup }); // an eln/bun runtime above
    expect(nested.ok === false && nested.reason).toBe('agent-ancestor');
    const login = grantPreflight({ selfPid: 82, stdinIsTTY: true, runtimePid: 100, lookup }); // Terminal → login(root) → zsh
    expect(login.ok).toBe(true);
  });
  test('grant file: mode 0400 and a dangling symlink are unsafe; a revoke whose audit row fails does not revoke', () => {
    const r = root();
    const { lookup, procs } = table();
    writeProxyGrant(r, procs.get(100)!, T0);
    chmodSync(join(r, 'proxy', 'grants.json'), 0o400);
    expect(readProxyGrant(r, 'CLAUDE-OP', UID).unsafe).toBe(true);
    chmodSync(join(r, 'proxy', 'grants.json'), 0o600);
    const r2 = root();
    mkdirSync(join(r2, 'proxy'));
    symlinkSync(join(r2, 'nowhere.json'), join(r2, 'proxy', 'grants.json'));
    expect(readProxyGrant(r2, 'CLAUDE-OP', UID)).toEqual({ grant: null, unsafe: true });
    rmSync(join(r, 'proxy', 'audit.jsonl'));
    mkdirSync(join(r, 'proxy', 'audit.jsonl')); // the audit append now fails
    expect(() => revokeProxyGrant(r, 'CLAUDE-OP', T0 + 1)).toThrow();
    expect(readProxyGrant(r, 'CLAUDE-OP', UID).grant?.runtime.pid).toBe(100);
    void lookup;
  });
});

describe('verify — the calling process must descend from the granted pid ⊕ start', () => {
  test('a descendant of claude(100) verifies; codex(202) and a person(302) do not', () => {
    const r = root();
    const { lookup, procs } = table();
    writeProxyGrant(r, procs.get(100)!, T0);
    const ok = verifyProxyCaller({ stateRoot: r, pid: 102, lookup, now: T0 + 60_000, selfUid: UID });
    expect(ok.ok && [ok.principal, ok.hops]).toEqual(['CLAUDE-OP', 2]);
    const codex = verifyProxyCaller({ stateRoot: r, pid: 202, lookup, now: T0, selfUid: UID });
    expect(codex.ok === false && [codex.reason, codex.line]).toEqual(['not-descendant', 'proxy: this process does not run inside the CLAUDE-OP session — a --from/ELANOUS_TRACK name is not an identity']);
    expect(verifyProxyCaller({ stateRoot: r, pid: 302, lookup, now: T0, selfUid: UID }).ok).toBe(false);
  });
  test('pid reuse (same pid, new start time) and a dead runtime are refused; the grant expires after 7 days', () => {
    const r = root();
    const { lookup, procs } = table();
    writeProxyGrant(r, procs.get(100)!, T0);
    const reused = table([{ pid: 100, ppid: 10, uid: UID, start: '9999:0', name: 'claude' }]);
    expect((verifyProxyCaller({ stateRoot: r, pid: 102, lookup: reused.lookup, now: T0, selfUid: UID }) as { reason: string }).reason).toBe('runtime-gone');
    const gone: ProcLookup = (pid) => (pid === 100 ? undefined : lookup(pid));
    expect((verifyProxyCaller({ stateRoot: r, pid: 102, lookup: gone, now: T0, selfUid: UID }) as { reason: string }).reason).toBe('runtime-gone');
    expect((verifyProxyCaller({ stateRoot: r, pid: 102, lookup, now: T0 + 7 * 24 * 60 * 60_000 + 1, selfUid: UID }) as { reason: string }).reason).toBe('expired');
  });
  test('a hand-written grant (no audit row), a loose file mode or a symlink is ignored', () => {
    const r = root();
    const { lookup, procs } = table();
    const g = writeProxyGrant(r, procs.get(100)!, T0);
    writeFileSync(join(r, 'proxy', 'audit.jsonl'), '');
    expect((verifyProxyCaller({ stateRoot: r, pid: 102, lookup, now: T0, selfUid: UID }) as { reason: string }).reason).toBe('grant-unaudited');
    writeFileSync(join(r, 'proxy', 'audit.jsonl'), `${JSON.stringify({ event: 'grant', grantId: g.grantId })}\n`);
    expect(verifyProxyCaller({ stateRoot: r, pid: 102, lookup, now: T0, selfUid: UID }).ok).toBe(true);
    chmodSync(join(r, 'proxy', 'grants.json'), 0o644);
    expect(readProxyGrant(r, 'CLAUDE-OP', UID).unsafe).toBe(true);
    const r3 = root();
    writeProxyGrant(r3, procs.get(100)!, T0);
    rmSync(join(r3, 'proxy', 'grants.json'));
    symlinkSync(join(r, 'proxy', 'grants.json'), join(r3, 'proxy', 'grants.json'));
    expect((verifyProxyCaller({ stateRoot: r3, pid: 102, lookup, now: T0, selfUid: UID }) as { reason: string }).reason).toBe('grant-unsafe');
  });
  test('revoke ends it and writes a revoke row', () => {
    const r = root();
    const { lookup, procs } = table();
    writeProxyGrant(r, procs.get(100)!, T0);
    expect(revokeProxyGrant(r, 'CLAUDE-OP', T0 + 1)).toBe(true);
    expect((verifyProxyCaller({ stateRoot: r, pid: 102, lookup, now: T0 + 2, selfUid: UID }) as { reason: string }).reason).toBe('no-grant');
    expect(readFileSync(join(r, 'proxy', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event)).toEqual(['grant', 'revoke']);
  });
});

describe('authority — allow-list · deny-list · audit rows · OP notice', () => {
  test('an allowed op from the proxy session is audited and noticed; a deny-listed op never passes', () => {
    const r = root();
    const { lookup, procs } = table();
    writeProxyGrant(r, procs.get(100)!, T0);
    const notices: string[] = [];
    const ok = proxyAuthority({ stateRoot: r, op: 'seat-assign', target: 'TC A12', pid: 102, lookup, now: T0, selfUid: UID, notify: (l) => notices.push(l), log: () => {} });
    expect(ok.ok && ok.notice).toBe('[Claude OP 대행] seat-assign TC A12');
    expect(notices).toEqual(['[Claude OP 대행] seat-assign TC A12']);
    for (const op of ['paid-vm', 'secret', 'jud-veto', 'force-push', 'merge', 'pkill', 'crown-directive']) {
      const d = proxyAuthority({ stateRoot: r, op, pid: 102, lookup, now: T0, selfUid: UID, notify: (l) => notices.push(l), log: () => {} });
      expect(d.ok === false && d.denied).toBe(true);
    }
    expect(proxyAuthority({ stateRoot: r, op: 'delete-repo', pid: 102, lookup, now: T0, selfUid: UID, notify: () => {}, log: () => {} }).ok).toBe(false);
    const rows = readFileSync(join(r, 'proxy', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((x) => `${x.event}:${x.op ?? ''}:${x.result ?? x.reason ?? ''}`)).toEqual([
      'grant::', 'action:seat-assign:allowed',
      'refused:paid-vm:denied-op', 'refused:secret:denied-op', 'refused:jud-veto:denied-op', 'refused:force-push:denied-op',
      'refused:merge:denied-op', 'refused:pkill:denied-op', 'refused:crown-directive:denied-op', 'refused:delete-repo:not-allowed',
    ]);
    expect(notices).toEqual(['[Claude OP 대행] seat-assign TC A12']);
  });
  test('resolveProxyActor: a claimed CLAUDE-OP that verifies acts as OP; one that does not is refused; others pass through', () => {
    const r = root();
    const { lookup, procs } = table();
    writeProxyGrant(r, procs.get(100)!, T0);
    // the CLI runs as this test process: give it a place in the fake table under claude(100) / under codex(200)
    const self = process.pid;
    const under = (parent: number): ProcLookup => (pid) => (pid === self ? { pid: self, ppid: parent, uid: UID, start: '1:0', name: 'bun' } : lookup(pid));
    const asProxy = resolveProxyActor({ claimed: 'claude-op', op: 'land-unhold', target: '#40270', stateRoot: r, lookup: under(101), notify: () => {}, now: T0 });
    expect(asProxy).toEqual({ kind: 'proxy', actor: 'OP', notice: '[Claude OP 대행] land-unhold #40270' });
    const forged = resolveProxyActor({ claimed: 'CLAUDE-OP', op: 'land-unhold', stateRoot: r, lookup: under(201), notify: () => {}, now: T0 });
    expect(forged.kind).toBe('refused');
    expect(resolveProxyActor({ claimed: 'TC', op: 'land-unhold', stateRoot: r, lookup, now: T0 })).toEqual({ kind: 'not-proxy' });
  });
});

describe('els doors — unowned tab close and the tool door', () => {
  test('authorizeRequest: proxyConfirmed stands in for a person on an UNOWNED tab only — never the OP tab', () => {
    const owner = { kind: 'outsider', note: 'no pane credential' } as const;
    const plain = { tabId: 't-plain', workspace: 'w', ownerSeats: [] as (string | null)[] };
    const opTab = { tabId: 't-op', workspace: 'w', ownerSeats: [null], opTab: true };
    expect(authorizeRequest(owner, { op: 'close-tab', tab: 't-plain' }, 'w', undefined, plain).allow).toBe(false);
    expect(authorizeRequest(owner, { op: 'close-tab', tab: 't-plain', proxyConfirmed: true } as never, 'w', undefined, plain).allow).toBe(true);
    const refused = authorizeRequest(owner, { op: 'close-tab', tab: 't-op', proxyConfirmed: true } as never, 'w', undefined, opTab);
    expect(refused.allow === false && refused.reason).toBe('els: close-tab denied — the OP tab itself is closed only with a person\'s confirmation');
  });
  test('proxyPeerAuthority: the proxy peer gets one audited use; a reused pid or a non-descendant leaves no audit row', () => {
    const r = root();
    const { lookup, procs } = table();
    writeProxyGrant(r, procs.get(100)!, T0);
    const notices: string[] = [];
    const ok = proxyPeerAuthority({ pid: 102, expectStart: '1102:0', op: 'els-close-unowned', target: 't-plain', stateRoot: r, lookup, notify: (l) => notices.push(l), now: T0 });
    expect(ok !== undefined && ok.live()).toBe(true);
    expect(proxyPeerAuthority({ pid: 102, expectStart: '7:0', op: 'els-act', stateRoot: r, lookup, notify: (l) => notices.push(l), now: T0 })).toBeUndefined();
    expect(proxyPeerAuthority({ pid: 202, expectStart: '1202:0', op: 'els-act', stateRoot: r, lookup, notify: (l) => notices.push(l), now: T0 })).toBeUndefined();
    expect(notices).toEqual(['[Claude OP 대행] els-close-unowned t-plain']);
    expect(readFileSync(join(r, 'proxy', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event)).toEqual(['grant', 'action']);
  });
});

describe('CLAUDE-OP-PROXY-IDENTITY sim world (seeds 1–5 · impersonation · audit)', () => {
  // A seeded evening: random callers (the proxy session's children, codex/UX/person shells, a pid-reused claude, a
  // revoked or expired grant) attempt random ops (allowed and deny-listed). Invariants per seed:
  //   I1 an action row exists iff the caller descends from the live granted process, the grant is live and the op is allowed;
  //   I2 every attempt leaves exactly one audit row (action or refused); I3 deny-listed ops never yield an action row;
  //   I4 one OP notice per action row, none for refusals.
  function rng(seed: number): () => number { let x = seed * 2654435761 >>> 0; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); }
  const OPS = ['update-all', 'els-act', 'seat-assign', 'land-unhold', 'els-close-unowned', 'paid-vm', 'secret', 'jud-veto', 'force-push', 'pkill', 'merge'];
  const CALLERS = [{ pid: 102, proxy: true }, { pid: 101, proxy: true }, { pid: 202, proxy: false }, { pid: 302, proxy: false }, { pid: 42, proxy: false }];
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, () => {
      const r = rng(seed);
      const dir = root();
      const { lookup, procs } = table();
      writeProxyGrant(dir, procs.get(100)!, T0);
      let notices = 0; let attempts = 0; let expectedActions = 0;
      let revokedAt = Infinity;
      for (let i = 0; i < 60; i++) {
        const now = T0 + i * 5 * 60_000;
        if (i === 40 && r() < 0.5) { revokeProxyGrant(dir, 'CLAUDE-OP', now); revokedAt = i; }
        const caller = CALLERS[Math.floor(r() * CALLERS.length)]!;
        const op = OPS[Math.floor(r() * OPS.length)]!;
        const reused = r() < 0.1;
        const look: ProcLookup = reused ? (pid) => (pid === 100 ? { ...procs.get(100)!, start: '42:0' } : lookup(pid)) : lookup;
        attempts += 1;
        const a = proxyAuthority({ stateRoot: dir, op, pid: caller.pid, lookup: look, now, selfUid: UID, notify: () => { notices += 1; }, log: () => {} });
        const should = caller.proxy && !reused && i < revokedAt && ['update-all', 'els-act', 'seat-assign', 'land-unhold', 'els-close-unowned'].includes(op);
        expect(a.ok).toBe(should); // I1
        if (should) expectedActions += 1;
      }
      const rows = readFileSync(join(dir, 'proxy', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const acts = rows.filter((x) => x.event === 'action');
      expect(acts.length + rows.filter((x) => x.event === 'refused').length).toBe(attempts); // I2
      expect(acts.every((x) => !['paid-vm', 'secret', 'jud-veto', 'force-push', 'pkill', 'merge'].includes(x.op))).toBe(true); // I3
      expect(acts.length).toBe(expectedActions);
      expect(notices).toBe(expectedActions); // I4
    });
  }
});

describe('grant on the installed build — an SSH terminal and Claude Code named by its version (rail 67 refusal)', () => {
  // ssh: launchd(1) → sshd(900, root, unreadable by proc_pidinfo) → sshd-session(901, 501) → zsh(902) → bun eln(903)
  // Claude OP: herdr(5) → zsh(10) → «2.1.331»(100, argv0 claude) → zsh(101) → bun(102)
  const procs = new Map<number, ProcInfo>([
    [901, { pid: 901, ppid: 900, uid: UID, start: '901:0', name: 'sshd-session' }],
    [902, { pid: 902, ppid: 901, uid: UID, start: '902:0', name: '-zsh' }],
    [903, { pid: 903, ppid: 902, uid: UID, start: '903:0', name: 'bun' }],
    [5, { pid: 5, ppid: 1, uid: UID, start: '5:0', name: 'herdr' }],
    [10, { pid: 10, ppid: 5, uid: UID, start: '10:0', name: '-zsh' }],
    [100, { pid: 100, ppid: 10, uid: UID, start: '100:0', name: '2.1.331' }],
    [101, { pid: 101, ppid: 100, uid: UID, start: '101:0', name: 'zsh' }],
    [102, { pid: 102, ppid: 101, uid: UID, start: '102:0', name: 'bun' }],
  ]);
  const lookup: ProcLookup = (pid) => procs.get(pid); // 900 (root sshd) is not readable
  const argv: Record<number, string> = { 900: '/usr/sbin/sshd', 901: 'sshd-session:', 902: '-zsh', 903: 'bun', 5: 'herdr', 10: '-zsh', 100: 'claude', 101: 'zsh', 102: 'bun' };
  const meta = (owner: boolean) => (pid: number) => (pid === 900 ? (owner ? { uid: 0, ppid: 1, argv0: '/usr/sbin/sshd' } : undefined)
    : procs.has(pid) ? { uid: UID, ppid: procs.get(pid)!.ppid, argv0: argv[pid]! } : undefined);
  test('the root sshd parent is read with ps: another account → the walk is complete → claude (argv0) pid 100 is granted', () => {
    const v = grantPreflight({ selfPid: 903, stdinIsTTY: true, runtimePid: 100, lookup, meta: meta(true) });
    expect(v.ok && v.runtime.pid).toBe(100);
  });
  test('owner unreadable too, but the last observed hop is sshd-session → complete; any other unreadable hop fails closed', () => {
    expect(grantPreflight({ selfPid: 903, stdinIsTTY: true, runtimePid: 100, lookup, meta: meta(false) }).ok).toBe(true);
    const gap = grantPreflight({ selfPid: 102, stdinIsTTY: true, runtimePid: 100, lookup: (pid) => (pid === 10 ? undefined : lookup(pid)), meta: () => undefined });
    expect(gap.ok === false && gap.reason).toBe('ancestry-unknown');
  });
  test('Claude Code named by its version is still an agent ancestor (argv0) — granting from inside it refuses', () => {
    const inside = grantPreflight({ selfPid: 102, stdinIsTTY: true, runtimePid: 100, lookup, meta: meta(true) });
    expect(inside.ok === false && [inside.reason, inside.line]).toEqual(['agent-ancestor', 'eln proxy grant: refused — this terminal runs inside claude (pid 100); open your own terminal']);
  });
  test('meta present but an ancestor\'s argv0 unreadable (ps failed for it) → fail closed, never name-only', () => {
    const blind = (pid: number) => (pid === 100 ? undefined : meta(true)(pid));
    const v = grantPreflight({ selfPid: 102, stdinIsTTY: true, runtimePid: 100, lookup, meta: blind });
    expect(v.ok === false && v.reason).toBe('ancestry-unknown');
  });
  test('without argv0 a version-named process is not claude', () => {
    const v = grantPreflight({ selfPid: 903, stdinIsTTY: true, runtimePid: 100, lookup, meta: (pid) => (pid === 900 ? { uid: 0, ppid: 1, argv0: 'sshd' } : pid === 100 ? { uid: UID, ppid: 10, argv0: '/x/versions/2.1.331' } : meta(true)(pid)) });
    expect(v.ok === false && [v.reason, v.line]).toEqual(['runtime-not-claude', 'eln proxy grant: process 100 is 2.1.331, not a Claude Code session (claude)']);
  });
  test('the verify side is name-free: a descendant of the granted pid ⊕ start verifies though the kernel name is a version', () => {
    const r = root();
    writeProxyGrant(r, procs.get(100)!, T0);
    expect(verifyProxyCaller({ stateRoot: r, pid: 102, lookup, now: T0, selfUid: UID }).ok).toBe(true);
  });
});
