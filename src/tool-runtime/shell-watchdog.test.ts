// A201 ELN-TOOL-STALL-WATCHDOG — 내부 문서 `ELN-STEER-AND-TOOL-WATCHDOG`
// Bounds come from the product constants; the only numbers here are tiny option inputs.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { dispatchBash } from '../skills/tools/index.js';
import { runShell, setAuditLogRootForTesting, setAuditSinkForTesting } from '../shell-primitive/index.js';
import {
  SHELL_MIN_TIMEOUT_MS, SHELL_STALL_ENV,
  setShellWatchdogStatusSink, shellWatchdogScreenLine,
} from './shell-watchdog.js';

/** Tiny stall line for tests (an option input, never an asserted bound). */
const TINY_STALL_MS = 200;
const TICK_SECONDS = '0.05';

let cwd: string;
let auditRoot: string;
let events: Array<{ category: string; event: string; data: unknown }>;
let screen: string[];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'shell-watchdog-'));
  auditRoot = mkdtempSync(join(tmpdir(), 'shell-watchdog-audit-'));
  setAuditLogRootForTesting(auditRoot);
  setAuditSinkForTesting(() => {});
  events = [];
  screen = [];
  logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    events.push({ category, event, data });
  }) as typeof debug.log);
  setShellWatchdogStatusSink((line) => { screen.push(line); });
});

afterEach(() => {
  logSpy.mockRestore();
  setShellWatchdogStatusSink(null);
  setAuditSinkForTesting(null);
  setAuditLogRootForTesting(null);
  delete process.env[SHELL_STALL_ENV];
  rmSync(cwd, { recursive: true, force: true });
  rmSync(auditRoot, { recursive: true, force: true });
});

const watchdogEvents = (event: string) => events.filter((e) => e.category === 'tool.watchdog' && e.event === event);

test('Bash: a silent sleeping command is stopped as stalled, observed, shown, and does not hang', async () => {
  const result = await dispatchBash({ command: 'sleep 30' }, { cwd, stallMs: TINY_STALL_MS });
  expect(result.watchdog?.status).toBe('stalled');
  expect(result.watchdog?.limitMs).toBe(TINY_STALL_MS);
  expect(result.watchdog!.lastOutputAgoMs).toBeGreaterThanOrEqual(TINY_STALL_MS);
  expect(result.timedOut).toBe(false);
  expect(result.output.startsWith(result.watchdog!.text)).toBe(true);
  expect(watchdogEvents('stalled')).toHaveLength(1);
  // One screen line through the status sink, the same text the formatter produces.
  expect(screen).toEqual([shellWatchdogScreenLine(result.watchdog!)]);
  expect(screen[0]).toContain('셸 명령 정체');
}, 10_000);

test('Bash: a command that prints periodically is not stalled', async () => {
  const result = await dispatchBash(
    { command: `for i in 1 2 3 4 5 6 7 8; do echo tick; sleep ${TICK_SECONDS}; done` },
    { cwd, stallMs: TINY_STALL_MS },
  );
  expect(result.watchdog).toBeUndefined();
  expect(result.exitCode).toBe(0);
  expect(watchdogEvents('stalled')).toHaveLength(0);
  expect(screen).toEqual([]);
}, 10_000);

test('Bash: the shared cap stops a chatty command at its timeout', async () => {
  const result = await dispatchBash(
    { command: `while true; do echo tick; sleep ${TICK_SECONDS}; done`, timeout: SHELL_MIN_TIMEOUT_MS },
    { cwd, stallMs: TINY_STALL_MS },
  );
  expect(result.watchdog?.status).toBe('timeout');
  expect(result.watchdog?.limitMs).toBe(SHELL_MIN_TIMEOUT_MS);
  expect(result.timedOut).toBe(true);
  expect(watchdogEvents('timeout')).toHaveLength(1);
  expect(screen).toEqual([shellWatchdogScreenLine(result.watchdog!)]);
}, 10_000);

test('Bash: an escaped grandchild holding the pipe cannot keep the tool open past the kill grace', async () => {
  // The grandchild leaves the process group (setsid) and keeps stdout open; before A201 'close'
  // never came and the call hung. It exits on its own after a few seconds.
  const command = `perl -e 'use POSIX; exit 0 if fork; POSIX::setsid(); sleep 8'`;
  const result = await dispatchBash({ command }, { cwd, stallMs: TINY_STALL_MS });
  expect(result.watchdog?.status).toBe('stalled');
  // Order, not wall clock: stalled → SIGTERM → SIGKILL → forced result (the pipe never closed).
  const order = events.filter((e) => e.category === 'tool.watchdog')
    .map((e) => e.event === 'kill' ? `kill:${(e.data as { signal: string }).signal}` : e.event);
  expect(order).toEqual(['stalled', 'kill:SIGTERM', 'kill:SIGKILL', 'forced-close']);
}, 15_000);

test('RunShell legacy argv path: the same stall line applies (env override)', async () => {
  process.env[SHELL_STALL_ENV] = String(TINY_STALL_MS);
  const result = await runShell({ command: ['sleep', '30'], cwd, approval: 'none' });
  expect(result.outcome).toBe('timeout');
  expect(result.watchdog?.status).toBe('stalled');
  expect(result.watchdog?.tool).toBe('RunShell');
  expect(watchdogEvents('stalled')).toHaveLength(1);
  expect(screen).toEqual([shellWatchdogScreenLine(result.watchdog!)]);
}, 10_000);
