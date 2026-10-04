import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentMission, codexBackend } from './driver.js';
import { emitPtyDecision, type PtyDecision } from './pty-decision.js';
import { runPtyControlLoop } from '../autopilot/pty-control-loop.js';
import type { PtyHandle } from '../pty-shell/registry.js';

type Fixture = { result: Awaited<ReturnType<typeof runAgentMission>>; writes: string[]; events: PtyDecision[]; calls: number };

async function fakeMission(mode: 'unlock' | 'stuck' | 'prompt-after-interrupt' | 'changing-after-interrupt' | 'question' | 'choice-question' | 'scrollback' | 'changing-question' | 'progress-after-enter' | 'failed-screen' | 'healthy'): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'mission-recover-'));
  const writes: string[] = [];
  const events: PtyDecision[] = [];
  let screen = mode === 'failed-screen' ? 'Error: build failed' : mode === 'healthy' ? 'MISSION-COMPLETE' : 'frozen terminal';
  let ready = mode === 'failed-screen' || mode === 'healthy';
  let now = 0;
  let calls = 0;
  let changingFrame = 0;
  try {
    const result = await runAgentMission({
      mission: 'Run the command', repo: dir, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /output/ }, memory: false, resources: 'off', commit: false,
      recoverAfterMs: 40_000, screensDir: join(dir, 'screens'), maxRounds: 12,
    }, {
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      emitPtyDecision: (input) => emitPtyDecision(input, (_category, _event, row) => { events.push(row as PtyDecision); }),
      startPty: ((opts) => ({
        id: opts.id!, kind: 'codex', nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '',
        renderScreen: async () => mode === 'question' ? 'Use the existing file?'
          : mode === 'choice-question' ? 'Proceed? [y/N]'
          : mode === 'scrollback' ? `Proceed? [y/N]\nworking on task ${++changingFrame}`
          : mode === 'changing-question' ? `working on task ${++changingFrame}\nProceed? [y/N]`
          : mode === 'progress-after-enter' ? writes.length > 2
            ? `Proceed? [y/N]\nworking on task ${++changingFrame}` : 'Proceed? [y/N]'
          : mode === 'changing-after-interrupt' && writes.includes('\x03')
            ? `working on task ${++changingFrame}` : screen,
        renderScreenPng: async () => null,
        write: (text: string) => {
          writes.push(text);
          if (mode === 'unlock' && text === '\r' && writes.length > 2) { screen = 'MISSION-COMPLETE'; ready = true; }
          if (mode === 'prompt-after-interrupt' && text === '\x03') screen = 'agent >';
          if (mode === 'prompt-after-interrupt' && text === 'Run the command\r') { screen = 'MISSION-COMPLETE'; ready = true; }
        }, kill: () => {},
      } as unknown as PtyHandle)),
      checkEvidence: () => ready ? { ok: true, path: join(dir, 'docs', 'output.md') } : { ok: false, path: null, retry: 'output missing' },
      controlStream: async () => { calls++; return ready ? '{"action":"verify","reason":"completed"}' : '{"action":"wait"}'; },
      runControlLoop: (brain, deps, opts) => runPtyControlLoop(brain, {
        ...deps, settle: async () => {}, now: () => now,
        sleep: async () => { now += ['question', 'choice-question', 'scrollback', 'changing-question', 'progress-after-enter'].includes(mode) ? 1 : 40_000; },
      }, opts),
    });
    return { result, writes, events, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('fake PTY frozen for 40 seconds recovers with Enter and accepts the resulting evidence', async () => {
  const { result, writes, events } = await fakeMission('unlock');
  expect(result.ok).toBe(true);
  expect(writes.slice(2)).toEqual(['\r']);
  expect(events.filter((event): event is Extract<PtyDecision, { step: 'recover' }> => event.step === 'recover').map((event) => event.detail.action)).toEqual(['Enter']);
});

test('fake PTY still frozen escalates Enter, Esc, Ctrl-C plus previous command, then human with last screen', async () => {
  const { result, writes, events } = await fakeMission('stuck');
  expect(result.ok).toBe(false);
  expect(result.committed).toBe(false);
  expect(result.detail).toContain('사람 필요 · 마지막 화면 요약: frozen terminal');
  expect(writes.slice(2)).toEqual(['\r', '\x1b', '\x03', 'Run the command\r']);
  const recover = events.filter((event): event is Extract<PtyDecision, { step: 'recover' }> => event.step === 'recover');
  expect(recover.map((event) => event.detail.action)).toEqual([
    'Enter', 'Esc', 'Ctrl-C and replay previous command', 'Human needed',
  ]);
  expect(recover.every((event) => event.detail.blocked.includes('screen unchanged'))).toBe(true);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => events[0]!.seq + i));
  expect(events.at(-1)?.step).toBe('done');
});

test('Ctrl-C returning to the prompt replays the previous command before reporting recovery', async () => {
  const { result, writes, events } = await fakeMission('prompt-after-interrupt');
  expect(result.ok).toBe(true);
  expect(writes.slice(2)).toEqual(['\r', '\x1b', '\x03', 'Run the command\r']);
  const replayIndex = events.findIndex((event) => event.step === 'input' && event.text.includes('Run the command') && event.seq > events.find((entry) => entry.step === 'recover' && entry.detail.action === 'Esc')!.seq);
  const ctrlCIndex = events.findIndex((event) => event.step === 'input' && event.seq > events.find((entry) => entry.step === 'recover' && entry.detail.action === 'Esc')!.seq);
  const recover = events.filter((event): event is Extract<PtyDecision, { step: 'recover' }> => event.step === 'recover');
  expect(recover.map((event) => event.detail.action)).toEqual(['Enter', 'Esc', 'Ctrl-C and replay previous command']);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => events[0]!.seq + i));
  expect(replayIndex).toBeGreaterThan(ctrlCIndex);
  expect(events.findIndex((event) => event.step === 'recover' && event.detail.action === 'Ctrl-C and replay previous command')).toBeGreaterThan(replayIndex);
  expect(events.findIndex((event) => event.step === 'recover' && event.detail.action === 'Human needed')).toBe(-1);
  expect(events.filter((event) => event.step === 'read' && event.text.endsWith('agent >'))).toHaveLength(1);
});

test('changing non-prompt frames after Ctrl-C still replay the command but clear recovery on progress', async () => {
  const { result, writes, events } = await fakeMission('changing-after-interrupt');
  expect(result.ok).toBe(false);
  expect(result.detail).not.toContain('사람 필요');
  expect(writes.slice(2)).toEqual(['\r', '\x1b', '\x03', 'Run the command\r']);
  const recover = events.filter((event): event is Extract<PtyDecision, { step: 'recover' }> => event.step === 'recover');
  expect(recover.map((event) => event.detail.action)).toEqual(['Enter', 'Esc', 'Ctrl-C and replay previous command']);
  const replay = events.find((event) => event.step === 'input' && event.text.includes('Run the command') && event.seq > recover[1]!.seq);
  expect(replay).toBeDefined();
  expect(replay!.seq).toBeLessThan(recover[2]!.seq);
  expect(events.filter((event) => event.step === 'read' && event.text.includes('working on task')).length).toBeGreaterThan(1);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => events[0]!.seq + i));
});

test('a completed mission still passes its evidence gate without entering recovery', async () => {
  const { result, events } = await fakeMission('healthy');
  expect(result.ok).toBe(true);
  expect(events.filter((event) => event.step === 'recover')).toHaveLength(0);
});

test('DRIVE-OK failure on the final PTY screen cannot turn passing file evidence into success', async () => {
  const { result, events } = await fakeMission('failed-screen');
  expect(result.ok).toBe(false);
  expect(result.detail).toContain('DRIVE-OK: Error: build failed');
  expect(events.filter((event) => event.step === 'recover')).toHaveLength(0);
});

test('three repetitions of the same question start recovery before the time threshold', async () => {
  const { result, events, calls } = await fakeMission('question');
  expect(result.ok).toBe(false);
  expect(events.filter((event): event is Extract<PtyDecision, { step: 'recover' }> => event.step === 'recover').map((event) => event.detail.action)).toEqual([
    'Enter', 'Esc', 'Ctrl-C and replay previous command', 'Human needed',
  ]);
  expect(events.filter((event): event is Extract<PtyDecision, { step: 'recover' }> => event.step === 'recover').every((event) => event.detail.blocked.includes('same question repeated three times'))).toBe(true);
  expect(calls).toBe(2);
});

test('three identical choice prompts recover even when the line ends in [y/N]', async () => {
  const { writes, events, calls } = await fakeMission('choice-question');
  const recover = events.filter((event): event is Extract<PtyDecision, { step: 'recover' }> => event.step === 'recover');
  expect(writes.slice(2)).toEqual(['\r', '\x1b', '\x03', 'Run the command\r']);
  expect(recover.map((event) => event.detail.action)).toEqual(['Enter', 'Esc', 'Ctrl-C and replay previous command', 'Human needed']);
  expect(recover.every((event) => event.detail.blocked.includes('same question repeated three times: Proceed? [y/N]'))).toBe(true);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => events[0]!.seq + i));
  expect(calls).toBe(2);
});

test('a question in scrollback is not a repeated live prompt while the screen advances', async () => {
  const { writes, events, calls } = await fakeMission('scrollback');
  expect(writes.slice(2)).toEqual([]);
  expect(events.filter((event) => event.step === 'recover')).toHaveLength(0);
  expect(calls).toBe(12);
});

test('changing live prompt frames are progress, not three identical question screens', async () => {
  const { writes, events, calls } = await fakeMission('changing-question');
  expect(writes.slice(2)).toEqual([]);
  expect(events.filter((event) => event.step === 'recover')).toHaveLength(0);
  expect(calls).toBe(12);
});

test('progress after Enter clears the recovery stage despite an old prompt in scrollback', async () => {
  const { writes, events, calls } = await fakeMission('progress-after-enter');
  expect(writes.slice(2)).toEqual(['\r']);
  expect(events.filter((event): event is Extract<PtyDecision, { step: 'recover' }> => event.step === 'recover').map((event) => event.detail.action)).toEqual(['Enter']);
  expect(calls).toBe(11);
});
