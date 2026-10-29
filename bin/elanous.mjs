#!/usr/bin/env bun
// ⛔ 이 파일이 **배포 엔트리**다. `src/index.ts` 는 여기서 import 되므로 그쪽의
//   `import.meta.main` 은 항상 false — 실행은 여기서 명시적으로 건다(#6701 회귀).
// ⛔ 워커 스레드 안에서 이 파일이 «다시 적재» 되면 CLI 를 걸지 않는다 — `harness progress` 하위 조회는
//   전용 엔트리(`../src/harness/progress-worker-entry.ts`)를 직접 적재하므로 이 파일은 조회를 담당하지 않는다(HARNESS-PROGRESS-HANG).
const { shouldRunCliEntry } = await import('../src/harness/progress-worker-runtime.ts');
if (!shouldRunCliEntry()) {
  // 워커 문맥: 이 스레드는 하위 조회만 한다 — 대시보드·provider 선택·명령 디스패치를 다시 걸면 관측이 멈춘다.
} else if (process.argv.length === 3 && (process.argv[2] === '--version' || process.argv[2] === '-V')) {
  const { cliVersion } = await import('../src/version/code-revision.ts');
  console.log(cliVersion());
} else {
  const route = process.env.ELANOUS_FAST_ROUTER === '0'
    ? undefined
    : (await import('../src/cli/light-entry-route.ts')).selectLightCliRoute(process.argv.slice(2));
  if (route) {
    const { runLightCli } = await import('../src/light-cli.ts');
    await runLightCli(route);
  } else {
    const { runCli } = await import('../src/index.ts');
    runCli();
  }
}
