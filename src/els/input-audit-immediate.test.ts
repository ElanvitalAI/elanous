// ELS-SECURITY-AUDIT-IMMEDIATE (OP #130745 · #130768 — 보안 판정 JUD-2): a refused input is a
// security event; its audit row lands the moment the refusal happens — never delayed in the
// fast-path's 500 ms buffer, never dropped. Accepted ordinary keys KEEP the buffered lane
// (#39575's latency budget: one disk write per burst). Expected values are literals of THIS
// contract, independent of any product constant:
//   phase 1 — a guarded refusal (approval letter 'y' on an approval screen → exitCode 1) writes
//             its 'executor-refused' row immediately, before any buffer flush could run;
//   phase 2 — a fast-lane refusal (pty.write throws → exitCode 1) also writes its row
//             immediately (the pre-#39575 server wrote one row per input outcome);
//   phase 3 — an accepted ordinary key ('a') reaches the ledger only after the buffered flush
//             (~500 ms), proving the fix did not make every key synchronous.
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ElsPty } from './core.js';
import { attachEls, type AttachFrame } from './attach-client.js';
import { requestEls } from './client.js';
import { elsSocketPath, startElsServer } from './server.js';
import { AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { processIdentity } from './peer-seat.js';

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 20)); }
};

// Ratchet (env-without-restore, OP #131710): save the original env in beforeEach, restore it in
// afterEach (including the delete case) — a test file must never leak process.env into its neighbors.
const envTokenAtStart = process.env[AUTH_PANE_TOKEN_ENV];
beforeEach(() => { if (envTokenAtStart === undefined) delete process.env[AUTH_PANE_TOKEN_ENV]; else process.env[AUTH_PANE_TOKEN_ENV] = envTokenAtStart; });
afterEach(() => { if (envTokenAtStart === undefined) delete process.env[AUTH_PANE_TOKEN_ENV]; else process.env[AUTH_PANE_TOKEN_ENV] = envTokenAtStart; });

test.skipIf(process.platform !== 'darwin')('refused inputs are audited immediately; accepted keys keep the buffered lane', async () => {
  if (process.env.ELS_ATTACH_PRIVATE_TTY !== '1') {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path, '-t', 'refused inputs are audited immediately'], {
      env: { ...process.env, ELS_ATTACH_PRIVATE_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toMatchObject({ code: 0, output: expect.stringContaining('1 pass') });
    return;
  }
  const cleanups: (() => void)[] = [];
  try {
    const root = mkdtempSync(join(tmpdir(), 'els-auditimm-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const identity = processIdentity(process.pid);
    expect(identity).toBeDefined();
    // '!' makes the PTY write fail once — the fast lane's synchronous refusal (phase 2).
    let failBang = true;
    const pty: ElsPty = {
      id: 'pty_1', isAlive: () => true,
      write: (text) => { if (text === '!' && failBang) { failBang = false; throw new Error('gone'); } },
      // An approval screen: the guarded lane refuses approval letters typed by a pane credential.
      renderScreen: async () => 'Bash approval · Full command\ny run · n deny · Enter default N · Esc deny',
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
    const pane = (JSON.parse((await requestEls(elsSocketPath(root), { op: 'new', ws: 'HAND-TST', cwd: root, command: ['sh'] })).message) as { pane: string }).pane;
    const token = captured?.[AUTH_PANE_TOKEN_ENV];
    expect(typeof token).toBe('string');
    const allowFile = join(root, 'els', 'control-allow.json');
    mkdirSync(join(root, 'els'), { recursive: true });
    writeFileSync(allowFile, JSON.stringify({ rules: [{ principal: `els-pane:${pane}`, workspace: 'HAND-TST', pane: '*', actions: ['input'], effect: 'allow' }] }));
    process.env[AUTH_PANE_TOKEN_ENV] = token;
    const frames: AttachFrame[] = [];
    const errors: string[] = [];
    const attached = attachEls(elsSocketPath(root), pane, { cols: 80, rows: 24 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {}, onError: (message) => errors.push(message) });
    cleanups.push(() => attached.detach());
    await until(() => frames.length > 0);
    const auditPath = join(root, 'els', 'control-audit.jsonl');
    const inputRows = (): Record<string, unknown>[] => (existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '')
      .split('\n').filter((line) => line.includes('"action":"input"')).map((line) => JSON.parse(line) as Record<string, unknown>);
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');

    // Phase 1 — guarded refusal: 'y' on an approval screen is refused (exitCode 1). Its row must
    // exist the moment the error line is back — a 500 ms buffer would still be holding it.
    attached.input('y');
    await until(() => errors.length >= 1, 10_000);
    const refusedRows = inputRows();
    expect(refusedRows).toHaveLength(1);
    expect(refusedRows[0]).toMatchObject({ action: 'input', result: 'executor-refused', chars: 1, exitCode: 1, sha256: sha('y') });

    // Phase 2 — fast-lane refusal: '!' fails pty.write synchronously (exitCode 1). Same
    // immediacy: the pre-#39575 server wrote one row per input outcome.
    attached.input('!');
    await until(() => errors.length >= 2, 10_000);
    const fastRows = inputRows();
    expect(fastRows).toHaveLength(2);
    expect(fastRows[1]).toMatchObject({ action: 'input', result: 'executor-refused', chars: 1, exitCode: 1, sha256: sha('!') });

    // Phase 3 — an accepted ordinary key keeps the buffered lane: right after the key (and its
    // error-free delivery) no third row exists yet; it lands with the ~500 ms flush.
    attached.input('a');
    await until(() => errors.length >= 2 && frames.length > 0, 1_000).catch(() => undefined); // let the line settle, well under 500 ms
    expect(inputRows()).toHaveLength(2);   // buffered — not yet on disk
    await until(() => inputRows().length === 3, 5_000);   // the flush lands
    expect(inputRows()[2]).toMatchObject({ action: 'input', result: 'executed', chars: 1, exitCode: 0, sha256: sha('a') });
    // 30 s: the scene spawns a script-wrapped child of this file (출처: #129755 harness shape).
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
  }
}, 30_000);
