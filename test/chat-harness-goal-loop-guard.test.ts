import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const REPO_ROOT = resolve(import.meta.dir, '..');
const ENTRY = resolve(REPO_ROOT, 'src', 'index.ts');
const prompt = '두 더하기 두는 얼마인가';
const rejection = 'Harness chat goal-loop requires `dev --implement`';
const missingSession = 'chat-harness-goal-loop-guard-missing-session';
const compatibilityNotice = '`chat --tools` is a compatibility entrypoint; use `elanous agent` for tool-loop calls.';

type ChatResult = ReturnType<typeof spawnSync>;

/** tempRoot 아래의 debug 로그를 «자리를 안 박고» 모은다.
 *  ⛔ 「없음」과 「못 읽음」을 가른다 — 빈 문자열을 조용히 돌려주면
 *  `expect(logTrail).toContain(...)` 이 ***「계약 위반」처럼 실패***하고 원인이 안 보인다. */
function collectDebugLogs(root: string): string | null {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith('debug-')) files.push(full);
    }
  };
  walk(root);
  // ⛔⭐⭐ 「로그가 «하나도» 없다」와 「로그는 있는데 그 문자열이 없다」를 ***다른 값***으로 낸다.
  //   📏 실측 2026-08-26: `agent` 경로는 세션 조회에서 «먼저» 끝나 ***로그를 아예 안 쓴다***.
  //      그래서 「없음」을 실패로 접으면 그 시나리오가 못 돈다.
  //   🚨 그렇다고 빈 문자열을 조용히 돌려주면 ***부정 단언(`not.toContain`)이 «공짜로» 통과***한다 —
  //      로그 자리가 옮겨져 «안 읽힌» 것과 「그 이벤트가 없다」가 구별되지 않는다.
  //   ⇒ `null` 로 «없음»을 이름 붙여 내고, ***호출부가 어느 쪽인지 «명시»하게*** 한다.
  if (files.length === 0) return null;
  // ⛔⭐ 무인 리뷰 지적(#12985) — 이 훑기는 tempRoot 아래 «모든» debug-* 를 합치므로
  //   무관한 같은 접두 파일이 생기면 ***이벤트 단언이 오탐***할 수 있다.
  //   🩹 그렇다고 자리를 «다시 박으면» 방금 없앤 노화(경로가 옮겨지면 ENOENT)가 돌아온다.
  //   ⇒ 셋째 길: ***자가 「무엇을 몇 개 합쳤는지」를 스스로 낸다.***
  //     오탐이 나면 그 줄이 «범인을 이름으로» 말한다(조용한 오탐이 안 된다).
  if (files.length > 1) {
    console.log(`[goal-loop-guard] debug 로그 ${files.length}개 합침: ${files.map((f) => f.slice(root.length + 1)).join(', ')}`);
  }
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
}

type CommandRun = {
  result: ChatResult;
  /** `null` = 이 실행이 debug 로그를 «하나도» 안 남겼다(빈 문자열과 «다른 값»이다). */
  logTrail: string | null;
};

function runCommand(command: 'agent' | 'chat', args: readonly string[], env: Record<string, string> = {}): CommandRun {
  const tempRoot = mkdtempSync(join(tmpdir(), 'chat-harness-goal-loop-'));
  const configDir = join(tempRoot, 'config');
  const runDir = join(tempRoot, 'run');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    onboarding: { completed: true },
    llm: { provider: 'none' },
  }), { flag: 'w' });
  try {
    const result = spawnSync('bun', [ENTRY, '--config-dir', configDir, command, ...args], {
      cwd: runDir,
      encoding: 'utf-8',
      // The focused test can itself run inside a harness child; clear that
      // inherited identity so each scenario controls its own classification.
      env: { ...process.env, ELANOUS_HARNESS_SPACE: '', ELANOUS_TOOL_CWD: runDir, ...env },
      timeout: 15_000,
    });
    // 🪞⭐⭐ 2026-08-26 — 옛 판은 `join(runDir, 'log')` «한 자리»를 박아 두고 읽었다.
    //   📏 실측: `debugLogDir()` 는 ***`<runDir>/.elanous/debug`*** 를 낸다.
    //      기전 = src/debug/log.ts `resolveLogDir()` —
    //        `isWithinSourceRoot(sessionCwd)` 면 `<sessionCwd>/log`, ***아니면*** `<projectRoot>/.elanous/debug`.
    //      이 시험의 runDir 은 «임시 디렉토리»라 «아니면» 쪽이다.
    //   ⛔ 그래서 ENOENT 가 났고, 그 산출은 ***「계약이 깨졌다」와 「자리가 옮겨졌다」를 «안 갈랐다».***
    //   🩹 ⇒ 자리를 «다시 박지 않는다». tempRoot 아래를 «훑어» 찾는다 —
    //      이 트리는 «이 시험이 통째로 만든 것»이라 훑어도 남의 로그가 안 섞인다.
    //      ⇒ 로그 자리가 또 옮겨져도 이 시험은 «안 깨진다»(오늘 다섯 번 밟은 그 형태를 여기서 끊는다).
    const logTrail = collectDebugLogs(tempRoot);
    return { result, logTrail };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runChat(args: readonly string[], env: Record<string, string> = {}): CommandRun {
  return runCommand('chat', args, env);
}

function expectCompletedProcess(result: ChatResult): void {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).not.toBeNull();
}

function outputOf(result: ChatResult): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

describe('chat --tools compatibility notice', () => {
  test('writes the agent migration notice first, persists one enabled-tool-loop event, and continues to downstream session lookup', () => {
    const { result, logTrail } = runChat(['--tools', '--session', missingSession, prompt]);

    expectCompletedProcess(result);
    expect(result.status).not.toBe(0);
    expect(String(result.stderr ?? '').split('\n')[0]).toBe(compatibilityNotice);
    expect(outputOf(result)).toContain(missingSession);
    // ⛔ 「로그를 못 찾았다」를 「이벤트가 없다」로 읽지 않는다 — «먼저» 존재를 문다.
    //   자리가 또 옮겨지면 여기서 ***이름을 대고*** 죽는다(아래 toContain 이 아니라).
    expect(logTrail, 'debug 로그가 tempRoot 아래에 «하나도» 없다 — resolveLogDir() 자리를 다시 재라').not.toBeNull();
    expect(logTrail).toContain('chat.tools-compatibility');
    expect(logTrail).toContain('invoked');
    expect(logTrail).toContain('toolLoopEnabled');
    expect(logTrail).toContain('true');
  }, 20_000);

  test('does not write the chat --tools notice or persist its event for agent', () => {
    const { result, logTrail } = runCommand('agent', ['--session', missingSession, prompt]);

    expectCompletedProcess(result);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain(compatibilityNotice);
    // ⛔⭐ `agent` 는 세션 조회에서 «먼저» 끝나 ***로그를 아예 안 남긴다***(2026-08-26 실측).
    //   ⇒ 「없음」이 정상이다. 다만 ***그 「없음」을 «이름으로» 못 박는다*** —
    //     빈 문자열로 접으면 「자리가 옮겨져 못 읽었다」와 구별되지 않고 이 단언이 공짜로 통과한다.
    //   📌 그리고 위 `expectCompletedProcess` ⊕ status/출력 단언이 ***「그래도 돌긴 했다」***를 따로 문다.
    if (logTrail !== null) expect(logTrail).not.toContain('chat.tools-compatibility');
  }, 20_000);

  test('keeps the compatibility announcer void and after the unchanged harness guard', () => {
    const source = readFileSync(ENTRY, 'utf8');
    const match = source.match(/function announceChatToolsCompatibility\(\): void \{[\s\S]*?\n\}/)?.[0];

    expect(match).toContain("debug.log('chat.tools-compatibility', 'invoked', { toolLoopEnabled: true })");
    expect(match).not.toMatch(/(?:const|let|var)\s+\w+\s*=\s*announceChatToolsCompatibility\(/);
    const chatAction = source.match(/\.command\('chat <text\.\.\.>'\)[\s\S]*?const cfg = getUserConfig\(\);/)?.[0];
    expect(chatAction).toContain('if (getHarnessSpace() && opts.tools && opts.goalLoop && !opts.implement)');
    expect(chatAction).toContain('if (opts.tools) announceChatToolsCompatibility();');
    expect(chatAction!.indexOf('if (getHarnessSpace()')).toBeLessThan(chatAction!.indexOf('if (opts.tools) announceChatToolsCompatibility();'));
  });
});

describe('chat harness goal-loop guard', () => {
  test('rejects the legacy tools + goal-loop entrypoint in a harness process', () => {
    const { result } = runChat(['--tools', '--goal-loop', prompt], {
      ELANOUS_HARNESS_SPACE: 'self-implement',
    });

    expectCompletedProcess(result);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(rejection);
    expect(result.stderr).toContain('dev');
    expect(result.stderr).toContain('--implement');
  });

  const allowedCases: Array<{ name: string; args: string[]; env: Record<string, string> }> = [
    { name: 'explicit bypass', args: ['--tools', '--goal-loop', '--implement', '--session', missingSession, prompt], env: { ELANOUS_HARNESS_SPACE: 'self-implement' } },
    { name: 'non-harness path', args: ['--tools', '--goal-loop', '--session', missingSession, prompt], env: {} },
    { name: 'tools-only harness path', args: ['--tools', '--session', missingSession, prompt], env: { ELANOUS_HARNESS_SPACE: 'self-implement' } },
  ];

  test.each(allowedCases)('allows $name to reach the downstream chat session lookup', ({ args, env }) => {
    const { result } = runChat(args, env);

    expectCompletedProcess(result);
    expect(result.status).not.toBe(0);
    expect(outputOf(result)).toContain(missingSession);
    expect(outputOf(result)).not.toContain(rejection);
  }, 20_000);
});
