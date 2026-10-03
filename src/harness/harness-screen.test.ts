// harness-screen — 공간 화면 버퍼(X11 forwarding식 릴레이) 테스트

import { setDefaultTimeout, describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeHarnessScreen, readHarnessScreen, listHarnessScreens, harnessScreenPath, harnessScreenDir, writeHarnessHeartbeat, readHarnessHeartbeat, stripScreenAnsi, detectScreenGoalOutcome, readHarnessScreenTail, resolveHarnessScreenKey } from './harness-screen.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const dirs: string[] = [];
function tmpEnv(): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), 'hscreen-'));
  dirs.push(d);
  return { ELANOUS_STATE_DIR: d } as NodeJS.ProcessEnv;
}
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } } });

describe('harness-screen — 화면 키 해석', () => {
  test('공간 식별자를 작업 디렉터리보다 우선하고 출처를 남긴다', () => {
    expect(resolveHarnessScreenKey('space-123', '/tmp/worktree')).toEqual({ key: 'space-123', source: 'space-id' });
  });

  test('공간 식별자가 없으면 작업 디렉터리 마지막 조각과 출처를 쓴다', () => {
    expect(resolveHarnessScreenKey('', '/tmp/worktree')).toEqual({ key: 'worktree', source: 'cwd-basename' });
  });

  test('둘 다 없으면 기존 unknown 키 계약으로 수렴한다', () => {
    expect(resolveHarnessScreenKey(undefined, undefined)).toEqual({ key: 'unknown', source: 'unknown' });
  });
});

describe('harness-screen — canonical key wiring', () => {
  test('writer와 harvest reader는 canonical resolver를 부르고 로컬 basename key 계산을 되살리지 않는다', () => {
    const root = join(import.meta.dir, '..');
    const driver = readFileSync(join(root, 'self-implement', 'headless-elanous-driver.ts'), 'utf8');
    const orchestrate = readFileSync(join(root, 'self-dev', 'orchestrate.ts'), 'utf8');

    expect((driver.match(/resolveHarnessScreenKey\(space\.id, opts\.cwd\)/g) ?? []).length).toBe(2);
    expect((orchestrate.match(/resolveHarnessScreenKey\((?:input\.spaceId|spaceId), worktreePath\)/g) ?? []).length).toBe(2);
    expect(driver).not.toContain('const screenKey = basename(opts.cwd)');
    expect(driver).not.toContain('resolveHarnessScreenSpaceId');
    expect(orchestrate).not.toContain('resolveHarnessScreenSpaceId');
    expect(orchestrate).toContain("? 'screen-missing-output-tail'");
    expect(orchestrate).toContain("? 'screen-empty-output-tail'");
    expect(orchestrate).toContain("transcript?.trim().length ? transcript : d.output");
  });
});

describe('harness-screen — 화면 버퍼', () => {
  test('write → read 왕복', () => {
    const env = tmpEnv();
    writeHarnessScreen('f1-grounding', 'goal-loop 화면\n라인2', env);
    expect(readHarnessScreen('f1-grounding', env)).toBe('goal-loop 화면\n라인2');
  });

  test('없는 화면 → null', () => {
    expect(readHarnessScreen('nope', tmpEnv())).toBeNull();
  });

  test('ELANOUS_STATE_DIR 스코프(격리) — 경로가 state-dir 하위', () => {
    const env = tmpEnv();
    expect(harnessScreenPath('x', env)).toContain(env.ELANOUS_STATE_DIR!);
    expect(harnessScreenDir(env)).toContain('harness-screens');
  });

  test('공간 id 정규화(슬래시/특수문자 → 파일명 안전)', () => {
    const env = tmpEnv();
    writeHarnessScreen('self-impl/f1 배선!', 'frame', env);
    // 슬래시·특수문자가 제거/치환돼도 read 왕복 성립
    const list = listHarnessScreens(env);
    expect(list.length).toBe(1);
    expect(readHarnessScreen('self-impl/f1 배선!', env)).toBe('frame');
  });

  test('listHarnessScreens — 최신 mtime 순', () => {
    const env = tmpEnv();
    writeHarnessScreen('run-a', 'a', env);
    writeHarnessScreen('run-b', 'b', env);
    const list = listHarnessScreens(env);
    expect(list.length).toBe(2);
    expect(list.map((e) => e.spaceId).sort()).toEqual(['run-a', 'run-b']);
    expect(list.every((e) => e.bytes > 0)).toBe(true);
  });

  test('write fail-soft (쓰기 불가여도 throw 안 함)', () => {
    // 존재하지 않는 부모 아래로 강제(권한/경로) — mkdir recursive 로 대개 생성되나, 빈 id 등 엣지에서도 무예외.
    expect(() => writeHarnessScreen('', 'x', tmpEnv())).not.toThrow();
  });
});

describe('harness-heartbeat — INC-1 진단(frozen vs idle)', () => {
  test('write → read 왕복 + at 타임스탬프', () => {
    const env = tmpEnv();
    writeHarnessHeartbeat('f1', { i: 42, alive: true, silentFor: 3 }, env);
    const hb = JSON.parse(readHarnessHeartbeat('f1', env)!);
    expect(hb.i).toBe(42);
    expect(hb.alive).toBe(true);
    expect(typeof hb.at).toBe('number');   // 동기 flush 타임스탬프(staleness 판정용)
  });
  test('없으면 null', () => {
    expect(readHarnessHeartbeat('nope', tmpEnv())).toBeNull();
  });
  test('화면 버퍼와 별개 파일(.hb vs .screen)', () => {
    const env = tmpEnv();
    writeHarnessScreen('r', 'screen-frame', env);
    writeHarnessHeartbeat('r', { i: 1 }, env);
    expect(readHarnessScreen('r', env)).toBe('screen-frame');       // 화면은 그대로
    expect(JSON.parse(readHarnessHeartbeat('r', env)!).i).toBe(1);  // heartbeat 별개
  });
});

describe('harness-screen — "docker logs" 관측(2026-07-21 대표 co-design)', () => {
  test('stripScreenAnsi — CSI/charset/keypad/CR 제거', () => {
    const raw = '\x1b[2J\x1b[H\x1b[38;2;1;2;3m색\x1b[0m\x1b(B\r종료';
    expect(stripScreenAnsi(raw)).toBe('색종료');
  });

  test('self screen CLI — 출력 경계에서 프레임 ANSI를 제거한다', () => {
    const env = tmpEnv();
    const raw = '\x1b[38;2;1;2;3m색상 프레임\x1b[0m\r\nGOAL-COMPLETE';
    writeHarnessScreen('cli-ansi', raw, env);

    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'screen', '--space', 'cli-ansi'], {
      cwd: join(import.meta.dir, '../..'),
      encoding: 'utf8',
      // Keep child stderr byte-exact for the self screen CLI contract.
      env: { ...process.env, ...env, MSS_LOG_STORE_DIAGNOSTICS: '0' },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('색상 프레임\nGOAL-COMPLETE');
    expect(result.stdout).not.toContain('\x1b');
    expect(readHarnessScreen('cli-ansi', env)).toBe(raw);
  });

  test('detectScreenGoalOutcome — 단독 줄 GOAL-COMPLETE 만 complete', () => {
    expect(detectScreenGoalOutcome('작업중\nGOAL-COMPLETE\n  [session x]')).toBe('complete');
    // 단독 줄 아니면(문장 내 언급) complete 아님(오완료 방지·run-goal-loop 규율 동형)
    expect(detectScreenGoalOutcome('이건 GOAL-COMPLETE 가 아니라 진행중')).not.toBe('complete');
    expect(detectScreenGoalOutcome('타임아웃 true 로 중단')).toBe('incomplete');
    expect(detectScreenGoalOutcome('그냥 진행 로그')).toBeNull();
  });

  test('detectScreenGoalOutcome — ANSI 섞인 프레임에서도 판정', () => {
    expect(detectScreenGoalOutcome('\x1b[32mGOAL-COMPLETE\x1b[0m')).toBe('complete');
  });

  test('readHarnessScreenTail — 클린 tail + outcome + 경로(재현 없이 진단)', () => {
    const env = tmpEnv();
    const frame = Array.from({ length: 60 }, (_, i) => `\x1b[2K라인${i}`).join('\n') + '\nGOAL-COMPLETE';
    writeHarnessScreen('task-abc', frame, env);
    const tail = readHarnessScreenTail('task-abc', 10, env);
    expect(tail).not.toBeNull();
    expect(tail!.outcome).toBe('complete');
    expect(tail!.text.split('\n').length).toBeLessThanOrEqual(10);   // 마지막 N줄만
    expect(tail!.text).toContain('GOAL-COMPLETE');
    expect(tail!.text).not.toContain('\x1b');                        // ANSI 제거됨
    expect(tail!.path).toContain(env.ELANOUS_STATE_DIR!);
  });

  test('readHarnessScreenTail — 없는 공간 → null', () => {
    expect(readHarnessScreenTail('none', 10, tmpEnv())).toBeNull();
  });
});
