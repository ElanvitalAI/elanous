import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { runBgLaunch } from '../src/cli/bg-launch.js';
import type { SetupCheckResult } from '../src/nexus/setup-status.js';

let tmpRoot: string;
let prevNexusDir: string | undefined;

function okSetup(): SetupCheckResult {
  return { ok: true, required: [], recommended: [] };
}

function badSetup(): SetupCheckResult {
  return {
    ok: false,
    required: [
      { id: 'llm', label: 'LLM provider', passed: false, hint: 'run `elanous setup llm`' },
      { id: 'pwa-build', label: 'PWA build', passed: false, hint: 'run `elanous nexus build`' },
    ],
    recommended: [],
  };
}

function llmOnlySetup(): SetupCheckResult {
  return {
    ok: false,
    required: [
      { id: 'llm', label: 'LLM provider', passed: false, hint: 'run `elanous setup llm`' },
      { id: 'pwa-build', label: 'PWA build', passed: true, hint: 'run `elanous nexus build`' },
    ],
    recommended: [],
  };
}

function sink(): { log: (s: string) => void; error: (s: string) => void; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (s) => { logs.push(s); },
    error: (s) => { errors.push(s); },
    logs,
    errors,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(joinPath(tmpdir(), 'elanous-bg-launch-'));
  prevNexusDir = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
});

afterEach(() => {
  if (prevNexusDir === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexusDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Q.1 · runBgLaunch', () => {
  test('setup OK → child 가 detached + headless 로 spawn', async () => {
    const out = sink();
    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const result = await runBgLaunch({
      setupStatus: okSetup(),
      out,
      logPathFn: () => joinPath(tmpRoot, 'logs', 'bg.log'),
      spawnFn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts: opts as Record<string, unknown> });
        return { pid: 12345, unref() {} };
      },
      sleepFn: async () => {},
      probeChildFn: () => 'alive',
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain('nexus');
    expect(calls[0]!.args).toContain('run');
    // headless/inline lifecycle is now pinned via env (ELANOUS_NEXUS_BG_PARENT=1),
    // not a `--headless` argv flag (removed 2026-05-13 · auto-detect path).
    expect((calls[0]!.opts.env as Record<string, string | undefined>).ELANOUS_NEXUS_BG_PARENT).toBe('1');
    expect(calls[0]!.opts.detached).toBe(true);
  });

  test('setup 미완 (LLM 없음) → exit 1 + setup status 출력', async () => {
    const out = sink();
    let spawnCalls = 0;
    const result = await runBgLaunch({
      setupStatus: badSetup(),
      out,
      spawnFn: () => {
        spawnCalls += 1;
        return { pid: 1, unref() {} };
      },
    });
    expect(result.exitCode).toBe(1);
    expect(spawnCalls).toBe(0);
    expect(out.errors.join('\n')).toContain('setup incomplete');
    expect(out.logs.join('\n')).toContain('Run `elanous nexus` (interactive) once');
  });

  test('LLM 만 빠짐 → exit 하지 않고 ELANOUS_NEXUS_SETUP_MODE=1 + /setup', async () => {
    const out = sink();
    let env: Record<string, string | undefined> | undefined;
    const result = await runBgLaunch({
      setupStatus: llmOnlySetup(),
      out,
      spawnFn: (_cmd, _args, opts) => {
        env = opts.env as Record<string, string | undefined>;
        return { pid: 77, unref() {} };
      },
      sleepFn: async () => {},
      probeChildFn: () => 'alive',
    });
    expect(result.exitCode).not.toBe(1);
    expect(env?.ELANOUS_NEXUS_SETUP_MODE).toBe('1');
    expect(out.logs.join('\n')).toContain('/setup');
    expect(out.logs.join('\n')).toContain('셋업 모드로 떴습니다');
  });

  test('log path 가 ~/.elanous/nexus/logs/ 아래', async () => {
    const result = await runBgLaunch({
      setupStatus: okSetup(),
      now: () => 1700000000000,
      spawnFn: () => ({ pid: 11, unref() {} }),
      sleepFn: async () => {},
      probeChildFn: () => 'alive',
    });
    expect(result.exitCode).toBe(0);
    expect(result.logPath).toBe(joinPath(tmpRoot, 'logs', 'nexus-1700000000000.log'));
    expect(existsSync(result.logPath!)).toBe(true);
  });

  test('child stdio = [ignore, fd, fd]', async () => {
    let stdio: unknown[] | undefined;
    const logPath = joinPath(tmpRoot, 'logs', 'fd.log');
    await runBgLaunch({
      setupStatus: okSetup(),
      logPathFn: () => logPath,
      spawnFn: (_cmd, _args, opts) => {
        stdio = opts.stdio as unknown[];
        return { pid: 22, unref() {} };
      },
      sleepFn: async () => {},
      probeChildFn: () => 'alive',
    });
    expect(stdio?.[0]).toBe('ignore');
    expect(typeof stdio?.[1]).toBe('number');
    expect(stdio?.[1]).toBe(stdio?.[2]);
    expect(readFileSync(logPath, 'utf-8')).toBe('');
  });

  test('child env 에 ELANOUS_NEXUS_BG_PARENT=1 set', async () => {
    let env: Record<string, string | undefined> | undefined;
    await runBgLaunch({
      setupStatus: okSetup(),
      spawnFn: (_cmd, _args, opts) => {
        env = opts.env as Record<string, string | undefined>;
        return { pid: 33, unref() {} };
      },
      sleepFn: async () => {},
      probeChildFn: () => 'alive',
    });
    expect(env?.ELANOUS_NEXUS_BG_PARENT).toBe('1');
  });

  test('forwardArgs 가 child argv 에 포함 (--http-host 등)', async () => {
    let args: string[] = [];
    const out = sink();
    await runBgLaunch({
      setupStatus: okSetup(),
      force: true,
      forwardArgs: ['--http-host', '0.0.0.0', '--http-port', '43111', '--tools', 'webterm'],
      out,
      spawnFn: (_cmd, childArgs) => {
        args = childArgs;
        return { pid: 44, unref() {} };
      },
      sleepFn: async () => {},
      probeChildFn: () => 'alive',
    });
    expect(args).toContain('--force');
    expect(args).toEqual(expect.arrayContaining(['--http-host', '0.0.0.0', '--http-port', '43111', '--tools', 'webterm']));
    expect(out.logs.join('\n')).toContain('http      http://0.0.0.0:43111');
  });

  test('startup child death → exit 1 + last child log line surfaces tool-cwd refusal', async () => {
    const out = sink();
    const logPath = joinPath(tmpRoot, 'logs', 'tool-cwd-refusal.log');
    const result = await runBgLaunch({
      setupStatus: okSetup(),
      forwardArgs: ['--http-port', '43112', '--tools', 'webterm'],
      out,
      logPathFn: () => logPath,
      spawnFn: () => {
        return { pid: 55, unref() {} };
      },
      sleepFn: async () => {
        // ⛔ await 를 빼면 로그 «쓰기»와 부모의 «읽기»가 경쟁해 이 시험이 간헐적으로 갈린다.
        await Bun.write(logPath, 'booting nexus\nerror: Isolated instance requires an explicit tool cwd; pass --tool-cwd <path> or set ELANOUS_TOOL_CWD.\n    at resolveToolCwd (/repo/src/boot/tool-cwd.ts:74:15)\n    at async <anonymous> (/repo/src/index.ts:10125:13)\n');
      },
      probeChildFn: () => 'exited',
    });

    const errors = out.errors.join('\n');
    expect(result.exitCode).toBe(1);
    expect(errors).toContain('detached child exited during startup');
    expect(errors).toContain('Isolated instance requires an explicit tool cwd');
    expect(out.logs.join('\n')).not.toContain('elanous nexus: started in background');
  });
});

// 🔬 **기본 probe(`process.kill(pid, 0)`) 를 «실제로» 태운다**
//
// 🚨 계기: 종전 회귀 시험은 `probeChildFn` 을 «주입»해서, 기본 probe 가 「죽은 자식」과 「산 자식」을
//    옳게 가르는지는 ***한 번도 안 재고 있었다***(리뷰 지적 · 2026-09-01).
//    ⇒ 여기서는 `spawnFn` «만» 주입하고 probe 는 «진짜 것»이 돌게 둔다.
// ⛔ 두 위험을 «둘 다» 피한다:
//    ⓐ 종료된 프로세스의 pid 는 OS 가 재사용할 수 있다 ⇒ 「죽었다」 시험이 간헐적으로 산 것을 본다
//    ⓑ `pid: undefined` 는 결정적이지만 defaultProbeChild 의 «첫 줄»만 타고 `process.kill` 을 «안 탄다»
//       (📏 실측: kill 검사를 빼도 9 pass — 즉 그 형태로는 이 판이 재려던 것을 «못 잰다»)
// ✅ 그래서 «재사용될 수 없는» pid 를 쓴다 — 커널 상한 밖의 값은 언제나 ESRCH 다.
/** ⛔ 「이 pid 는 절대 없다」를 «가정»하지 않는다 — 이 기계에서 «실제로» ESRCH 인 것을 찾아서 쓴다.
 *  찾지 못하면 시험이 스스로 멈춘다(조용히 다른 축을 재지 않는다). */
function findUnassignablePid(): number {
  for (const candidate of [0x7fff_fffe, 0x7fff_fffd, 0x3fff_fffe, 4_194_303]) {
    try {
      process.kill(candidate, 0);
    } catch (err) {
      // ⛔ 「던졌다 = 없다」로 접지 않는다 — EPERM 은 ***존재하는데 권한이 없는*** 것이고
      //    EINVAL 은 인자가 틀린 것이다. 둘을 「없음」으로 세면 이 시험의 양성이 «다른 축»을 잰다.
      //    ⇒ 정확히 ESRCH 일 때만 쓴다(오늘 이 창이 종일 고친 「두 뜻을 한 값으로」의 판본).
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('이 기계에서 ESRCH 인 pid 를 못 찾았다 — 이 시험의 전제가 성립하지 않는다');
}

describe('runBgLaunch — 기본 probe 가 산 자식과 죽은 자식을 «가른다»', () => {
  test('⛔ 존재할 수 없는 pid ⇒ kill 이 던지고 실패로 끝난다 (알려진 «양성» · 결정적)', async () => {
    const out = sink();
    const probePid = findUnassignablePid();
    const result = await runBgLaunch({
      setupStatus: okSetup(),
      out,
      // ⛔ spawnFn «만» 주입한다 — sleep·log 경로·probe 를 전부 «기본»으로 태운다.
      //    ⛔ 「이 pid 는 어느 플랫폼에서도 절대 없다」는 «가정»을 코드가 보장 못 한다(리뷰 지적)
      //       ⇒ 가정하지 말고 ***그 자리에서 ESRCH 를 확인***한다.
      spawnFn: () => ({ pid: probePid, unref() {} }),
    });
    // ⛔ 그 확인과 기본 probe 사이에 350ms 가 있어 «이론상» 재할당이 가능하다(리뷰 지적).
    //    막을 수는 없지만 ***탐지***할 수는 있다 — 그러면 이 시험이 «조용히» 통과하는 길이 없어진다.
    //    (재할당됐다면 아래가 던지지 않고, 이 단언이 그 사실을 이름으로 말한다.)
    let stillGone = false;
    try { process.kill(probePid, 0); } catch (err) {
      stillGone = (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
    // ⛔ 실패 시 «무엇이 일어난 것인지»를 그 자리에서 말한다 — CI 에서 이 줄만 보고 진단할 수 있게.
    if (!stillGone) {
      throw new Error(
        `pid ${probePid} 가 이 시험 «도중»에 재할당됐다(ESRCH → 존재). ` +
        '이 시험의 결함이 아니라 «드문 경합»이다 — 다시 돌려라. 반복되면 findUnassignablePid 의 후보를 넓혀라.',
      );
    }
    expect(result.exitCode).toBe(1);
    expect(out.errors.join('\n')).toContain('exited during startup');
  });

  test('✅ 살아 있는 pid ⇒ 성공으로 끝난다 (알려진 «음성» · 과탐 방지)', async () => {
    const out = sink();
    const result = await runBgLaunch({
      setupStatus: okSetup(),
      out,
      // ⛔ spawnFn «만» 주입. 이 시험 프로세스 자신 — 확실히 살아 있다.
      spawnFn: () => ({ pid: process.pid, unref() {} }),
    });
    expect(result.exitCode).toBe(0);
    expect(out.logs.join('\n')).toContain('started in background');
    // ⛔ 「그 문구가 없다」가 아니라 ***오류가 «하나도» 없다***를 문다 — 수용 기준이 그것이다.
    expect(out.errors).toEqual([]);
  });
});
