// ELS-POD-TAB (칸 스펙 출처: seat-state/OP/orders/WORKER-MIGRATION-PHASE1-1119.md 40·45행 — 논리 트리는 워크스페이스 >
// 탭 > 자식 탭, 물리는 놓인 곳(place) 속성 { host, runtime: process | pod }). A Pod is a TAB, never a workspace or
// host: its screen is that pod's log stream — the HOST's own els runs kubectl, so the credentials never leave the
// host — and its steering is a control inbox soft memo, never PTY bytes. 완료 경계(OP #112010): fake kubectl 로
// Pod 탭 화면 스트림 + place.runtime=pod 배지 1회 관측.
//
// Methodology (ii) from the cell order: the badge and the ls contract are light view/serialization observations
// (space-tabs-view.test.ts style), while the stream itself is measured on a REAL els server + real PTY running a
// fake kubectl executable (attach-pty.test.ts style — every opened process is cleaned up).
import { afterAll, afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachEls, type AttachFrame } from './attach-client.js';
import { parsePaneRows } from './attach-view.js';
import { requestEls } from './client.js';
import { elsSocketPath, startElsServer } from './server.js';
import { buildTabRow, withCommands } from './space-tabs-view.js';
import { guardElsProcesses, reapElsProcesses } from './test-support/els-process-guard.js';

guardElsProcesses();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await reapElsProcesses(); });
// 출처: #39791 r2 게이트 RED — the pregate guard runs this file under `env -i`, which strips SHELL, so the
// login-env capture is impossible and a holder refuses (fail-closed — the adoption-secret gate, holder-main)
// to spawn its pane child: the stream starves at the gate while the same tree passes in a full env. This
// universe opts out of the capture instead — the blessed path holder-main names for gate hosts — and it
// needs no login rc env anyway: the fake kubectl runs by absolute path, so the holder's process.env base
// is exactly right here.
const priorSkipLoginEnv = process.env.ELANOUS_SKIP_LOGIN_ENV;
process.env.ELANOUS_SKIP_LOGIN_ENV = '1';
afterAll(() => { if (priorSkipLoginEnv === undefined) delete process.env.ELANOUS_SKIP_LOGIN_ENV; else process.env.ELANOUS_SKIP_LOGIN_ENV = priorSkipLoginEnv; });
// 출처: #39791 RAMP-0334 — 15 s starved while several pregate trains share the host (0.3.34 runs 3-parallel); 45 s stays inside the 60 s test bound.
const until = async (check: () => boolean, ms = 45_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 20)); }
};

// A fake `kubectl` in the SIM-FAKE-BIN shape (a tiny executable in its own temp dir, spawned here by absolute path
// so the els server needs no PATH change): `kubectl logs -f <pod>` streams two distinguishing lines, then a
// heartbeat every second so a still-streaming tab keeps producing frames. Closing the pane kills it with the PTY.
const fakeKubectl = (dir: string): string => {
  const bin = join(dir, 'kubectl');
  writeFileSync(bin, [
    '#!/bin/sh',
    'printf "ELS_POD_TAB_STREAM_LINE_1\\nELS_POD_TAB_STREAM_LINE_2\\n"',
    'while :; do printf "ELS_POD_TAB_HEARTBEAT\\n"; sleep 1; done',
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return bin;
};

/** One els test universe: a temp state root, a real server, one live Pod tab (a pane running the fake kubectl). */
const podTab = async (): Promise<{ socket: string; pane: string }> => {
  const root = mkdtempSync(join(tmpdir(), 'els-podtab-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const binDir = mkdtempSync(join(tmpdir(), 'els-podbin-'));
  cleanups.push(() => rmSync(binDir, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const socket = elsSocketPath(root);
  const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: [fakeKubectl(binDir), 'logs', '-f', 'eln-pod'] });
  if (created.exitCode !== 0) throw new Error(created.message);
  const { pane } = JSON.parse(created.message) as { pane: string };
  cleanups.push(async () => { await requestEls(socket, { op: 'close', pane }); });
  return { socket, pane };
};

test('ELS-POD-TAB ①: the Pod tab\'s screen is the pod\'s stream — the host\'s els runs (fake) kubectl and the pane shows its log lines', async () => {
  const { socket, pane } = await podTab();
  const frames: AttachFrame[] = [];
  const view = attachEls(socket, pane, { cols: 90, rows: 20 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {} });
  cleanups.push(() => view.detach());
  await until(() => frames.some((frame) => frame.screen.includes('ELS_POD_TAB_STREAM_LINE_2')));
}, 60_000); // 출처: attach-pty.test.ts — a real PTY plus waits of at most 45 s each

test('ELS-POD-TAB ②: the server stamps the pane row\'s place — { host, runtime: \'pod\' } rides the `els ls` answer', async () => {
  const { socket, pane } = await podTab();
  const listed = await requestEls(socket, { op: 'ls' });
  expect(listed.exitCode).toBe(0);
  const rows = (JSON.parse(listed.message) as { panes: { pane: string; place?: { host?: string; runtime?: string } }[] }).panes;
  expect(rows.find((row) => row.pane === pane)?.place).toEqual({ host: 'local', runtime: 'pod' });
}, 60_000);

test('ELS-POD-TAB ③: the tab row draws the pod badge — 📦 keeps the kubectl emoji, «[pod]» marks place.runtime=pod', () => {
  const ls = JSON.stringify({ panes: [
    { address: 'op/t1/p1', workspace: 'op', pane: 'p1', title: 'eln-pod', state: 'working', command: ['kubectl', 'logs', '-f', 'eln-pod'], place: { host: 'local', runtime: 'pod' } },
    { address: 'op/t1/p2', workspace: 'op', pane: 'p2', title: 'zsh', state: 'idle', command: ['zsh'] },
  ] });
  const rows = withCommands(parsePaneRows(ls), ls);
  // withCommands passes the server's place through to the tab row (the same lane as command/stalled).
  expect((rows[0]! as { readonly place?: unknown }).place).toEqual({ host: 'local', runtime: 'pod' });
  const line = (buildTabRow(rows, 'p1', 60).line ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  // #39800 moved the emoji out of the tab row (into the dropdown — WHAT the pane runs); «[pod]» is WHERE, so it
  // rides the name part right after the UPPERCASE label, and a narrow row cuts it as the name gives way.
  expect(line).toContain('ELN-POD [pod]');   // the pod place badge is explicit in the row's name part
  expect(line).not.toContain('📦');           // the kubectl emoji stays in the dropdown — the row carries no emoji
  expect(line).toContain('ZSH');              // a process pane of the same space keeps its plain tab …
  expect(line).not.toContain('ZSH [pod]');   // … without the pod badge
});

test('ELS-POD-TAB ④: control is a control-inbox soft memo — `els do` answers in memo words and no PTY bytes land in the stream', async () => {
  const { socket, pane } = await podTab();
  const frames: AttachFrame[] = [];
  const view = attachEls(socket, pane, { cols: 90, rows: 20 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {} });
  cleanups.push(() => view.detach());
  await until(() => frames.some((frame) => frame.screen.includes('ELS_POD_TAB_HEARTBEAT')));
  const memo = await requestEls(socket, { op: 'do', pane, text: 'ELS_POD_TAB_MEMO_LINE', from: 'OP' });
  expect(memo.exitCode).toBe(0);
  expect(memo.message).toContain('memo');            // the door answers in memo vocabulary …
  expect(memo.message).not.toContain('delivered');   // … not in PTY-delivery words
  // JUD-B #136279 / #39803: acknowledged is not received — the memo must LAND in the pod pane's control inbox
  // (persisted in the journal, newest last, bounded) and ride back out through `els ls`, the same lane as place,
  // stamped by the server's clock — while the stream below stays the pod's own.
  const readback = await requestEls(socket, { op: 'ls' });
  expect(readback.exitCode).toBe(0);
  const stored = (JSON.parse(readback.message) as { panes: { pane: string; place?: { runtime?: string };
      inbox?: { from: string; at: number; text: string }[] }[] }).panes.find((row) => row.pane === pane);
  expect(stored?.place?.runtime).toBe('pod');                       // the row is still the pod's
  expect((stored?.inbox ?? []).length).toBe(1);                     // exactly one memo accepted
  expect(stored?.inbox?.[0]?.from).toBe('OP');
  expect(stored?.inbox?.[0]?.text).toBe('ELS_POD_TAB_MEMO_LINE');
  expect(Number.isSafeInteger(stored?.inbox?.[0]?.at)).toBe(true); // server-stamped, not client-trusted
  // The stream keeps flowing (two more heartbeats) while neither the memo text nor the «⇢ from ·» marker ever lands.
  const seen = frames.length;
  await until(() => frames.length >= seen + 2);
  expect(frames.some((frame) => frame.screen.includes('ELS_POD_TAB_MEMO_LINE'))).toBe(false);
  expect(frames.some((frame) => frame.screen.includes('⇢ OP'))).toBe(false);
}, 60_000);
