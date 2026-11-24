// ELS-WHEEL-SCROLLBACK (OP #136704): a wheel over an alternate-screen pane that tracks its own
// mouse (?1049h + ?1000h/?1006h) must reach the pane as bytes — els has no scrollback lane to
// spin there (baseY=0 → clamped to 0), and swallowing the wheel leaves `eln`/`less` panes with
// their own scroller unable to scroll at all. A wheel over a normal-buffer pane keeps asking els
// to scroll the els scrollback (the existing lane — unchanged).
//
// The lane's completion line (JUD-C #137142 → JUD-B #137144 교차 판정): the two tests above route the
// wheel (app level); the server-level tests below run the real lane end to end — a 1000-line shell
// reaches its FIRST line, the ring stays memory-bounded (only the newest 1000 lines kept), and new
// pane output returns a scrolled view to the bottom. The scroll-position indicator while scrolled is
// the app status line (attach-app.test.ts: '스크롤백 N줄 위').
import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachEls, type AttachFrame, type AttachHandlers, type Attached } from './attach-client.js';
import { createAttachApp } from './attach-app.js';
import { requestEls } from './client.js';
import type { ElsResult } from './core.js';
import { elsSocketPath, startElsServer, type ElsRequest } from './server.js';
import { guardElsProcesses, reapElsProcesses } from './test-support/els-process-guard.js';

const row = (ws: string, pane: string) => ({ address: `${ws}/t1/${pane}`, workspace: `name-${ws}`, pane, title: 'alt', state: 'working' });
const listOf = (...panes: object[]): string => JSON.stringify({ workspaces: [], tabs: [], panes });
const WHEEL_UP = '\u001b[<64;60;10M';                                 // SGR 1006 wheel-up over the pane

type FramePayload = Parameters<AttachHandlers['onFrame']>[0];

function harness() {
  const listing = listOf(row('w1', 'p1'));
  const requests: ElsRequest[] = [];
  const attachments: { pane: string; handlers: AttachHandlers; typed: string[]; scrolls: number[] }[] = [];
  const app = createAttachApp({
    request: async (request: ElsRequest): Promise<ElsResult> => {
      requests.push(request);
      if (request.op === 'ls') return { exitCode: 0, message: listing };
      return { exitCode: 0, message: '' };
    },
    attach: (pane: string, size: { cols: number; rows: number }, handlers: AttachHandlers): Attached => {
      const a = { pane, size, handlers, typed: [] as string[], resizes: [] as [number, number][], scrolls: [] as number[], detached: false };
      attachments.push(a);
      return {
        input: (text: string) => { a.typed.push(text); },
        resize: (cols: number, rows: number) => { a.resizes.push([cols, rows]); },
        scroll: (lines: number) => { a.scrolls.push(lines); },   // Attached.scroll (attach-client.ts:27) — the wheel lane today
        detach: () => { a.detached = true; },
      } as unknown as Attached;
    },
    write: () => {},
    size: () => ({ cols: 80, rows: 24 }),
    cwd: '/tmp',
    env: {},
    setInterval: () => 0,
    clearInterval: () => {},
    pollMs: 60_000,
    chatCommand: ['elanous'],
    memory: { load: () => ({}), save: () => {} },
  });
  return { app, attachments, requests };
}

test('wheel over an alternate-screen pane that tracks its own mouse reaches the pane as bytes', async () => {
  const h = harness();
  await h.app.start('p1');
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 23, back: 0, screen: '[screen 51x23 scrolled-back=0]', wheelPassthrough: true } as FramePayload);
  h.app.key(WHEEL_UP);
  // ELS-WHEEL-HISTORY: the report reaches the pane at PANE coordinates — screen col 60 minus the 28-col side list and its
  // divider = 31, screen row 10 minus the tab row = 9 (the raw screen coordinates were off by the els chrome).
  expect(h.attachments[0]!.typed).toEqual(['\u001b[<64;31;9M']);
  expect(h.attachments[0]!.scrolls).toEqual([]);
});

test('wheel over a normal-buffer pane keeps asking els to scroll the els scrollback', async () => {
  const h = harness();
  await h.app.start('p1');
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 23, back: 0, screen: '[screen 51x23 scrolled-back=0]' } as FramePayload);
  h.app.key(WHEEL_UP);
  expect(h.attachments[0]!.scrolls).toEqual([3]);
  expect(h.attachments[0]!.typed).toEqual([]);
});

// ── The real lane end to end: a throwaway els server with a real /bin/sh pane (attach-pty.test.ts pattern) ──
guardElsProcesses();

// The env this process inherited from whatever els pane runs the suite carries a credential that is foreign to
// the throwaway server below — the auth line it would make `requestEls` send gets refused and the answer misread
// (the ssh-bridge tests' pattern of scrubbing ELANOUS_ELS_*). Restored after this file's tests.
const scrubbedElsEnv: Array<[string, string]> = [];
for (const name of Object.keys(process.env)) {
  if (!name.startsWith('ELANOUS_ELS_')) continue;
  const value = process.env[name];
  if (value !== undefined) scrubbedElsEnv.push([name, value]);
  delete process.env[name];
}
afterAll(() => { for (const [name, value] of scrubbedElsEnv) process.env[name] = value; });

// This file's real-pane tests boot a throwaway server whose login-env capture (login-env-handoff.ts →
// shell-env-bootstrap.ts: `$SHELL -l -i -c printenv`) feeds every holder stdin. The gate's guard runner
// (hq-find-guard bun) rebuilds the environment with `/usr/bin/env -i` from an allowlist that carries no
// SHELL: the capture then never succeeds, and the holder refuses to spawn the pane child at all
// (holder-main.ts JUD-2 필수 1 — fail-closed), so not one frame ever arrives and the lane tests starve at
// their 15 s waits (#39847 gate r1/r2 RED; E1/E3 vs E2 repro — OP #137617). Hand the capture a login shell
// while this file's tests run — only when the environment came without one; removed again after.
const shellEnvWasMissing = process.env.SHELL === undefined;
if (shellEnvWasMissing) process.env.SHELL = '/bin/zsh';
afterAll(() => { if (shellEnvWasMissing) delete process.env.SHELL; });

const serverCleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of serverCleanups.splice(0).reverse()) await cleanup(); await reapElsProcesses(); });
const until = async (check: () => boolean, ms = 15_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 20)); }
};

/** Boots a throwaway server and one real /bin/sh pane running `script`; everything it leaves is cleaned up after. */
async function shPane(script: string): Promise<{ socket: string; pane: string }> {
  const root = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'els-wheelsb-'));
  serverCleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  serverCleanups.push(() => started.close());
  const socket = elsSocketPath(root);
  const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh', '-c', script] });
  if (created.exitCode !== 0) throw new Error(created.message);
  const { pane } = JSON.parse(created.message) as { pane: string };
  serverCleanups.push(async () => { await requestEls(socket, { op: 'close', pane }); });
  return { socket, pane };
}

/** Watches the pane through a real attach — every frame the server pushes lands in `frames`. */
async function watchLane(socket: string, pane: string): Promise<{ frames: AttachFrame[]; attached: Attached }> {
  const frames: AttachFrame[] = [];
  const attached = attachEls(socket, pane, { cols: 60, rows: 10 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {} });
  serverCleanups.push(() => attached.detach());
  return { frames, attached };
}

test('a 1000-line shell: scrolling up reaches the FIRST line of the history (the lane holds the whole shell)', async () => {
  const { socket, pane } = await shPane('i=1; while [ "$i" -le 1000 ]; do printf "SHELL-LINE-%04d\\n" "$i"; i=$((i+1)); done; sleep 30');
  const { frames, attached } = await watchLane(socket, pane);
  await until(() => frames.some((f) => f.screen.includes('SHELL-LINE-1000')));
  attached.scroll(100_000);                                // far past the top — the server clamps to what the ring kept
  await until(() => frames.some((f) => (f.back ?? 0) >= 900));   // clamped at the ring top (1001 buffer lines − 10 rows = 991)
  const top = frames.find((f) => (f.back ?? 0) >= 900)!;
  expect(top.back).toBeLessThanOrEqual(1000);               // the ring never reports more than it keeps
  expect(top.screen).toContain('SHELL-LINE-0001');         // the FIRST line is on screen
  expect(top.screen).not.toContain('SHELL-LINE-1000');
}, 30_000);

test('a pane past the cap: the ring keeps only the newest 1000 lines — memory stays bounded', async () => {
  const { socket, pane } = await shPane('i=1; while [ "$i" -le 2600 ]; do printf "SHELL-LINE-%04d\\n" "$i"; i=$((i+1)); done; sleep 30');
  const { frames, attached } = await watchLane(socket, pane);
  await until(() => frames.some((f) => f.screen.includes('SHELL-LINE-2600')));
  attached.scroll(100_000);
  await until(() => frames.some((f) => f.back === 1000));   // clamped at the ring size — never 2590
  const top = frames.find((f) => f.back === 1000)!;
  expect(top.screen).toContain('SHELL-LINE-1592');         // the oldest line the ring still keeps (2601 − 1010 + 1)
  expect(top.screen).not.toContain('SHELL-LINE-1590');     // everything older dropped
  expect(top.screen).not.toContain('SHELL-LINE-0001');
}, 30_000);

test('new pane output returns a scrolled view to the bottom (nothing typed — the pane itself printed)', async () => {
  // `sleep 8` keeps the pane alive past the assertion window: the exit frame (a final bottom render on pane
  // death) must not satisfy the return — only the pane's own new output while it still runs can (probe: the
  // pre-fix view sticks at back=11 with the late line off-screen until exit, and only the exit frame is bottom).
  const { socket, pane } = await shPane('i=1; while [ "$i" -le 20 ]; do printf "HISTORY-LINE-%02d\\n" "$i"; i=$((i+1)); done; sleep 0.4; printf "LATE-NEW-OUTPUT\\n"; sleep 8');
  const { frames, attached } = await watchLane(socket, pane);
  await until(() => frames.some((f) => f.screen.includes('HISTORY-LINE-20')));
  attached.scroll(15);                                     // clamps to 11 (21 buffer lines − 10 rows): the view is scrolled up
  await until(() => frames.some((f) => f.back === 11));
  // 0.4 s later the pane prints on its own — the lane returns to the live bottom, the late line on screen.
  await until(() => frames.some((f) => f.back === 0 && f.screen.includes('LATE-NEW-OUTPUT')), 4_000);
}, 30_000);