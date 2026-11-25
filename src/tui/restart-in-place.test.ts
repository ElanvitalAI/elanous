// TUI-RESTART-NESTED-CHAIN — a TUI self-restart replaces the process (execve) instead of waiting on a child.
import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTuiSelfRestartOnStaleBuild } from '../index.js';

const baseDeps = {
  migrateSessionId: 'sess-a1', scriptPath: '/opt/new/bin/elanous.mjs', args: ['--resume', 'sess-old'],
  stale: () => ({ stale: true, reason: 'installed-moved' }),
  owned: () => ({ sessionId: 'sess-a1', at: 1 }), liveActiveSessionId: () => 'sess-a1', sessionExists: () => true,
  globalLatestSessionId: () => null, sessionProvider: () => undefined, retireCurrentTui: () => {}, log: () => {},
};

test('restart execs the new TUI in place: the waiting-child spawn is not used', async () => {
  const calls: string[][] = [];
  const spawned: string[][] = [];
  const replaced = new Error('process replaced');
  const run = runTuiSelfRestartOnStaleBuild({
    ...baseDeps,
    replaceProcess: (argv: readonly string[]) => { calls.push([...argv]); throw replaced; },
    spawnChild: async (_cmd: string, argv: readonly string[]) => { spawned.push([...argv]); return 0; },
  } as Parameters<typeof runTuiSelfRestartOnStaleBuild>[0]);
  await expect(run).rejects.toBe(replaced);
  expect(calls).toEqual([[process.execPath, '/opt/new/bin/elanous.mjs', '--resume', 'sess-a1']]);
  expect(spawned).toEqual([]);
});

test('execve failure falls back to the old spawn path and is logged', async () => {
  const events: string[] = [];
  const spawned: string[][] = [];
  const result = await runTuiSelfRestartOnStaleBuild({
    ...baseDeps,
    log: (event: string) => { events.push(event); },
    replaceProcess: () => 'execve rc=-1',
    spawnChild: async (_cmd: string, argv: readonly string[]) => { spawned.push([...argv]); return 0; },
  } as Parameters<typeof runTuiSelfRestartOnStaleBuild>[0]);
  expect(result.outcome).toBe('relaunch');
  expect(events).toEqual(['relaunch', 'exec', 'exec-failed']);
  expect(spawned).toEqual([['/opt/new/bin/elanous.mjs', '--resume', 'sess-a1']]);
});

test('a new entry that cannot start is not exec-ed: the launch entry is exec-ed instead', async () => {
  const calls: string[][] = [];
  const replaced = new Error('process replaced');
  const run = runTuiSelfRestartOnStaleBuild({
    ...baseDeps,
    fallbackScriptPath: '/opt/old/bin/elanous.mjs',
    probeEntry: () => false,
    replaceProcess: (argv: readonly string[]) => { calls.push([...argv]); throw replaced; },
  } as Parameters<typeof runTuiSelfRestartOnStaleBuild>[0]);
  await expect(run).rejects.toBe(replaced);
  expect(calls).toEqual([[process.execPath, '/opt/old/bin/elanous.mjs', '--resume', 'sess-a1']]);
});

test('restart twice with the real execve → one process (same pid every generation, parent = this test)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-exec-twice-'));
  try {
    const script = join(dir, 'gen.mjs');
    const out = join(dir, 'gens.txt');
    writeFileSync(script, [
      "import { appendFileSync } from 'node:fs';",
      'const { execInPlace } = await import(process.env.EXEC_MODULE);',
      "const gen = Number(process.env.GEN ?? '0');",
      'appendFileSync(process.env.OUT, `${gen} ${process.pid} ${process.ppid}\\n`);',
      'if (gen < 2) {',
      "  const failure = execInPlace([process.execPath, process.argv[1]], { ...process.env, GEN: String(gen + 1) });",
      "  appendFileSync(process.env.OUT, `failed ${failure}\\n`);",
      '  process.exit(3);',
      '}',
    ].join('\n'));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
    const proc = Bun.spawn([process.execPath, script], {
      env: { ...env, OUT: out, EXEC_MODULE: join(import.meta.dir, 'exec-in-place.ts') }, stdout: 'ignore', stderr: 'pipe',
    });
    const code = await proc.exited;
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    if (code !== 0) appendFileSync(out, await new Response(proc.stderr).text());
    expect(code).toBe(0);
    expect(lines).toEqual([
      `0 ${proc.pid} ${process.pid}`,
      `1 ${proc.pid} ${process.pid}`,
      `2 ${proc.pid} ${process.pid}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
