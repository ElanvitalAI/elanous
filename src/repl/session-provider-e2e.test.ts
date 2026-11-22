import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userConfigPath } from '../user-config.js';

// TUI-NEXT-PROVIDER-FLAG-IGNORED e2e (JUD-B 실경로 보강 · OP #128708): the pure
// decision tests live in session-provider-turn.test.ts; this file drives the REAL
// defect path end-to-end — a non-stream REPL child reading one JSONL turn from
// stdin (the exact path where the old wiring silently dropped the session
// choice) — through a child process running session-provider-e2e.driver.ts
// (JUD-B #126943 probe moved into the PR). Only the model call is mocked; the
// spy reports the provider/model the turn actually reached the call with.
// Bun.spawnSync would block until the child exits, so the stdin write must use
// async Bun.spawn (the child reads stdin lines while the parent writes).

interface Capture { provider: string; model: string }

async function runProbe(stdinLine: string): Promise<{ captures: Capture[]; turnLine: any }> {
  const home = mkdtempSync(join(tmpdir(), 'sp-e2e-'));
  mkdirSync(join(home, 'xdg'), { recursive: true });
  try {
    const repoRoot = import.meta.dir.slice(0, import.meta.dir.lastIndexOf('/src') + 1);
    // The parent seat may itself run under a session-provider env (ELANOUS_LLM_*);
    // the child must resolve from the probe HOME only, like the passthrough test.
    // `as Record<...>`: under the gate's Next ProcessEnv declaration process.env
    // has no string index signature, so spread-then-delete needs the explicit type.
    const env = { ...process.env, PROBE_HOME: home, ELANOUS_CONFIG_DIR: home, XDG_CONFIG_HOME: join(home, 'xdg') } as Record<string, string | undefined>;
    delete env.ELANOUS_LLM_PROVIDER;
    delete env.ELANOUS_LLM_MODEL;
    const proc = Bun.spawn(['bun', join(import.meta.dir, 'session-provider-e2e.driver.ts')], {
      cwd: repoRoot, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    void proc.stdin.write(stdinLine);
    await proc.stdin.end();
    const [exitCode, err, out] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    expect(exitCode).toBe(0);
    const captures = err.split('\n').filter((line) => line.startsWith('PROBE_CAPTURE '))
      .map((line) => JSON.parse(line.slice('PROBE_CAPTURE '.length)) as Capture);
    const turnLine = out.split('\n').map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
      .find((parsed) => parsed && typeof parsed === 'object' && 'turnId' in parsed);
    return { captures, turnLine };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('e2e (JUD-B probe): a JSONL stdin turn with sessionProvider glm/glm-5 reaches the model call as glm', async () => {
  const { captures, turnLine } = await runProbe('{"id":"t1","prompt":"provider choice e2e","sessionProvider":{"provider":"glm","model":"glm-5"}}');
  expect(turnLine?.turnId).toBe('t1');
  expect(captures.length).toBeGreaterThan(0); // 출처: #39541 e2e — 프록 캡처 1개 이상(0이면 아래 provider 단언이 실패하는 근거 경계)
  expect(captures[0]!.provider).toBe('glm');
  expect(captures[0]!.model).toBe('glm-5');
});

test('e2e control (JUD-B probe): no sessionProvider — the saved openai-codex choice is untouched', async () => {
  const { captures } = await runProbe('{"id":"c1","prompt":"control turn"}');
  expect(captures.length).toBeGreaterThan(0); // 출처: #39541 e2e — 프록 캡처 1개 이상(0이면 아래 provider 단언이 실패하는 근거 경계)
  expect(captures[0]!.provider).toBe('openai-codex');
  expect(captures[0]!.model).toBe('gpt-6-sol');
});
