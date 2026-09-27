import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asideBackend, geminiBackend, buildMissionWorktreeProvenance, buildScreenLogPayload, checkEvidence, claudeBackend, codexBackend, collectTscDiagnostics, createMissionControlBrain, createMissionSearch, createMissionVerifyDone, grokBackend, recordMissionWorktreeProvenance, runAgentMission, runTsc, SCREEN_LOG_TAIL_MAX_LINE_LENGTH, SCREEN_LOG_TAIL_MAX_LINES, type EvidenceMode } from './driver.js';
import { emitPtyEvent } from '../pty-shell/registry.js';
import type { PtyHandle } from '../pty-shell/registry.js';
import { createWorktree, gateWorktreeReuse } from '../git-fs/worktree.js';
import { recordHarnessWorktreeProvenance } from '../harness/harness-worktree-add.js';
import { debug } from '../debug/log.js';
import { classifierFrameLines } from '../capture/frame-state-detect.js';
import type { StreamLLMFn } from '../autopilot/llm-control-brain.js';
import type { LLMMessage } from '../llm.js';
import type { TypecheckError } from '../typecheck-ratchet.js';
import { decideInterventionStep } from '../self-implement/intervention-step.js';

const observation = {
  screen: 'agent screen',
  state: 'idle' as const,
  step: 0,
  intervention: decideInterventionStep({
    screen: 'agent screen',
    previous: null,
    stopAfterSameScreens: 2,
    descriptor: { level: 'L3', controlStance: 'owned', draft: 'continue' },
  }),
  changed: false,
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} — ${result.stderr}`);
  return result.stdout.trim();
}

function scriptedStream(raw: string): StreamLLMFn {
  return async () => raw;
}

test('runAgentMission re-emits exactly once on its Codex child exit with the spawned CODEX_HOME and runId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-pty-usage-'));
  const home = join(dir, 'codex-home');
  mkdirSync(home);
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const calls: Array<{ codexHome: string; runId: string; workdir: string; sinceMs?: number }> = [];
  try {
    let spawnedId = '';
    let spawnedRunId = '';
    const result = await runAgentMission({ mission: 'done', repo: dir, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture/ }, memory: false, commit: false,
      screensDir: join(dir, 'screens'),
    }, {
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      startPty: ((opts) => {
        const id = opts.id!;
        spawnedId = id;
        spawnedRunId = opts.env?.ELANOUS_RUN_ID ?? '';
        expect(opts.env?.CODEX_HOME).toBe(home);
        return { id, kind: 'codex', nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
          renderScreenPng: async () => null, write: () => {}, kill: () => {},
        } as unknown as PtyHandle;
      }),
      runControlLoop: async () => {
        emitPtyEvent({ type: 'exit', id: 'unrelated-child', exitCode: 0 });
        expect(calls).toHaveLength(0);
        emitPtyEvent({ type: 'output', id: spawnedId, chunk: 'Session ID: 12345678-1234-1234-1234-123456789abc' });
        emitPtyEvent({ type: 'exit', id: spawnedId, exitCode: 0 });
        emitPtyEvent({ type: 'exit', id: spawnedId, exitCode: 0 });
        return { termination: { kind: 'success' }, steps: 1 } as never;
      },
      reemitPtyUsage: (opts) => { calls.push(opts); return 0; },
    });
    expect(result.ok).toBe(false);
    expect(spawnedRunId).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ codexHome: home, runId: spawnedRunId, workdir: dir, sessionId: '12345678-1234-1234-1234-123456789abc' });
    expect(typeof calls[0]?.sinceMs).toBe('number');
    emitPtyEvent({ type: 'exit', id: spawnedId, exitCode: 0 });
    expect(calls).toHaveLength(1);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('agent-mission worktree provenance', () => {
  test('records literal agent owner and command in worktree scope, then opens the strict reuse gate', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agent-mission-provenance-'));
    try {
      const repo = join(tmp, 'repo');
      const root = join(tmp, 'worktrees');
      git(tmp, 'init', '-q', '-b', 'main', repo);
      git(repo, 'config', 'user.email', 't@t.t');
      git(repo, 'config', 'user.name', 't');
      writeFileSync(join(repo, 'f.txt'), 'x');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'init');
      const branch = 'agent/provenance-reuse';
      const created = createWorktree({ repoRoot: repo, worktreeRoot: root, branch, base: 'HEAD', skipRemoteBaseSync: true });
      const provenance = buildMissionWorktreeProvenance(branch, '2026-08-12T00:00:00.000Z');

      recordHarnessWorktreeProvenance(created.path, provenance);

      expect(git(created.path, 'config', '--worktree', '--get', 'elanous.harness.owner')).toBe('agent:agent/provenance-reuse');
      expect(git(created.path, 'config', '--worktree', '--get', 'elanous.harness.command')).toBe('elanous agent-mission');
      expect(git(created.path, 'config', '--worktree', '--get', 'elanous.harness.createdAt')).toBe('2026-08-12T00:00:00.000Z');
      expect(gateWorktreeReuse(created.path, true, {
        branch,
        commonGitDir: join(repo, git(repo, 'rev-parse', '--git-common-dir')),
      }).reuse).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('provenance recording failure is observed and rethrown instead of looking like unrecorded ownership', () => {
    const observed: unknown[][] = [];
    const original = debug.log;
    debug.log = ((...args: unknown[]) => observed.push(args)) as typeof debug.log;
    try {
      const provenance = buildMissionWorktreeProvenance('agent/failure', '2026-08-12T00:00:00.000Z');
      expect(() => recordMissionWorktreeProvenance('/wt', provenance, () => { throw new Error('write denied'); }))
        .toThrow('agent-mission worktree provenance failed — write denied');
      expect(observed).toContainEqual(['agent-mission', 'provenance-failed', {
        path: '/wt', owner: 'agent:agent/failure', command: 'elanous agent-mission', createdAt: '2026-08-12T00:00:00.000Z', reason: 'write denied',
      }, { level: 'warn' }]);
    } finally {
      debug.log = original;
    }
  });
});

describe('buildScreenLogPayload', () => {
  test('bottom line count is bounded at the classifier-compatible ten-line constant while retaining the final lines', () => {
    const screen = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n');
    const payload = buildScreenLogPayload('capture', screen);

    expect(SCREEN_LOG_TAIL_MAX_LINES).toBe(10);
    expect(payload.tail).toEqual(Array.from({ length: 10 }, (_, index) => `line-${index + 3}`));
    expect(payload.tail).toHaveLength(10);
    expect(payload.tailTruncated).toBe(false);
  });

  test('uses the classifier-cleaned final non-empty lines despite blank and ANSI-only physical trailing lines', () => {
    const longLine = `long-${'x'.repeat(SCREEN_LOG_TAIL_MAX_LINE_LENGTH + 1)}`;
    const cleanLines = Array.from({ length: SCREEN_LOG_TAIL_MAX_LINES + 2 }, (_, index) => `line-${index + 1}`);
    const screen = [
      ...cleanLines,
      '\u001B[31mcolored-line\u001B[0m',
      '││',
      '   ',
      longLine,
      '\u001B[2K',
      '',
    ].join('\n');
    const expectedClassifierInput = classifierFrameLines(screen).slice(-SCREEN_LOG_TAIL_MAX_LINES);
    const payload = buildScreenLogPayload('capture', screen);

    expect(expectedClassifierInput).toHaveLength(SCREEN_LOG_TAIL_MAX_LINES);
    expect(payload.tail).toEqual(expectedClassifierInput.map((line) => [...line].slice(0, SCREEN_LOG_TAIL_MAX_LINE_LENGTH).join('')));
    expect(payload.tail).toHaveLength(SCREEN_LOG_TAIL_MAX_LINES);
    expect(payload.tail.every((line) => [...line].length <= SCREEN_LOG_TAIL_MAX_LINE_LENGTH)).toBe(true);
    expect(payload.tailTruncated).toBe(true);
  });

  test('long tail line is capped and records truncation separately', () => {
    const payload = buildScreenLogPayload('capture', 'x'.repeat(SCREEN_LOG_TAIL_MAX_LINE_LENGTH + 1));

    expect(payload.tail).toEqual(['x'.repeat(SCREEN_LOG_TAIL_MAX_LINE_LENGTH)]);
    expect(payload.tailTruncated).toBe(true);
  });

  test('short screen keeps existing label and chars values and is not marked truncated', () => {
    const screen = 'short\nscreen';
    const payload = buildScreenLogPayload('ready', screen);

    expect(payload).toEqual({ label: 'ready', chars: screen.length, tail: ['short', 'screen'], tailTruncated: false });
  });
});

describe('createMissionControlBrain', () => {
  test('wait/send/verify/done 5-action 판단을 canonical 3-action으로 매핑하고 carriage return을 붙인다', async () => {
    const make = (raw: string) => createMissionControlBrain({ mission: 'goal', evidenceReady: () => false, search: () => {}, stream: scriptedStream(raw) });
    expect(await make('{"action":"wait"}').decide(observation)).toEqual({ action: 'wait' });
    expect(await make('{"action":"send","text":"continue"}').decide(observation)).toEqual({ action: 'input', text: 'continue\r' });
    expect(await make('{"action":"verify","reason":"evidence"}').decide(observation)).toEqual({ action: 'done', reason: 'evidence' });
    expect(await make('{"action":"done","reason":"complete"}').decide(observation)).toEqual({ action: 'done', reason: 'complete' });
  });

  test.each([asideBackend, claudeBackend, codexBackend, grokBackend])('$name 백엔드 이름만 시스템 프롬프트와 화면 머리표에 사용한다', async (backend) => {
    let messages: LLMMessage[] = [];
    const brain = createMissionControlBrain({
      mission: 'goal', backend, evidenceReady: () => false, search: () => {},
      stream: async (captured) => {
        messages = captured;
        return '{"action":"wait"}';
      },
    });

    await brain.decide(observation);

    const system = messages.find((message) => message.role === 'system')!.content;
    const user = messages.find((message) => message.role === 'user')!.content;
    expect(system).toContain(backend.name);
    expect(user).toContain(`=== ${backend.name} 화면 ===`);
    for (const name of ['codex', 'claude', 'gemini', 'grok', 'aside']) {
      if (name !== backend.name) {
        expect(system).not.toContain(name);
        expect(user).not.toContain(name);
      }
    }
  });

  test('provision(P4) — 감독이 provision emit 시 provisioner 호출 후 결과 detail 을 input 으로 내부화', async () => {
    let got: { layer: string; spec: string } | null = null;
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async (req) => { got = { layer: req.layer, spec: req.spec }; return { ok: true, layer: req.layer, spec: req.spec, action: 'installed', detail: `설치완료 ${req.spec}` }; },
      stream: scriptedStream('{"action":"provision","spec":"lodash","layer":"pkg","reason":"module not found"}'),
    });
    expect(await brain.decide(observation)).toEqual({ action: 'input', text: '설치완료 lodash\r' });
    expect(got).not.toBeNull();
    expect(got!.layer).toBe('pkg');
    expect(got!.spec).toBe('lodash');
  });

  test('provision 미배선(provision dep 없음) = wait 폴백(무회귀)', async () => {
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      stream: scriptedStream('{"action":"provision","spec":"lodash","layer":"pkg"}'),
    });
    expect(await brain.decide(observation)).toEqual({ action: 'wait' });
  });

  test('provision 거부/실패 결과도 자식에 "계속 진행" input 으로 전달(denied detail)', async () => {
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async (req) => ({ ok: false, layer: req.layer, spec: req.spec, action: 'denied', detail: '설치 거부(정책). 다른 방법으로 진행하라.' }),
      stream: scriptedStream('{"action":"provision","spec":"postgres","layer":"app"}'),
    });
    expect(await brain.decide(observation)).toEqual({ action: 'input', text: '설치 거부(정책). 다른 방법으로 진행하라.\r' });
  });

  test('provision dedup — 같은 spec 반복 요청은 재설치 안 하고 "다른 방법으로" 지시(설치루프 차단)', async () => {
    let calls = 0;
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async (req) => { calls += 1; return { ok: true, layer: req.layer, spec: req.spec, action: 'installed', detail: `설치완료 ${req.spec}` }; },
      stream: scriptedStream('{"action":"provision","spec":"lodash","layer":"pkg"}'),
    });
    const first = await brain.decide(observation);
    expect(first).toEqual({ action: 'input', text: '설치완료 lodash\r' });
    const second = await brain.decide(observation); // 같은 spec 재요청
    expect(calls).toBe(1); // 성공 후엔 영구 차단 → provisioner 한 번만 호출
    expect(second.action).toBe('input'); // 무조건 input(wait 회귀 통과 방지)
    if (second.action === 'input') expect(second.text).toContain('이미 provision');
  });

  test('provision dedup — 실패는 제한적 재시도(최대 2회) 후 차단(일시 오류 재시도·지속실패 루프 차단)', async () => {
    let calls = 0;
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async (req) => { calls += 1; return { ok: false, layer: req.layer, spec: req.spec, action: 'error', detail: '설치 실패. 다른 방법으로.' }; },
      stream: scriptedStream('{"action":"provision","spec":"lodash","layer":"pkg"}'),
    });
    await brain.decide(observation); // 1회
    await brain.decide(observation); // 2회
    const third = await brain.decide(observation); // 3회째 = 차단
    expect(calls).toBe(2); // 실패는 2회까지만 실제 시도(일시 오류 재시도 허용)
    if (third.action === 'input') expect(third.text).toContain('이미 provision');
  });

  test('provision — 무효 layer 는 pkg 로 오분류 안 하고 정책에 raw 그대로 전달(우회 차단·must-fix)', async () => {
    let gotLayer = '';
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async (req) => { gotLayer = req.layer; return { ok: false, layer: req.layer, spec: req.spec, action: 'denied', detail: '거부' }; },
      stream: scriptedStream('{"action":"provision","spec":"x","layer":"garbage-xyz"}'),
    });
    await brain.decide(observation);
    expect(gotLayer).toBe('garbage-xyz'); // pkg 로 바뀌지 않음 → 정책이 defer(오분류-as-pkg 우회 없음)
  });

  test('provision 콜백 예외 → decide 밖 전파 안 하고 graceful input(미션 무중단)', async () => {
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async () => { throw new Error('provisioner boom'); },
      stream: scriptedStream('{"action":"provision","spec":"lodash","layer":"pkg"}'),
    });
    const d = await brain.decide(observation);
    expect(d.action).toBe('input');
    if (d.action === 'input') expect(d.text).toContain('설치 없이');
  });

  test('search는 omni 결과를 .mission-context.md에 기록한 뒤 context 후속 input으로 내부화한다', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'mission-search-'));
    try {
      const search = createMissionSearch({
        worktree,
        omniPath: '/fake/omni.ts',
        crawl: (query, path) => {
          expect(query).toBe('PTY contract');
          expect(path).toBe('/fake/omni.ts');
          return '## contract\ncanonical PTY reference';
        },
      });
      const brain = createMissionControlBrain({
        mission: 'goal', evidenceReady: () => false, search,
        stream: scriptedStream('{"action":"search","query":"PTY contract"}'),
      });
      expect(await brain.decide(observation)).toEqual({ action: 'input', text: '조사 결과를 .mission-context.md 에 저장했다. 읽고 계속 진행하라.\r' });
      expect(readFileSync(join(worktree, '.mission-context.md'), 'utf8')).toContain('canonical PTY reference');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('search — crawl이 throw해도 미션 무중단(graceful·실패 메시지를 context에 기록)', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'mission-search-fail-'));
    try {
      const search = createMissionSearch({
        worktree, omniPath: '/fake/omni.ts',
        crawl: () => { throw new Error('network down'); }, // omni-crawl(외부·네트워크) 실패 시뮬
      });
      const brain = createMissionControlBrain({
        mission: 'goal', evidenceReady: () => false, search,
        stream: scriptedStream('{"action":"search","query":"q"}'),
      });
      // decide 가 throw 하지 않고 정상 input 을 반환해야 미션이 안 죽는다(control loop error termination 회피).
      expect(await brain.decide(observation)).toEqual({ action: 'input', text: '조사 결과를 .mission-context.md 에 저장했다. 읽고 계속 진행하라.\r' });
      expect(readFileSync(join(worktree, '.mission-context.md'), 'utf8')).toContain('omni-crawl 실패: network down');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});

describe('runTsc baseline comparison', () => {
  const baseline: TypecheckError[] = [{ file: 'scripts/existing.ts', line: 'scripts/existing.ts(1,1): error TS2304: Cannot find name \'Existing\'.' }];

  test('기준선에 이미 있던 오류만 존재하면 통과한다', () => {
    const result = runTsc('/worktree', baseline, () => ({ ran: true, diagnostics: [...baseline] }));
    expect(result).toMatchObject({ ok: true, baselineErrors: 1, newErrors: [] });
  });

  test('기준선 밖 새 오류만 실패 문구에 담는다', () => {
    const newDiagnostic: TypecheckError = { file: 'src/new.ts', line: 'src/new.ts(2,3): error TS2322: Type \'number\' is not assignable to type \'string\'.' };
    const result = runTsc('/worktree', baseline, () => ({ ran: true, diagnostics: [...baseline, newDiagnostic] }));
    expect(result.ok).toBe(false);
    expect(result.failure).toBe(newDiagnostic.line);
    expect(result.failure).not.toContain(baseline[0]!.line);
    expect(result).toMatchObject({ baselineErrors: 1, newErrors: [newDiagnostic.line] });
  });

  test('진단 없는 타입검사 실행 실패는 기준선 비교 전에 실패한다', () => {
    const result = runTsc('/worktree', baseline, () => ({ ran: false, diagnostics: [], failure: 'tsc 설정 오류' }));
    expect(result).toMatchObject({ ok: false, baselineErrors: 1, newErrors: [], failure: 'tsc 설정 오류' });
  });

  // 🩸 2026-09-23: 저장소 tsc 가 V8 기본 힙(≈4GB)을 넘는다(RSS 5.0GB) — 외부 에이전트 미션 게이트도 OOM 으로 막혔다.
  test('⛔ tsc 에 명시 힙을 싣는다', () => {
    const seen: { env?: NodeJS.ProcessEnv }[] = [];
    collectTscDiagnostics('/worktree', ((_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => { seen.push(o); return ''; }) as never);
    expect(seen[0]?.env?.NODE_OPTIONS ?? '').toContain('--max-old-space-size=');
  });

  test('TS5058처럼 파싱할 수 없는 정상 오류 종료는 collect 경로에서 fail-closed다', () => {
    const failure = Object.assign(new Error('tsconfig missing'), { status: 2, signal: null, stdout: '', stderr: 'error TS5058: The specified path does not exist.' });
    const collected = collectTscDiagnostics('/worktree', () => { throw failure; });
    expect(collected.ran).toBe(false);
    expect(collected.diagnostics).toEqual([]);
    expect(collected.failure).toContain('타입 검사 실행 실패');
    expect(collected.output).toBe('error TS5058: The specified path does not exist.');
  });
});

describe('test evidence tsc preservation', () => {
  const worktree = '/clean-worktree';
  const evidence: EvidenceMode = { kind: 'test', testPath: 'test/target.test.ts' };

  test('전체 타입검사 실패면 runTest를 호출하지 않고 기존 tsc 실패 문구를 보존한다', () => {
    let testsRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => ({ ran: true, diagnostics: [{ file: 'src/broken.ts', line: 'src/broken.ts(1,1): error TS2322: broken' }] }),
      runTest: () => { testsRun += 1; return { ok: true, out: '1 pass' }; },
      hasChanges: () => true,
    });
    expect(result).toEqual({ ok: false, path: null, retry: 'tsc 실패. 다음 에러를 고쳐라:\nsrc/broken.ts(1,1): error TS2322: broken' });
    expect(testsRun).toBe(0);
  });

  test('TS5058 수집 실패는 원시 출력으로 보고하고 runTest를 호출하지 않는다', () => {
    const failure = Object.assign(new Error('tsconfig missing'), { status: 2, signal: null, stdout: '', stderr: 'error TS5058: The specified path does not exist.' });
    const collected = collectTscDiagnostics(process.cwd(), () => { throw failure; });
    let testsRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => collected,
      runTest: () => { testsRun += 1; return { ok: true, out: '1 pass' }; },
      hasChanges: () => true,
    });
    expect(result).toEqual({ ok: false, path: null, retry: 'tsc 실패. 다음 에러를 고쳐라:\nerror TS5058: The specified path does not exist.' });
    expect(testsRun).toBe(0);
  });

  test('전체 타입검사 성공 뒤에만 runTest를 실행하고 기존 테스트 실패 문구를 보존한다', () => {
    let testsRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => ({ ran: true, diagnostics: [] }),
      runTest: () => { testsRun += 1; return { ok: false, out: '0 pass / 1 fail' }; },
      hasChanges: () => true,
    });
    expect(result).toEqual({ ok: false, path: null, retry: '테스트 실패/부재:\n0 pass / 1 fail' });
    expect(testsRun).toBe(1);
  });

  test('26개 이상 진단은 앞 25개만 싣는다(종전 parseTscErrors().slice(0,25) 계약 보존)', () => {
    const diagnostics: TypecheckError[] = Array.from({ length: 26 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: `src/f${i}.ts(1,1): error TS2322: msg${i}`,
    }));
    // 종전 문구 = parseTscErrors(out).slice(0,25).join('\n') || out.slice(-1500), 그 뒤 .slice(0,1500).
    const former = diagnostics.map((d) => d.line).slice(0, 25).join('\n').slice(0, 1500);
    let testsRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => ({ ran: true, diagnostics }),
      runTest: () => { testsRun += 1; return { ok: true, out: '1 pass' }; },
      hasChanges: () => true,
    });
    expect(result).toEqual({ ok: false, path: null, retry: `tsc 실패. 다음 에러를 고쳐라:\n${former}` });
    // 26번째 진단은 문구에 없어야 한다(25개 상한).
    expect((result.retry ?? '')).not.toContain('msg25');
    expect((result.retry ?? '')).toContain('msg24');
    expect(testsRun).toBe(0);
  });

  test('1500자 초과 비파싱 출력은 끝 1500자를 쓴다(종전 out.slice(-1500) 계약 보존·앞부분 아님)', () => {
    const head = 'HEAD_MARKER_';
    const tail = '_TAIL_MARKER';
    const filler = 'x'.repeat(2000);
    const rawOutput = `${head}${filler}${tail}`; // >1500자, 머리·꼬리 구별
    // 종전 문구 = ('' || out.slice(-1500)).slice(0,1500) = out.slice(-1500).
    const former = rawOutput.slice(-1500).slice(0, 1500);
    let testsRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => ({ ran: false, diagnostics: [], output: rawOutput, failure: 'tsc 실행 실패' }),
      runTest: () => { testsRun += 1; return { ok: true, out: '1 pass' }; },
      hasChanges: () => true,
    });
    expect(result).toEqual({ ok: false, path: null, retry: `tsc 실패. 다음 에러를 고쳐라:\n${former}` });
    // 끝부분(꼬리)은 실리고 머리는 잘려나가야 한다(앞 1500자를 쓰면 회귀).
    expect((result.retry ?? '')).toContain(tail);
    expect((result.retry ?? '')).not.toContain(head);
    expect(testsRun).toBe(0);
  });
});

describe('createMissionVerifyDone', () => {
  const evidence: EvidenceMode = { kind: 'doc', dirRel: 'docs', glob: /PLAN/ };

  test('evidence 미달은 coverage를 실행하지 않고 canonical retry를 반환한다', async () => {
    let coverageCalls = 0;
    const verifyDone = createMissionVerifyDone({
      worktree: '/worktree', evidence, checklist: ['must-have'], coverageRetries: 2,
      checkEvidence: () => ({ ok: false, path: null, retry: '문서가 없다.' }),
      verifyCoverage: async () => { coverageCalls += 1; return { covered: [], missing: [], ratio: 1, method: 'test' }; },
    });
    await expect(verifyDone()).resolves.toEqual({ ok: false, retry: '문서가 없다.\n고친 뒤 MISSION-COMPLETE 라고 답하라.\r' });
    expect(coverageCalls).toBe(0);
  });

  test('coverage 미달은 retry budget 동안 되먹이고, 예산 소진 시 미달을 수락한다(visible omission·원본 시맨틱)', async () => {
    const missing = { covered: [], missing: ['must-have'], ratio: 0, method: 'test' };
    const verifyDone = createMissionVerifyDone({
      worktree: '/worktree', evidence, checklist: ['must-have'], coverageRetries: 1,
      checkEvidence: () => ({ ok: true, path: '/worktree/docs/PLAN.md' }),
      gatherArtifactText: () => 'artifact',
      verifyCoverage: async () => missing, // 계속 미달
    });
    const first = await verifyDone();
    const second = await verifyDone();
    // 1회 되먹임(남은 0) 후, 예산 소진 시 evidence 는 충족했으므로 수락한다(최종 ok 는 evidence gate 가 결정·
    // hard-fail 로 두면 control loop 이 budget 까지 헛돌며 자식을 계속 찌른다).
    expect(first).toMatchObject({ ok: false, retry: expect.stringContaining('남은 커버리지 재시도: 0') });
    expect(second).toEqual({ ok: true });
  });

  test('coverage 완전 충족이면 즉시 success(재시도 예산 무관)', async () => {
    const complete = { covered: ['must-have'], missing: [], ratio: 1, method: 'test' };
    const verifyDone = createMissionVerifyDone({
      worktree: '/worktree', evidence, checklist: ['must-have'], coverageRetries: 2,
      checkEvidence: () => ({ ok: true, path: '/worktree/docs/PLAN.md' }),
      gatherArtifactText: () => 'artifact',
      verifyCoverage: async () => complete,
    });
    expect(await verifyDone()).toEqual({ ok: true });
  });
});

describe('checkEvidence doc — only a document this mission wrote counts', () => {
  const mkRepo = () => {
    const d = mkdtempSync(join(tmpdir(), 'doc-evidence-'));
    execFileSync('git', ['init', '-q', d]);
    mkdirSync(join(d, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(d, 'docs', 'plans', 'PLAN-old-2026-01-01.md'), 'old\n');
    execFileSync('git', ['-C', d, 'add', '-A']);
    execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
    return d;
  };
  const ev = { kind: 'doc' as const, dirRel: 'docs/plans', glob: /^PLAN-.*\.md$/ };

  test('a matching document that was already committed does not pass round 0', () => {
    const d = mkRepo();
    try {
      const r = checkEvidence(d, ev);
      expect(r.ok).toBe(false);
      expect(r.retry).toContain('이번 미션이 쓴 것이 아니다');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a new document passes · an edited old one passes', () => {
    const d = mkRepo();
    try {
      writeFileSync(join(d, 'docs', 'plans', 'PLAN-new-2026-09-27.md'), 'new\n');
      expect(checkEvidence(d, ev)).toMatchObject({ ok: true, path: join(d, 'docs', 'plans', 'PLAN-new-2026-09-27.md') });
      rmSync(join(d, 'docs', 'plans', 'PLAN-new-2026-09-27.md'));
      writeFileSync(join(d, 'docs', 'plans', 'PLAN-old-2026-01-01.md'), 'old\nedited\n');
      expect(checkEvidence(d, ev)).toMatchObject({ ok: true, path: join(d, 'docs', 'plans', 'PLAN-old-2026-01-01.md') });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a document inside a wholly untracked directory passes (porcelain collapses it to the directory)', () => {
    const d = mkRepo();
    try {
      const e2 = { kind: 'doc' as const, dirRel: 'docs/fresh', glob: /^RFC-.*\.md$/ };
      mkdirSync(join(d, 'docs', 'fresh'), { recursive: true });
      writeFileSync(join(d, 'docs', 'fresh', 'RFC-x.md'), 'x\n');
      expect(checkEvidence(d, e2)).toMatchObject({ ok: true });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('gemini(agy) backend answers the folder-trust menu', () => {
  const trustScreen = 'Accessing workspace:\n/tmp/wt\nDo you trust the contents of this project?\nAntigravity CLI requires permission to read, edit, and execute files here.\n> Yes, I trust this folder\n  No, exit\n  ↑/↓ Navigate · enter Confirm';
  test('the trust menu is confirmed with Enter (default = trust) and reported as handled', () => {
    const writes: string[] = [];
    expect(geminiBackend.handleTrust?.(trustScreen, (s) => writes.push(s))).toBe(true);
    expect(writes).toEqual(['\r']);
  });
  test('a normal prompt screen is left alone', () => {
    const writes: string[] = [];
    expect(geminiBackend.handleTrust?.('Antigravity CLI 1.2.12\n> \n? for shortcuts', (s) => writes.push(s))).toBe(false);
    expect(writes).toEqual([]);
  });
});
