import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskNotificationQueue, type PendingTaskNotification } from '../agent/task-notification.js';
import { CLASSIC_SIDETAB_MISSION_TOOL_NAME, createClassicSidetabMissionIntegration, createClassicSidetabMissionPairSessionRegistry, createClassicSidetabMissionTool } from './classic-sidetab-mission.js';
import { captureClassicMissionExitObservation, createClassicSidetabMissionTrioVisibleRunner, runClassicSidetabMissionTrioMember, startClassicSidetabMissionTrio } from './classic-sidetab-mission-trio.js';
import { findGitDir } from '../git-fs/locate.js';

test('trio exit evidence reports natural status without initiating cleanup', () => {
  expect(captureClassicMissionExitObservation(true, 0)).toEqual({ exitCode: 0, exitObservation: 'natural-exit' });
  expect(captureClassicMissionExitObservation(false, null)).toEqual({});
});

test('classic trio entrypoint sends exactly one Grok trust response through the PTY', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'classic-trio-grok-trust-'));
  const mainRepo = join(tempRoot, 'main');
  const cwd = join(tempRoot, 'worktree');
  try {
    mkdirSync(mainRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet', mainRepo]);
    writeFileSync(join(mainRepo, 'fixture.txt'), 'linked worktree fixture\n');
    execFileSync('git', ['-C', mainRepo, 'add', 'fixture.txt']);
    execFileSync('git', ['-C', mainRepo, '-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    execFileSync('git', ['-C', mainRepo, 'worktree', 'add', '--quiet', '--detach', cwd, 'HEAD']);
    expect(findGitDir(cwd)?.isWorktree).toBe(true);
    const outputPath = join(cwd, 'grok-trust-entrypoint.md');
    const writes: string[] = [];
    const trustScreen = [
      'Do you trust the contents of this directory?',
      cwd,
      'Grok Build may run or modify contents in this directory.',
      'Yes, proceed y / No, quit n',
    ].join('\n');
    let screen = trustScreen;
    let markerValue: string | undefined;
    let grokResult: Awaited<ReturnType<typeof runClassicSidetabMissionTrioMember>> | undefined;
    const trio = await startClassicSidetabMissionTrio({
      mission: 'Read package.json and report its version.',
      checkGrokAuth: () => ({ ok: true }),
      spawnVisible: (agent) => ({ id: `${agent}-pty`, cwd }),
      runVisible: async (agent, mission, session) => {
        if (agent !== 'grok') return { ok: true, status: 'completed', path: join(cwd, `${agent}.md`), exitCode: 0 };
        const result = await runClassicSidetabMissionTrioMember({
          member: agent, cwd: session!.cwd, mission, outputPath,
          pty: {
            snapshot: () => screen,
            write: bytes => {
              writes.push(bytes);
              if (bytes === 'y\r') { screen = '❯ Ask Grok to do anything'; return true; }
              if (bytes === '\r') {
                if (screen.includes('Say M-')) {
                  markerValue = screen.match(/M-[a-f0-9]{12}/)?.[0];
                  if (markerValue) writeFileSync(`${outputPath}.completion-${markerValue}`, markerValue);
                  screen = `└ ${markerValue ?? ''}`;
                } else if (screen.includes('Write the result to the exact file path')) {
                  writeFileSync(outputPath, '# package version 1.2.3\n');
                  screen = '❯ Ask Grok to do anything';
                }
              } else {
                screen += bytes;
              }
              return true;
            },
            isAlive: () => true,
          },
          handleTrust: () => false,
        });
        grokResult = result;
        return { ...result, path: outputPath, exitCode: 0 };
      },
      registry: createClassicSidetabMissionPairSessionRegistry(),
      enqueue: () => {},
    });

    await trio.completion;
    expect(grokResult).toMatchObject({ ok: true, promptReady: true, missionSubmitted: true, completionMarker: true });
    expect(grokResult?.initialScreen).toContain('Do you trust the contents of this directory?');
    expect(writes.filter(write => write === 'y\r')).toHaveLength(1);
  } finally {
    if (findGitDir(mainRepo)) {
      try { execFileSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', cwd]); } catch { /* temp tree cleanup below is authoritative */ }
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('two completed hands write one synthesis record with attribution rows and notify its path', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sidetab-trio-synthesis-'));
  const notifications: PendingTaskNotification[] = [];
  try {
    const started = await startClassicSidetabMissionTrio({
      mission: 'Compare the candidates for the demo.',
      context: { callId: 'synthesis-call', parentSessionId: 'synthesis-parent' },
      checkGrokAuth: () => ({ ok: false, reason: 'Grok unavailable for this pair run' }),
      spawnVisible: (agent) => agent === 'grok' ? null : { id: `${agent}-pty`, cwd },
      runVisible: async (agent) => ({
        ok: true,
        status: 'completed',
        exitCode: agent === 'codex' ? 0 : null,
        path: join(cwd, `${agent}.md`),
        content: `${agent} candidate result`,
      }),
      registry: createClassicSidetabMissionPairSessionRegistry(),
      enqueue: (notification) => notifications.push(notification),
      createId: (() => { let id = 0; return () => `synthesis-${++id}`; })(),
    });

    await started.completion;

    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification.resultPath).toBeTruthy();
    const synthesisPath = notification.resultPath!;
    const contents = readFileSync(synthesisPath, 'utf8');
    expect(contents).toContain('| codex | Compare the candidates for the demo. |');
    expect(contents).toContain('| claude | Compare the candidates for the demo. |');
    expect(contents).toContain('| codex | Compare the candidates for the demo. | ' + join(cwd, 'codex.md') + ' | 완료 | 0 | 미수집 |');
    expect(contents).toContain('| claude | Compare the candidates for the demo. | ' + join(cwd, 'claude.md') + ' | 완료 | 미상 | 미수집 |');
    expect(contents).toContain('codex candidate result');
    expect(contents).toContain('claude candidate result');
    expect(contents).toContain('## 채택 결과\n_최종 채택문은 알림을 받은 부모 응답에서 작성한다.');
    expect(contents).toContain('## 채택 근거\n_후보별 상태와 원문은 위 표에 기록했다.');
    const resultFiles = readdirSync(join(cwd, '.elanous', 'mission-results'));
    expect(resultFiles).toEqual([synthesisPath.split('/').at(-1)!]);
    const payload = JSON.parse(notification.output) as { artifacts: string[]; body: string };
    expect(payload.artifacts).toEqual([synthesisPath]);
    expect(payload.body).toContain(`Synthesis record: ${synthesisPath}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('synthesis labels an omitted exit code as unconfirmed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sidetab-trio-unconfirmed-exit-'));
  const notifications: PendingTaskNotification[] = [];
  try {
    const started = await startClassicSidetabMissionTrio({
      mission: 'Inspect the demo.',
      checkGrokAuth: () => ({ ok: false }),
      spawnVisible: (agent) => agent === 'grok' ? null : { id: `${agent}-pty`, cwd },
      runVisible: async (agent) => ({ ok: true, status: 'completed', path: join(cwd, `${agent}.md`) }),
      registry: createClassicSidetabMissionPairSessionRegistry(),
      enqueue: (notification) => notifications.push(notification),
    });
    await started.completion;
    const contents = readFileSync(notifications[0]!.resultPath!, 'utf8');
    expect(contents).toContain('| codex | Inspect the demo. | ' + join(cwd, 'codex.md') + ' | 완료 | 미수집 | 미수집 |');
    expect(contents).toContain('- 종료 코드: 미확인');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('trio launches three visible agents with the same prompt and enqueues one comparison/adoption notification', async () => {
  const queue = new TaskNotificationQueue();
  queue.clear();
  const registry = createClassicSidetabMissionPairSessionRegistry();
  const spawned: string[] = [];
  const liveSessions = new Set<string>();
  const missions: Array<{ agent: string; mission: string }> = [];
  const delivered: PendingTaskNotification[] = [];
  let id = 0;
  const started = await startClassicSidetabMissionTrio({
    mission: 'Inspect and fix the graph demo.',
    context: { callId: 'trio-call', parentSessionId: 'parent-trio' },
    checkGrokAuth: () => { expect(spawned).toEqual(['claude', 'codex']); return { ok: true }; },
    spawnVisible: (agent) => { spawned.push(agent); const id = `${agent}-pty`; liveSessions.add(id); return { id, cwd: '/work' }; },
    runVisible: async (agent, mission) => {
      missions.push({ agent, mission });
      return { ok: true, status: 'completed', content: `${agent} candidate`, finalScreen: `${agent} raw final frame` };
    },
    registry,
    enqueue: (notification) => { delivered.push(notification); queue.enqueue(notification); },
    createId: () => `id-${++id}`,
    now: () => 100,
  });

  expect(spawned).toEqual(['claude', 'codex', 'grok']);
  expect(started.result.members.grok.status).toBe('running');
  await started.completion;
  expect(liveSessions.size).toBe(3);
  expect([...liveSessions].sort()).toEqual(["claude-pty", "codex-pty", "grok-pty"]);
  expect(missions).toHaveLength(3);
  expect(new Set(missions.map((entry) => entry.mission))).toEqual(new Set(['Inspect and fix the graph demo.']));
  expect(queue.drainForParentSession('other-parent')).toEqual([]);
  const notices = queue.drainForParentSession('parent-trio');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ taskId: 'trio-call', agentName: 'Codex + Claude + Grok', state: 'done' });
  const payload = JSON.parse(delivered[0]!.output) as { body: string };
  expect(payload.body).toContain('codex candidate');
  expect(payload.body).toContain('claude candidate');
  expect(payload.body).toContain('grok candidate');
  expect(payload.body).toContain('grok final raw PTY screen:\ngrok raw final frame');
  expect(payload.body).toContain('adopted result');

  const second = await startClassicSidetabMissionTrio({
    mission: 'Inspect the same graph demo again.',
    context: { callId: 'trio-call-2', parentSessionId: 'parent-trio' },
    checkGrokAuth: () => ({ ok: true }),
    spawnVisible: (agent) => { spawned.push(agent); const id = `${agent}-pty`; liveSessions.add(id); return { id, cwd: '/work' }; },
    runVisible: async (agent, mission) => {
      missions.push({ agent, mission });
      return { ok: true, status: 'completed', content: `${agent} second candidate` };
    },
    registry,
    enqueue: (notification) => { delivered.push(notification); queue.enqueue(notification); },
    createId: () => `id-${++id}`,
  });
  expect(second.result.members.grok.status).toBe('running');
  await second.completion;
  expect(liveSessions.size).toBe(3);
  expect(spawned).toEqual(['claude', 'codex', 'grok', 'claude', 'codex', 'grok']);
  expect(delivered).toHaveLength(2);
  expect(queue.drainForParentSession('parent-trio')).toHaveLength(1);
});

test('partial trio completion stays actionable and aligns notification and JSON status', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sidetab-trio-partial-'));
  const delivered: PendingTaskNotification[] = [];
  try {
    const started = await startClassicSidetabMissionTrio({
      mission: 'Read package.json and report its name.',
      checkGrokAuth: () => ({ ok: true }),
      spawnVisible: agent => ({ id: `${agent}-pty`, cwd }),
      runVisible: async agent => agent === 'claude'
        ? { ok: false, status: 'failed', error: 'Mission text was not visible', path: '' }
        : { ok: true, status: 'completed', content: `${agent} reports elanous` },
      registry: createClassicSidetabMissionPairSessionRegistry(),
      enqueue: notification => delivered.push(notification),
      createId: (() => { let id = 0; return () => `partial-${++id}`; })(),
    });

    await started.completion;

    expect(delivered).toHaveLength(1);
    const notice = delivered[0]!;
    const payload = JSON.parse(notice.output) as { status: string; coverage: string; successfulMembers: string[]; failedMembers: Array<{ agent: string; reason: string }>; body: string; artifacts: string[] };
    expect(notice.state).toBe('done');
    expect(payload).toMatchObject({ status: notice.state, coverage: 'partial', successfulMembers: ['codex', 'grok'] });
    expect(payload.failedMembers).toEqual([{ agent: 'claude', reason: 'Mission text was not visible' }]);
    expect(payload.body).toContain('codex candidate');
    expect(payload.body).toContain('grok candidate');
    expect(payload.body).toContain('claude (Mission text was not visible)');
    expect(payload.body).toContain('Present a non-empty adopted result and a short reason.');
    expect(payload.artifacts).toHaveLength(1);
    const synthesis = readFileSync(payload.artifacts[0]!, 'utf8');
    expect(synthesis).toContain('| claude | Read package.json and report its name. |  | Mission text was not visible |');
    expect(synthesis).toContain('## 채택 결과\n_최종 채택문은 알림을 받은 부모 응답에서 작성한다.');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('all failed trio hands produce an error notification with no fabricated adoption', async () => {
  const delivered: PendingTaskNotification[] = [];
  const started = await startClassicSidetabMissionTrio({
    mission: 'Run a missing task.',
    checkGrokAuth: () => ({ ok: true }),
    spawnVisible: agent => ({ id: `${agent}-pty`, cwd: '/work' }),
    runVisible: async agent => ({ ok: false, status: 'failed', error: `${agent} failed`, path: '' }),
    registry: createClassicSidetabMissionPairSessionRegistry(),
    enqueue: notification => delivered.push(notification),
    createId: (() => { let id = 0; return () => `failed-${++id}`; })(),
  });
  await started.completion;
  expect(delivered).toHaveLength(1);
  const notice = delivered[0]!;
  const payload = JSON.parse(notice.output) as { status: string; coverage: string; successfulMembers: string[]; body: string };
  expect(notice.state).toBe('error');
  expect(payload).toMatchObject({ status: notice.state, coverage: 'none', successfulMembers: [] });
  expect(payload.body).toContain('No candidate succeeded');
  expect(payload.body).toContain('Leave the adopted result explicitly unavailable');
});

test('timeout preserves already completed candidates for parent synthesis', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sidetab-trio-timeout-'));
  const delivered: PendingTaskNotification[] = [];
  const resolveRun = new Map<string, (result: { ok: boolean; status: 'completed' | 'failed'; content?: string; error?: string }) => void>();
  const started = await startClassicSidetabMissionTrio({
    mission: 'Inspect the package.',
    checkGrokAuth: () => ({ ok: true }),
    spawnVisible: agent => ({ id: `${agent}-pty`, cwd }),
    runVisible: agent => new Promise(resolve => resolveRun.set(agent, resolve)),
    registry: createClassicSidetabMissionPairSessionRegistry(),
    enqueue: notification => delivered.push(notification),
    createId: (() => { let id = 0; return () => `timeout-${++id}`; })(),
    timeoutMs: 150,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  resolveRun.get('codex')!({ ok: true, status: 'completed', content: 'codex package result' });
  resolveRun.get('grok')!({ ok: true, status: 'completed', content: 'grok package result' });
  await started.completion;

  const notice = delivered[0]!;
  const payload = JSON.parse(notice.output) as { status: string; coverage: string; successfulMembers: string[]; failedMembers: Array<{ agent: string; reason: string }>; body: string };
  expect(notice.state).toBe('done');
  expect(payload).toMatchObject({ status: notice.state, coverage: 'partial', successfulMembers: ['codex', 'grok'] });
  expect(payload.failedMembers).toEqual([{ agent: 'claude', reason: 'mission exceeded the configured safety timeout' }]);
  expect(payload.body).toContain('codex package result');
  expect(payload.body).toContain('grok package result');
  expect(payload.body).toContain('mission exceeded the configured safety timeout');
  rmSync(cwd, { recursive: true, force: true });
});

test('unavailable Grok falls back to two hands and discloses why in one notification', async () => {
  const queue = new TaskNotificationQueue();
  queue.clear();
  const spawned: string[] = [];
  const ran: string[] = [];
  const delivered: PendingTaskNotification[] = [];
  let id = 0;
  const started = await startClassicSidetabMissionTrio({
    mission: 'Same goal',
    context: { callId: 'fallback-call', parentSessionId: 'fallback-parent' },
    checkGrokAuth: () => ({ ok: false, reason: 'grok whoami: login required' }),
    spawnVisible: (agent) => { spawned.push(agent); return { id: `${agent}-pty`, cwd: '/work' }; },
    runVisible: async (agent, mission) => { ran.push(`${agent}:${mission}`); return { ok: true, status: 'completed', content: `${agent} candidate` }; },
    registry: createClassicSidetabMissionPairSessionRegistry(),
    enqueue: (notification) => { delivered.push(notification); queue.enqueue(notification); },
    createId: () => `fallback-${++id}`,
  });

  expect(started.result.grokFallback).toBe('grok whoami: login required');
  expect(started.result.members.grok).toMatchObject({ ok: false, status: 'failed' });
  await started.completion;
  expect(spawned).toEqual(['claude', 'codex']);
  expect(ran.sort()).toEqual(['claude:Same goal', 'codex:Same goal']);
  const notices = queue.drainForParentSession('fallback-parent');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ agentName: 'Codex + Claude (Grok fallback)' });
  expect(delivered).toHaveLength(1);
  const payload = JSON.parse(delivered[0]!.output) as { status: string; coverage: string; successfulMembers: string[]; failedMembers: Array<{ agent: string }>; body: string };
  expect(delivered[0]!.state).toBe('done');
  expect(payload).toMatchObject({ status: 'done', coverage: 'complete', successfulMembers: ['codex', 'claude'], failedMembers: [] });
  expect(payload.body).toContain('Grok unavailable; continued with Codex + Claude');
  expect(payload.body).toContain('grok whoami: login required');
});

test('Grok PTY spawn failure still keeps the Codex and Claude missions running', async () => {
  const spawned: string[] = [];
  const ran: string[] = [];
  let id = 0;
  const started = await startClassicSidetabMissionTrio({
    mission: 'Same goal',
    checkGrokAuth: () => ({ ok: true }),
    spawnVisible: (agent) => { spawned.push(agent); return agent === 'grok' ? null : { id: `${agent}-pty`, cwd: '/work' }; },
    runVisible: async (agent) => { ran.push(agent); return { ok: true, status: 'completed', content: 'done' }; },
    registry: createClassicSidetabMissionPairSessionRegistry(),
    enqueue: () => {},
    createId: () => `spawn-${++id}`,
  });
  await started.completion;
  expect(spawned).toEqual(['claude', 'codex', 'grok']);
  expect(ran.sort()).toEqual(['claude', 'codex']);
  expect(started.result.grokFallback).toBe('Grok sidetab PTY could not start');
});

test('sidetab mission tool opts into one same-goal three-hand comparison and rejects mixed prompts', async () => {
  const seen: string[] = [];
  const linkedIssueIds: Array<string | undefined> = [];
  const tool = createClassicSidetabMissionTool(
    async () => ({ ok: true, status: 'completed' }),
    undefined,
    async (mission, context) => {
      seen.push(mission);
      linkedIssueIds.push(context?.linearIssueId);
      return {
        trioId: 'trio-1',
        members: {
          codex: { ok: true, status: 'running', interactionId: 'codex-1' },
          claude: { ok: true, status: 'running', interactionId: 'claude-1' },
          grok: { ok: false, status: 'failed', error: 'Grok login unavailable; run grok login' },
        },
        grokFallback: 'Grok login unavailable; run grok login',
      };
    },
  );
  const result = await tool.dispatch({ agent: 'codex', mission: 'same task', withGrok: true });
  expect(result).toMatchObject({ status: 'running', id: 'codex-1' });
  expect(result.body).toContain('Grok fallback');
  expect(seen).toEqual(['same task']);
  const emptyParallel = await tool.dispatch({ agent: 'codex', mission: 'same task', parallelMission: '', withGrok: true });
  expect(emptyParallel.status).toBe('running');
  const duplicatedParallel = await tool.dispatch({ agent: 'codex', mission: 'same task', parallelMission: 'same task', withGrok: true });
  expect(duplicatedParallel).toMatchObject({ status: 'running', id: 'codex-1' });
  expect(duplicatedParallel.body).toContain('Three-hand comparison started');
  const emptyLinearIssue = await tool.dispatch({ agent: 'codex', mission: 'same task', linearIssueId: '', withGrok: true });
  expect(emptyLinearIssue.status).toBe('running');
  expect(emptyLinearIssue.body).not.toContain('Linked Linear');
  expect(linkedIssueIds.at(-1)).toBeUndefined();
  const emptySingleLinearIssue = await tool.dispatch({ agent: 'codex', mission: 'same task', linearIssueId: '' });
  expect(emptySingleLinearIssue.status).toBe('error');
  expect(emptySingleLinearIssue.body).toContain('completed without an answer');
  const linkedLinearIssue = await tool.dispatch({ agent: 'codex', mission: 'same task', linearIssueId: 'DEMO-123', withGrok: true });
  expect(linkedLinearIssue.status).toBe('running');
  expect(linkedLinearIssue.body).toContain('Linked Linear progress is not synchronized');
  expect(linkedIssueIds.at(-1)).toBe('DEMO-123');
  expect(seen).toEqual(['same task', 'same task', 'same task', 'same task', 'same task']);
  const rejected = await tool.dispatch({ agent: 'codex', mission: 'primary', parallelMission: 'different', withGrok: true });
  expect(rejected).toMatchObject({ status: 'error' });
  expect(rejected.body).toContain('omit parallelMission');
  expect(tool.spec.name).toBe(CLASSIC_SIDETAB_MISSION_TOOL_NAME);
  expect((tool.spec.parameters.properties as Record<string, unknown>).withGrok).toHaveProperty('anyOf');
  const properties = tool.spec.parameters.properties as Record<string, { minLength?: number }>;
  expect(properties.linearIssueId?.minLength).toBeUndefined();
  expect(properties.parallelMission?.minLength).toBeUndefined();
});

test('RunSidetabMission production adapter drives all three fake PTYs through trust, results, synthesis, and one notification', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'classic-trio-production-pty-'));
  const mainRepo = join(tempRoot, 'main');
  const cwd = join(tempRoot, 'worktree');
  mkdirSync(mainRepo, { recursive: true });
  execFileSync('git', ['init', '--quiet', mainRepo]);
  writeFileSync(join(mainRepo, 'fixture.txt'), 'linked worktree fixture\n');
  execFileSync('git', ['-C', mainRepo, 'add', 'fixture.txt']);
  execFileSync('git', ['-C', mainRepo, '-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  execFileSync('git', ['-C', mainRepo, 'worktree', 'add', '--quiet', '--detach', cwd, 'HEAD']);
  const spawned: string[] = [];
  const delivered: PendingTaskNotification[] = [];
  let completion: Promise<void> | undefined;
  const ptys = new Map<string, { screen: string; writes: string[] }>();
  const runVisible = createClassicSidetabMissionTrioVisibleRunner({
    ptyForSession: session => {
      const state = ptys.get(session.id)!;
      return {
        snapshot: () => state.screen,
        isAlive: () => true,
        exitCode: () => 0,
        write: bytes => {
          state.writes.push(bytes);
          if (bytes === 'y\r') { state.screen = '❯ Ask Grok to do anything'; return true; }
          if (bytes === '\r') {
            const marker = state.screen.match(/Say (M-[a-f0-9]{12}) alone and write it to the exact file path (\S+)/);
            if (marker) {
              mkdirSync(join(cwd, '.elanous', 'mission-results'), { recursive: true });
              writeFileSync(marker[2]!, `${marker[1]}\n`);
              state.screen = `└ ${marker[1]}`;
            } else {
              const target = state.screen.match(/Write the result to the exact file path (\S+)/)?.[1];
              if (!target) return false;
              mkdirSync(join(cwd, '.elanous', 'mission-results'), { recursive: true });
              writeFileSync(target, `# ${session.id} candidate\n`);
              state.screen = session.id === 'grok-pty' ? '❯ Ask Grok to do anything' : `❯ Ask ${session.id.replace('-pty', '')} to do anything`;
            }
          } else {
            state.screen += bytes;
          }
          return true;
        },
      };
    },
    outputPath: (agent, session) => join(session.cwd, '.elanous', 'mission-results', `classic-trio-${agent}-${session.id}.md`),
    handleTrust: () => false,
    sleep: async () => {},
  });
  try {
    const started = await startClassicSidetabMissionTrio({
      mission: 'same graph task',
      context: { callId: 'production-call', parentSessionId: 'production-parent' },
      checkGrokAuth: () => ({ ok: true }),
      spawnVisible: agent => {
        spawned.push(agent);
        const id = `${agent}-pty`;
        ptys.set(id, { screen: agent === 'grok' ? [
          'Do you trust the contents of this directory?', cwd,
          'Grok Build may run or modify contents in this directory.',
          'Yes, proceed y / No, quit n',
        ].join('\n') : `❯ Ask ${agent} to do anything`, writes: [] });
        return { id, cwd };
      },
      runVisible,
      registry: createClassicSidetabMissionPairSessionRegistry(),
      enqueue: notification => delivered.push(notification),
      createId: (() => { let n = 0; return () => `production-${++n}`; })(),
      timeoutMs: 5_000,
    });
    completion = started.completion;
    await completion;
    expect(spawned).toEqual(['claude', 'codex', 'grok']);
    expect(ptys.get('grok-pty')?.writes.filter(value => value === 'y\r')).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    const payload = JSON.parse(delivered[0]!.output) as { coverage: string; successfulMembers: string[]; body: string; artifacts: string[] };
    expect(payload.coverage).toBe('complete');
    expect(payload.successfulMembers).toEqual(['codex', 'claude', 'grok']);
    expect(payload.body).toContain('Codex + Claude + Grok results');
    expect(payload.body).toContain('Synthesis record:');
    expect(payload.body).toContain('grok candidate:');
    expect(payload.artifacts).toHaveLength(1);
    expect(readFileSync(payload.artifacts[0]!, 'utf8')).toContain('| grok | same graph task |');
  } finally {
    if (findGitDir(mainRepo)) {
      try { execFileSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', cwd]); } catch { /* temp tree cleanup below is authoritative */ }
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
