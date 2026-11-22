// ELS-INPUT-FAST-PATH (OP #128948 1순위): a typed key on an authenticated attach must reach the PTY ahead of the
// server's other work for that pane — no screen render, no pane lock wait behind a `do` delivery, no async hop.
// The keyboard may never queue behind the server's own inspections.
//
// These tests bind the budget to the layer where it lives (core.machineFastInput), with the same fake-PTY fixture
// pattern as send-family.test.ts. The budget numbers are literals of THIS budget, independent of any product
// constant:
//   - while a `do` delivery holds the pane lock through a 50 ms renderScreen, a typed key reaches pty.write in < 5 ms
//     (the old machineInput lane makes this RED: it queues on the same lock);
//   - the fast lane renders no screen on its own path (the old lane renders one per key);
//   - approval letters (y/Y) and control bytes never take the fast lane — they go back to the guarded machine lane.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';
import { attachEls, type AttachFrame } from './attach-client.js';
import { requestEls } from './client.js';
import { elsSocketPath, startElsServer } from './server.js';
import { AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { processIdentity } from './peer-seat.js';

// The non-owner scene hands this process the pane token through the environment
// (AUTH_PANE_TOKEN_ENV). The file-level afterEach keeps that mutation a test-local
// fact — the env-without-restore ratchet's restore pair (출처: #129755 gate r1 RED).
const envTokenAtFileStart = process.env[AUTH_PANE_TOKEN_ENV];
afterEach(() => {
  if (envTokenAtFileStart === undefined) delete process.env[AUTH_PANE_TOKEN_ENV];
  else process.env[AUTH_PANE_TOKEN_ENV] = envTokenAtFileStart;
});

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 20)); }
};

/** A pane PTY whose renderScreen takes a literal 50 ms — the slow inspection a typed key must not wait behind. */
function slowRenderPty(writes: string[], renders: () => void, screen = 'ready\n'): ElsPty {
  return {
    id: 'pty_1',
    isAlive: () => true,
    write: (text: string) => { writes.push(text); },
    renderScreen: async () => { renders(); await new Promise((resolve) => setTimeout(resolve, 50)); return screen; },
    onExit: () => {},
    kill: () => {},
    resize: () => {},
  };
}

function bootCore(writes: string[], renders: () => void) {
  const core = createElsCore({ load: () => emptyJournal(), save: () => {}, spawn: () => slowRenderPty(writes, renders) });
  expect(core.start()).toBeUndefined();
  const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: '/tmp', command: ['/bin/sh'] }).message) as { pane: string }).pane;
  return { core, pane };
}

test('fast lane: a key typed while a do delivery holds the pane lock through a 50 ms render reaches pty.write in < 5 ms', async () => {
  const writes: string[] = [];
  let renders = 0;
  const { core, pane } = bootCore(writes, () => { renders += 1; });
  writes.length = 0;
  // A `do` line is in flight: it holds the pane's lock and its renderScreen takes 50 ms.
  const doAnswer = core.do(pane, 'echo hi', 'OP').catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));   // the do's inspection has the lock now
  const t0 = performance.now();
  const done = core.machineFastInput(pane, 'a');
  const typedMs = performance.now() - t0;
  expect('redirectToGuard' in done ? done : done.exitCode).toBe(0);
  expect(writes).toContain('a');
  expect(typedMs).toBeLessThan(5);   // 출처: #128948 — 이 예산 리터럴: 키는 느린 배달 뒤에 줄 서지 않는다
  await doAnswer;
});

test('fast lane path shape: a key triggers no screen render on its own path — the old lane rendered one per key', async () => {
  const writes: string[] = [];
  let renders = 0;
  const { core, pane } = bootCore(writes, () => { renders += 1; });
  await new Promise((resolve) => setTimeout(resolve, 80));   // any boot renders settle
  const rendersBefore = renders;
  const done = core.machineFastInput(pane, 'a');
  expect('redirectToGuard' in done ? done : done.exitCode).toBe(0);
  expect(writes).toEqual(['a']);
  await new Promise((resolve) => setTimeout(resolve, 80));   // a deferred render would land within 80 ms if it existed
  expect(renders).toBe(rendersBefore);   // the fast path renders no screen for the key
});

test('guarded lane keeps its defenses: y/Y approval letters and control bytes never take the fast lane to the PTY', async () => {
  const writes: string[] = [];
  let renders = 0;
  const { core, pane } = bootCore(writes, () => { renders += 1; });
  for (const bytes of ['y', 'Y', '\x1b', 'a\x03b']) {
    const fast = core.machineFastInput(pane, bytes);
    expect('redirectToGuard' in fast).toBe(true);   // the fast lane refuses to carry these
  }
  expect(writes).toEqual([]);   // nothing reached the PTY raw from the fast lane
  // The guarded machine lane still owns them (this screen is not a TUI, so approval letters are refused there too).
  expect((await core.machineInput(pane, 'y')).exitCode).toBe(2);
  expect(writes).toEqual([]);
});

// OP #129755 (JUD-B #129747): the non-owner attach end-to-end scene. A verified pane principal —
// this test process itself, bound as the pane shell (darwin, private TTY) — attaches to its own
// pane and types a mixed burst back to back: ordinary keys, approval letters (y/Y) and a control
// byte. Typed order survives end to end: the PTY sees every accepted key in typed order (the
// letters ride the guarded machine lane's paste envelope), and the audit ledger holds exactly one
// row per input line, in typed order, flushed by the attach's close.
test.skipIf(process.platform !== 'darwin')('non-owner attach: a mixed key burst keeps typed order on the PTY and one audit row per input, flushed at close', async () => {
  if (process.env.ELS_ATTACH_PRIVATE_TTY !== '1') {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path, '-t', 'non-owner attach: a mixed key burst'], {
      env: { ...process.env, ELS_ATTACH_PRIVATE_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toMatchObject({ code: 0, output: expect.stringContaining('1 pass') });
    return;
  }
  const envTokenAtStart = process.env[AUTH_PANE_TOKEN_ENV];
  const cleanups: (() => void)[] = [() => { if (envTokenAtStart === undefined) delete process.env[AUTH_PANE_TOKEN_ENV]; else process.env[AUTH_PANE_TOKEN_ENV] = envTokenAtStart; }];
  try {
    const root = mkdtempSync(join(tmpdir(), 'els-fast-nonowner-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const identity = processIdentity(process.pid);
    expect(identity).toBeDefined();
    const writes: string[] = [];
    const pty: ElsPty = {
      id: 'pty_1',
      isAlive: () => true,
      write: (text) => { writes.push(text); },
      renderScreen: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return 'ready\n'; },
      bracketedPasteEnabled: () => true,
      onExit: () => {}, kill: () => {}, resize: () => {},
    };
    let captured: Record<string, string> | undefined;
    let spawns = 0;
    const started = await startElsServer({
      stateRoot: root,
      spawn: (_command, _cwd, _title, env) => {
        spawns += 1;
        if (spawns === 1) captured = { ...(env as Record<string, string>) };
        return spawns === 1
          ? { ...pty, pid: process.pid, processBinding: { pid: process.pid, start: identity!.start, generation: 'fixture' } }
          : pty;
      },
    });
    if ('exitCode' in started) throw new Error(started.message);
    cleanups.push(() => { void started.close(); });
    // The pane's shell is this process, so its token makes the attach a verified pane principal —
    // a NON-owner line: humanApprovalKeys is false, the input branch is the fast/guarded pair.
    const pane = (JSON.parse((await requestEls(elsSocketPath(root), { op: 'new', ws: 'HAND-TST', cwd: root, command: ['sh'] })).message) as { pane: string }).pane;
    const token = captured?.[AUTH_PANE_TOKEN_ENV];
    expect(typeof token).toBe('string');
    // The door is default-deny for typing ops — `attach` is judged as `input` — and this pane's
    // principal carries seat 'unknown' (the pane was minted by an uncredentialed `new`), so no
    // coded default speaks for it: without a file rule the attach line itself is refused and no
    // frame ever arrives. The rule is this scene's own fixture, the working shape of the
    // JUD #39096 scene (attach.test.ts): principal els-pane:<id> · this pane's workspace · '*'.
    const allowFile = join(root, 'els', 'control-allow.json');
    mkdirSync(join(root, 'els'), { recursive: true });
    writeFileSync(allowFile, JSON.stringify({ rules: [{ principal: `els-pane:${pane}`, workspace: 'HAND-TST', pane: '*', actions: ['input'], effect: 'allow' }] }));
    process.env[AUTH_PANE_TOKEN_ENV] = token;
    const frames: AttachFrame[] = [];
    const attached = attachEls(elsSocketPath(root), pane, { cols: 80, rows: 24 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {}, onError: () => {} });
    cleanups.push(() => attached.detach());
    await until(() => frames.length > 0);
    // The mixed burst: ordinary keys, approval letters, a control byte — no gaps between the lines.
    const keys = ['a', 'y', '\x1b', 'b', '\r', 'Y', 'c'];
    for (const key of keys) attached.input(key);
    // The PTY sees every accepted key in typed order: the letters as the guarded lane's paste
    // envelopes, the bare control byte refused (never written), everything else as typed.
    const expectedWrites = ['a', '\x1b[200~y\x1b[201~', 'b', '\r', '\x1b[200~Y\x1b[201~', 'c'];
    await until(() => writes.length >= expectedWrites.length, 10_000);
    expect(writes).toEqual(expectedWrites);
    // Ledger order (출처: OP #130745 — refusals are security events, never buffered): the refused
    // control byte's row lands IMMEDIATELY at its refusal — before any 500 ms buffer could flush —
    // so it precedes the accepted keys' rows; the six accepted keys land in typed order from the
    // buffered flush (close included). Exactly one row per input line, chars + sha256 only.
    const ledgerOrder = ['\x1b', 'a', 'y', 'b', '\r', 'Y', 'c'];   // refusal first, accepted in typed order
    attached.detach();
    const auditPath = join(root, 'els', 'control-audit.jsonl');
    await until(() => {
      if (!existsSync(auditPath)) return false;
      return readFileSync(auditPath, 'utf8').split('\n').filter((line) => line.includes('"action":"input"')).length >= keys.length;
    }, 10_000);
    const rows = readFileSync(auditPath, 'utf8').split('\n').filter((line) => line.includes('"action":"input"')).map((line) => JSON.parse(line) as { chars: number; sha256: string; exitCode: number });
    expect(rows).toHaveLength(keys.length);
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(rows.map((row) => [row.chars, row.sha256, row.exitCode])).toEqual(ledgerOrder.map((key) => [1, sha(key), key === '\x1b' ? 2 : 0]));
    // 30 s: the scene spawns a script-wrapped child of this file — the 5 s runner default
    // would kill the end-to-end scene before the audit flush settles (출처: #129755).
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
  }
}, 30_000);
