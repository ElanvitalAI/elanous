import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_MISSION_TAKEOVER_WAIT_MS, codexBackend, runAgentMission } from './driver.js';
import type { PtyHandle } from '../pty-shell/registry.js';
import type { AgentMissionDeps } from './driver.js';
import { debug } from '../debug/log.js';
import { ptyWebAddress } from '../cli/pty-web-address.js';

async function runFixture(termination: 'success' | 'cancelled', unavailable = false) {
  const dir = mkdtempSync(join(tmpdir(), 'mission-pty-link-'));
  const docs = join(dir, 'docs');
  mkdirSync(docs);
  writeFileSync(join(docs, 'fixture.md'), 'mission evidence');
  const stderr: string[] = [];
  const stdout: string[] = [];
  const logs: unknown[][] = [];
  const writes: string[] = [];
  let kills = 0;
  let ptyId = '';
  let waitMs: number | undefined;
  const originalWrite = process.stderr.write;
  const originalStdoutWrite = process.stdout.write;
  const originalLog = debug.log;
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  debug.log = ((...args: unknown[]) => { logs.push(args); }) as typeof debug.log;
  try {
    const deps: AgentMissionDeps = {
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      resolvePtyWebAddress: (id) => unavailable
        ? ptyWebAddress(id, { status: 'absent', reason: 'daemon-absent' })
        : ptyWebAddress(id, { status: 'registered', loopback: 'http://127.0.0.1/app/', url: 'https://host.ts.net/app/', source: 'tailnet' }),
      startPty: (opts) => {
        ptyId = opts.id!;
        return {
          id: ptyId, kind: 'codex', nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
          renderScreenPng: async () => null, write: (s: string) => { writes.push(s); }, kill: () => { kills++; },
        } as unknown as PtyHandle;
      },
      runControlLoop: async (_brain, controlDeps) => {
        waitMs = controlDeps.awaitOwnership?.maxWaitMs;
        return { termination: termination === 'success' ? { kind: 'success', reason: 'done' } : { kind: 'cancelled' }, steps: 1 };
      },
    };
    const spec = { mission: 'done', repo: dir, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc' as const, dirRel: 'docs', glob: /fixture/ }, memory: false, commit: false,
      screensDir: join(dir, 'screens'),
    };
    let result: Awaited<ReturnType<typeof runAgentMission>> | undefined;
    let error: unknown;
    try { result = await runAgentMission(spec, deps); } catch (caught) { error = caught; }
    return { result, error, stderr, stdout, logs, writes, kills, ptyId, waitMs };
  } finally {
    process.stderr.write = originalWrite;
    process.stdout.write = originalStdoutWrite;
    debug.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('PTY spawn prints one stderr direct link, logs it, waits up to 30 minutes for ownership, and returns URL and id', async () => {
  const actual = await runFixture('success');
  expect(AGENT_MISSION_TAKEOVER_WAIT_MS).toBe(1_800_000);
  expect(actual.waitMs).toBe(1_800_000);
  const webUrl = `https://host.ts.net/app/term?pty=${actual.ptyId}`;
  expect(actual.stderr).toEqual([`[agent-mission] pty=${actual.ptyId} watch=${webUrl}\n`]);
  expect(actual.result).toMatchObject({ ptyId: actual.ptyId, webUrl, ok: false, branch: 'fixture' });
  expect(actual.stdout).toEqual([]);
  expect(actual.logs).toContainEqual(['agent-mission', 'pty-link', { id: actual.ptyId, webUrl: actual.result?.webUrl, webUrlSource: 'tailnet' }]);
  expect(actual.logs).toContainEqual(['agent-mission', 'takeover-wait', { id: actual.ptyId, maxWaitMs: 1_800_000 }]);
  expect(actual.writes).toEqual(['done', '\r']);
});

test('unavailable PWA prints the reason on stderr and returns a null webUrl', async () => {
  const actual = await runFixture('success', true);
  expect(actual.stderr).toEqual([`[agent-mission] pty=${actual.ptyId} watch=(web unavailable: daemon-absent)\n`]);
  expect(actual.result).toMatchObject({ ptyId: actual.ptyId, webUrl: null });
  expect(actual.logs).toContainEqual(['agent-mission', 'pty-link', { id: actual.ptyId, webUrl: null, webUrlSource: null }]);
});

test('cancelled control yields without killing the human-owned PTY', async () => {
  const actual = await runFixture('cancelled');
  expect(actual.waitMs).toBe(1_800_000);
  expect(actual.stderr).toHaveLength(1);
  expect((actual.error as Error)?.message).toContain('AGENT_YIELDED');
  expect(actual.kills).toBe(0);
});
