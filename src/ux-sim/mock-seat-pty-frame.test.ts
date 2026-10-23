import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtyFrame, observeSeatPtyFirstFrame } from './mock-seat-pty-frame.js';

describe('N03 real PTY input and render boundary', () => {
  test('first frame and key frame have the same run, host, clock, terminal and binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-evidence-'));
    try {
      const artifactPath = join(dir, 'frame.json');
      const result = await mockSeatPtyFrame({ runId: 'n03-case-1', rows: 28, cols: 90,
        now: '2026-10-22T07:00:00.000Z', host: 'fake-seat-host', key: 'k', artifactPath, timeoutMs: 10_000 });
      expect(result.exitCode).toBe(0);
      expect(result.firstFrame).toContain(`N03 first run=n03-case-1 host=fake-seat-host now=${Date.parse('2026-10-22T07:00:00.000Z')} size=90x28`);
      expect(result.afterKeyFrame).toContain(`N03 key=k run=n03-case-1 host=fake-seat-host now=${Date.parse('2026-10-22T07:00:00.000Z')} size=90x28`);
      expect(result.firstFrame).toMatch(/home=\/(?:var|tmp)\//);
      expect(result.firstFrame).not.toContain(`home=${process.env.HOME}`);
      expect(result.firstFrame).toContain('\x1b[');
      expect(result.afterKeyFrame).toContain('\x1b[');
      expect(result.binarySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.entrySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.actualHost).toBe(hostname());
      expect(result.startedAt).not.toBe(result.injectedNow);
      expect(result.injectedNow).toBe('2026-10-22T07:00:00.000Z');
      expect(result.injectedHost).toBe('fake-seat-host');
      expect(JSON.parse(readFileSync(artifactPath, 'utf8'))).toEqual(result);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('rejects a different executable SHA before spawning', async () => {
    await expect(mockSeatPtyFrame({ expectedBinarySha256: '0'.repeat(64) })).rejects.toThrow('binary SHA mismatch');
  });

  test('an installed executable must declare its entry arguments', async () => {
    await expect(mockSeatPtyFrame({ executable: process.execPath })).rejects.toThrow('custom executable requires explicit args');
  });

  test('captures a markerless first frame from the real widget child and pins both loaded files', async () => {
    const result = await observeSeatPtyFirstFrame({ runId: 'n03-markerless',
      executable: process.execPath, entry: join(import.meta.dir, 'mock-seat-pty-frame-child.ts'),
      settleMs: 150, timeoutMs: 5_000, requiredText: 'N03 error-reports=off' });
    expect(result.firstFrame).toContain('N03 first run=n03-markerless');
    expect(result.firstFrame).toContain('N03 error-reports=off');
    expect(result.firstFrame).not.toContain('N03:READY:');
    expect(result.requiredTextSeen).toBe(true);
    expect(result.stopReason).toBe('settled');
    expect(result.firstFrame).toContain('\x1b[');
    expect(result.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.entrySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.timedOut).toBe(false);
    expect(result.stoppedByProbe).toBe(true);
    expect(result.childExited).toBe(true);
    expect(result.quietMs).toBeGreaterThanOrEqual(result.settleMs);
  });

  test('rejects an unpinned installed entry before starting a PTY', async () => {
    await expect(observeSeatPtyFirstFrame({ runId: 'n03-bad-entry', executable: process.execPath,
      entry: join(import.meta.dir, 'mock-seat-pty-frame-child.ts'), expectedEntrySha256: '0'.repeat(64) }))
      .rejects.toThrow('entry SHA mismatch');
  });

  test('a silent installed entry yields a timeout receipt and its child is stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-silent-'));
    try {
      const entry = join(dir, 'silent.mjs');
      writeFileSync(entry, 'await new Promise(resolve => setTimeout(resolve, 10_000));\n');
      const result = await observeSeatPtyFirstFrame({ runId: 'n03-silent',
        executable: process.execPath, entry, settleMs: 250, timeoutMs: 350,
        requiredText: 'first screen ready' });
      expect(result.timedOut).toBe(true);
      expect(result.stopReason).toBe('timeout');
      expect(result.requiredTextSeen).toBe(false);
      expect(result.stoppedByProbe).toBe(true);
      expect(result.childExited).toBe(true);
      expect(result.signal).not.toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a self-terminating entry records child-exit rather than timeout or probe stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-exit-'));
    try {
      const entry = join(dir, 'exit.mjs');
      writeFileSync(entry, 'console.log("N03 done");\n');
      const result = await observeSeatPtyFirstFrame({ runId: 'n03-exit',
        executable: process.execPath, entry, settleMs: 500, timeoutMs: 5_000,
        requiredText: 'N03 done' });
      expect(result.firstFrame).toContain('N03 done');
      expect(result.stopReason).toBe('child-exit');
      expect(result.timedOut).toBe(false);
      expect(result.stoppedByProbe).toBe(false);
      expect(result.childExited).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
