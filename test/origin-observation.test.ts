import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log.js';
import { originObservationFields } from '../src/agent/origin-observation.js';
import { establishExecutionOrigin, identityEnv } from '../src/agent/identity-env.js';
import { observeNestAtBoot, resetNestBootObservationForTest } from '../src/agent/nest-depth.js';
import { buildHarnessSeams } from '../src/harness/harness-seams.js';
import { runSelfImplement, type SelfImplementSeams } from '../src/self-implement/orchestrator.js';

const originEnvKeys = ['ELANOUS_ORIGIN_ROOT', 'ELANOUS_ORIGIN_AGENT', 'ELANOUS_ORIGIN_SESSION', 'ELANOUS_CONTROLLER', 'ELANOUS_NEST_DEPTH', 'AI_AGENT', 'CLAUDE_CODE_SESSION_ID'] as const;
const savedEnv = Object.fromEntries(originEnvKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of originEnvKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetNestBootObservationForTest();
});

function setOriginEnv(): void {
  process.env.ELANOUS_ORIGIN_ROOT = 'external-agent';
  process.env.ELANOUS_ORIGIN_AGENT = 'codex';
  process.env.ELANOUS_ORIGIN_SESSION = 'session-origin-observation';
  process.env.ELANOUS_CONTROLLER = 'parent-elanous';
}

function okSeams(): SelfImplementSeams {
  return {
    // ⛔⭐⭐⭐ 기본을 «무동작»으로 — 안 채우면 실제 계정 스토어를 읽고 codex 자식을 띄우고
    //   ~/.elanous/budget 에 쓴다(= 테스트가 «운영 쿼터를 소모»한다 · 리뷰 must-fix).
    refreshCodexQuotaSignals: async () => ({ accounts: [] }),
    createWorktree: async ({ branch, base }) => ({ path: `/tmp/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
    implement: async () => ({ ok: true, summary: 'ok' }),
    gate: async () => ({ passed: true }),
    openPr: async () => ({ url: 'https://example.test/pr/1', number: 1 }),
    approvePr: async () => true,
  };
}

describe('origin observation fields', () => {
  // ⛔⭐ 종전엔 *"네 파일이 `origin-observation.js` 문자열을 포함하나"* 를 봤다 — **쓰지 않는 import 도
  //    통과**하므로 Goodhart 다(리뷰 1R). ⇒ 지웠다. **실제 payload 를 보는 통합 단언**이 아래에 있고
  //    그것이 배선을 증명한다. *"참조가 있다"* 와 *"값이 실린다"* 는 다른 명제다.

  // ⛔⭐ 무정규화 계약을 고정한다(리뷰 1R) — `presentEnv` 는 **부재 판정에만** trim 을 쓰고
  //    **값은 그대로 나른다.** 정규화하지 않는 이유: origin 값의 뜻은 `[S]` 진입점이 정하고
  //    이 심은 **읽어서 싣기만** 한다. 여기서 다듬으면 두 층이 같은 값을 다르게 본다.
  //    ⚠️ 따라서 `' external-agent '` 는 **공백째** 실린다 — 그것이 이상하면 고칠 자리는 **세팅 쪽**이다.
  test('공백만 있으면 부재로 보되, 값의 앞뒤 공백은 다듬지 않는다(무정규화 계약)', () => {
    for (const key of originEnvKeys) delete process.env[key];
    process.env.ELANOUS_ORIGIN_ROOT = ' external-agent ';
    process.env.ELANOUS_ORIGIN_AGENT = '  ';
    const payload = originObservationFields();
    expect(payload.originRoot).toBe(' external-agent ');   // ⛔ trim 하지 않는다
    expect(payload.originAgent).toBeUndefined();           // 공백만 = 필드 생략
  });

  test('blank origin values omit every field and guess no value', () => {
    for (const key of originEnvKeys) delete process.env[key];
    process.env.ELANOUS_ORIGIN_ROOT = '';
    process.env.ELANOUS_ORIGIN_AGENT = '   ';
    process.env.ELANOUS_ORIGIN_SESSION = '';
    process.env.ELANOUS_CONTROLLER = '\t';

    const payload = originObservationFields();

    expect(payload).toEqual({});
    expect(payload).not.toHaveProperty('originRoot');
    expect(Object.values(payload).filter((value) => typeof value === 'string')).toEqual([]);
  });

  test('forwards only the origin values already supplied by the environment', () => {
    setOriginEnv();
    expect(originObservationFields()).toEqual({
      originRoot: 'external-agent',
      originAgent: 'codex',
      originSession: 'session-origin-observation',
      controller: 'parent-elanous',
    });
  });

  test('AI_AGENT sets the external origin, agent, and supplied session', () => {
    for (const key of originEnvKeys) delete process.env[key];
    process.env.AI_AGENT = 'codex';
    process.env.CLAUDE_CODE_SESSION_ID = 'agent-session';

    expect(establishExecutionOrigin()).toBe('external-agent');
    expect(originObservationFields()).toEqual({
      originRoot: 'external-agent', originAgent: 'codex', originSession: 'agent-session',
    });
  });

  test('uses a non-empty explicit session identifier when the parent did not provide one', () => {
    const env: NodeJS.ProcessEnv = { AI_AGENT: 'codex' };

    expect(establishExecutionOrigin(env, undefined, ' explicit-session ')).toBe('external-agent');
    expect(env.ELANOUS_ORIGIN_SESSION).toBe('explicit-session');
  });

  test('ignores an empty explicit session identifier and preserves a parent origin session', () => {
    const empty: NodeJS.ProcessEnv = { AI_AGENT: 'codex' };
    establishExecutionOrigin(empty, undefined, '   ');
    expect(empty.ELANOUS_ORIGIN_SESSION).toBeUndefined();

    const inherited: NodeJS.ProcessEnv = {
      AI_AGENT: 'codex',
      CLAUDE_CODE_SESSION_ID: 'claude-session',
      ELANOUS_ORIGIN_SESSION: 'parent-session',
    };
    establishExecutionOrigin(inherited, undefined, 'explicit-session');
    expect(inherited.ELANOUS_ORIGIN_SESSION).toBe('parent-session');
  });

  test('missing AI_AGENT sets human-cli without an agent key', () => {
    for (const key of originEnvKeys) delete process.env[key];

    expect(establishExecutionOrigin()).toBe('human-cli');
    expect(originObservationFields()).toEqual({ originRoot: 'human-cli' });
    expect(process.env.ELANOUS_ORIGIN_AGENT).toBeUndefined();
  });

  test('set-once preserves an inherited root despite AI_AGENT', () => {
    for (const key of originEnvKeys) delete process.env[key];
    process.env.ELANOUS_ORIGIN_ROOT = 'elanous-internal';
    process.env.AI_AGENT = 'claude-code';

    expect(establishExecutionOrigin()).toBe('elanous-internal');
    expect(originObservationFields()).toEqual({ originRoot: 'elanous-internal' });
  });

  test('propagates all four origin keys to child PTY environment', () => {
    const env = {
      ELANOUS_ORIGIN_ROOT: 'external-agent',
      ELANOUS_ORIGIN_AGENT: 'codex',
      ELANOUS_ORIGIN_SESSION: 'agent-session',
      ELANOUS_CONTROLLER: 'run-parent',
    };

    expect(identityEnv(env)).toEqual({
      ELANOUS_ORIGIN_ROOT: 'external-agent',
      ELANOUS_ORIGIN_AGENT: 'codex',
      ELANOUS_ORIGIN_SESSION: 'agent-session',
      ELANOUS_CONTROLLER: 'run-parent',
    });
  });

  test('self and dev establish origin before their log sink registration', () => {
    const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
    const selfHook = source.slice(source.indexOf("selfCmd.hook('preAction'"), source.indexOf("selfCmd\n  .command('author"));
    const devStart = source.indexOf(".command('dev [text...]')");
    const devAction = source.slice(devStart, source.indexOf('const input = buildDevCommandInput(pipelineInput)', devStart));

    expect(selfHook.indexOf('establishExecutionOrigin()')).toBeGreaterThanOrEqual(0);
    expect(selfHook.indexOf('establishExecutionOrigin()')).toBeLessThan(selfHook.indexOf('registerStandaloneLogSink(surface)'));
    expect(devAction.indexOf('establishExecutionOrigin()')).toBeGreaterThanOrEqual(0);
    expect(devAction.indexOf('establishExecutionOrigin()')).toBeLessThan(devAction.indexOf('registerStandaloneLogSink(DEV_PIPELINE_SINK_SURFACE)'));
  });

  test('four in-process requested events carry the shared origin snapshot and requested nest depth', async () => {
    setOriginEnv();
    process.env.ELANOUS_NEST_DEPTH = '2';
    const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const log = debug.log;
    debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
      calls.push([category, event, data]);
    }) as typeof debug.log;
    try {
      await runSelfImplement({ feature: 'origin observation', runId: 'origin-run', seams: okSeams() });
      buildHarnessSeams({ seams: okSeams() });
      observeNestAtBoot();
    } finally {
      debug.log = log;
    }

    const origin = {
      originRoot: 'external-agent', originAgent: 'codex', originSession: 'session-origin-observation', controller: 'parent-elanous',
    };
    expect(calls).toContainEqual(['run-identity', 'own', expect.objectContaining({ runId: 'origin-run', nestDepth: 2, ...origin })]);
    expect(calls).toContainEqual(['self-implement', 'start', expect.objectContaining({ runId: 'origin-run', nestDepth: 2, ...origin })]);
    expect(calls).toContainEqual(['run-identity', 'own', expect.objectContaining({ owner: 'harness-seams', nestDepth: 2, ...origin })]);
    expect(calls).toContainEqual(['substrate.nest', 'boot', expect.objectContaining({ depth: 2, ...origin })]);
  });

  test('dev-pipeline plan emits the fifth requested payload from the real isolated CLI boundary', () => {
    const runId = `run-origin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'origin-observation-'));
    const stateDir = join(fixtureRoot, '.elanous-test');
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ llm: { provider: 'local', baseUrl: 'http://127.0.0.1:1' } }));
    try {
      const env = {
        ...process.env,
        NODE_ENV: undefined,
        ELANOUS_STATE_DIR: undefined,
        ELANOUS_CONFIG_DIR: undefined,
        ELANOUS_RUN_ID: runId,
        ELANOUS_ORIGIN_ROOT: 'external-agent',
        ELANOUS_ORIGIN_AGENT: 'codex',
        ELANOUS_ORIGIN_SESSION: 'session-origin-observation',
        ELANOUS_CONTROLLER: 'parent-elanous',
      };
      const cli = join(import.meta.dir, '..', 'bin', 'elanous.mjs');
      const dev = spawnSync('bun', [cli, `--test=${stateDir}`, 'dev', 'origin event test', '--backend', 'codex', '--transport', 'acp'], {
        cwd: fixtureRoot, env, encoding: 'utf8', timeout: 15_000,
      });
      // ACP may wait for a connection after recording the plan; only the observed payload is asserted.
      const logs = spawnSync('bun', [cli, `--test=${stateDir}`, 'logs', '--test', '--exact-category', 'dev-pipeline', '--event', 'plan', '--grep', runId, '--since', '10m', '--json', '--limit', '5'], {
        cwd: fixtureRoot, env, encoding: 'utf8', timeout: 15_000,
      });
      expect(logs.status, `dev: ${dev.stdout}\n${dev.stderr}\nlogs: ${logs.stdout}\n${logs.stderr}`).toBe(0);
      const outputRows = logs.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { _meta?: unknown; data?: unknown });
      const rows = outputRows.filter((row) => row._meta === undefined);
      expect(rows, `dev: ${dev.stdout}\n${dev.stderr}\nlogs: ${logs.stdout}\n${logs.stderr}`).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ data: expect.any(String) }));
      expect(JSON.parse(rows[0]!.data as string)).toEqual(expect.objectContaining({
        runId, dispatch: 'acp', executor: 'external', wired: true, nestDepth: expect.any(Number),
        originRoot: 'external-agent', originAgent: 'codex', originSession: 'session-origin-observation', controller: 'parent-elanous',
      }));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 35_000);
});
