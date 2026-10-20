#!/usr/bin/env bun
// ⛔ 이 파일이 **배포 엔트리**다. `src/index.ts` 는 여기서 import 되므로 그쪽의
//   `import.meta.main` 은 항상 false — 실행은 여기서 명시적으로 건다(#6701 회귀).
if (process.argv.length === 3 && (process.argv[2] === '--version' || process.argv[2] === '-V')) {
  const { cliVersion } = await import('../src/version/code-revision.ts');
  console.log(cliVersion());
} else {
  const { selectLightCliRoute } = await import('../src/cli/light-entry-route.ts');
  const route = selectLightCliRoute(process.argv.slice(2));
  if (route) {
    const { runLightCli } = await import('../src/light-cli.ts');
    await runLightCli(route);
  } else {
    const { runCli } = await import('../src/index.ts');
    runCli();
  }
}
