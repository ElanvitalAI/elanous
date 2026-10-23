import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, getActiveSessionId, loadSession, setActiveSessionId } from '../session/index.js';
import { claimTuiOwnedSession, decideTuiRestartSession, getTuiOwnedSession } from './tui-self-report.js';
import { runTuiSelfRestartOnStaleBuild } from '../index.js';

// 실물 무대: 임시 상태 디렉터리에 진짜 세션 스토어를 세우고, 실제 생산 경로
// (프레임 관측 훅 claimTuiOwnedSession · decideTuiRestartSession · runTuiSelfRestartOnStaleBuild)
// 를 그대로 지나가며 자식 argv 의 --resume 를 관측한다. spawnChild 만 기록기로 바꾼다.
// 세션 스토어는 ELANOUS_STATE_DIR 를 호출마다 읽으므로 정적 import 뒤 env 를 세워도 격리된다.

let dir = '';
const savedStateDir = process.env.ELANOUS_STATE_DIR;
const savedStateDirSource = process.env.ELANOUS_STATE_DIR_SOURCE;
const savedConfigDir = process.env.ELANOUS_CONFIG_DIR;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tui-h9-live-'));
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_STATE_DIR_SOURCE = 'test';
  process.env.ELANOUS_CONFIG_DIR = dir;
});

afterAll(() => {
  claimTuiOwnedSession(null);
  restoreEnv('ELANOUS_STATE_DIR', savedStateDir);
  restoreEnv('ELANOUS_STATE_DIR_SOURCE', savedStateDirSource);
  restoreEnv('ELANOUS_CONFIG_DIR', savedConfigDir);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('TUI-H9-ACTIVE-SESSION-ID 실물 무대(진짜 세션 스토어 · 격리 상태 디렉터리)', () => {
  test('전역 최신이 다른 대화여도 이 TUI 가 확인한 활성 대화로 재기동한다', async () => {
    const mine = createSession({ title: 'tui-h9-mine' });
    const other = createSession({ title: 'tui-h9-other' });

    claimTuiOwnedSession(mine.id, 1);
    setActiveSessionId(other.id);

    const mismatch = decideTuiRestartSession({
      owned: getTuiOwnedSession(),
      liveActiveSessionId: getActiveSessionId(),
      sessionExists: (id) => loadSession(id) !== null,
    });
    expect(mismatch.ok).toBe(false);

    setActiveSessionId(mine.id);
    const decision = decideTuiRestartSession({
      owned: getTuiOwnedSession(),
      liveActiveSessionId: getActiveSessionId(),
      sessionExists: (id) => loadSession(id) !== null,
    });
    if (!decision.ok) throw new Error(`재기동 판정이 막혔다: ${decision.reason}`);
    expect(decision.sessionId).toBe(mine.id);

    let childArgv: readonly string[] = [];
    const result = await runTuiSelfRestartOnStaleBuild({
      stale: () => ({ stale: true, reason: 'stale-build' }),
      scriptPath: '/bin/elanous.mjs',
      args: ['--tui', '--resume=launch-old'],
      globalLatestSessionId: () => other.id,
      spawnChild: async (_cmd: string, argv: readonly string[]) => {
        childArgv = argv;
        return 0;
      },
    });

    expect(result.outcome).toBe('relaunch');
    expect(childArgv[childArgv.indexOf('--resume') + 1]).toBe(mine.id);
    expect(childArgv).not.toContain(other.id);
    expect(other.id).not.toBe(mine.id);
  });
});
