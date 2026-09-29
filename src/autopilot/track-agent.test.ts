import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideTrackAction, executeTrackAction, universeLaunch } from './track-agent.js';

const input = { missionId: 'apm_test', taskId: 'task:test', title: '티저 제작', prompt: '영상 티저', track: 'T' };

describe('track agent', () => {
  test('tool-free resident turn uses track ownership, handoff and phase context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'track-agent-'));
    const docs = join(root, 'docs');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(docs);
    writeFileSync(join(docs, 'HANDOFF-T-video.md'), '영상 트랙 최신 인계');
    writeFileSync(join(root, 'CLAUDE.md'), '결정표: 소유 트랙과 작업 경계');
    const calls: string[][] = [];
    try {
      const decision = await decideTrackAction(input, { root, session: () => 'sess_test', run: async (args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ reply: JSON.stringify({ action: 'say', reason: '구현' }) }) };
      } });
      expect(decision).toEqual({ action: 'say', reason: '구현' });
      expect(calls[0]?.slice(0, 5)).toEqual(['agent', '--session', 'sess_test', '--json', '--no-tools']);
      expect(calls[0]?.at(-1)).toContain('HANDOFF-T-video.md');
      expect(calls[0]?.at(-1)).toContain('영상 트랙 최신 인계');
      expect(calls[0]?.at(-1)).toContain('결정표: 소유 트랙과 작업 경계');
      expect(calls[0]?.at(-1)).toContain(input.prompt);
      expect(calls[0]?.at(-1)).toContain(input.taskId);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('invalid JSON and forbidden verbs fail closed before launch', async () => {
    const deps = { session: () => 'sess_test', run: async () => ({ stdout: '{broken' }) };
    expect((await decideTrackAction(input, deps)).action).toBe('hold');
    const blocked = await decideTrackAction(input, { ...deps,
      run: async () => ({ stdout: JSON.stringify({ reply: '{"action":"say","reason":"deploy site"}' }) }),
    });
    expect(blocked.action).toBe('hold');
    expect(await executeTrackAction(blocked, input, { launch: async () => { throw new Error('must not launch'); } }))
      .toMatchObject({ status: 'held' });
  });

  test('the forbidden-verb gate blocks a launch for this phase', async () => {
    let launched = false;
    const result = await executeTrackAction({ action: 'say' }, { ...input, prompt: '운영 배포와 재시작' }, {
      launch: async () => { launched = true; },
    });
    expect(result.status).toBe('held');
    expect(launched).toBe(false);
  });

  test('an unknown track is held instead of launching', async () => {
    let launched = false;
    const result = await executeTrackAction({ action: 'say' }, { ...input, track: 'unknown' }, {
      checkBudget: async () => true, launch: async () => { launched = true; },
    });
    expect(result.status).toBe('held');
    expect(launched).toBe(false);
  });

  test('a denied budget holds the phase before launch', async () => {
    let launched = false;
    const result = await executeTrackAction({ action: 'say' }, input, {
      checkBudget: async () => false, launch: async () => { launched = true; },
    });
    expect(result).toEqual({ status: 'held', detail: '예산 관문' });
    expect(launched).toBe(false);
  });

  test('a failed budget probe is fail closed', async () => {
    let launched = false;
    const result = await executeTrackAction({ action: 'say' }, input, {
      checkBudget: async () => { throw new Error('quota unreadable'); },
      launch: async () => { launched = true; },
    });
    expect(result).toEqual({ status: 'held', detail: '예산 관문 측정 실패' });
    expect(launched).toBe(false);
  });

  test('launch is detached, cannot auto-merge and respects the concurrency limit', async () => {
    const args: string[][] = [];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const deps = { maxConcurrent: 1, checkBudget: async () => true,
      launch: async (values: string[]) => { args.push(values); await pending; } };
    const first = executeTrackAction({ action: 'say' }, input, deps);
    expect((await executeTrackAction({ action: 'say' }, input, deps)).status).toBe('held');
    finish();
    expect((await first).status).toBe('launched');
    expect(args).toEqual([['harness', 'say', '--no-auto-merge', `${input.title}\n${input.prompt}`]]);
  });

  test('the concurrency slot stays held until the launched run exits, not just until it spawns', async () => {
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => { exit = resolve; });
    const deps = { maxConcurrent: 1, checkBudget: async () => true, launch: async () => ({ exited }) };
    expect((await executeTrackAction({ action: 'say' }, input, deps)).status).toBe('launched');
    expect((await executeTrackAction({ action: 'say' }, input, deps)).status).toBe('held');
    exit();
    await exited; await Promise.resolve();
    expect((await executeTrackAction({ action: 'say' }, input, { ...deps, launch: async () => undefined })).status).toBe('launched');
  });

  test('release, --prod and config set in a phase are held', async () => {
    for (const prompt of ['cut a release of the app', 'run it with --prod now', 'elanous config set llm.model x']) {
      let launched = false;
      const r = await executeTrackAction({ action: 'say' }, { ...input, prompt }, {
        checkBudget: async () => true, launch: async () => { launched = true; } });
      expect(r.status).toBe('held');
      expect(launched).toBe(false);
    }
  });

  test('children run in the daemon universe (config and state pinned), never the test universe', () => {
    const { argv, env } = universeLaunch(['harness', 'say', 'x'], '/tmp/daemon-root');
    expect(argv).toEqual(['bin/elanous.mjs', '--config-dir', '/tmp/daemon-root', 'harness', 'say', 'x']);
    expect(argv).not.toContain('--test');
    expect(env.ELANOUS_STATE_DIR).toBe('/tmp/daemon-root');
  });
});
