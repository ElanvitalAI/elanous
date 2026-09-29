import { describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrollAgent } from './broll-agent.js';
import type { AgentMissionResult } from '../agent-mission/driver.js';
import * as decision from '../live/detail-switch.js';

const slot = { start: 1.25, end: 4.5, prompt: 'a spoken sentence' };
const signal = new AbortController().signal;
const result = (ok: boolean, evidencePath: string | null): AgentMissionResult => ({
  ok, evidencePath, worktree: '', branch: null, rounds: 1, committed: false, usedOmniCrawl: false, detail: '',
});
const fixture = () => {
  const clipsDir = mkdtempSync(join(tmpdir(), 'broll-agent-'));
  return { clipsDir, skillDir: join(import.meta.dir, '../../skills/motion-broll'), file: join(clipsDir, 'slot-001250.mp4') };
};

describe('createBrollAgent', () => {
  it('codex authors one named evidence clip inside the workdir via PTY', async () => {
    const { clipsDir, skillDir, file } = fixture();
    const runMission = mock(async (spec: Parameters<NonNullable<Parameters<typeof createBrollAgent>[0]['runMission']>>[0]) => {
      writeFileSync(file, 'mp4');
      return result(true, file);
    });
    const agent = createBrollAgent({ backend: 'codex', clipsDir, skillDir, runMission });
    expect(await agent(slot, { signal, timeoutMs: 600_000 })).toBe(file);
    const spec = runMission.mock.calls[0]![0];
    expect(spec.agent?.name).toBe('codex');
    expect(spec.workdir).toBe(clipsDir);
    expect(spec.signal).toBe(signal);
    expect(spec.headless).toBe(false);
    expect(spec.memory).toBe(false);
    expect(spec.evidence).toMatchObject({ kind: 'doc', dirRel: '.' });
    if (spec.evidence.kind !== 'doc') throw new Error('wrong evidence kind');
    expect(spec.evidence.glob.test('slot-001250.mp4')).toBe(true);
    expect(spec.evidence.glob.test('slot-001251.mp4')).toBe(false);
    expect(spec.evidence.glob.test('slot-001250xmp4')).toBe(false);
    expect(spec.mission).toContain(join(skillDir, 'SKILL.md'));
    expect(spec.mission).toContain(slot.prompt);
    expect(spec.mission).toContain('1.25 seconds');
    expect(spec.mission).toContain('4.5 seconds');
  });

  it('authors a slot beyond six millisecond digits without truncating its evidence name', async () => {
    const { clipsDir, skillDir } = fixture();
    const longSlot = { start: 1000.125, end: 1002, prompt: 'late narration' };
    const file = join(clipsDir, 'slot-1000125.mp4');
    const runMission = mock(async (_spec: Parameters<NonNullable<Parameters<typeof createBrollAgent>[0]['runMission']>>[0]) => {
      writeFileSync(file, 'mp4');
      return result(true, file);
    });
    const agent = createBrollAgent({ backend: 'codex', clipsDir, skillDir, runMission });
    expect(await agent(longSlot, { signal, timeoutMs: 600_000 })).toBe(file);
    expect(runMission).toHaveBeenCalledTimes(1);
    const spec = runMission.mock.calls[0]![0];
    if (spec.evidence.kind !== 'doc') throw new Error('wrong evidence kind');
    expect(spec.evidence.glob.test('slot-1000125.mp4')).toBe(true);
    expect(spec.evidence.glob.test('slot-1000126.mp4')).toBe(false);
    expect(spec.workdir).toBe(clipsDir);
    expect(spec.headless).toBe(false);
  });

  it('failed mission and wrong evidence never select a clip', async () => {
    const { clipsDir, skillDir, file } = fixture();
    const failed = createBrollAgent({ backend: 'codex', clipsDir, skillDir, runMission: async () => {
      writeFileSync(file, 'mp4');
      return result(false, file);
    } });
    expect(await failed(slot, { signal, timeoutMs: 100 })).toBeNull();
    const other = join(clipsDir, 'slot-001251.mp4');
    const mismatch = createBrollAgent({ backend: 'codex', clipsDir, skillDir, runMission: async () => {
      writeFileSync(other, 'mp4');
      return result(true, other);
    } });
    expect(await mismatch(slot, { signal, timeoutMs: 100 })).toBeNull();
    const stale = createBrollAgent({ backend: 'elanous', clipsDir, skillDir, runElanous: async () => {} });
    expect(await stale(slot, { signal, timeoutMs: 100 })).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('logged-in claude is driven as claude over PTY, never headless', async () => {
    const { clipsDir, skillDir, file } = fixture();
    const runMission = mock(async (_spec: Parameters<NonNullable<Parameters<typeof createBrollAgent>[0]['runMission']>>[0]) => { writeFileSync(file, 'mp4'); return result(true, file); });
    const agent = createBrollAgent({ backend: 'claude', clipsDir, skillDir, claudeAvailable: async () => true, runMission });
    expect(await agent(slot, { signal, timeoutMs: 100 })).toBe(file);
    expect(runMission.mock.calls[0]![0].agent?.name).toBe('claude');
    expect(runMission.mock.calls[0]![0].headless).toBe(false);
  });

  it('logged-out claude routes once to codex with a ROUTE decision', async () => {
    const { clipsDir, skillDir, file } = fixture();
    const route = spyOn(decision, 'emitDecision').mockImplementation(() => true);
    try {
      const runMission = mock(async (_spec: Parameters<NonNullable<Parameters<typeof createBrollAgent>[0]['runMission']>>[0]) => { writeFileSync(file, 'mp4'); return result(true, file); });
      const agent = createBrollAgent({ backend: 'claude', clipsDir, skillDir, claudeAvailable: async () => false, runMission });
      expect(await agent(slot, { signal, timeoutMs: 100 })).toBe(file);
      expect(runMission).toHaveBeenCalledTimes(1);
      expect(runMission.mock.calls[0]![0].agent?.name).toBe('codex');
      expect(runMission.mock.calls[0]![0].headless).toBe(false);
      expect(route).toHaveBeenCalledTimes(1);
      expect(route.mock.calls[0]![0]).toMatchObject({ kind: 'ROUTE', what: 'B-roll 저작 에이전트', reason: 'claude 로그인 없음 → codex' });
    } finally { route.mockRestore(); }
  });

  it('elanous receives prompt on the clip workdir and returns only an actual clip', async () => {
    const { clipsDir, skillDir, file } = fixture();
    const runElanous = mock(async (prompt: string, cwd: string, received: AbortSignal) => {
      expect(prompt).toContain('slot-001250.mp4');
      expect(cwd).toBe(clipsDir);
      expect(received).toBe(signal);
      writeFileSync(file, 'mp4');
    });
    const agent = createBrollAgent({ backend: 'elanous', clipsDir, skillDir, runElanous });
    expect(await agent(slot, { signal, timeoutMs: 100 })).toBe(file);
    expect(runElanous).toHaveBeenCalledTimes(1);
  });
});
