import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';
import { runNextTuiScenario } from './next-tui-seat-scenarios.js';

const PROBE = join(import.meta.dir, 'mock-seat-pty-sequence-child.ts');
const REPO_CLI = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

describe('N03 key sequence: one screen per step on a real PTY', () => {
  test('each step is read back as the screen the probe rendered, in order, with an isolated HOME', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-seq-'));
    try {
      const root = join(dir, 'root');
      const artifactPath = join(dir, 'seq.json');
      const run = await mockSeatPtySequence({
        executable: process.execPath, args: [PROBE], root, runId: 'n03-seq-1', artifactPath, cols: 200,
        ready: { label: 'boot', until: 'N03 seq ready' },
        steps: [
          { label: 'a', keys: 'a', until: 'count=1 last=a' },
          { label: 'b', keys: 'b', until: 'count=2 last=b' },
        ],
      });
      expect(run.frames.map((f) => f.label)).toEqual(['boot', 'a', 'b']);
      expect(run.frames[0]!.screen).toContain(`home=${root}`);
      expect(run.frames[0]!.screen).toContain('skipLogin=1');
      expect(run.frames[1]!.screen).toContain('N03 seq count=1 last=a');
      expect(run.frames[2]!.screen).toContain('N03 seq count=2 last=b');
      expect(run.frames[2]!.input).toBe('b');
      expect(run.exitCode).toBe(0);
      expect(run.binarySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(run.entrySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(run.rootKept).toBe(true);
      expect(existsSync(root)).toBe(true);
      expect(JSON.parse(readFileSync(artifactPath, 'utf8'))).toEqual(JSON.parse(JSON.stringify(run)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  test('refuses credential-shaped child env and a different executable SHA before spawning', async () => {
    const base = { executable: process.execPath, args: [PROBE], ready: { label: 'boot', until: 'x' }, steps: [{ label: 's', keys: 'a', until: 'x' }] };
    await expect(mockSeatPtySequence({ ...base, env: { XAI_API_KEY: 'k' } })).rejects.toThrow('credential-shaped env: XAI_API_KEY');
    await expect(mockSeatPtySequence({ ...base, env: { ANTHROPIC_BASE_URL: 'u' } })).rejects.toThrow('credential-shaped env');
    await expect(mockSeatPtySequence({ ...base, expectedBinarySha256: '0'.repeat(64) })).rejects.toThrow('binary SHA mismatch');
    await expect(mockSeatPtySequence({ ...base, steps: [] })).rejects.toThrow('at least one step');
  });
});

// The scenarios drive the real `--tui next` of this tree on the network-free fake LLM and read
// the universe back through the same CLI's `logs`. The busy-/new probe is a timing race (the fake
// LLM answers in milliseconds), so it is reported as a check but not asserted here.
describe('next TUI scenarios on N03 (this tree · fake LLM)', () => {
  test('next-new-session: /new clears the screen, the next turn uses a new session, the old one stays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-new-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-new-session', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      const { busyNewRejected: _b, busyKeptSession: _k, ...deterministic } = r.checks;
      expect(deterministic).toEqual({
        screenClearedWithNewTitle: true, statusNamesPrevious: true, sessionNewObservedOnce: true,
        nextTurnInNewSession: true, oldSessionKept: true, onlyFakeProvider: true, exitedClean: true,
      });
      expect(r.logs.rc).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-compact: a seeded long session compacts once before the turn, then /compact once more', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-compact-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-compact', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        autoCompactOnce: true, autoBeforeIsSeeded12: true, manualCompactOnce: true, screenShowsAuto: true,
        summaryFromFakeLlm: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-tool-fold: a real Bash tool call prints 30 lines, the block shows folded, Enter in the log expands it and folds it again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-fold-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-tool-fold', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        realToolResultStored: true, collapsedAfterTurn: true, expandedOnEnter: true, foldedAgainOnEnter: true,
        sessionUnchanged: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-tool-fold-read (TUI-NEXT-TOOL-RESULT-RENDER 재현): a real Read of a 20-line file folds as «▸ 도구 Read · 20줄 (접힘)» and expands to the file lines, never the raw JSON envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-fold-read-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-tool-fold-read', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        realReadEnvelopeStored: true, collapsedAfterTurn: true, expandedAsFileLines: true, noRawEnvelope: true,
        onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  // 재현(TUI-GOAL-INTERIM-QUIET · n8n 10-22 22:4x): every step ends «아직 못 했다» and the internal input was drawn
  // «나: [골 이어가기] …». Four real turns on a PTY — opt-in (ELANOUS_N03_SLOW=1) like the other long scenarios.
  test.skipIf(process.env.ELANOUS_N03_SLOW !== '1')('next-goal-interim: goal-continue to its cap folds each continued step and shows the «not done» paragraph once, no «나:» header', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-interim-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-goal-interim', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        continuedSeveral: true, everyStepOnScreen: true, notDoneAtMostOnce: true, finalReportShown: true, foldedEachContinued: true,
        noUserHeaderForInternal: true, toolLineKept: true, internalTurnsStored: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 240_000);
});

