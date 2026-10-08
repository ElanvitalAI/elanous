import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnRealCli } from './testing/real-cli-spawn.js';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);
// ⏱️ 테스트 타임아웃은 «대기열 몫»까지 둔다 — spawn 자체의 60초 타임아웃은 슬롯을 얻은 뒤부터 잰다(real-cli-spawn.ts).
const CONCURRENT_TEST_TIMEOUT_MS = 600_000;

/**
 * GIT-T13 회귀 방어 — **배포 엔트리(`bin/elanous.mjs`)가 실제로 dispatch 하는가.**
 *
 * `#6701` 이 `src/index.ts` 의 `main()` 을 `if (import.meta.main)` 으로 감쌌다.
 * 배포 엔트리는 `bin/elanous.mjs` 이고 그것이 `src/index.ts` 를 **import** 하므로
 * 그 조건은 항상 false → `elanous` 의 **모든 명령**이 출력 0바이트 · exit 0 의
 * 조용한 no-op 이 됐다. 당시 단위 테스트 3개는 `program` 을 직접 import 해서
 * hook 배선만 쟀기 때문에 전부 통과했다 — **아무도 실물을 안 돌렸다.**
 *
 * ⇒ 이 테스트가 재는 것은 로직이 아니라 **경로**다: 셸에서 치는 그 명령이
 *   프로세스로 떠서 산출을 내는가. 그래서 in-process import 가 아니라 spawn 이다.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(REPO_ROOT, 'bin/elanous.mjs');

/** 버전은 `package.json` 이 SSOT — 여기 박으면 버전 갱신이 무관한 실패를 만든다. */
const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { version?: string }
).version;

// ⏱️ GATE-SPEED ③ — 실물 spawn 은 «그대로»다. 기다리는 방식만 비동기 ⊕ 상한 있는 동시성(`describe.concurrent`)으로
//   바꿨다 — 순차 `spawnSync` 45회가 이 파일을 게이트 임계 경로(0.2.18 컷 391초)로 만들었다.
async function runBin(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const r = await spawnRealCli(['bun', BIN, ...args], {
    cwd: REPO_ROOT,
    timeoutMs: 60_000,
    // 격리 — 이 테스트는 산출의 **유무**만 재므로 운영 스토어에 닿을 이유가 없다.
    env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off', ...env },
  });
  // ⛔⭐ 타임아웃·spawn 실패는 **stdout 이 비는 방식으로** 나타난다 — 이 테스트가 겨누는
  //   회귀(무출력)와 **정확히 같은 모양**이다. 여기서 갈라 두지 않으면 인프라 문제가
  //   "엔트리가 또 죽었다" 로 오독된다. 그래서 단언 전에 시끄럽게 던진다.
  if (r.error) throw new Error(`spawn 실패(회귀 아님): ${r.error.message}`);
  if (r.signal) throw new Error(`시그널 종료(회귀 아님 · 타임아웃 의심): signal=${r.signal}`);
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

// ⚠️ 실물 spawn 은 모듈 그래프가 커서 1회 ~7초다(실측). bun test 기본 5초로는
//    **타임아웃이 곧 0바이트**라 죽은 엔트리와 구분이 안 된다 — 명시 상향한다.
const SPAWN_TIMEOUT_MS = 60_000;

async function runBinWithDelayedStdout(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ bytes: number; validJson: boolean; stderr: string; status: number | null }> {
  // The consumer does not attach stdin until its timeout elapses. Running this through
  // `sh` preserves the kernel pipe's backpressure; spawning the producer directly would
  // let Bun drain its stdout pipe before this test begins consuming it.
  const consumer = "setTimeout(() => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { text += chunk; }); process.stdin.on('end', () => { let validJson = true; try { JSON.parse(text); } catch { validJson = false; } process.stdout.write(JSON.stringify({ bytes: Buffer.byteLength(text), validJson }) + '\\n'); }); }, 1200);";
  const result = await spawnRealCli(['sh', '-c', '"$@" | bun -e "$ELANOUS_DELAYED_STDOUT_CONSUMER"', 'sh', 'bun', BIN, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off', ELANOUS_DELAYED_STDOUT_CONSUMER: consumer, ...env },
    timeoutMs: SPAWN_TIMEOUT_MS,
  });
  if (result.error) throw new Error(`slow consumer pipeline failed to spawn: ${result.error.message}`);
  return {
    ...JSON.parse(result.stdout ?? '') as { bytes: number; validJson: boolean },
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe.concurrent('배포 엔트리 bin/elanous.mjs', () => {
  test('release checklist 중복 칸과 없는 칸은 두 줄의 사용자 오류만 stderr로 낸다', async () => {
    const id = `cli-user-error-${process.pid}-${Date.now()}`;
    const version = '99.99.99';
    const added = await runBin(['--test', 'release', 'checklist', '--version', version, 'add', id, 'test item']);
    expect(added.status).toBe(0);
    try {
      const duplicate = await runBin(['--test', 'release', 'checklist', '--version', version, 'add', id, 'again']);
      expect(duplicate.status).toBe(1);
      expect(duplicate.stdout).toBe('');
      expect(duplicate.stderr.trim()).toBe(`❌ 이미 있는 칸: ${id}\n  ↳ set <id> 로 고친다`);
      expect(duplicate.stderr).not.toMatch(/^\s*at\s|^Bun v/m);

      const missing = await runBin(['--test', 'release', 'checklist', '--version', version, 'set', `${id}-absent`, '--status', 'red']);
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe('');
      expect(missing.stderr.trim()).toBe(`❌ 없는 칸: ${id}-absent\n  ↳ list 로 칸 목록을 본다`);
      expect(missing.stderr).not.toMatch(/^\s*at\s|^Bun v/m);
    } finally {
      const removed = await runBin(['--test', 'release', 'checklist', '--version', version, 'rm', id]);
      expect(removed.status).toBe(0);
    }
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('예상하지 못한 예외는 코드 프레임과 스택을 보존한다', async () => {
    const missing = join(tmpdir(), `missing-checklist-seed-${process.pid}-${Date.now()}.md`);
    const result = await runBin(['--test', 'release', 'checklist', 'seed', '--from', missing]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toMatch(/^\s*at\s/m);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('--version 이 산출을 낸다 (조용한 no-op 이 아니다)', async () => {
    const { stdout, stderr, status } = await runBin(['--version']);
    // ⛔ exit 0 만으로는 못 가른다 — 죽은 엔트리도 exit 0 였다. 산출을 재야 한다.
    expect(`${stdout}${stderr}`.trim().length).toBeGreaterThan(0);
    expect(PKG_VERSION).toBeTruthy();
    expect(stdout).toContain(PKG_VERSION!);
    expect(status).toBe(0);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('알 수 없는 명령은 조용히 성공하지 않는다 (commander dispatch 도달)', async () => {
    const { stdout, stderr, status } = await runBin(['__no_such_command__']);
    // 죽은 엔트리는 무엇을 줘도 0바이트 · exit 0 였다. 거부는 시끄러워야 한다.
    expect(`${stdout}${stderr}`).toContain('__no_such_command__');
    expect(status).not.toBe(0);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test.each(['--resume', '--bogus-flag'])('self goal-run-search가 %s를 Commander의 unknown option으로 거부한다', async (flag) => {
    const { stdout, stderr, status } = await runBin(['self', 'goal-run-search', '--limit', '1', flag, 'XYZ']);
    expect(`${stdout}${stderr}`).toContain('unknown option');
    expect(status).not.toBe(0);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('harness ask --graph is no longer accepted', async () => {
    const { stdout, stderr, status } = await runBin(['--test', 'harness', 'ask', '/tmp/goal.md', '--graph', 'maybe', '--dry-run']);
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain("error: unknown option '--graph'");
    expect(stderr).not.toMatch(/\bat\s+.*\(/);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test.each(['repro', 'eval-prompt'])('%s 는 LLM 실행 없이 attach 대체 경로를 안내한다', async (command) => {
    const { stdout, stderr, status } = await runBin([command, '문장']);
    const output = `${stdout}${stderr}`;
    expect(output).toContain('repro is retired');
    expect(output).toContain('elanous attach --message');
    expect(output).toContain('--assert-tool-min');
    expect(output).toContain('--assert-tool-max');
    expect(output).toContain('--assert-text-contains');
    expect(status).not.toBe(0);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  // ⛔⭐⭐ 되돌릴 수 없는 소비의 «유일한» 안전장치라 회귀를 코드로 잠근다(1R must-fix).
  //   ⚠️ 이 테스트는 «네트워크를 치지 않는다** — 가드가 그 «전에» 끊는 것이 요구사항 자체다.
  test('provider codex reset-credits redeem 은 --yes 없이 거부하고 exit 2 를 낸다 (fail-closed)', async () => {
    const r = await spawnRealCli(['bun', BIN, 'provider', 'codex', 'reset-credits', 'redeem'], {
      timeoutMs: 60_000,
    });
    expect(r.status).toBe(2);                       // ⛔ 0 이면 소비가 통과했다는 뜻이다
    expect(`${r.stderr}`).toContain('--yes');
    // 소비 경로로 «들어가지 않았다»는 증거 — 성공 안내문이 안 나온다
    expect(`${r.stdout}`).not.toContain('usedPercent');
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('repro 는 일반 도움말 명령 목록에 노출되지 않는다', async () => {
    const { stdout, stderr, status } = await runBin(['--help']);
    expect(status).toBe(0);
    expect(`${stdout}${stderr}`).not.toMatch(/^\s*repro(?:\||\s|$)/m);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('top-level help advertises ACP server and websocket transport', async () => {
    const { stdout, status } = await runBin(['--test', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--acp-server');
    expect(stdout).toContain('--transport=websocket');
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('nexus run 도움말 끝은 등록된 숨은 옵션의 수와 이름을 알린다', async () => {
    const { stdout, stderr, status } = await runBin(['nexus', 'run', '--help']);
    const output = `${stdout}${stderr}`;
    expect(status).toBe(0);
    expect(output).toMatch(/Hidden options \(7\):\s*--headless, --foreground, --bg, --http-port, --http-host, --tools, --history-dir\s*$/);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('self entrances --json은 1.2초 늦게 읽는 실제 stdout 파이프 소비자에게도 대용량 JSON을 끝까지 출력한다', async () => {
    // `self entrances`는 fixture를 스캔하지 않고 1.2초 지연 전에 대용량 JSON을 쓴다.
    // 따라서 실제 셸 파이프에서 non-blocking stdout short-write를 재현한다.
    const piped = await runBinWithDelayedStdout(['self', 'entrances', '--json']);
    const redirected = await runBin(['self', 'entrances', '--json']);
    expect(piped.status).toBe(0);
    expect(piped.stderr).toBe('');
    expect(redirected.status).toBe(0);
    expect(redirected.stderr).toBe('');
    expect(piped.bytes).toBeGreaterThan(65_536);
    expect(piped.bytes).toBe(Buffer.byteLength(redirected.stdout));
    expect(piped.validJson).toBe(true);
    JSON.parse(redirected.stdout);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('self parked 도움말은 JSON 출력의 updatedAt 필드를 명시한다', async () => {
    const { stdout, stderr, status } = await runBin(['self', 'parked', '--help']);
    expect(status).toBe(0);
    // ⛔⭐ Commander 가 도움말을 «폭에 맞춰 접는다» — 줄바꿈이 필드 사이 «아무 데나» 들어간다.
    //   ⇒ 공백을 먼저 «한 칸으로 접고» 문다. 안 그러면 이 시험이 「문면」이 아니라
    //     ***「터미널 폭」***을 무는 자가 된다(폭이 바뀌면 빨개진다).
    const help = `${stdout}${stderr}`.replace(/\s+/g, ' ');
    // ⛔ 봉투만 적혀 있으면 도구를 쓰는 사람이 parked[] «안»을 모른다 — 둘 다 문다.
    expect(help).toContain('{parked, counts, displayLimit, omittedCount, population, stores, limitation}');
    expect(help).toContain('[{feature, status, stage?, error?, runId, branch?, updatedAt, source}]');
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('self parked는 사람용 행에 갱신 나이를 싣고 JSON parked 계약은 보존한다', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-self-parked-'));
    const runsDir = join(stateDir, 'self-dev-runs');
    mkdirSync(runsDir, { recursive: true });
    const updatedAt = Date.now() - 86_400_000;
    const checkpoint = {
      runId: 'parked-run',
      createdAt: 1,
      updatedAt,
      results: [{
        taskId: 'parked-task', feature: 'Parked feature', status: 'failed', stage: 'gate-failed',
        error: { code: 'SELF_IMPL_FAILED', message: 'failed gate' },
      }],
    };
    writeFileSync(join(runsDir, 'parked-run.json'), JSON.stringify(checkpoint));
    try {
      const env = { ELANOUS_STATE_DIR: stateDir };
      const human = await runBin(['self', 'parked'], env);
      expect(human.status).toBe(0);
      // 🪞 2026-08-26 — 사람 행이 ***[self-dev-run] 접두***를 얻었다(모집단 표시).
      //   ⛔ 늙은 기대가 아니라 «현재 계약»을 문다 — 그 접두가 곧 「어느 모집단인가」이고,
      //   그것이 오늘 수리 신호 축이 갈린 바로 그 값이다.
      expect(human.stdout).toContain('⚠️ [self-dev-run] failed/gate-failed · Parked feature — SELF_IMPL_FAILED  [run parked-run] · 1d ago');

      const json = await runBin(['self', 'parked', '--json'], env);
      expect(json.status).toBe(0);
      // 🪞 2026-08-26 — `--json` 이 ***맨 배열에서 «봉투»로*** 바뀌었고 원소에 `source` 가 붙었다.
      //   ⛔ 늙은 기대(맨 배열)를 되살리지 마라 — 봉투가 담은 counts/omittedCount 가
      //   ***「내가 무엇을 «안» 보고 있나」***를 말하는 값이고, 그게 이 명령의 요점이다.
      expect(JSON.parse(json.stdout)).toEqual({
        parked: [{
          feature: 'Parked feature', status: 'failed', stage: 'gate-failed',
          error: { code: 'SELF_IMPL_FAILED', message: 'failed gate' },
          goalId: null, runId: 'parked-run', updatedAt, source: 'self-dev-run',
        }],
        counts: { total: 1, selfDevRun: 1, selfImplementLedger: 0 },
        displayLimit: Number.MAX_SAFE_INTEGER,
        omittedCount: 0,
        population: { selfDevRun: 'existing parked-goal scan', selfImplementLedgerStatus: 'interrupted' },
        stores: { count: 2, names: [runsDir, join(stateDir, 'run-ledger')] },
        limitation: '이 자는 현재 self-dev run 저장소와 self-implement 원장만 읽고 다른 우주는 보지 않으며, 그 런이 아직 열려 있는지도 보지 않습니다.',
      });
      expect(human.stdout).toContain('원장 상태=interrupted');
      expect(human.stdout).toContain('이 자는 현재 self-dev run 저장소와 self-implement 원장만 읽고 다른 우주는 보지 않으며, 그 런이 아직 열려 있는지도 보지 않습니다.');

      const resolved = await runBin(['self', 'parked', '--resolve', 'parked-run', '--reason', 'succeeded later'], env);
      expect(resolved.status).toBe(0);
      expect(resolved.stdout).toContain('parked run 처리 완료 표시: parked-run — succeeded later');
      expect(JSON.parse(readFileSync(join(runsDir, 'parked-run.json'), 'utf8'))).toMatchObject({
        runId: 'parked-run',
        results: checkpoint.results,
        parkedResolution: { reason: 'succeeded later' },
      });

      const afterResolution = await runBin(['self', 'parked', '--json'], env);
      expect(afterResolution.status).toBe(0);
      // ⭐ 처리 표시 «뒤»에도 봉투는 그대로다 — 「비었다」가 «맨 배열»로 퇴화하지 않는다.
      //   ⛔ counts 가 사라지면 「0건」과 「안 봤다」가 다시 같은 모양이 된다.
      expect(JSON.parse(afterResolution.stdout)).toEqual({
        parked: [],
        counts: { total: 0, selfDevRun: 0, selfImplementLedger: 0 },
        displayLimit: Number.MAX_SAFE_INTEGER,
        omittedCount: 0,
        population: { selfDevRun: 'existing parked-goal scan', selfImplementLedgerStatus: 'interrupted' },
        stores: { count: 2, names: [runsDir, join(stateDir, 'run-ledger')] },
        limitation: '이 자는 현재 self-dev run 저장소와 self-implement 원장만 읽고 다른 우주는 보지 않으며, 그 런이 아직 열려 있는지도 보지 않습니다.',
      });

      const absent = await runBin(['self', 'parked', '--resolve', 'unknown-run', '--reason', 'reviewed'], env);
      expect(absent.status).not.toBe(0);
      expect(`${absent.stdout}${absent.stderr}`).toContain('self-dev run not found: unknown-run');

      const victim = join(stateDir, 'victim.json');
      writeFileSync(victim, '{"preserve":true}', 'utf8');
      const traversal = await runBin(['self', 'parked', '--resolve', '../victim', '--reason', 'reviewed'], env);
      expect(traversal.status).not.toBe(0);
      expect(`${traversal.stdout}${traversal.stderr}`).toContain('invalid self-dev run ID: ../victim');
      expect(readFileSync(victim, 'utf8')).toBe('{"preserve":true}');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('self parked는 숫자가 아닌 updatedAt을 사람용 행에 덧붙이지 않는다', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-self-parked-invalid-age-'));
    const runsDir = join(stateDir, 'self-dev-runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'invalid-age.json'), JSON.stringify({
      runId: 'invalid-age', createdAt: 1, updatedAt: 'not-a-timestamp',
      results: [{ taskId: 'invalid-task', feature: 'Invalid timestamp', status: 'cancelled' }],
    }));
    try {
      const result = await runBin(['self', 'parked'], { ELANOUS_STATE_DIR: stateDir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('⚠️ [self-dev-run] cancelled · Invalid timestamp  [run invalid-age]');
      expect(result.stdout).not.toMatch(/\[run invalid-age\].*ago/);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('self participants는 tracked·empty·legacy·absent run을 서로 다른 stdout 문면으로 조회한다', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-self-participants-'));
    const runsDir = join(stateDir, 'self-dev-runs');
    mkdirSync(runsDir, { recursive: true });
    const checkpoint = (runId: string, participants?: unknown) => ({
      runId,
      createdAt: 1,
      updatedAt: 1,
      results: [],
      ...(participants === undefined ? {} : { participants }),
    });
    writeFileSync(join(runsDir, 'tracked.json'), JSON.stringify(checkpoint('tracked', [{
      id: 'process:42', kind: 'process', transports: [], registeredAt: 1, runIdSource: 'generated',
    }])));
    writeFileSync(join(runsDir, 'empty.json'), JSON.stringify(checkpoint('empty', [])));
    writeFileSync(join(runsDir, 'legacy.json'), JSON.stringify(checkpoint('legacy')));
    try {
      const env = { ELANOUS_STATE_DIR: stateDir };
      const tracked = await runBin(['self', 'participants', 'tracked'], env);
      expect(tracked.status).toBe(0);
      expect(tracked.stdout).toContain('scope: run-participation');
      expect(tracked.stdout).toContain('note: 프로세스 조상과 후손은 elanous pty lineage가 답합니다.');
      expect(tracked.stdout).toContain('id=process:42 kind=process runIdSource=generated');

      const empty = await runBin(['self', 'participants', 'empty'], env);
      expect(empty.status).toBe(0);
      expect(empty.stdout).toContain('참가자 없음: participant tracking은 사용했지만 기록된 참가자가 없습니다.');

      const legacy = await runBin(['self', 'participants', 'legacy'], env);
      expect(legacy.status).toBe(0);
      expect(legacy.stdout).toContain('participants 축 없음: 옛 기록은 participant tracking을 사용하지 않았습니다.');

      const absent = await runBin(['self', 'participants', 'absent'], env);
      expect(absent.status).toBe(0);
      expect(absent.stdout).toContain('run 없음: absent');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, CONCURRENT_TEST_TIMEOUT_MS);
});

describe.concurrent('config set llm.provider — provider별 자격증명 동기화', () => {
  const oldKey = 'old-openai-secret-for-cli-test';
  const rotationKey = 'anthropic-rotation-secret-for-cli-test';
  const envKey = 'anthropic-env-secret-for-cli-test';

  async function withConfig(
    llm: Record<string, unknown>,
    run: (configPath: string, env: NodeJS.ProcessEnv) => Promise<void>,
    env: NodeJS.ProcessEnv = {},
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'config-set-provider-credential-'));
    const xdgConfigHome = join(root, 'cfg');
    const configPath = join(xdgConfigHome, 'elanous', 'config.json');
    try {
      mkdirSync(join(xdgConfigHome, 'elanous'), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ llm }), 'utf8');
      await run(configPath, {
        HOME: root,
        XDG_CONFIG_HOME: xdgConfigHome,
        ELANOUS_STATE_DIR: join(root, 'state'),
        ELANOUS_SUPPRESS_XDG_WARNING: '1',
        ELANOUS_LLM_PROVIDER: '',
        ELANOUS_LLM_MODEL: '',
        ELANOUS_ESCALATE_PROVIDER: '',
        ELANOUS_ESCALATE_MODEL: '',
        ANTHROPIC_API_KEY: '',
        GROK_API_KEY: '',
        ...env,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('rotation은 env보다 우선해 저장하고 출력은 키 값을 노출하지 않는다', async () => {
    await withConfig(
      { provider: 'openai-codex', apiKey: oldKey, rotation: [{ provider: 'anthropic', apiKey: rotationKey }] },
      async (configPath, env) => {
        const switched = await runBin(['config', 'set', 'llm.provider', 'anthropic'], { ...env, ANTHROPIC_API_KEY: envKey });
        expect(switched.status).toBe(0);
        expect(switched.stdout).toContain('provider credential updated: anthropic via rotation');
        expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ llm: { provider: 'anthropic', apiKey: rotationKey } });
        const output = `${switched.stdout}\n${switched.stderr}`;
        expect(output).not.toContain(oldKey);
        expect(output).not.toContain(rotationKey);
        expect(output).not.toContain(envKey);
      },
    );
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('rotation이 없으면 provider 환경변수 키를 저장한다', async () => {
    await withConfig(
      { provider: 'openai-codex', apiKey: oldKey, rotation: [] },
      async (configPath, env) => {
        const switched = await runBin(['config', 'set', 'llm.provider', 'anthropic'], { ...env, ANTHROPIC_API_KEY: envKey });
        expect(switched.status).toBe(0);
        expect(switched.stdout).toContain('provider credential updated: anthropic via env');
        expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ llm: { provider: 'anthropic', apiKey: envKey } });
        expect(`${switched.stdout}\n${switched.stderr}`).not.toContain(envKey);
      },
    );
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('같은 provider는 자격증명을 갱신하거나 설정 파일을 다시 쓰지 않는다', async () => {
    await withConfig(
      { provider: 'anthropic', apiKey: rotationKey, model: 'claude-test', rotation: [{ provider: 'anthropic', apiKey: rotationKey }] },
      async (configPath, env) => {
        const before = readFileSync(configPath, 'utf8');
        const same = await runBin(['config', 'set', 'llm.provider', 'anthropic'], { ...env, ANTHROPIC_API_KEY: envKey });
        expect(same.status).toBe(0);
        expect(`${same.stdout}\n${same.stderr}`).not.toContain('provider credential updated:');
        expect(readFileSync(configPath, 'utf8')).toBe(before);
      },
    );
  }, CONCURRENT_TEST_TIMEOUT_MS);

  test('자격증명 없음은 경고와 기존 키 유지를, keyless와 다른 경로는 무경고 키 유지를 보장한다', async () => {
    await withConfig(
      { provider: 'openai-codex', apiKey: oldKey, model: 'gpt-5', rotation: [] },
      async (configPath, env) => {
        const unavailable = await runBin(['config', 'set', 'llm.provider', 'grok'], env);
        expect(unavailable.status).toBe(0);
        expect(unavailable.stdout).toContain('provider credential unavailable: grok');
        expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ llm: { provider: 'grok', apiKey: oldKey } });

        const keyless = await runBin(['config', 'set', 'llm.provider', 'local'], env);
        expect(keyless.status).toBe(0);
        expect(`${keyless.stdout}\n${keyless.stderr}`).not.toContain('provider credential unavailable:');
        expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ llm: { provider: 'local', apiKey: oldKey } });

        const model = await runBin(['config', 'set', 'llm.model', 'manually-selected-model'], env);
        expect(model.status).toBe(0);
        expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ llm: { model: 'manually-selected-model', apiKey: oldKey } });
        const output = `${unavailable.stdout}\n${unavailable.stderr}\n${keyless.stdout}\n${keyless.stderr}\n${model.stdout}\n${model.stderr}`;
        expect(output).not.toContain(oldKey);
      },
    );
  }, CONCURRENT_TEST_TIMEOUT_MS);
});

// ⛔⭐⭐⭐⭐ `provider codex status` — 리뷰 must-fix. 이 명령의 값은 «세 수»에 있고,
//   그 셋은 전부 «표면이 런타임과 같은 자를 쓰는가」다. 그래서 실물로 문다:
//   ① 신호 디렉터리가 ELANOUS_STATE_DIR 을 «따라가는가»(인스턴스 해석과 갈릴 수 있다 — 그 사실도 값으로)
//   ② 임계가 «판정기가 실제로 쓴» 정규화 값인가(raw config 를 찍으면 0·101·NaN 에서 거짓말한다)
//   ③ 신호 «나이»가 JSON 에 있는가(핵심 진단 항목인데 텍스트에만 있으면 도구가 못 읽는다)
//   ⛔ 이 셋은 in-process 로 못 문다 — 실제로 그 명령이 떠서 그 값을 내야 한다.
describe.concurrent('provider codex status — 실물 산출', () => {
  test('우주·임계·신호 나이를 «값으로» 낸다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-status-cli-'));
    try {
      // ⛔⭐ 홈도 «격리»한다(리뷰 must-fix) — 종전엔 실제 ~/.codex 에 의존해 깨끗한 CI 에서 깨졌다.
      const isoHome = join(root, 'codex-home');
      mkdirSync(isoHome, { recursive: true });
      // ⛔⭐ auth 스토어도 «격리»한다(리뷰 should-fix) — 안 하면 이 시험이 실제 계정 구성을
      //   읽어, 사람마다·시점마다 다른 답을 본다(우리가 오늘 그 축을 계속 고쳤다).
      //   authStorePath() 는 XDG_CONFIG_HOME 을 존중하므로 그것으로 가둔다.
      const isoCfg = join(root, 'cfg');
      mkdirSync(join(isoCfg, 'elanous'), { recursive: true });
      writeFileSync(join(isoCfg, 'elanous', 'auth.json'), JSON.stringify({ providers: {} }), 'utf8');
      const isoEnv = { HOME: root, ELANOUS_STATE_DIR: join(root, 'unrelated-instance-state'), CODEX_HOME: isoHome, XDG_CONFIG_HOME: isoCfg, ELANOUS_SUPPRESS_XDG_WARNING: '1' };
      const r = await runBin(['provider', 'codex', 'status', '--json'], isoEnv);
      if (r.status !== 0) throw new Error(`status 가 실패했다(회귀): ${r.stderr.slice(0, 300)}`);
      const out = JSON.parse(r.stdout) as {
        universe: { instanceRoot: string; signalDir: string; authStore: string };
        // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
        rotation: { thresholdPercent: number; reason: string };
        current: { signalAgeMinutes: number | null; signalObservedAt: number | null; home: string | null };
        candidates: Array<{ signalAgeMinutes: number | null }>;
      };
      // ① 🪞 2026-08-26 정정 — 옛 기대는 *"신호는 «공유 자격 뿌리(HOME)»를 따른다"* 였다.
      //   그건 `OBS-T110`(#10211) 판이고, ***`OBS-T114`(#10219) 가 그 위에 한 칸을 더 놓았다***:
      //   ⓐ ELANOUS_STATE_DIR_SOURCE='derived' → 파생이니 «무시»(아무도 의도 안 한 격리를 막는다)
      //   ⓑ ELANOUS_STATE_DIR 이 «명시»로 서 있으면 → ***존중한다***
      //   ⓒ 아니면 XDG_CONFIG_HOME/elanous · 없으면 homedir()/.elanous
      //   🔑 이 시험은 ELANOUS_STATE_DIR 을 «명시로» 준다 ⇒ ⓑ 다. 그리고 ***그 규칙이 이 시험을 지킨다*** —
      //      존중 안 하면 이 시험이 사람의 진짜 ~/.elanous/budget 에 쓴다(코드 주석이 그렇게 말한다).
      //   📌 규칙 «자체»의 정본 물개는 src/budget/credential-root-provenance.test.ts 다.
      //      여기서는 「실물 CLI 가 그 규칙대로 값을 내나」만 문다.
      expect(out.universe.signalDir).toBe(join(isoEnv.ELANOUS_STATE_DIR, 'budget'));
      expect(out.universe.signalDir).not.toStartWith(join(root, '.elanous'));
      expect(out.universe.instanceRoot.length).toBeGreaterThan(0);
      // ② 임계는 «수»다 — raw config(unknown)를 그대로 흘리면 여기서 걸린다
      expect(typeof out.rotation.thresholdPercent).toBe('number');
      expect(out.rotation.thresholdPercent).toBeGreaterThanOrEqual(1);
      expect(out.rotation.thresholdPercent).toBeLessThanOrEqual(100);
      // ⛔⭐ 그리고 «비정상 설정을 실제로 주입»해 정규화를 문다(리뷰 should-fix) —
      //   범위 검사만으로는 raw 를 흘려도 통과할 수 있다. 0 은 판정기가 95 로 바꾼다.
      const cfgDir = mkdtempSync(join(tmpdir(), 'codex-status-cfg-'));
      try {
        mkdirSync(join(cfgDir, 'elanous'), { recursive: true });
        writeFileSync(join(cfgDir, 'elanous', 'config.json'),
          JSON.stringify({ llm: { codexAccountRotationThresholdPercent: 0 } }), 'utf8');
        const bad = await runBin(['provider', 'codex', 'status', '--json'],
          { ...isoEnv, XDG_CONFIG_HOME: cfgDir });
        if (bad.status !== 0) throw new Error(`status 실패(회귀): ${bad.stderr.slice(0, 300)}`);
        const parsedBad = JSON.parse(bad.stdout) as { rotation: { thresholdPercent: number } };
        // ⭐ 설정은 0 인데 «판정기가 쓰는 값»은 정규화된 값이다 — 화면이 0 이라 말하면 거짓말이다.
        //   격리 환경의 현재 계정은 `default` 라 대표 원칙(«default 는 60% 까지만» · min(60, 전역 95))으로 60 이다.
        expect(parsedBad.rotation.thresholdPercent).toBe(60);

        // ⛔⭐⭐ 그리고 «유효값»도 문다 — 이것이 없으면 「설정이 아예 안 읽히는」 회귀를 못 잡는다.
        //   0 만 주면 배선이 죽어도(0 → undefined → 95) 같은 답이 나와 통과한다.
        //   📏 실측 2026-08-07: `#7579` 가 이 노브를 config 스키마에 «하나도» 안 넣어
        //   ***임계 설정이 통째로 no-op 이었다.*** 이 줄이 그것을 잡는다.
        writeFileSync(join(cfgDir, 'elanous', 'config.json'),
          JSON.stringify({ llm: { codexAccountRotationThresholdPercent: 42 } }), 'utf8');
        const ok = await runBin(['provider', 'codex', 'status', '--json'],
          { ...isoEnv, XDG_CONFIG_HOME: cfgDir });
        if (ok.status !== 0) throw new Error(`status 실패(회귀): ${ok.stderr.slice(0, 300)}`);
        expect((JSON.parse(ok.stdout) as { rotation: { thresholdPercent: number } }).rotation.thresholdPercent).toBe(42);
      } finally {
        try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      // ③ 신호 나이 키가 «있다» — 빈 우주라 값은 null 이지만 «키가 없으면» 도구가 못 읽는다
      expect(out.current).toHaveProperty('signalAgeMinutes');
      expect(out.current).toHaveProperty('signalObservedAt');
      for (const c of out.candidates) expect(c).toHaveProperty('signalAgeMinutes');

      // ⛔⭐⭐ 만료 신호에서도 «나이»가 나와야 한다(리뷰 must-fix) — 가장 필요한 순간이 그때다.
      //   「65분 전(곧 갱신)」과 「4320분 전(갱신이 죽었다)」은 완전히 다른 진단이다.
      // ⭐ 격리 홈을 줬으므로 이 경로는 «우리가 만든 것»이다 — 사용자 상태에 안 기댄다
      const home = realpathSync(isoHome);
      {
        const key = createHash('sha256').update(home).digest('hex').slice(0, 12);
        // 🪞 2026-08-26 — 쓰는 자리를 ***도구가 스스로 말한 signalDir*** 로 잡는다.
        //   ⛔ 종전엔 join(root,'.elanous','budget') 으로 «손으로» 박아 뒀는데, `OBS-T114` 로
        //   읽는 쪽이 옮겨 가면서 ***쓴 신호를 아무도 안 읽어*** signalAgeMinutes 가 null 이 됐다.
        //   ⇒ 위 ① 이 signalDir «값»을 이미 못 박았으니, 여기서는 그 값을 «쓴다» — 다시 안 갈린다.
        const signalDir = out.universe.signalDir;
        mkdirSync(signalDir, { recursive: true });
        writeFileSync(join(signalDir, `codex-quota-signal-${key}.json`), JSON.stringify({
          rateLimitReached: null, usedPercent: 7,
          observedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
          measuredHome: home,
        }), 'utf8');
        const stale = await runBin(['provider', 'codex', 'status', '--json'], isoEnv);
        if (stale.status !== 0) throw new Error(`status 실패(회귀): ${stale.stderr.slice(0, 300)}`);
        const p2 = JSON.parse(stale.stdout) as { current: { signalAgeMinutes: number | null; signalFresh: boolean } };
        // ⭐ 만료지만 «나이는 있다» — 종전엔 둘 다 접혀 null 이었다
        expect(p2.current.signalFresh).toBe(false);
        expect(p2.current.signalAgeMinutes).toBeGreaterThan(60);
      }
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, CONCURRENT_TEST_TIMEOUT_MS);
});

// ⛔ 이 시험만 «순차»로 남긴다 — `self running-runs` 는 살아 있는 프로세스 표를 읽으므로, 같은 파일의
//   동시 spawn 이 겹치면 piped/redirected 두 번의 산출 바이트가 «시험 자신 때문에» 갈린다.
describe('배포 엔트리 bin/elanous.mjs — 순차', () => {
  test('self running-runs --json은 한 줄과 끝 개행을 보존하고 늦은 파이프 소비자에도 같은 바이트를 낸다', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-running-runs-small-'));
    const args = ['self', 'running-runs', '--json'];
    const env = { ELANOUS_STATE_DIR: stateDir };
    try {
      const piped = await runBinWithDelayedStdout(args, env);
      const redirected = await runBin(args, env);
      expect(piped.status).toBe(0);
      expect(piped.stderr).toBe('');
      expect(redirected.status).toBe(0);
      expect(redirected.stderr).toBe('');
      expect(redirected.stdout.endsWith('\n')).toBe(true);
      expect(redirected.stdout.split('\n')).toHaveLength(2);
      expect(piped.bytes).toBe(Buffer.byteLength(redirected.stdout));
      expect(piped.validJson).toBe(true);
      JSON.parse(redirected.stdout);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, CONCURRENT_TEST_TIMEOUT_MS);
});
