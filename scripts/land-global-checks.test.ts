import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAND_GLOBAL_CHECKS, landGlobalChecks, landNextMdGate, runLandGlobalChecksGate, type LandGlobalChecksRun } from './land-global-checks.js';
import { TUI_ENTRY_PATH } from '../test/helpers/dashboard-source.js';

const ROOT = join(import.meta.dir, '..');

// 꼴마다 반증 하나 — 그 꼴이 그 시험을 끌어오고, 닮은 다른 경로는 안 끌어온다.
test('apps/pwa 의 tsx 는 hook-order-sweep 을 끌어오고 ts·다른 앱 tsx 는 안 끌어온다', () => {
  expect(landGlobalChecks(['apps/pwa/src/app/page.tsx'])).toEqual(['test/hook-order-sweep.test.ts']);
  expect(landGlobalChecks(['apps/pwa/src/app/page.ts'])).toEqual([]);
  expect(landGlobalChecks(['apps/desktop/src/App.tsx'])).toEqual([]);
});

// RELEASE-NOTE-ON-LAND — 노트 줄을 «초안·브랜드 규칙»(draft.test)만 보면 발행 판정(notes-check)의 B11 한국어
// 자와 어긋난다. 0.2.24 컷 노드가 `신설:` 한 줄로 두 번 ✗ 났는데(10-12 01:28 · 01:51) 착지에서는 그 줄이 그대로 통과했다.
test('release/next.md 는 release-story draft 시험과 announce-loop 발행 노트 시험을 둘 다 끌어오고 다른 release 문서는 안 끌어온다', () => {
  expect(landGlobalChecks(['release/next.md']))
    .toEqual(['scripts/release-story/draft.test.ts', 'scripts/announce-loop/check-node.test.ts']);
  expect(landGlobalChecks(['release/0.2.19.md'])).toEqual([]);
  expect(landGlobalChecks(['docs/release/next.md'])).toEqual([]);
});

test('docs/ops/machines.yaml 은 machines-ledger-data 시험을 끌어오고 다른 yaml 은 안 끌어온다', () => {
  expect(landGlobalChecks(['docs/ops/machines.yaml'])).toEqual(['test/machines-ledger-data.test.ts']);
  expect(landGlobalChecks(['docs/ops/other.yaml'])).toEqual([]);
});

test('새 CLI 하위 명령(src/index.ts · src/cli/ 등록 모듈)은 src/index.test.ts 를 끌어오고 시험 파일·다른 index 는 안 끌어온다', () => {
  expect(landGlobalChecks(['src/cli/new-command-cli.ts'])).toEqual(['src/index.test.ts']);
  expect(landGlobalChecks(['src/index.ts'])).toEqual(['src/index.test.ts']);
  expect(landGlobalChecks(['src/cli/harness/sub-cli.ts'])).toEqual(['src/index.test.ts']);
  expect(landGlobalChecks(['src/cli/new-command-cli.test.ts'])).toEqual([]);
  expect(landGlobalChecks([TUI_ENTRY_PATH])).toEqual([]);
});

// 10-11 #26232 — src/cli 밖 명령 등록 모듈이 하위 명령을 더해 index.test 목록 스냅샷을 깼다(main 빨강).
test('src/cli 밖의 *-cli.ts · *-cli-command.ts 도 src/index.test.ts 를 끌어온다', () => {
  expect(landGlobalChecks(['src/harness/harness-cli-command.ts'])).toEqual(['src/index.test.ts']);
  expect(landGlobalChecks(['src/loops/loop-cli.ts'])).toEqual(['src/index.test.ts']);
  expect(landGlobalChecks(['src/harness/harness-cli-command.test.ts'])).toEqual([]);
  expect(landGlobalChecks(['src/harness/harness-stop.ts'])).toEqual([]);
});

test('여러 꼴이 겹치면 표 순서로 한 번씩만 끌어온다', () => {
  expect(landGlobalChecks(['src/cli/a-cli.ts', 'apps/pwa/a.tsx', 'apps/pwa/b.tsx', 'release/next.md', 'docs/ops/machines.yaml']))
    .toEqual([...new Set(LAND_GLOBAL_CHECKS.map(({ test: file }) => file))]);
});

test('표가 가리키는 시험 파일은 저장소에 실제로 있다', () => {
  for (const { test: file } of LAND_GLOBAL_CHECKS) expect(existsSync(join(ROOT, file))).toBe(true);
});

function gate(changedFiles: string[], result: LandGlobalChecksRun) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const run = () => runLandGlobalChecksGate({
    changedFiles, cwd: '/repo', log: (m) => logs.push(m), error: (m) => errors.push(m),
    runTests: (tests) => { calls.push([...tests]); return result; },
  });
  return { run, calls, logs, errors };
}

test('게이트: 꼴에 안 걸리면 러너를 안 부르고 통과한다', () => {
  const g = gate(['src/flow/cards.ts'], { status: 0, output: '' });
  expect(g.run()).toBe(true);
  expect(g.calls).toEqual([]);
  expect(g.logs.join('\n')).toContain('해당 없음');
});

test('게이트: 끌려온 시험만 러너에 넘기고, 실패하면 막는다', () => {
  const g = gate(['apps/pwa/src/app/page.tsx', 'src/flow/cards.ts'], { status: 1, output: '(fail) hooks run in order\n 0 pass\n 1 fail\nRan 1 tests across 1 file.' });
  expect(g.run()).toBe(false);
  expect(g.calls).toEqual([['test/hook-order-sweep.test.ts']]);
  expect(g.errors.join('\n')).toContain('(fail) hooks run in order');
});

test('게이트: 러너가 못 돌았으면 「통과」가 아니라 던진다', () => {
  const g = gate(['release/next.md'], { status: null, output: '', error: 'spawnSync bun ETIMEDOUT' });
  expect(() => g.run()).toThrow('ETIMEDOUT');
});

test('release note checker ignores a parent graph context and reads this checkout next.md', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'land-next-md-context-'));
  const originalContext = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    mkdirSync(join(cwd, 'release'), { recursive: true });
    writeFileSync(join(cwd, 'release', 'next.md'), '# Next\n\n## Fix\n\n- fix — Add a deterministic release gate.\n');
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({
      outputs: { docs: { notes: join(cwd, 'removed-release-docs-worktree', '0.2.41.md'), flipped: [] } },
    });
    const logs: string[] = [];
    const errors: string[] = [];
    expect(landNextMdGate(cwd, { log: (message) => logs.push(message), error: (message) => errors.push(message) })).toBe(true);
    expect(logs.join('\n')).toContain('release/next.md 발행 노트 검사(check-node) PASS');
    expect(errors).toEqual([]);

    writeFileSync(join(cwd, 'release', 'next.md'), '# Next\n\n## Fix\n\n- fix — 신설: checkout 문서의 한국어 위반.\n');
    const invalidLogs: string[] = [];
    const invalidErrors: string[] = [];
    expect(landNextMdGate(cwd, { log: (message) => invalidLogs.push(message), error: (message) => invalidErrors.push(message) })).toBe(false);
    expect(invalidErrors.join('\n')).toContain('B11');
    expect(invalidErrors.join('\n')).toContain('release/next.md');
    expect(invalidLogs).toEqual([]);
  } finally {
    if (originalContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = originalContext;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('게이트(기본 러너): 실제 spawn 으로 끌려온 시험만 넘기고, 그 종료 코드가 실패면 막는다', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'land-global-checks-'));
  try {
    mkdirSync(join(cwd, 'scripts'), { recursive: true });
    // 가짜 결정적 러너 — 받은 인자를 적고, hook-order-sweep 을 받으면 실패한다.
    writeFileSync(join(cwd, 'scripts/test-deterministic.ts'), [
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "writeFileSync('args.json', JSON.stringify(args));",
      "if (args.includes('test/hook-order-sweep.test.ts')) { console.log('(fail) hooks run in order'); process.exit(1); }",
    ].join('\n'));
    const errors: string[] = [];
    const io = { cwd, log: () => {}, error: (m: string) => errors.push(m) };
    expect(runLandGlobalChecksGate({ ...io, changedFiles: ['docs/ops/machines.yaml', 'src/flow/cards.ts'] })).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, 'args.json'), 'utf8'))).toEqual(['test/machines-ledger-data.test.ts']);
    expect(runLandGlobalChecksGate({ ...io, changedFiles: ['apps/pwa/src/app/page.tsx'] })).toBe(false);
    expect(errors.join('\n')).toContain('(fail) hooks run in order');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
