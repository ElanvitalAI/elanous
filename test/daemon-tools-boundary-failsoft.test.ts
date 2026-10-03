// 데몬 직접 쓰기 두 경로의 **fail-soft 계약**을 「조회 자체가 던진다」로 문다.
//
// ⛔⭐⭐⭐ `mock.module` 은 프로세스 전역이고 자동으로 복원되지 않는다. 이 파일은 부모
// 테스트 프로세스에서는 모킹 전용 자식을 실행하고, 자식에서만 가짜 모듈을 설치한다.
// 따라서 이미 모듈을 잡은 중간 의존성이 부모에서 가짜를 계속 참조할 수 없다.
//
// ⛔⭐⭐⭐ 그리고 왜 이 파일이 «생겼나» — 원래 이 계약을 문다고 «선언한» 테스트가 있었는데
//   ***판별력이 0 이었다***(무인 리뷰 지적 → `[T]` 가 옛 구현을 재현해 실측):
//
//     선언   "가드(`getSessionBoundary`)가 `try` 밖이면 이 테스트가 던져서 실패한다.
//             즉 이 한 테스트가 ②③ 을 같이 문다"
//     실물   그 테스트는 `debug.log` «만» 던지게 한다. 그런데 `debug.log` 는 «어느 판이든»
//            `try` 안이다 ⇒ 가드가 밖으로 나가도 아무 일이 안 일어난다
//     📏 실측  가드를 `try` 밖으로 되돌림 → 기존 테스트 ***17 pass*** (판별력 0)
//              write.ts 의 try/catch 를 «통째로» 제거 → 여전히 ***17 pass*** (커버리지 0)
//
// 🧩 ⇒ ***「무엇을 던지게 하나」가 「무엇을 무나」를 정한다.*** 관측 «전달»을 던지게 하면
//   전달만 물고, 관측 «조회»를 던지게 해야 조회가 물린다.

import { setDefaultTimeout, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import type { DaemonToolDispatchCtx } from '../src/boot/daemon-tools/types.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const CHILD_ENV = 'ELANOUS_DAEMON_TOOLS_BOUNDARY_FAILSOFT_CHILD';

function makeCtx(cwd: string, overrides: Partial<DaemonToolDispatchCtx> = {}): DaemonToolDispatchCtx {
  return { cwd, signal: new AbortController().signal, ...overrides };
}

async function runInIsolatedBoundaryProcess(): Promise<void> {
  const child = Bun.spawn({
    cmd: ['bun', 'test', fileURLToPath(import.meta.url)],
    cwd: process.cwd(),
    env: { ...process.env, [CHILD_ENV]: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  expect(await child.exited).toBe(0);
}

if (process.env[CHILD_ENV] === '1') {
  // ⛔⭐ `...real` 스프레드가 «필수»다 — 안 하면 같은 모듈의 `getSessionCwd` 등이 사라져
  //   이 경로가 아닌 «다른» 모듈이 깨지고, 그 실패를 이 계약의 실패로 오독하게 된다.
  const realWorkingDir = await import('../src/session/working-dir.js');
  mock.module('../src/session/working-dir.js', () => ({
    ...realWorkingDir,
    getSessionBoundary: () => {
      throw new Error('boundary lookup down');
    },
  }));

  const { dispatchEdit } = await import('../src/boot/daemon-tools/edit.js');
  const { dispatchWrite } = await import('../src/boot/daemon-tools/write.js');

  describe('데몬 직접 쓰기 — «관측 조회»가 던져도 완료된 쓰기가 안 바뀐다', () => {
    test('dispatchEdit — 가드가 던져도 편집 결과가 그대로다', async () => {
      const cwd = mkdtempSync(joinPath(tmpdir(), 'elanous-boundary-edit-'));
      writeFileSync(joinPath(cwd, 'soft.txt'), 'before\n');

      const result = await dispatchEdit(
        { file_path: 'soft.txt', edits: [{ old_string: 'before', new_string: 'after' }] },
        makeCtx(cwd, { sessionId: 'boundary-edit' }),
      );

      expect(result.applied).toBe(1);
      expect(readFileSync(joinPath(cwd, 'soft.txt'), 'utf8')).toBe('after\n');
    });

    // ⭐ 이 하나가 `write.ts` 의 커버리지 0 을 닫는다 — 두 파일이 관측 로직을 «중복»해 두고 있어
    //   `edit.ts` 만 물면 `write.ts` 쪽 회귀는 영영 안 잡힌다.
    test('dispatchWrite — 가드가 던져도 쓰기 결과가 그대로다', async () => {
      const cwd = mkdtempSync(joinPath(tmpdir(), 'elanous-boundary-write-'));

      await dispatchWrite(
        { file_path: 'written.txt', content: 'written body\n' },
        makeCtx(cwd, { sessionId: 'boundary-write' }),
      );

      expect(readFileSync(joinPath(cwd, 'written.txt'), 'utf8')).toBe('written body\n');
    });
  });
} else {
  describe('데몬 직접 쓰기 — 모듈 대체 격리', () => {
    // Caller: Bun's test-file runner executes this test, which calls
    // runInIsolatedBoundaryProcess() to run the global module replacement only
    // in a child process.
    test('관측 조회를 던지는 시험은 별도 프로세스에서 실행한다', runInIsolatedBoundaryProcess);
  });
}
