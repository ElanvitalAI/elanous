import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemotesStore } from './remotes.js';
import { parseAutopilotPath } from '../nexus/api/autopilot-api.js';
import {
  REMOTE_OPS_ARMING_PATH,
  REMOTE_OPS_HEALTH_UNAVAILABLE,
  REMOTE_OPS_LOOPS_UNAVAILABLE,
  REMOTE_OPS_MISSIONS_PATH,
  REMOTE_OPS_TASKS_PATH,
  resolveOpsStatusRemoteFlag,
  runOpsStatusRemote,
} from './ops-status-remote.js';
import { readRemoteFlag } from './remote-resolve.js';
import { TaskStore } from '../task-orchestrator/store.js';
import { createMission } from '../task-orchestrator/mission.js';
import { createTask } from '../task-orchestrator/types.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = resolve(REPO_ROOT, 'bin/elanous.mjs');
const SPAWN_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeBookmark(cfg: string, name: string, port: string, token: string, setDefault = true): void {
  mkdirSync(join(cfg, 'remotes'), { recursive: true });
  writeFileSync(join(cfg, 'remotes', `${name}.token`), token);
  writeFileSync(join(cfg, 'remotes.json'), JSON.stringify({
    version: 1,
    ...(setDefault ? { default: name } : {}),
    remotes: {
      [name]: {
        host: `127.0.0.1:${port}`,
        acp_url: `ws://127.0.0.1:${port}/v1/acp`,
        token_file: join(cfg, 'remotes', `${name}.token`),
        addedAt: '2026-09-01T00:00:00Z',
      },
    },
  }));
}

function seedRealOpsStore(tasksDir: string): { missionTotal: number; taskTotal: number } {
  mkdirSync(tasksDir, { recursive: true });
  const prev = process.env.ELANOUS_TASKS_DIR;
  process.env.ELANOUS_TASKS_DIR = tasksDir;
  const store = new TaskStore();
  try {
    store.saveMission(createMission({ title: 'Remote ops alpha', source: { kind: 'manual' } }));
    store.saveMission(createMission({ title: 'Remote ops beta', source: { kind: 'manual' } }));
    for (let i = 0; i < 5; i += 1) {
      store.saveTask(createTask({
        title: `Remote ops task ${i}`,
        surface: { kind: 'llm-direct', prompt: `seed ${i}` },
      }));
    }
    return { missionTotal: 2, taskTotal: 5 };
  } finally {
    store.close();
    if (prev === undefined) delete process.env.ELANOUS_TASKS_DIR;
    else process.env.ELANOUS_TASKS_DIR = prev;
  }
}

async function independentOpsCounts(origin: string, token: string): Promise<{
  missionTotal: number;
  taskTotal: number;
}> {
  const missionsRes = await fetch(`${origin}${REMOTE_OPS_MISSIONS_PATH}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const tasksRes = await fetch(`${origin}${REMOTE_OPS_TASKS_PATH}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!missionsRes.ok) throw new Error(`independent GET ${REMOTE_OPS_MISSIONS_PATH} HTTP ${missionsRes.status}`);
  if (!tasksRes.ok) throw new Error(`independent GET ${REMOTE_OPS_TASKS_PATH} HTTP ${tasksRes.status}`);
  const missions = await missionsRes.json() as { total?: unknown };
  const tasks = await tasksRes.json() as { summary?: { total?: unknown } };
  if (typeof missions.total !== 'number') throw new Error('independent GET /v1/missions missing total');
  if (typeof tasks.summary?.total !== 'number') throw new Error('independent GET /v1/tasks missing summary.total');
  return { missionTotal: missions.total, taskTotal: tasks.summary.total };
}

/**
 * ⛔⭐ **이름이 약속하는 것을 좁힌다** — 이것은 ***실제 데몬(`nexus run`)이 «아니다»***.
 * `startNexusHttpServer` 를 «별도 프로세스»에서 조립해 띄우는 HTTP API 하니스다.
 *
 * ✅ 이것이 답하는 것: CLI 가 «별도 프로세스의 HTTP» 와 말하는가 · 어떤 method/path 를 보내는가
 * ⛔ 이것이 «못» 답하는 것: 실제 데몬의 부팅·인증·미들웨어 구성이 그렇게 도는가
 *    ⇒ 그 축은 라이브의 몫이다(실측 2026-09-01: 원격에서 미션 11·태스크 76 이 데몬 직접 조회와 일치).
 * 📏 실제 데몬을 여기서 띄우려 «두 번» 시도했고 둘 다 구조로 막혔다:
 *    ⑴ `nexus run` 격리 기동 ⇒ 45초 내 미응답(대화형 셋업 마법사 의존)
 *    ⑵ `runNexus({ detachForTesting: true })` ⇒ 그 파일이 적어 둔 대로 httpServer 가 undefined
 */
async function startOutOfProcessHttpApi(opts: {
  home: string;
  token: string;
  tasksDir: string;
  stateDir: string;
}): Promise<{ port: string; origin: string; stop(): void }> {
  const portFile = join(opts.home, 'nexus-port');
  const serverTs = join(opts.home, 'nexus-server.ts');
  const startPort = 41000 + Math.floor(Math.random() * 8000);
  writeFileSync(serverTs, `
    import { appendFileSync, writeFileSync } from 'node:fs';
    process.env.ELANOUS_TASKS_DIR = ${JSON.stringify(opts.tasksDir)};
    process.env.ELANOUS_STATE_DIR = ${JSON.stringify(opts.stateDir)};
    process.env.ELANOUS_CONFIG_DIR = ${JSON.stringify(opts.stateDir)};
    process.env.ELANOUS_DEBUG_LEVEL = 'off';
    const { startNexusHttpServer } = await import(${JSON.stringify(join(REPO_ROOT, 'src/nexus/api/http-server.ts'))});
    const { createNexusState } = await import(${JSON.stringify(join(REPO_ROOT, 'src/nexus/state/state.ts'))});
    const { TabRegistry } = await import(${JSON.stringify(join(REPO_ROOT, 'src/nexus/state/tab-registry.ts'))});
    const { NexusEventBus } = await import(${JSON.stringify(join(REPO_ROOT, 'src/nexus/api/event-bus.ts'))});
    const bus = new NexusEventBus();
    const state = createNexusState({ nexusVersion: '0.17.0', phase: 'ops-status-remote' });
    state.bus = bus;
    const registry = new TabRegistry(state);
    const srv = startNexusHttpServer({
      state,
      registry,
      eventBus: bus,
      startPort: ${startPort},
      portRange: 16,
      hostname: '127.0.0.1',
      metaApi: { bearerToken: ${JSON.stringify(opts.token)} },
    });
    // ⭐ 실제 «요청 메서드·경로»를 기록한다 — stdout 문면만 보면 「GET 이었나」를 못 판정한다.
    //    서버는 그대로 두고 앞에 «기록 프록시»를 한 겹 둔다(리뷰 should-fix 반영).
    const requestLog = ${JSON.stringify(join(opts.home, 'requests.jsonl'))};
    Bun.serve({
      port: ${startPort + 500},
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const u = new URL(req.url);
        appendFileSync(requestLog, JSON.stringify({ method: req.method, path: u.pathname }) + String.fromCharCode(10));
        return fetch('http://127.0.0.1:' + srv.port + u.pathname + u.search, {
          method: req.method,
          headers: req.headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
        });
      },
    });
    writeFileSync(${JSON.stringify(portFile)}, String(${startPort + 500}));
  `);
  const stderrChunks: string[] = [];
  const child = spawn(process.execPath, [serverTs], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELANOUS_TASKS_DIR: opts.tasksDir,
      ELANOUS_STATE_DIR: opts.stateDir,
      ELANOUS_CONFIG_DIR: opts.stateDir,
      ELANOUS_DEBUG_LEVEL: 'off',
    },
  });
  children.push(child);
  child.stderr?.on('data', (chunk) => { stderrChunks.push(String(chunk)); });
  const deadline = Date.now() + 30_000;
  while (!existsSync(portFile) && Date.now() < deadline) await Bun.sleep(50);
  if (!existsSync(portFile)) {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    throw new Error(`out-of-process HTTP API never reported a port: ${stderrChunks.join('')}`);
  }
  const port = readFileSync(portFile, 'utf8').trim();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    stop: () => { try { child.kill('SIGKILL'); } catch { /* already dead */ } },
  };
}

function spawnOpsStatus(cfg: string, home: string, extraArgs: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [BIN, '--test', '--config-dir', cfg, 'ops', 'status', ...extraArgs], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ELANOUS_DEBUG_LEVEL: 'off',
      HOME: home,
      ELANOUS_STATE_DIR: cfg,
      ELANOUS_CONFIG_DIR: cfg,
    },
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
}

describe('resolveOpsStatusRemoteFlag uses readRemoteFlag', () => {
  test('command-local -r / --remote is parsed by readRemoteFlag, not a private parser', () => {
    expect(resolveOpsStatusRemoteFlag({ args: ['ops', 'status', '-r'] })).toEqual(readRemoteFlag(['-r']));
    expect(resolveOpsStatusRemoteFlag({ args: ['ops', 'status', '--remote', 'mbp'] })).toEqual(readRemoteFlag(['--remote', 'mbp']));
    expect(resolveOpsStatusRemoteFlag({ args: ['ops', 'status'] })).toEqual({ present: false, value: '' });
    expect(resolveOpsStatusRemoteFlag({ remote: true })).toEqual(readRemoteFlag(['-r']));
    expect(resolveOpsStatusRemoteFlag({ remote: 'iso' })).toEqual(readRemoteFlag(['--remote', 'iso']));
  });
});

describe('runOpsStatusRemote classification/message', () => {
  test('missing default bookmark returns remote-error and names the missing bookmark', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ops-status-class-'));
    dirs.push(home);
    const cfg = join(home, '.elanous');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'remotes.json'), JSON.stringify({ version: 1, remotes: {} }));
    const errors: string[] = [];
    const result = await runOpsStatusRemote({
      args: ['ops', 'status', '-r'],
      remotesStore: () => new RemotesStore({ remotesFilePath: join(cfg, 'remotes.json'), tokensDir: join(cfg, 'remotes') }),
      out: { log: () => {}, error: (line) => errors.push(line) },
    });
    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe('remote-error');
    expect(result.message).toContain('no default remote bookmark');
    expect(result.message).toContain('elanous nexus connect');
    expect(errors.join('\n')).toContain('no default remote bookmark');
  });
});

describe('bin/elanous.mjs ops status -r', () => {
  test('진입점 spawn: out-of-process HTTP API GET /v1/missions and /v1/tasks counts match ops status -r stdout, with route provenance and unavailable loops/health', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ops-status-live-r-'));
    dirs.push(home);
    const tasksDir = join(home, 'tasks');
    const stateDir = join(home, 'nexus-state');
    const cfg = join(home, '.elanous');
    mkdirSync(stateDir, { recursive: true });
    seedRealOpsStore(tasksDir);
    const token = 'remote-token';
    let server: Awaited<ReturnType<typeof startOutOfProcessHttpApi>> | undefined;
    try {
      server = await startOutOfProcessHttpApi({ home, token, tasksDir, stateDir });
      const independent = await independentOpsCounts(server.origin, token);
      expect(independent.missionTotal).toBe(2);
      expect(independent.taskTotal).toBe(5);
      writeBookmark(cfg, 'mbp', server.port, token);
      const res = spawnOpsStatus(cfg, home, ['-r']);
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      expect(res.status).toBe(0);
      expect(out).toContain(`${independent.missionTotal}건`);
      expect(out).toContain(`${independent.taskTotal}건`);
      expect(out).toContain(`GET ${REMOTE_OPS_MISSIONS_PATH}`);
      expect(out).toContain(`GET ${REMOTE_OPS_TASKS_PATH}`);
      expect(out).toContain(`GET ${REMOTE_OPS_ARMING_PATH}`);
      expect(out).toContain(REMOTE_OPS_LOOPS_UNAVAILABLE);
      expect(out).toContain(REMOTE_OPS_HEALTH_UNAVAILABLE);
      expect(out).not.toContain('nexusVersion');
      expect(out).not.toMatch(/루프\s+0개/);
      expect(out).not.toMatch(/건강\s+정상/);
      expect(out).not.toMatch(/\bPOST\b/);
    } finally {
      server?.stop();
    }
  }, SPAWN_TIMEOUT_MS);

  test('진입점 spawn: repeating ops status -r without restarting NEXUS yields the same mission/task counts as independent GET', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ops-status-live-repeat-'));
    dirs.push(home);
    const tasksDir = join(home, 'tasks');
    const stateDir = join(home, 'nexus-state');
    const cfg = join(home, '.elanous');
    mkdirSync(stateDir, { recursive: true });
    seedRealOpsStore(tasksDir);
    const token = 'remote-token';
    let server: Awaited<ReturnType<typeof startOutOfProcessHttpApi>> | undefined;
    try {
      server = await startOutOfProcessHttpApi({ home, token, tasksDir, stateDir });
      writeBookmark(cfg, 'mbp', server.port, token);
      const independent = await independentOpsCounts(server.origin, token);
      const first = spawnOpsStatus(cfg, home, ['-r']);
      const second = spawnOpsStatus(cfg, home, ['-r']);
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.stdout).toContain(`${independent.missionTotal}건`);
      expect(first.stdout).toContain(`${independent.taskTotal}건`);
      expect(second.stdout).toContain(`${independent.missionTotal}건`);
      expect(second.stdout).toContain(`${independent.taskTotal}건`);
      expect(first.stdout).toBe(second.stdout);
      const after = await independentOpsCounts(server.origin, token);
      expect(after).toEqual(independent);
    } finally {
      server?.stop();
    }
  }, SPAWN_TIMEOUT_MS);

  test('진입점 spawn: missing default bookmark exits 1 and names the missing bookmark', () => {
    const home = mkdtempSync(join(tmpdir(), 'ops-status-no-bookmark-'));
    dirs.push(home);
    const cfg = join(home, '.elanous');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'remotes.json'), JSON.stringify({ version: 1, remotes: {} }));
    const res = spawnOpsStatus(cfg, home, ['-r']);
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(res.status).toBe(1);
    expect(out).toMatch(/bookmark|북마크/);
    expect(out).toContain('no default remote bookmark');
    expect(out).toContain('elanous nexus connect');
  });

  test('진입점 spawn: unknown named bookmark exits 1 and names the bookmark', () => {
    const home = mkdtempSync(join(tmpdir(), 'ops-status-ghost-'));
    dirs.push(home);
    const cfg = join(home, '.elanous');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'remotes.json'), JSON.stringify({ version: 1, remotes: {} }));
    const res = spawnOpsStatus(cfg, home, ['--remote', 'ghost']);
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(res.status).toBe(1);
    expect(out).toContain('ghost');
    expect(out).toContain('unknown bookmark');
  });

  test('진입점 spawn: without -r the remote is not queried and local ops status still prints', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ops-status-no-r-'));
    dirs.push(home);
    const tasksDir = join(home, 'tasks');
    const stateDir = join(home, 'nexus-state');
    const cfg = join(home, '.elanous');
    mkdirSync(stateDir, { recursive: true });
    seedRealOpsStore(tasksDir);
    const token = 'remote-token';
    let server: Awaited<ReturnType<typeof startOutOfProcessHttpApi>> | undefined;
    try {
      server = await startOutOfProcessHttpApi({ home, token, tasksDir, stateDir });
      writeBookmark(cfg, 'mbp', server.port, token);
      const res = spawnOpsStatus(cfg, home, []);
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      expect(res.status).toBe(0);
      expect(out).toContain('운영 상태 스냅샷');
      expect(out).not.toContain('Remote ops alpha');
      expect(out).not.toContain(`GET ${REMOTE_OPS_MISSIONS_PATH}`);
      expect(out).not.toContain(REMOTE_OPS_LOOPS_UNAVAILABLE);
    } finally {
      server?.stop();
    }
  }, SPAWN_TIMEOUT_MS);

  test('진입점 spawn: GET-only — independent NEXUS counts stay unchanged and stdout names only GET routes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ops-status-get-only-'));
    dirs.push(home);
    const tasksDir = join(home, 'tasks');
    const stateDir = join(home, 'nexus-state');
    const cfg = join(home, '.elanous');
    mkdirSync(stateDir, { recursive: true });
    seedRealOpsStore(tasksDir);
    const token = 'tok';
    let server: Awaited<ReturnType<typeof startOutOfProcessHttpApi>> | undefined;
    try {
      server = await startOutOfProcessHttpApi({ home, token, tasksDir, stateDir });
      writeBookmark(cfg, 'box', server.port, token);
      const before = await independentOpsCounts(server.origin, token);
      // ⭐ CLI 를 치기 «직전» 오프셋 — 이 시험 자신의 GET 과 CLI 의 GET 을 가르는 유일한 자다.
      const logOffsetBeforeCli = readFileSync(join(home, 'requests.jsonl'), 'utf8')
        .split(String.fromCharCode(10)).filter(Boolean).length;
      const res = spawnOpsStatus(cfg, home, ['-r']);
      expect(res.status).toBe(0);
      const out = `${res.stdout ?? ''}`;
      expect(out).toContain(`GET ${REMOTE_OPS_MISSIONS_PATH}`);
      expect(out).toContain(`GET ${REMOTE_OPS_TASKS_PATH}`);
      expect(out).toContain(`GET ${REMOTE_OPS_ARMING_PATH}`);
      expect(out).not.toMatch(/\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b/);
      // ⭐ CLI 가 «끝난 직후» 오프셋 — 뒤에 오는 independentOpsCounts(after) 를 슬라이스에서 끊는다.
      const logOffsetAfterCli = readFileSync(join(home, 'requests.jsonl'), 'utf8')
        .split(String.fromCharCode(10)).filter(Boolean).length;
      const after = await independentOpsCounts(server.origin, token);
      expect(after).toEqual(before);
      expect(out).toContain(`${before.missionTotal}건`);
      expect(out).toContain(`${before.taskTotal}건`);

      // ⭐ stdout 문면이 아니라 ***서버가 «실제로 받은» 요청***으로 판정한다.
      //    ⛔ 「포함되어 있나」로 세면 안 된다 — 이 시험 자신의 independentOpsCounts() GET 이 앞뒤로 섞인다.
      //    ✅ CLI 를 «치기 직전»의 오프셋부터 세어, 그 구간이 ***정확히 그 셋***인지 본다.
      const readLog = (): Array<{ method: string; path: string }> =>
        readFileSync(join(home, 'requests.jsonl'), 'utf8')
          .split(String.fromCharCode(10)).filter(Boolean)
          .map((l) => JSON.parse(l) as { method: string; path: string });
      const cliSlice = readLog().slice(logOffsetBeforeCli, logOffsetAfterCli);
      expect(cliSlice.every((r) => r.method === 'GET')).toBe(true);
      expect(cliSlice.map((r) => r.path).sort()).toEqual(
        [REMOTE_OPS_MISSIONS_PATH, REMOTE_OPS_TASKS_PATH, REMOTE_OPS_ARMING_PATH].sort(),
      );
    } finally {
      server?.stop();
    }
  }, SPAWN_TIMEOUT_MS);

  test('진입점 spawn: failed GET names the first failed path in the diagnostic', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ops-status-path-diag-'));
    dirs.push(home);
    const tasksDir = join(home, 'tasks');
    const stateDir = join(home, 'nexus-state');
    const cfg = join(home, '.elanous');
    mkdirSync(stateDir, { recursive: true });
    seedRealOpsStore(tasksDir);
    const token = 'remote-token';
    let server: Awaited<ReturnType<typeof startOutOfProcessHttpApi>> | undefined;
    try {
      server = await startOutOfProcessHttpApi({ home, token, tasksDir, stateDir });
      writeBookmark(cfg, 'mbp', server.port, 'wrong-token');
      const res = spawnOpsStatus(cfg, home, ['-r']);
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      expect(res.status).toBe(1);
      expect(out).toContain(`GET ${REMOTE_OPS_MISSIONS_PATH}`);
      expect(out).toMatch(/HTTP 401/);
    } finally {
      server?.stop();
    }
  }, SPAWN_TIMEOUT_MS);
});

/**
 * ⛔⭐ 이 파일의 다른 시험들이 «못 보는 것»을 여기서 말한다.
 *
 * `startOutOfProcessHttpApi` 는 «별도 프로세스»를 띄우지만 그것은 ***테스트가 조립한 부트스트랩***이지
 * 실제 데몬 진입점(`nexus run`)이 아니다. 그래서 그 시험들은 ***「내 클라이언트가 «내가 세운» 서버와 말한다」***
 * 까지만 증명하고, ***「진짜 데몬이 그 경로를 «실제로» 제공한다」는 못 증명한다.***
 *
 * 그 구멍 중 «값싸게 닫히는 절반»이 ***경로 드리프트***다 — 서버가 `/v1/missions` 를 다른 이름으로 바꾸면
 * 위 시험들은 «여전히 통과»한다(테스트 서버가 옛 이름을 계속 제공하므로). 아래가 그것을 문다.
 *
 * ⚠️ 나머지 절반(데몬의 «구성»·인증·미들웨어가 실제로 그렇게 도는가)은 이 시험이 «못 답한다».
 *    그 축은 라이브 검증의 몫이다 — 실측 2026-09-01: 원격에서 미션 11건·태스크 76건이
 *    데몬 직접 조회와 «일치»했다(grokb1 x86_64 → Mac 데몬).
 */
describe('ops status -r 이 부르는 경로는 «진짜» NEXUS 서버에 실재한다', () => {
  test('리터럴로 매칭되는 둘이 http-server 의 핸들러에 «그대로» 있다', () => {
    const serverSource = readFileSync(join(REPO_ROOT, 'src/nexus/api/http-server.ts'), 'utf8');
    for (const path of [REMOTE_OPS_MISSIONS_PATH, REMOTE_OPS_TASKS_PATH]) {
      expect(serverSource).toContain(`'${path}'`);
    }
  });

  // ⛔ arming 은 «리터럴이 아니다» — http-server 가 parseAutopilotPath 로 «접두 디스패치»한다.
  //    그래서 소스 문자열로 찾으면 «오탐»이 난다(내가 그 함정을 한 번 밟았다).
  //    ✅ 실제 디스패처를 «불러서» 판정한다.
  test('arming 은 진짜 디스패처(parseAutopilotPath)가 «인식»한다', () => {
    expect(parseAutopilotPath(REMOTE_OPS_ARMING_PATH)).toBe('arming');
  });
});
