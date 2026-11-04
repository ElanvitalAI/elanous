import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PendingTaskNotification } from '../agent/task-notification.js';
import { enqueueClassicSidetabMissionPairCompletion, prepareClassicSidetabMissionOutputDirectory, runPreparedClassicSidetabVisibleMission } from './classic-sidetab-mission-job.js';
import { startClassicSidetabMissionPair } from './classic-sidetab-mission-pair.js';
import { createClassicSidetabMissionPairSessionRegistry } from './classic-sidetab-mission.js';

const workspaces: string[] = [];
function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'classic-pair-job-'));
  workspaces.push(workspace);
  execFileSync('git', ['init', '--quiet', workspace]);
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(workspace, 'one.txt'), 'one\n');
  writeFileSync(join(workspace, 'two.txt'), 'two\n');
  execFileSync('git', ['-C', workspace, 'add', 'one.txt', 'two.txt']);
  execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'base']);
  return workspace;
}

function candidate(baseSha: string, file: string, before: string, after: string): string {
  return `<SIDETAB-CANDIDATE-V1 base-sha="${baseSha}">\n` +
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n` +
    '</SIDETAB-CANDIDATE-V1>';
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test('production pair runner prepares output before the real visible-agent writes', async () => {
  const workspace = createWorkspace();
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'write a visible result', parallelMission: 'write another visible result',
    spawnVisible: (agent) => {
      const cwd = join(workspace, agent);
      mkdirSync(cwd, { recursive: true });
      return { id: agent + '-first-run', cwd };
    },
    runVisible: async (agent, prompt, session) => {
      const outputPath = join(session!.cwd, '.elanous', 'mission-results', 'actual-' + agent + '.md.tmp');
      let screen = '\n› Ask Codex to do anything\n';
      let typed = '';
      let enterCount = 0;
      expect(existsSync(join(session!.cwd, '.elanous', 'mission-results'))).toBe(false);
      const result = await runPreparedClassicSidetabVisibleMission({
        agent, mission: prompt, outputPath,
        pty: {
          snapshot: () => screen,
          isAlive: () => true,
          write: (bytes) => {
            if (bytes !== '\r') { typed += bytes; screen += bytes; return; }
            enterCount += 1;
            if (enterCount === 1) {
              expect(existsSync(join(session!.cwd, '.elanous', 'mission-results'))).toBe(true);
              expect(statSync(join(session!.cwd, '.elanous', 'mission-results')).mode & 0o777).toBe(0o700);
              writeFileSync(outputPath, '# ' + agent + ' first-run result\n');
              screen = '\n› Ask Codex to do anything\n';
            } else {
              const marker = typed.match(/Say (M-[a-f0-9]{12}) alone and write it to the exact file path (.+)\./);
              expect(marker).not.toBeNull();
              writeFileSync(marker![2]!, marker![1]! + '\n');
              screen += '\n└ ' + marker![1] + '\n';
            }
            typed = '';
          },
        },
        handleTrust: () => false, sleep: async () => {}, pollMs: 0,
        readyTimeoutMs: 100, visibilityTimeoutMs: 100, completionTimeoutMs: 100,
      });
      expect(result).toMatchObject({ ok: true, missionTyped: true, missionSubmitted: true, completionMarker: true });
      expect(readFileSync(outputPath, 'utf8')).toBe('# ' + agent + ' first-run result\n');
      return result;
    },
    registry: createClassicSidetabMissionPairSessionRegistry(), hasSession: () => true, killSession: () => {}, enqueue: () => {},
    createId: (() => { let id = 0; return () => 'actual-' + (++id); })(),
  });
  await started.completion;
});

test('pair output preparation preserves permissions on an existing result directory', () => {
  const workspace = createWorkspace();
  const dir = join(workspace, '.elanous', 'mission-results');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o750);

  prepareClassicSidetabMissionOutputDirectory(join(dir, 'classic-pair-pty-1.md.tmp'));
  expect(statSync(dir).mode & 0o777).toBe(0o750);
});

test('pair completion is one parent-scoped notification with both answers and redacted result paths', async () => {
  const notifications: PendingTaskNotification[] = [];
  const workspaceDir = createWorkspace();
  const baseSha = execFileSync('git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const pair = {
    codex: {
      missionId: 'codex-mission',
      taskId: 'codex-mission',
      parentSessionId: 'parent-session-7',
      startedAt: 10,
      mission: 'Codex mission',
      workspaceDir,
      baseSha,
      completion: Promise.resolve({ ok: true, path: '/private/codex.md', content: `Codex answer /private/codex.md\n${candidate(baseSha, 'one.txt', 'one', 'codex-one')}` }),
    },
    claude: {
      missionId: 'claude-mission',
      taskId: 'claude-mission',
      parentSessionId: 'parent-session-7',
      startedAt: 20,
      mission: 'Claude mission',
      workspaceDir,
      baseSha,
      completion: Promise.resolve({ ok: true, path: '/private/claude.md', content: `Claude answer /private/claude.md\n${candidate(baseSha, 'two.txt', 'two', 'claude-two')}` }),
    },
  };

  await enqueueClassicSidetabMissionPairCompletion(pair, (notification) => notifications.push(notification), () => 50);

  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    taskId: 'codex-mission',
    parentSessionId: 'parent-session-7',
    agentName: 'Codex + Claude',
    state: 'done',
    durationMs: 40,
  });
  const notification = notifications[0]!;
  expect(notification.output).toContain('Full comparison attached');
  expect(notification.output).not.toContain('/private/');
  const synthesis = readFileSync(notification.resultPath!, 'utf8');
  expect(synthesis).toContain('Codex answer [internal result]');
  expect(synthesis).toContain('Claude answer [internal result]');
  expect(synthesis).not.toContain('/private/');
  expect(synthesis).toContain('State: merged');
});

test('successful child text without a captured base SHA stays unavailable and cannot report done', async () => {
  const notifications: PendingTaskNotification[] = [];
  const workspaceDir = createWorkspace();
  await enqueueClassicSidetabMissionPairCompletion({
    codex: {
      taskId: 'missing-base', startedAt: 1, mission: 'Codex', workspaceDir,
      completion: Promise.resolve({ ok: true, content: 'unverified codex answer' }),
    },
    claude: {
      taskId: 'missing-base', startedAt: 1, mission: 'Claude', workspaceDir,
      completion: Promise.resolve({ ok: true, content: 'unverified claude answer' }),
    },
  }, (notification) => notifications.push(notification), () => 2);

  expect(notifications[0]!.state).toBe('error');
  const synthesis = readFileSync(notifications[0]!.resultPath!, 'utf8');
  expect(synthesis).toContain('State: unavailable');
  expect(synthesis).toContain('pair base SHA was not captured');
  expect(synthesis).toContain('unverified codex answer');
  expect(synthesis).toContain('unverified claude answer');
});

test('pair completion attaches the isolated merged patch from the pinned base SHA', async () => {
  const notifications: PendingTaskNotification[] = [];
  const workspaceDir = createWorkspace();
  execFileSync('git', ['init', '--quiet', workspaceDir]);
  execFileSync('git', ['-C', workspaceDir, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', workspaceDir, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(workspaceDir, 'one.txt'), 'one\n');
  writeFileSync(join(workspaceDir, 'two.txt'), 'two\n');
  execFileSync('git', ['-C', workspaceDir, 'add', 'one.txt', 'two.txt']);
  const baseSha = execFileSync('git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const diff = (agent: string, file: string, before: string, after: string) =>
    `${agent} candidate\n<SIDETAB-CANDIDATE-V1 base-sha="${baseSha}">\n` +
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n` +
    '</SIDETAB-CANDIDATE-V1>';
  const pair = {
    codex: {
      taskId: 'integrate-task', startedAt: 1, mission: 'change one', workspaceDir, baseSha,
      completion: Promise.resolve({ ok: true, path: '/private/codex.md', content: diff('codex', 'one.txt', 'one', 'codex-one') }),
    },
    claude: {
      taskId: 'integrate-task', startedAt: 1, mission: 'change two', workspaceDir, baseSha,
      completion: Promise.resolve({ ok: true, path: '/private/claude.md', content: diff('claude', 'two.txt', 'two', 'claude-two') }),
    },
  };

  await enqueueClassicSidetabMissionPairCompletion(pair, (notification) => notifications.push(notification), () => 2);

  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.state).toBe('done');
  expect(notifications[0]!.output).toContain('Non-overlapping candidate changes are merged');
  const synthesis = readFileSync(notifications[0]!.resultPath!, 'utf8');
  expect(synthesis).toContain('State: merged');
  expect(synthesis).toContain('codex-one');
  expect(synthesis).toContain('claude-two');
  expect(synthesis).toContain('codex candidate');
  expect(synthesis).toContain('claude candidate');
  expect(readFileSync(join(workspaceDir, 'one.txt'), 'utf8')).toBe('one\n');
  expect(readFileSync(join(workspaceDir, 'two.txt'), 'utf8')).toBe('two\n');
  expect(execFileSync('git', ['-C', workspaceDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('?? .elanous/');
});

test('pair completion leaves overlapping candidate hunks unresolved and preserves both for the parent', async () => {
  const notifications: PendingTaskNotification[] = [];
  const workspaceDir = createWorkspace();
  const baseSha = execFileSync('git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const diff = (agent: string, choice: string) =>
    `${agent} candidate\n<SIDETAB-CANDIDATE-V1 base-sha="${baseSha}">\n` +
    `diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-one\n+${choice}\n` +
    '</SIDETAB-CANDIDATE-V1>';
  const pair = {
    codex: {
      taskId: 'conflict-task', startedAt: 1, mission: 'Codex change', workspaceDir, baseSha,
      completion: Promise.resolve({ ok: true, content: diff('Codex', 'codex-choice') }),
    },
    claude: {
      taskId: 'conflict-task', startedAt: 1, mission: 'Claude change', workspaceDir, baseSha,
      completion: Promise.resolve({ ok: true, content: diff('Claude', 'claude-choice') }),
    },
  };

  await enqueueClassicSidetabMissionPairCompletion(pair, (notification) => notifications.push(notification), () => 2);

  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.state).toBe('done');
  expect(notifications[0]!.output).toContain('unresolved overlapping hunks');
  const synthesis = readFileSync(notifications[0]!.resultPath!, 'utf8');
  expect(synthesis).toContain('State: conflict');
  expect(synthesis).toContain('Parent action: choose or revise');
  expect(synthesis).toContain('codex-choice');
  expect(synthesis).toContain('claude-choice');
  expect(readFileSync(join(workspaceDir, 'one.txt'), 'utf8')).toBe('one\n');
  expect(execFileSync('git', ['-C', workspaceDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('?? .elanous/');
});

test('pair completion marks a missing answer as error and says which agent had no answer', async () => {
  const notifications: PendingTaskNotification[] = [];
  const workspaceDir = createWorkspace();
  await enqueueClassicSidetabMissionPairCompletion({
    codex: {
      missionId: 'codex-mission', taskId: 'pair-task', parentSessionId: 'parent-session-8', startedAt: 1,
      mission: 'Codex task', workspaceDir,
      completion: Promise.resolve({ ok: true, content: '  ' }),
    },
    claude: {
      missionId: 'claude-mission', taskId: 'pair-task', parentSessionId: 'parent-session-8', startedAt: 1,
      mission: 'Claude task', workspaceDir,
      completion: Promise.resolve({ ok: true, content: 'Claude answer' }),
    },
  }, (notification) => notifications.push(notification), () => 2);

  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.state).toBe('error');
  expect(notifications[0]!.output).toContain('Pair completed with failures');
  const synthesis = readFileSync(notifications[0]!.resultPath!, 'utf8');
  expect(synthesis).toContain('| Codex | Codex task | 없음 | 실패/빈 결과 | 미채택 — 빈 결과 |');
  expect(synthesis).toContain('| Claude Code | Claude task | 없음 | 성공 | 채택');
  expect(synthesis).toContain('Claude answer');
});

test('a failed child candidate is preserved for review but never reconciled', async () => {
  const notifications: PendingTaskNotification[] = [];
  const workspaceDir = createWorkspace();
  const baseSha = execFileSync('git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const makeDiff = (file: string, before: string, after: string) => candidate(baseSha, file, before, after);
  await enqueueClassicSidetabMissionPairCompletion({
    codex: {
      taskId: 'failed-candidate', startedAt: 1, mission: 'Codex failed', workspaceDir, baseSha,
      completion: Promise.resolve({ ok: false, status: 'failed', error: 'child failed after partial output', content: makeDiff('one.txt', 'one', 'must-not-merge') }),
    },
    claude: {
      taskId: 'failed-candidate', startedAt: 1, mission: 'Claude ok', workspaceDir, baseSha,
      completion: Promise.resolve({ ok: true, content: makeDiff('two.txt', 'two', 'claude-ok') }),
    },
  }, (notification) => notifications.push(notification), () => 2);

  expect(notifications[0]!.state).toBe('error');
  const synthesis = readFileSync(notifications[0]!.resultPath!, 'utf8');
  expect(synthesis).toContain('State: unavailable');
  expect(synthesis).toContain('requires two successful children');
  expect(synthesis).not.toContain('State: merged');
  expect(synthesis).toContain('Codex 실패 결과의 후보 패치 (보존만 · 병합 대상 아님)');
  expect(synthesis).toContain('must-not-merge');
  expect(synthesis).not.toContain('```diff');
  expect(synthesis).toContain('claude-ok');
});

test('failed candidate evidence survives when the pair has no common base SHA', async () => {
  const notifications: PendingTaskNotification[] = [];
  const workspaceDir = createWorkspace();
  const baseSha = execFileSync('git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const failedDiff = candidate(baseSha, 'one.txt', 'one', 'preserve-for-review');
  await enqueueClassicSidetabMissionPairCompletion({
    codex: {
      taskId: 'mismatched-base-candidate', startedAt: 1, mission: 'Codex failed', workspaceDir, baseSha,
      completion: Promise.resolve({ ok: false, status: 'failed', error: 'child failed after partial output', content: failedDiff }),
    },
    claude: {
      taskId: 'mismatched-base-candidate', startedAt: 1, mission: 'Claude ok', workspaceDir, baseSha: 'a'.repeat(40),
      completion: Promise.resolve({ ok: true, content: candidate('a'.repeat(40), 'two.txt', 'two', 'claude-ok') }),
    },
  }, (notification) => notifications.push(notification), () => 2);

  expect(notifications[0]!.state).toBe('error');
  const synthesis = readFileSync(notifications[0]!.resultPath!, 'utf8');
  expect(synthesis).toContain('State: unavailable');
  expect(synthesis).toContain('pair base SHA was not captured');
  expect(synthesis).toContain('Codex 실패 결과의 후보 패치 (보존만 · 병합 대상 아님)');
  expect(synthesis).toContain('preserve-for-review');
  expect(synthesis).not.toContain('State: merged');
  expect(synthesis).not.toContain('```diff');
});
