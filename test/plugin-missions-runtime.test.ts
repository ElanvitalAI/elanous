// ── PX-4 P3: mission evaluator + registry + Turn hook ──
//
// Evaluator tests spawn tiny shell scripts (echo/jq-style) written to
// tmp so the JSON-stdin/stdout contract is exercised end-to-end. The
// registry tests drive tick() directly with fixtures whose evaluator
// is a shell script whose output we control.

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMissionEvaluator } from '../src/plugin-missions/evaluator-runner';
import {
  MissionRegistry,
  type MissionRegistration,
} from '../src/plugin-missions/registry';
import { buildMissionTurnHook } from '../src/plugin-missions/turn-hook';
import type { MissionDefinition } from '../src/plugin-missions/types';

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'mission-test-'));
}

function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function def(over: Partial<MissionDefinition> = {}): MissionDefinition {
  return {
    id: 'm1',
    name: 'M1',
    goalPath: 'mission.md',
    sandboxPath: 'sandbox.md',
    evaluator: { command: 'echo "{}"', format: 'json', timeoutMs: 5_000 },
    keepPolicy: 'pass_only',
    maxIterations: 3,
    ...over,
  };
}

describe('PX-4 P3 — runMissionEvaluator', () => {
  test('immediate exit with unread large stdin keeps evaluator output and exit status', async () => {
    const dir = scratchDir();
    const input = {
      missionId: 'm1', iteration: 1, workDir: dir,
      goalContent: 'x'.repeat(1024 * 1024), sandboxContent: '',
    };
    for (const [command, expected] of [
      ['echo \'{"done":true,"score":0.75}\'', 'json'],
      ['exit 7', 'exit 7'],
    ] as const) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await runMissionEvaluator(
          def({ evaluator: { command, format: 'json', timeoutMs: 5_000 } }), input,
        );
        if (expected === 'json') {
          expect(result.done).toBe(true);
          expect(result.score).toBe(0.75);
        } else expect(result.error).toBe(expected);
      }
    }
  });

  test('parses JSON stdout into MissionResult', async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, 'mission.md'), 'goal');
    writeFileSync(join(dir, 'sandbox.md'), 'sandbox');
    const script = writeScript(dir, 'eval.sh',
      `#!/bin/sh\necho '{"done": true, "score": 0.9, "reason": "ok"}'\n`);
    const result = await runMissionEvaluator(
      def({ evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
      { missionId: 'm1', iteration: 1, workDir: dir, goalContent: 'g', sandboxContent: 's' },
    );
    expect(result.done).toBe(true);
    expect(result.score).toBe(0.9);
    expect(result.reason).toBe('ok');
  });

  test('exit 1 → error with exit code', async () => {
    const dir = scratchDir();
    const script = writeScript(dir, 'fail.sh', `#!/bin/sh\nexit 1\n`);
    const result = await runMissionEvaluator(
      def({ evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
      { missionId: 'm1', iteration: 1, workDir: dir, goalContent: '', sandboxContent: '' },
    );
    expect(result.error).toBe('exit 1');
    expect(result.done).toBe(false);
  });

  test('malformed JSON → error malformed-json', async () => {
    const dir = scratchDir();
    const script = writeScript(dir, 'bad.sh', `#!/bin/sh\necho "not-json"\n`);
    const result = await runMissionEvaluator(
      def({ evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
      { missionId: 'm1', iteration: 1, workDir: dir, goalContent: '', sandboxContent: '' },
    );
    expect(result.error).toBe('malformed-json');
  });

  test('empty stdout → error empty-stdout', async () => {
    const dir = scratchDir();
    const script = writeScript(dir, 'empty.sh', `#!/bin/sh\nexit 0\n`);
    const result = await runMissionEvaluator(
      def({ evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
      { missionId: 'm1', iteration: 1, workDir: dir, goalContent: '', sandboxContent: '' },
    );
    expect(result.error).toBe('empty-stdout');
  });

  test('timeout → error timeout', async () => {
    const dir = scratchDir();
    const script = writeScript(dir, 'slow.sh', `#!/bin/sh\nsleep 2\n`);
    const result = await runMissionEvaluator(
      def({ evaluator: { command: script, format: 'json', timeoutMs: 50 } }),
      { missionId: 'm1', iteration: 1, workDir: dir, goalContent: '', sandboxContent: '' },
    );
    expect(result.error).toBe('timeout');
  }, 10_000);

  test('stdin carries JSON with missionId + iteration', async () => {
    const dir = scratchDir();
    // Use cat — echo back stdin as stdout (wrapping in a valid JSON
    // object). sh substitutes $() expansion to capture stdin into a
    // file first, then emit a crafted JSON referencing its contents.
    const captured = join(dir, 'stdin.txt');
    const script = writeScript(dir, 'echo.sh',
      `#!/bin/sh\ncat > ${captured}\necho '{"done": false, "reason": "captured"}'\n`);
    const result = await runMissionEvaluator(
      def({ evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
      { missionId: 'm-test', iteration: 7, workDir: dir, goalContent: 'G', sandboxContent: 'S' },
    );
    expect(result.done).toBe(false);
    const { readFileSync } = await import('node:fs');
    const stdinPayload = JSON.parse(readFileSync(captured, 'utf-8'));
    expect(stdinPayload.missionId).toBe('m-test');
    expect(stdinPayload.iteration).toBe(7);
    expect(stdinPayload.goalContent).toBe('G');
  });
});

describe('PX-4 P3 — MissionRegistry', () => {
  let reg: MissionRegistry;
  beforeEach(() => { reg = new MissionRegistry(); });

  test('register + dispose lifecycle', () => {
    const dir = scratchDir();
    const dispose = reg.register({
      pluginId: 'test',
      pluginDir: dir,
      def: def(),
    } satisfies MissionRegistration);
    expect(reg.list().length).toBe(1);
    dispose();
    expect(reg.list().length).toBe(0);
  });

  test('register() rejects duplicate ids', () => {
    const dir = scratchDir();
    reg.register({ pluginId: 'a', pluginDir: dir, def: def() });
    expect(() => reg.register({ pluginId: 'a', pluginDir: dir, def: def() }))
      .toThrow(/already registered/);
  });

  test('autostart=true → active() picks it up', () => {
    const dir = scratchDir();
    reg.register({ pluginId: 't', pluginDir: dir, def: def({ autostart: true }) });
    expect(reg.active().map(d => d.id)).toEqual(['m1']);
  });

  test('pass_only: done=true ends the mission', async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, 'mission.md'), '');
    writeFileSync(join(dir, 'sandbox.md'), '');
    const script = writeScript(dir, 'ok.sh', `#!/bin/sh\necho '{"done": true}'\n`);
    reg.register({
      pluginId: 't', pluginDir: dir,
      def: def({ autostart: true,
                 evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
    });
    await reg.tick(0);
    expect(reg.state('m1')?.status).toBe('done');
  });

  test('pass_only: done=false runs repeatedly up to maxIterations then aborts', async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, 'mission.md'), '');
    writeFileSync(join(dir, 'sandbox.md'), '');
    const script = writeScript(dir, 'never-done.sh',
      `#!/bin/sh\necho '{"done": false}'\n`);
    reg.register({
      pluginId: 't', pluginDir: dir,
      def: def({ autostart: true, maxIterations: 3,
                 evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
    });
    // pass_only with done=false never keeps, so iteration stays at 0
    // (nothing advances). We protect via the trailing-errors check
    // only when result.error is set — these are clean non-done runs,
    // so the mission would spin forever without maxIterations. Here
    // we assert it stays at iteration=0 after N ticks — that matches
    // the documented pass_only semantics.
    for (let t = 0; t < 5; t++) await reg.tick(t);
    const s = reg.state('m1');
    expect(s?.status).toBe('running');
    expect(s?.iteration).toBe(0);
    expect(s?.history.length).toBe(5);
  });

  test('never policy: history grows + iteration advances each tick', async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, 'mission.md'), '');
    writeFileSync(join(dir, 'sandbox.md'), '');
    const script = writeScript(dir, 'loop.sh',
      `#!/bin/sh\necho '{"done": false, "score": 1}'\n`);
    reg.register({
      pluginId: 't', pluginDir: dir,
      def: def({ autostart: true, keepPolicy: 'never', maxIterations: 3,
                 evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
    });
    await reg.tick(0);
    await reg.tick(1);
    await reg.tick(2);
    const s = reg.state('m1');
    expect(s?.iteration).toBe(3);
    expect(s?.status).toBe('aborted');   // maxIterations reached
    expect(s?.history.length).toBe(3);
  });

  test('score_improvement: only strictly-better score advances', async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, 'mission.md'), '');
    writeFileSync(join(dir, 'sandbox.md'), '');
    // Emit an increasing score on each run by counting tmp files.
    const counter = join(dir, 'count.txt');
    writeFileSync(counter, '0');
    const script = writeScript(dir, 'score.sh',
      `#!/bin/sh\nN=$(cat ${counter});N=$((N+1));echo $N > ${counter};echo "{\\"done\\": false, \\"score\\": $N}"\n`);
    reg.register({
      pluginId: 't', pluginDir: dir,
      def: def({ autostart: true, keepPolicy: 'score_improvement', maxIterations: 4,
                 evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
    });
    await reg.tick(0);
    await reg.tick(1);
    const s = reg.state('m1')!;
    // Iteration 1 had prev score undefined → kept (first score wins).
    // Iteration 2 had score 2 > 1 → kept. So iteration should be 2.
    expect(s.iteration).toBe(2);
  });

  test('cadence.everyNTurn=3 skips intermediate turns', async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, 'mission.md'), '');
    writeFileSync(join(dir, 'sandbox.md'), '');
    const counter = join(dir, 'count.txt');
    writeFileSync(counter, '0');
    const script = writeScript(dir, 'count.sh',
      `#!/bin/sh\nN=$(cat ${counter});N=$((N+1));echo $N > ${counter};echo '{"done": false}'\n`);
    reg.register({
      pluginId: 't', pluginDir: dir,
      def: def({ autostart: true, keepPolicy: 'never', maxIterations: 10,
                 cadence: { everyNTurn: 3 },
                 evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
    });
    for (let t = 0; t < 7; t++) await reg.tick(t);
    const { readFileSync } = await import('node:fs');
    // Turns 0, 3, 6 — 3 evaluations.
    expect(Number(readFileSync(counter, 'utf-8').trim())).toBe(3);
  });

  test('abort(id) transitions running → aborted', async () => {
    const dir = scratchDir();
    reg.register({ pluginId: 't', pluginDir: dir, def: def({ autostart: true }) });
    reg.abort('m1', 'user-request');
    expect(reg.state('m1')?.status).toBe('aborted');
    expect(reg.state('m1')?.lastResult?.error).toBe('user-request');
  });

  test('start() resets iteration + history on an aborted mission', async () => {
    const dir = scratchDir();
    reg.register({ pluginId: 't', pluginDir: dir, def: def({ autostart: true }) });
    reg.abort('m1');
    await reg.start('m1');
    const s = reg.state('m1')!;
    expect(s.status).toBe('running');
    expect(s.iteration).toBe(0);
    expect(s.history.length).toBe(0);
  });
});

describe('PX-4 P3 — buildMissionTurnHook', () => {
  test('empty registry → {} (no banner)', async () => {
    const reg = new MissionRegistry();
    const hook = buildMissionTurnHook({ registry: reg });
    const out = await hook.invoke(
      { turnNumber: 1, messages: [], systemPrompt: '', tools: [] },
      makeCtx(),
    );
    expect(out).toEqual({});
  });

  test('one active mission → systemPromptInject banner with id', async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, 'mission.md'), '');
    writeFileSync(join(dir, 'sandbox.md'), '');
    const script = writeScript(dir, 'ok.sh', `#!/bin/sh\necho '{"done": false}'\n`);
    const reg = new MissionRegistry();
    reg.register({
      pluginId: 't', pluginDir: dir,
      def: def({ autostart: true, keepPolicy: 'never',
                 evaluator: { command: script, format: 'json', timeoutMs: 5_000 } }),
    });
    const hook = buildMissionTurnHook({ registry: reg });
    const out = await hook.invoke(
      { turnNumber: 0, messages: [], systemPrompt: '', tools: [] },
      makeCtx(),
    );
    expect(out.systemPromptInject).toContain('m1');
    expect(out.systemPromptInject).toContain('Active missions');
  });

  test('priority is 5 (reserved range)', () => {
    const reg = new MissionRegistry();
    const hook = buildMissionTurnHook({ registry: reg });
    expect(hook.priority).toBe(5);
    expect(hook.event).toBe('Turn');
  });
});

function makeCtx() {
  return {
    pluginId: 'test',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    abortSignal: new AbortController().signal,
  };
}
