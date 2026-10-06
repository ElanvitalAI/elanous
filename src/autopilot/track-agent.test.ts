import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveInstanceRoot, treeDerivedRootFor } from '../instance/resolve.js';
import { TRACK_AGENT_FORBIDDEN_ACTION_REGEX, decideTrackAction, executeTrackAction, universeLaunch } from './track-agent.js';

const input = { missionId: 'apm_test', taskId: 'task:test', title: '티저 제작', prompt: '영상 티저', track: 'T' };

describe('track agent', () => {
  test('work topic does not become a forbidden operation but an imperative merge request does', async () => {
    expect(TRACK_AGENT_FORBIDDEN_ACTION_REGEX.test('병합 경로에 동결 검사를 더하는')).toBe(false);
    expect(TRACK_AGENT_FORBIDDEN_ACTION_REGEX.test('main 에 병합해라')).toBe(true);
    const launched = await executeTrackAction({ action: 'say' }, { ...input, title: '병합 경로에 동결 검사를 더하는', prompt: '동결 검사 구현' },
      { shadow: false, checkBudget: async () => true, launch: async () => {} });
    expect(launched.status).toBe('launched');
    expect((await executeTrackAction({ action: 'say' }, { ...input, prompt: 'main 에 병합해라' })).status).toBe('held');
    expect(await executeTrackAction({ action: 'say' }, { ...input, title: 'main 에 병합해라', prompt: '구현' },
      { shadow: false, checkBudget: async () => true, launch: async () => {} }))
      .toMatchObject({ status: 'launched' });
    expect((await executeTrackAction({ action: 'say' }, { ...input, title: 'main 에 병합해라', prompt: 'main 에 병합해라' })).status).toBe('held');
  });

  test('the exported forbidden-action regex matches the decision and launch gates', async () => {
    const forbidden = ['deploy site', '운영 배포', 'run with --prod', 'config set llm.model x'];
    const allowed = ['draft a teaser', '티저 제작'];
    for (const phrase of forbidden) {
      expect(TRACK_AGENT_FORBIDDEN_ACTION_REGEX.test(phrase)).toBe(true);
      const decision = await decideTrackAction(input, {
        shadow: false, session: () => 'sess_test',
        run: async () => ({ stdout: JSON.stringify({ reply: JSON.stringify({ action: 'say', reason: phrase }) }) }),
      });
      expect(decision.action).toBe('hold');
      let launched = false;
      const result = await executeTrackAction({ action: 'say' }, { ...input, prompt: phrase }, {
        shadow: false, checkBudget: async () => true, launch: async () => { launched = true; },
      });
      expect(result).toEqual({ status: 'held', detail: '금지 작업 — 사람 확인' });
      expect(launched).toBe(false);
    }
    for (const phrase of allowed) expect(TRACK_AGENT_FORBIDDEN_ACTION_REGEX.test(phrase)).toBe(false);
  });

  test('mutating the exported regex cannot bypass the decision or launch gate', async () => {
    const originalTest = TRACK_AGENT_FORBIDDEN_ACTION_REGEX.test;
    try {
      TRACK_AGENT_FORBIDDEN_ACTION_REGEX.test = () => false;
      const decision = await decideTrackAction(input, {
        shadow: false, session: () => 'sess_test',
        run: async () => ({ stdout: JSON.stringify({ reply: JSON.stringify({ action: 'say', reason: 'deploy site' }) }) }),
      });
      expect(decision.action).toBe('hold');
      let launched = false;
      const result = await executeTrackAction({ action: 'say' }, { ...input, prompt: 'deploy site' }, {
        shadow: false, checkBudget: async () => true, launch: async () => { launched = true; },
      });
      expect(result).toEqual({ status: 'held', detail: '금지 작업 — 사람 확인' });
      expect(launched).toBe(false);
    } finally {
      TRACK_AGENT_FORBIDDEN_ACTION_REGEX.test = originalTest;
    }
  });

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

  test('shadow cap holds before the ordinary decision path and cannot reach execution', async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'track-agent-cap-'));
    let sessions = 0;
    let decisions = 0;
    let budgets = 0;
    let orchestrations = 0;
    try {
      const decision = await decideTrackAction(input, {
        shadow: true, shadowOptions: { ledgerDir, maxDecisionsPerDay: 0 },
        session: () => { sessions++; return 'sess_test'; },
        run: async () => { decisions++; return { stdout: JSON.stringify({ reply: '{"action":"say"}' }) }; },
      });
      expect(decision).toEqual({ action: 'hold', reason: '일일 판정 상한' });
      expect([sessions, decisions]).toEqual([0, 0]);
      const result = await executeTrackAction(decision, input, {
        shadow: true, shadowOptions: { ledgerDir, orchestrate: async () => {
          orchestrations++;
          return { stdout: '[]' };
        } }, checkBudget: async () => { budgets++; return true; },
      });
      expect(result).toEqual({ status: 'held', detail: '일일 판정 상한' });
      expect([budgets, orchestrations]).toEqual([0, 0]);
    } finally { rmSync(ledgerDir, { recursive: true, force: true }); }
  });

  test('shadow execution keeps forbidden-task, track and budget gates before orchestration', async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'track-agent-shadow-'));
    let launches = 0;
    let budgets = 0;
    const deps = { shadow: true, shadowOptions: { ledgerDir, orchestrate: async () => {
      launches++;
      return { stdout: JSON.stringify([{ status: 'done', worktreePath: '/tmp/shadow-run' }]) };
    } }, checkBudget: async () => { budgets++; return true; },
    launch: async () => { throw new Error('ordinary launch must not run'); } };
    try {
      expect(await executeTrackAction({ action: 'say' }, { ...input, prompt: 'deploy the site' }, deps))
        .toEqual({ status: 'held', detail: '금지 작업 — 사람 확인' });
      expect(await executeTrackAction({ action: 'say' }, { ...input, track: 'unknown' }, deps))
        .toEqual({ status: 'held', detail: '트랙 미정 — 사람 확인' });
      expect(await executeTrackAction({ action: 'say' }, input, { ...deps, checkBudget: async () => false }))
        .toEqual({ status: 'held', detail: '예산 관문' });
      expect([budgets, launches]).toEqual([0, 0]);
      expect(await executeTrackAction({ action: 'say' }, input, deps))
        .toEqual({ status: 'launched', detail: '/tmp/shadow-run' });
      expect([budgets, launches]).toEqual([1, 1]);
    } finally { rmSync(ledgerDir, { recursive: true, force: true }); }
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

  test('children run in the daemon universe with the matching state-root origin', () => {
    const previousDir = process.env.ELANOUS_STATE_DIR;
    const previousSource = process.env.ELANOUS_STATE_DIR_SOURCE;
    try {
      process.env.ELANOUS_STATE_DIR = '/tmp/daemon-root';
      process.env.ELANOUS_STATE_DIR_SOURCE = 'derived';
      const { argv, env } = universeLaunch(['harness', 'say', 'x'], '/tmp/daemon-root');
      expect(argv).toEqual(['bin/elanous.mjs', '--config-dir', '/tmp/daemon-root', 'harness', 'say', 'x']);
      expect(argv).not.toContain('--test');
      expect(env.ELANOUS_STATE_DIR).toBe('/tmp/daemon-root');
      expect(env.ELANOUS_STATE_DIR_SOURCE).toBe('derived');
      const different = universeLaunch([], '/tmp/different-root');
      expect(different.env.ELANOUS_STATE_DIR_SOURCE).toBe('explicit');
      delete process.env.ELANOUS_STATE_DIR_SOURCE;
      expect(universeLaunch([], '/tmp/daemon-root').env.ELANOUS_STATE_DIR_SOURCE).toBe('explicit');
      const derivedRoot = treeDerivedRootFor(process.cwd());
      expect(derivedRoot).not.toBeNull();
      process.env.ELANOUS_STATE_DIR = derivedRoot!;
      expect(universeLaunch([], derivedRoot!).env.ELANOUS_STATE_DIR_SOURCE).toBe('derived');
      delete process.env.ELANOUS_STATE_DIR;
      expect(universeLaunch([], effectiveInstanceRoot()).env.ELANOUS_STATE_DIR_SOURCE).toBe('derived');
    } finally {
      if (previousDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousDir;
      if (previousSource === undefined) delete process.env.ELANOUS_STATE_DIR_SOURCE;
      else process.env.ELANOUS_STATE_DIR_SOURCE = previousSource;
    }
  });
});

test('security words stay blocked even as a topic: secret · credential · 자격 · 비밀 · force', () => {
  for (const text of ['rotate the secret store', 'credential refresh', 'Pod 자격 갱신', '비밀 값 정리', 'git push --force']) {
    expect(TRACK_AGENT_FORBIDDEN_ACTION_REGEX.test(text)).toBe(true);
  }
  expect(TRACK_AGENT_FORBIDDEN_ACTION_REGEX.test('병합 경로에 동결 검사를 더하는 수리')).toBe(false);
});
