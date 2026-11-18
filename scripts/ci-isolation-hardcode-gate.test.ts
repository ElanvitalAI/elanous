import { describe, expect, test } from 'bun:test';
import {
  homedirAliases,
  isHardcodeLine,
  renderIsolationObservation,
  renderViolation,
  runIsolationHardcodeGate,
  scanHardcodeCandidates,
} from './ci-isolation-hardcode-gate.js';
import { join } from 'node:path';

describe('ci-isolation-hardcode-gate violation reporting', () => {
  test('scan retains every line matching the unchanged homedir()+.elanous criterion', () => {
    const source = [
      "const unrelated = '.elanous';",
      "const root = join(homedir(), '.elanous', 'logs');",
      "const homeOnly = homedir();",
      "const nested = join(homedir(), '.elanous-test', 'state');",
    ].join('\n');

    expect(isHardcodeLine("join(homedir(), '.elanous')")).toBe(true);
    expect(isHardcodeLine("const unrelated = '.elanous';")).toBe(false);
    // `com.elanous.nexus.plist` 의 `.elanous` 는 경로 조각이 아니다(2026-09-24 오탐).
    expect(isHardcodeLine("plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.elanous.nexus.plist'),")).toBe(false);
    expect(scanHardcodeCandidates(source)).toEqual([
      { lineNumber: 2, line: "const root = join(homedir(), '.elanous', 'logs');" },
      { lineNumber: 4, line: "const nested = join(homedir(), '.elanous-test', 'state');" },
    ]);
  });

  test('observation report prints scanned file count before pass/fail decisions, including zero files', () => {
    expect(renderIsolationObservation(0, 0)).toBe('[isolation-gate] scanned 0 files; 0 hardcoding observation(s).');
    expect(renderIsolationObservation(77, 81)).toBe('[isolation-gate] scanned 77 files; 81 hardcoding observation(s).');
  });

  test('violation report prints candidate line numbers and the baseline-exceeding count', () => {
    const candidates = scanHardcodeCandidates([
      "import { homedir } from 'node:os';",
      "const first = join(homedir(), '.elanous', 'one');",
      "const second = join(homedir(), '.elanous', 'two');",
      "const third = join(homedir(), '.elanous', 'three');",
    ].join('\n'));

    const report = renderViolation('src/cli/logs-cli.ts', 2, { count: candidates.length, candidates });

    expect(report).toContain('src/cli/logs-cli.ts: 2 → 3 (+1 신규 하드코딩 · 후보 3줄, baseline 초과 1줄)');
    expect(report).toContain('line 2: const first = join(homedir(),');
    expect(report).toContain('line 3: const second = join(homedir(),');
    expect(report).toContain('line 4: const third = join(homedir(),');
  });

  test('main execution path prints scanned observation before PASS, FAIL, and --update decisions', () => {
    const emptyScan = new Map();
    const violatingScan = new Map([
      ['src/cli/logs-cli.ts', { count: 1, candidates: [{ lineNumber: 1, line: "join(homedir(), '.elanous')" }] }],
    ]);

    const passOut: string[] = [];
    const passErr: string[] = [];
    const passCode = runIsolationHardcodeGate({
      args: [],
      scan: () => emptyScan,
      loadBaseline: () => new Map(),
      log: message => passOut.push(message),
      error: message => passErr.push(message),
    });

    expect(passCode).toBe(0);
    expect(passErr).toEqual([]);
    expect(passOut[0]).toBe('[isolation-gate] scanned 0 files; 0 hardcoding observation(s).');
    expect(passOut[1]).toStartWith('[isolation-gate] PASS');

    const failEvents: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
    const failCode = runIsolationHardcodeGate({
      args: [],
      scan: () => violatingScan,
      loadBaseline: () => new Map([['src/cli/logs-cli.ts', 0]]),
      log: message => failEvents.push({ stream: 'stdout', text: message }),
      error: message => failEvents.push({ stream: 'stderr', text: message }),
    });

    const failObservationIndex = failEvents.findIndex(event => event.text === '[isolation-gate] scanned 1 files; 1 hardcoding observation(s).');
    const failDecisionIndex = failEvents.findIndex(event => event.text.startsWith('[isolation-gate] FAIL'));

    expect(failCode).toBe(1);
    expect(failObservationIndex).toBeGreaterThanOrEqual(0);
    expect(failDecisionIndex).toBeGreaterThanOrEqual(0);
    expect(failEvents[failObservationIndex]).toEqual({ stream: 'stdout', text: '[isolation-gate] scanned 1 files; 1 hardcoding observation(s).' });
    expect(failEvents[failDecisionIndex]?.stream).toBe('stderr');
    expect(failObservationIndex).toBeLessThan(failDecisionIndex);

    const updateOut: string[] = [];
    const writes: Array<Map<string, unknown>> = [];
    const updateCode = runIsolationHardcodeGate({
      args: ['--update'],
      scan: () => violatingScan,
      writeBaseline: entries => writes.push(entries),
      log: message => updateOut.push(message),
    });

    expect(updateCode).toBe(0);
    expect(writes).toEqual([violatingScan]);
    expect(updateOut[0]).toBe('[isolation-gate] scanned 1 files; 1 hardcoding observation(s).');
    expect(updateOut[1]).toBe('[isolation-gate] baseline 갱신 — 1 파일 · 1 하드코딩.');
  });
});

// ⭐ 래칫 «방향»을 무는 절 — `R-TST19`(값어치가 큰 반증은 시험에 박는다).
//   📏 2026-08-28 실측: 나는 이 셋을 «손으로» 쳤다(소스를 고쳐 0→1 이 잡히는지 보고 되돌렸다).
//     그 반증은 그 판에서만 살았다. 여기 박아 둔다 — 다음 사람은 다시 손으로 안 친다.
//   🔑 이 게이트의 계약은 「수」가 아니라 «방향»이다:
//     ⓐ 늘면 막는다   ⓑ 줄면 막지 않고 «--update 를 권한다»   ⓒ --update 는 그 «줄어든» 값을 쓴다
describe('changed-files 안전성', () => {
  const entry = (count: number) => ({ count, candidates: [{ lineNumber: 1, line: "join(homedir(), '.elanous')" }] });

  test('범위 밖 baseline을 수복으로 출력하지 않고 부분 --update를 거부한다', () => {
    const logs: string[] = [];
    const errors: string[] = [];
    let wrote = false;
    const code = runIsolationHardcodeGate({
      args: ['--changed-files', 'src/changed.ts'],
      scan: () => new Map([['src/changed.ts', entry(0)], ['src/outside.ts', entry(0)]]),
      loadBaseline: () => new Map([['src/changed.ts', 0], ['src/outside.ts', 1]]),
      log: message => logs.push(message), error: message => errors.push(message),
    });
    const updateCode = runIsolationHardcodeGate({
      args: ['--changed-files', 'src/changed.ts', '--update'],
      scan: () => new Map([['src/changed.ts', entry(1)]]),
      writeBaseline: () => { wrote = true; },
      error: message => errors.push(message),
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain('src/outside.ts');
    expect(updateCode).toBe(1);
    expect(wrote).toBe(false);
    expect(errors.join('\n')).toContain('--changed-files 와 --update');
  });
});

describe('격리 래칫 — 「방향」 계약', () => {
  const entry = (count: number) => ({
    count,
    candidates: Array.from({ length: count }, (_, i) => ({ lineNumber: i + 1, line: `join(homedir(), '.elanous', 'x${i}')` })),
  });

  test('반증 ⓐ — 수복된 자리가 «되돌아오면» 그 파일 이름과 수를 대고 막는다', () => {
    const out: string[] = [];
    const errors: string[] = [];
    const code = runIsolationHardcodeGate({
      args: [],
      scan: () => new Map([['src/registry/live-store.ts', entry(1)]]),
      loadBaseline: () => new Map([['src/registry/live-store.ts', 0]]),
      log: m => out.push(m),
      error: m => errors.push(m),
    });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('src/registry/live-store.ts');
    expect(errors.join('\n')).toContain('0 → 1');
  });

  test('반증 ⓑ — 줄어든 것은 «막지 않고» --update 를 권한다(그것이 ratchet down 이다)', () => {
    const out: string[] = [];
    const code = runIsolationHardcodeGate({
      args: [],
      scan: () => new Map([['src/registry/live-store.ts', entry(0)]]),
      loadBaseline: () => new Map([['src/registry/live-store.ts', 1]]),
      log: m => out.push(m),
      error: () => {},
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('--update');
  });

  test('반증 ⓒ — --update 는 «지금 값»을 쓴다(늘어난 값을 조용히 승인하지 않는지 보이게 한다)', () => {
    const writes: Map<string, { count: number }>[] = [];
    const out: string[] = [];
    const grown = new Map([['src/a.ts', entry(3)]]);
    const code = runIsolationHardcodeGate({
      args: ['--update'],
      scan: () => grown,
      writeBaseline: entries => writes.push(entries as never),
      log: m => out.push(m),
    });
    expect(code).toBe(0);
    expect(writes).toEqual([grown]);
    // ⛔ 「승인했다」가 산출에 «수로» 남아야 한다 — R-RUN12(승인 플래그는 판단을 대신하지 않는다).
    expect(out.join('\n')).toContain('3 하드코딩');
  });
});

// ⛔⭐ `OBS-T527` — 이 게이트가 ***「그러지 말라」고 적은 «주석»을 코드로 읽어*** 착지를 막았다.
//   🩸 실측(2026-09-11): `src/nexus/api/media-store.ts:35` 의 주석 한 줄이 잡혔다.
//   ⇒ 이 저장소는 함정을 «주석에 인용»하는 문화라, 규율을 적을수록 게이트에 걸린다.
//   ⛔ 그런데 «코드 뒤에 붙은» 주석은 계속 물어야 한다 — 그 줄은 실제로 도는 코드다.
describe('isHardcodeLine — 주석과 코드를 가른다 (OBS-T527)', () => {
  test('⛔ 온전히 주석인 줄은 «안 문다» — 블록·라인 주석 셋', () => {
    expect(isHardcodeLine("  *  경로를 손으로 짓지 않는다 — `join(homedir(), '.elanous', …)` 는 위험하다")).toBe(false);
    expect(isHardcodeLine("// join(homedir(), '.elanous', 'x') 를 쓰지 마라")).toBe(false);
    expect(isHardcodeLine("/* join(homedir(), '.elanous') */")).toBe(false);
  });

  test('⭐ 코드는 «그대로» 문다', () => {
    expect(isHardcodeLine("  return join(homedir(), '.elanous', 'media');")).toBe(true);
  });

  test('⛔⭐ 코드 «뒤»에 주석이 붙은 줄은 계속 문다 — 그 줄은 실제로 돈다', () => {
    expect(isHardcodeLine("  return join(homedir(), '.elanous'); // 임시")).toBe(true);
  });

  test('무관한 줄은 안 문다', () => {
    expect(isHardcodeLine("  return join(stateDir, 'media');")).toBe(false);
    expect(isHardcodeLine("  const home = homedir();")).toBe(false);
  });
});

describe('ci-isolation-hardcode-gate — two-line homedir alias (2026-09-24 · T3)', () => {
  test('catches join(<homedir alias>, ".elanous") split across lines, as in resolveDataDir and cronRepoRoot', () => {
    const resolveDataDirLike = [
      'export function resolveDataDir(deps: { home?: string } = {}): string {',
      '  const home = deps.home ?? homedir();',
      "  const stateData = join(home, '.elanous', 'data');",
      '  return stateData;',
      '}',
    ].join('\n');
    const cronRepoRootLike = [
      'export function cronRepoRoot(codeRoot: string, home: string = homedir()): string {',
      "  const raw = readFileSync(join(home, '.elanous', 'leader.json'), 'utf-8');",
      '  return raw;',
      '}',
    ].join('\n');
    expect([...homedirAliases(resolveDataDirLike)]).toEqual(['home']);
    expect(scanHardcodeCandidates(resolveDataDirLike).map((c) => c.lineNumber)).toEqual([3]);
    expect(scanHardcodeCandidates(cronRepoRootLike).map((c) => c.lineNumber)).toEqual([2]);
  });

  test('does not flag an alias used without .elanous, a comment-only mention, or an unrelated name', () => {
    const source = [
      'const home = homedir();',
      "const cache = join(home, '.cache');",
      "// join(home, '.elanous') is the trap this gate names",
      "const other = join(root, '.elanous');",
      "const plist = join(home, 'Library', 'LaunchAgents', 'com.elanous.nexus.plist');",
    ].join('\n');
    expect(scanHardcodeCandidates(source)).toEqual([]);
  });
});

describe('ci-isolation-hardcode-gate on the real tree (pr land full-tree mode)', () => {
  // 🩸 2026-11-18: main 이 전체 트리 모드에서 빨강이었다(8 파일 · 15줄 · src/oauth/codex*·src/secret/*-lease·els-cli·release-*-known-issue*).
  //   pr land 는 args=[] 로 전체 트리를 재므로 그 빨강이 모든 착지를 막았다. 착지 경로와 같은 인자로 이 트리를 잰다.
  test('the repository tree passes with no arguments, exactly as pr land runs it', () => {
    const errors: string[] = [];
    const code = runIsolationHardcodeGate({ args: [], cwd: join(import.meta.dir, '..'), log: () => {}, error: (m) => errors.push(m) });
    expect(errors).toEqual([]);
    expect(code).toBe(0);
  });
});
