import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { runCapabilityCheck, runLoadBalance, registerLaunchHeadCommands } from './launch-head-cli.js';

function ioFor(files: Record<string, string>, env: Record<string, string> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      readFile: (path: string) => {
        if (!(path in files)) {
          const error = new Error(`ENOENT: no such file, open '${path}'`) as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return files[path]!;
      },
      env,
      log: (line: string) => { logs.push(line); },
      error: (line: string) => { errors.push(line); },
    },
  };
}

test('ELANOUS_GRAPH_CONTEXT 의 input.goal_path 로 부르면 마지막 줄 JSON outcome 이 판정과 같고 rc 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-head-ctx-'));
  const goalPath = join(dir, 'goal.md');
  const contextPath = join(dir, 'context.json');
  const goalText = '대상 경로: apps/ios/Elanous/App.swift\n\niOS.\n';
  const captured = ioFor(
    {
      [goalPath]: goalText,
      [contextPath]: JSON.stringify({ input: { goal_path: goalPath }, outputs: {} }),
    },
    { ELANOUS_GRAPH_CONTEXT: contextPath },
  );
  const outcome = runCapabilityCheck([], captured.io);
  expect(outcome.code).toBe(0);
  expect(captured.logs.length).toBeGreaterThanOrEqual(2);
  const last = JSON.parse(captured.logs.at(-1)!);
  expect(last.outcome).toBe('local-only');
  expect(last.outcome).toBe(outcome.result?.outcome);
  expect(last.required).toContain('xcode');
  expect(Array.isArray(last.reasons)).toBe(true);
  expect(captured.logs[0]?.startsWith('capability:')).toBe(true);
});

test('없는 골 경로는 rc 2 이고 any 를 내지 않는다', () => {
  const missing = join(tmpdir(), 'launch-head-missing', 'no-such-goal.md');
  const captured = ioFor({});
  const outcome = runCapabilityCheck(['--goal', missing], captured.io);
  expect(outcome.code).toBe(2);
  expect(outcome.result).toBeUndefined();
  expect(captured.logs.join('\n')).not.toContain('"outcome"');
  expect(captured.logs.join('\n')).not.toContain('any');
  expect(captured.errors.join('\n')).toContain('골 파일을 못 읽음');
});

test('--goal 이 없고 컨텍스트도 없으면 rc 2 이고 any 를 내지 않는다', () => {
  const captured = ioFor({}, {});
  const outcome = runCapabilityCheck([], captured.io);
  expect(outcome.code).toBe(2);
  expect(outcome.result).toBeUndefined();
  expect(captured.logs).toEqual([]);
  expect(captured.errors.join('\n')).toContain('ELANOUS_GRAPH_CONTEXT');
});

test('컨텍스트에 goal_path 가 없으면 rc 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-head-nopath-'));
  const contextPath = join(dir, 'context.json');
  writeFileSync(contextPath, JSON.stringify({ input: {} }));
  const captured = ioFor({ [contextPath]: '{"input":{}}' }, { ELANOUS_GRAPH_CONTEXT: contextPath });
  const outcome = runCapabilityCheck([], captured.io);
  expect(outcome.code).toBe(2);
  expect(captured.errors.join('\n')).toContain('input.goal_path');
  expect(captured.logs).toEqual([]);
});

test('graphs/launch/recipes.yaml 에 capability-check · load-balance · budget-gate 명령이 있고 place 는 없다', () => {
  const yaml = readFileSync(new URL('../../graphs/launch/recipes.yaml', import.meta.url), 'utf8');
  expect(yaml).toContain("capability-check:");
  expect(yaml).toContain("command: 'bun \"${ELANOUS_ENTRY:-bin/elanous.mjs}\" launch-head capability'");
  expect(yaml).toContain('load-balance:');
  expect(yaml).toContain('command: \'bun "${ELANOUS_ENTRY:-bin/elanous.mjs}" launch-head balance\'');
  expect(yaml).toContain('budget-gate:');
  expect(yaml).toContain('command: \'bun "${ELANOUS_ENTRY:-bin/elanous.mjs}" harness budget --json\'');
  expect(yaml).not.toContain('place:');
});

const NOW = 1_000_000;
const QUERY = 'a'.repeat(64);
const root = '/isolated-instance';
const contextPath = '/isolated-context.json';
const tokensPath = join(root, 'control', 'tokens.json');

function balanceIo(fetcher: (input: string, init?: RequestInit) => Promise<Response>, required: string[] = []) {
  const captured = ioFor({
    [contextPath]: JSON.stringify({ input: {}, outputs: { capability: { required } } }),
    [tokensPath]: JSON.stringify({ query: QUERY, admin: 'b'.repeat(64), member: 'c'.repeat(64) }),
  }, { ELANOUS_GRAPH_CONTEXT: contextPath, ELANOUS_CONTROL_PORT: '31499' });
  return { ...captured, io: { ...captured.io, instanceRoot: () => root, fetch: fetcher, now: () => NOW } };
}

function row(name: string, load: number, capabilities: string[] = []) {
  return {
    id: name, kind: 'machine', machine: name, name, owner: 'owner',
    attrs: { capabilities, load: { loadAvg: [load], cpuCount: 2, freeMem: 50, totalMem: 100, observedAt: NOW } },
    observedAt: NOW, ttlMs: 600_000, ageMs: 0, expired: false,
  };
}

test('관제부가 응답하지 않으면 rc 0 · 마지막 줄 skipped (발사를 막지 않음)', async () => {
  const captured = balanceIo(async () => { throw new Error('ECONNREFUSED'); });
  const outcome = await runLoadBalance([], captured.io);
  expect(outcome.code).toBe(0);
  expect(JSON.parse(captured.logs.at(-1)!)).toEqual({
    outcome: 'skipped', candidates: [], reasons: ['관제부에 닿지 못함'],
  });
});

test('query 토큰으로 GET /v1/resources?kind=machine · 그래프 required 를 읽어 rankMachines 결과를 마지막 JSON 줄에 낸다', async () => {
  let called = false;
  const captured = balanceIo(async (input, init) => {
    called = true;
    expect(String(input)).toBe('http://127.0.0.1:31499/v1/resources?kind=machine');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${QUERY}`);
    return Response.json({ resources: [row('without', 0), row('with', 0.2, ['xcode'])] });
  }, ['xcode']);
  const outcome = await runLoadBalance(['--json'], captured.io);
  expect(called).toBe(true);
  expect(outcome.code).toBe(0);
  expect(JSON.parse(captured.logs.at(-1)!)).toEqual(outcome.result);
  expect(outcome.result.outcome).toBe('ranked');
  expect(outcome.result.candidates.map((candidate) => candidate.machine)).toEqual(['with']);
  expect(outcome.result.reasons.join(' ')).toContain('without');
});

test('HTTP 401/500 은 접속 실패가 아니라 rc 2 · HTTP 오류로 보고한다', async () => {
  for (const status of [401, 500]) {
    const captured = balanceIo(async () => new Response('error', { status }));
    const outcome = await runLoadBalance([], captured.io);
    expect(outcome.code).toBe(2);
    expect(JSON.parse(captured.logs.at(-1)!)).toEqual({
      outcome: 'skipped', candidates: [], reasons: [`관제부 HTTP 오류: ${status}`],
    });
    expect(captured.errors.join(' ')).toContain(`HTTP 오류: ${status}`);
    expect(captured.logs.at(-1)).not.toContain('관제부에 닿지 못함');
  }
});

test('잘못된 JSON/리소스 응답은 rc 2 · 응답 형식 오류로 보고한다', async () => {
  for (const response of [
    new Response('{', { headers: { 'content-type': 'application/json' } }),
    Response.json({ resources: 'not an array' }),
    Response.json({ resources: [null] }),
  ]) {
    const captured = balanceIo(async () => response);
    const outcome = await runLoadBalance([], captured.io);
    expect(outcome.code).toBe(2);
    expect(JSON.parse(captured.logs.at(-1)!)).toEqual(outcome.result);
    expect(outcome.result.reasons[0]).toContain('관제부 응답 형식 오류');
    expect(captured.errors.join(' ')).toContain('관제부 응답 형식 오류');
    expect(captured.logs.at(-1)).not.toContain('관제부에 닿지 못함');
  }
});

test('본문 수신 중 연결이 끊기면 rc 0 · 마지막 줄 skipped (JSON 오류가 아님)', async () => {
  const captured = balanceIo(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"resources":'));
      controller.error(new Error('connection reset during body'));
    },
  }), { status: 200 }));
  const outcome = await runLoadBalance([], captured.io);
  expect(outcome.code).toBe(0);
  expect(JSON.parse(captured.logs.at(-1)!)).toEqual({
    outcome: 'skipped', candidates: [], reasons: ['관제부에 닿지 못함'],
  });
});

test('응답 헤더 뒤 본문 수신이 끝나지 않아 타임아웃되면 rc 0 · skipped', async () => {
  const captured = balanceIo(async (_input, init) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"resources":'));
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    });
    return new Response(body, { status: 200 });
  });
  const outcome = await runLoadBalance([], captured.io);
  expect(outcome.code).toBe(0);
  expect(JSON.parse(captured.logs.at(-1)!)).toEqual({
    outcome: 'skipped', candidates: [], reasons: ['관제부에 닿지 못함'],
  });
  expect(captured.logs.at(-1)).not.toContain('JSON 파싱 실패');
}, 10_000);

test('rankMachines 판정 예외는 rc 2 · 순위 판정 오류로 보고한다', async () => {
  const captured = balanceIo(async () => Response.json({ resources: [row('healthy', 1), row('other', 1)] }));
  captured.io.now = () => { throw new Error('clock broken'); };
  const outcome = await runLoadBalance([], captured.io);
  expect(outcome.code).toBe(2);
  expect(JSON.parse(captured.logs.at(-1)!)).toEqual(outcome.result);
  expect(outcome.result.reasons).toEqual(['기계 순위 판정 오류: clock broken']);
  expect(captured.errors.join(' ')).toContain('기계 순위 판정 오류');
});

test('CLI dispatcher 는 balance [--json] 명령을 실제 등록한다', () => {
  const commands: string[] = [];
  const options: string[] = [];
  const subcommand = {
    description() { return this; },
    option(flag: string) { options.push(flag); return this; },
    action() { return this; },
  };
  const launchHead = {
    description() { return this; },
    command(name: string) { commands.push(name); return subcommand; },
  };
  const program = { command(name: string) { expect(name).toBe('launch-head'); return launchHead; } };
  registerLaunchHeadCommands(program as unknown as Command);
  expect(commands).toContain('balance');
  expect(options).toContain('--json');
});

const cliEntry = resolve(import.meta.dir, '../../bin/elanous.mjs');
const cliCwd = resolve(import.meta.dir, '../..');

async function balanceCommand(instanceRoot: string, contextPath: string, port: number, json = false) {
  const child = Bun.spawn(['bun', cliEntry, `--test=${instanceRoot}`, 'launch-head', 'balance', ...(json ? ['--json'] : [])], {
    cwd: cliCwd,
    env: { ...process.env, ELANOUS_GRAPH_CONTEXT: contextPath, ELANOUS_CONTROL_PORT: String(port) },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr, last: JSON.parse(stdout.trim().split('\n').at(-1)!) };
}

function balanceFixture(context: unknown = { outputs: { capability: { required: ['xcode'] } } }) {
  const dir = mkdtempSync(join(tmpdir(), 'launch-head-balance-cli-'));
  const contextFile = join(dir, 'graph-context.json');
  mkdirSync(join(dir, 'control'));
  writeFileSync(contextFile, JSON.stringify(context));
  writeFileSync(join(dir, 'control', 'tokens.json'), JSON.stringify({ query: QUERY }));
  return { dir, contextFile };
}

test('실제 launch-head balance 는 닫힌 관제 포트에서 rc 0 · 마지막 JSON 줄 skipped', async () => {
  const fixture = balanceFixture();
  const reserved = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = reserved.port;
  reserved.stop(true);
  try {
    const result = await balanceCommand(fixture.dir, fixture.contextFile, port!);
    expect(result.code).toBe(0);
    expect(result.last).toEqual({ outcome: 'skipped', candidates: [], reasons: ['관제부에 닿지 못함'] });
    expect(result.stdout.trim().split('\n').at(-1)).toBe(JSON.stringify(result.last));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}, 20_000);

test('실제 launch-head balance --json 은 가짜 관제부에 query 토큰을 보내고 문맥의 required 로 후보를 제한한다', async () => {
  const fixture = balanceFixture();
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests++;
    expect(new URL(request.url).pathname + new URL(request.url).search).toBe('/v1/resources?kind=machine');
    expect(request.headers.get('authorization')).toBe(`Bearer ${QUERY}`);
    return Response.json({ resources: [
      row('without', 0), row('with', 0.2, ['xcode']),
    ].map((machine) => ({ ...machine, observedAt: Date.now(), attrs: {
      ...machine.attrs, load: { ...machine.attrs.load, observedAt: Date.now() },
    } })) });
  } });
  try {
    const result = await balanceCommand(fixture.dir, fixture.contextFile, server.port!, true);
    expect(result.code).toBe(0);
    expect(result.last.outcome).toBe('ranked');
    expect(result.last.candidates.map((candidate: { machine: string }) => candidate.machine)).toEqual(['with']);
    expect(result.last.reasons.join(' ')).toContain('without');
    expect(result.stdout.trim().split('\n').at(-1)).toBe(JSON.stringify(result.last));
    expect(requests).toBe(1);
  } finally {
    server.stop(true);
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}, 20_000);

test('실제 CLI 는 관제부 HTTP 오류와 잘못된 응답을 rc 2 · 마지막 JSON 오류 이유로 낸다', async () => {
  const fixture = balanceFixture();
  let response = new Response('unauthorized', { status: 401 });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => response.clone() });
  try {
    for (const [next, reason] of [
      [new Response('unauthorized', { status: 401 }), '관제부 HTTP 오류: 401'],
      [new Response('server error', { status: 500 }), '관제부 HTTP 오류: 500'],
      [Response.json({ resources: 'bad' }), '관제부 응답 형식 오류: resources'],
    ] as const) {
      response = next;
      const result = await balanceCommand(fixture.dir, fixture.contextFile, server.port!);
      expect(result.code).toBe(2);
      expect(result.last).toEqual({ outcome: 'skipped', candidates: [], reasons: [reason] });
      expect(result.stdout.trim().split('\n').at(-1)).toBe(JSON.stringify(result.last));
      expect(result.stderr).toContain(reason);
    }
  } finally {
    server.stop(true);
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}, 20_000);

test('그래프 outputs.capability.required 가 빠지거나 형식이 틀리면 후보를 확정하지 않고 관제 장애와 구분한다', async () => {
  for (const context of [{ outputs: {} }, { outputs: { capability: { required: [3] } } }]) {
    const fixture = balanceFixture(context);
    let requests = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      requests++;
      return Response.json({ resources: [row('without', 0), row('with', 0.2, ['xcode'])] });
    } });
    try {
      const result = await balanceCommand(fixture.dir, fixture.contextFile, server.port!);
      expect(result.code).toBe(2);
      expect(result.last.outcome).toBe('skipped');
      expect(result.last.candidates).toEqual([]);
      expect(result.last.reasons[0]).toContain('그래프 문맥 오류');
      expect(result.last.reasons[0]).not.toContain('관제부에 닿지 못함');
      expect(result.stderr).toContain('그래프 문맥 오류');
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
}, 20_000);
