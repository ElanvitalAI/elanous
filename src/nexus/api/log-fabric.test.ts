/**
 * /v1/logs REST 계약 (통합 로그 패브릭 LF1 · 2026-07-13).
 *
 * store 는 :memory: 주입(deps.store) — 실 ~/.elanous 미접촉. 레벨 POST 는
 * setLevel/persistLevel spy 주입으로 전역 debug 싱글톤/실 config 미접촉.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LogStore } from '../../mss/logging/log-store.js';
import type { LogInstanceView } from '../../mss/logging/instance-registry.js';
import type { LogRecord } from '../../mss/logging/record.js';
import {
  handleLogsQuery,
  handleLogsStream,
  handleLogsLevelPost,
  parseSinceParam,
  parseLogQuery,
} from './log-fabric.js';
import type { MetaApiOpts } from './meta-api.js';

const OPTS: MetaApiOpts = { noAuth: true } as MetaApiOpts;

function rec(over: Partial<LogRecord> = {}): LogRecord {
  return { ts: new Date().toISOString(), category: 'voice.stt', event: 'chunk', ...over };
}

function seededStore(): LogStore {
  const store = new LogStore(':memory:');
  // OH10 PR-b2: severity 는 명시 level only(접미사 유도 삭제). 필터/히스토그램
  // 테스트가 error/warn 을 보게 하려면 명시 level 을 seed 에 넣는다.
  store.insertBatch([
    { rec: rec({ category: 'voice.stt.openai', event: 'handshake.error', data: { code: 401 }, level: 'error' }), surface: 'nexus' },
    { rec: rec({ category: 'webterm.tabs', event: 'list.ok' }), surface: 'pwa' },
    { rec: rec({ category: 'telegram.core', event: 'poll.timeout', level: 'warn' }), surface: 'telegram' },
    { rec: rec({ category: 'voice.tts', event: 'speak.begin' }), surface: 'nexus' },
  ]);
  return store;
}

function get(path: string): Request {
  return new Request(`http://localhost:31415${path}`);
}

describe('parseSinceParam — 상대/절대 표기', () => {
  it('30s/15m/2h/7d 상대 표기', () => {
    const now = 1_000_000_000_000;
    expect(parseSinceParam('30s', now)).toBe(now - 30_000);
    expect(parseSinceParam('15m', now)).toBe(now - 15 * 60_000);
    expect(parseSinceParam('2h', now)).toBe(now - 2 * 3_600_000);
    expect(parseSinceParam('7d', now)).toBe(now - 7 * 86_400_000);
  });
  it('epoch ms · ISO · 불가 시 null', () => {
    expect(parseSinceParam('1700000000000')).toBe(1_700_000_000_000);
    expect(parseSinceParam('2026-07-13T00:00:00Z')).toBe(Date.parse('2026-07-13T00:00:00Z'));
    expect(parseSinceParam('gibberish')).toBeNull();
  });

  it('시각 없는 날짜는 로컬 자정 표기와 같은 순간', () => {
    expect(parseSinceParam('2026-08-05')).toBe(parseSinceParam('2026-08-05 00:00'));
    expect(parseSinceParam('2026-08-05')).toBe(new Date(2026, 7, 5).getTime());
  });

  it('Asia/Seoul에서도 시각 없는 날짜를 로컬 자정으로 읽는다', () => {
    const result = spawnSync(process.execPath, [
      '-e',
      `import(${JSON.stringify(new URL('./log-fabric.js', import.meta.url).href)}).then(({ parseSinceParam }) => {
        const actual = parseSinceParam('2026-08-05');
        const expected = new Date(2026, 7, 5).getTime();
        process.exit(actual === expected ? 0 : 1);
      })`,
    ], { env: { ...process.env, TZ: 'Asia/Seoul' } });
    expect(result.status).toBe(0);
  });

  it('시각 없는 ISO 저연도를 보존한다', () => {
    for (const raw of ['0000-01-01', '0099-12-31']) {
      const [year, month, day] = raw.split('-').map(Number);
      const expected = new Date(0);
      expected.setHours(0, 0, 0, 0);
      expected.setFullYear(year!, month! - 1, day!);
      expect(parseSinceParam(raw)).toBe(expected.getTime());
    }
  });
});

describe('GET /v1/logs — 필터 조회', () => {
  it('무필터 = 최근순 전체(limit 내)', async () => {
    const store = seededStore();
    const res = handleLogsQuery(get('/v1/logs'), OPTS, { store: () => store });
    const j = await res.json() as { ok: boolean; logs: Array<{ category: string }>; count: number };
    expect(j.ok).toBe(true);
    expect(j.count).toBe(4);
    store.close();
  });

  it('level=warn → warn 이상만 (error 포함·info/debug 제외)', async () => {
    const store = seededStore();
    const res = handleLogsQuery(get('/v1/logs?level=warn'), OPTS, { store: () => store });
    const j = await res.json() as { logs: Array<{ level: string; event: string }> };
    expect(j.logs.map((l) => l.level).sort()).toEqual(['error', 'warn']);
    store.close();
  });

  it('surface 다중 + category prefix 조합', async () => {
    const store = seededStore();
    const res = handleLogsQuery(get('/v1/logs?surface=nexus,pwa&category=voice'), OPTS, { store: () => store });
    const j = await res.json() as { logs: Array<{ category: string; surface: string }> };
    expect(j.logs.length).toBe(2);
    expect(j.logs.every((l) => l.category.startsWith('voice') && (l.surface === 'nexus' || l.surface === 'pwa'))).toBe(true);
    store.close();
  });

  it('grep 은 event/data/category 부분 일치', async () => {
    const store = seededStore();
    const res = handleLogsQuery(get('/v1/logs?grep=401'), OPTS, { store: () => store });
    const j = await res.json() as { logs: Array<{ event: string; data?: { code: number } }> };
    expect(j.logs.length).toBe(1);
    expect(j.logs[0]!.data).toEqual({ code: 401 });
    store.close();
  });

  it('invalid level/since → 400', async () => {
    const store = seededStore();
    expect(handleLogsQuery(get('/v1/logs?level=loud'), OPTS, { store: () => store }).status).toBe(400);
    expect(handleLogsQuery(get('/v1/logs?since=nonsense'), OPTS, { store: () => store }).status).toBe(400);
    store.close();
  });

  it('store 불가(NODE_ENV=test 기본 싱글톤) → 503', () => {
    expect(handleLogsQuery(get('/v1/logs'), OPTS).status).toBe(503);
  });
});

describe('GET /v1/logs/stream — SSE 라이브 tail', () => {
  it('접속 이후 적재분만 필터 적용해 흘린다', async () => {
    const store = seededStore(); // 기존 4행은 스트림에 안 나옴(커서=maxId)
    const res = handleLogsStream(get('/v1/logs/stream?surface=pwa'), OPTS, { store: () => store });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // 신규 2행 — pwa 1 · nexus 1(필터로 걸러짐)
    store.insertBatch([
      { rec: rec({ category: 'webterm.acp', event: 'attach.ok' }), surface: 'pwa' },
      { rec: rec({ category: 'llm.provider', event: 'route' }), surface: 'nexus' },
    ]);
    let buf = '';
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !buf.includes('attach.ok')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
    await reader.cancel();
    expect(buf).toContain('event: log');
    expect(buf).toContain('attach.ok');
    expect(buf).not.toContain('llm.provider'); // surface 필터 서버측 적용
    store.close();
  });
});

describe('POST /v1/logs/level — 런타임 레벨 변경', () => {
  function post(body: unknown): Request {
    return new Request('http://localhost:31415/v1/logs/level', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  it('유효 레벨 → setLevel + persist 호출·200', async () => {
    const calls: string[] = [];
    const res = await handleLogsLevelPost(post({ level: 'diag' }), OPTS, {
      setLevel: (l) => calls.push(`set:${l}`),
      persistLevel: (l) => calls.push(`persist:${l}`),
    });
    const j = await res.json() as { ok: boolean; level: string; persisted: boolean };
    expect(j).toEqual({ ok: true, level: 'diag', persisted: true });
    expect(calls).toEqual(['set:diag', 'persist:diag']);
  });

  it('persist 실패해도 라이브 적용은 유효 (persisted:false 표시)', async () => {
    const res = await handleLogsLevelPost(post({ level: 'trail' }), OPTS, {
      setLevel: () => {},
      persistLevel: () => { throw new Error('disk'); },
    });
    const j = await res.json() as { persisted: boolean };
    expect(j.persisted).toBe(false);
  });

  it('무효 레벨 → 400 + valid 목록', async () => {
    const res = await handleLogsLevelPost(post({ level: 'loud' }), OPTS, { setLevel: () => {} });
    expect(res.status).toBe(400);
    const j = await res.json() as { valid: string[] };
    expect(j.valid).toContain('keytrace');
  });

  it('OH9 — render 만(level 없이) → setRenderSuppressed(!render) + persist·200', async () => {
    const calls: string[] = [];
    const res = await handleLogsLevelPost(post({ render: false }), OPTS, {
      setRenderSuppressed: (on) => calls.push(`suppress:${on}`),
      persistRenderLogs: (r) => calls.push(`persist:${r}`),
    });
    const j = await res.json() as { ok: boolean; render: boolean; level?: string; persisted: boolean };
    expect(j).toEqual({ ok: true, render: false, persisted: true });
    expect(calls).toEqual(['suppress:true', 'persist:false']); // render off → 억제 ON
  });

  it("OH9 — render 'on' 문자열도 수용(왕복)", async () => {
    const calls: string[] = [];
    const res = await handleLogsLevelPost(post({ render: 'on' }), OPTS, {
      setRenderSuppressed: (on) => calls.push(`suppress:${on}`),
      persistRenderLogs: () => {},
    });
    const j = await res.json() as { render: boolean };
    expect(j.render).toBe(true);
    expect(calls).toEqual(['suppress:false']); // render on → 억제 OFF
  });

  it('OH9 — level + render 동시 → 둘 다 적용', async () => {
    const calls: string[] = [];
    const res = await handleLogsLevelPost(post({ level: 'diag', render: true }), OPTS, {
      setLevel: (l) => calls.push(`lvl:${l}`),
      persistLevel: () => {},
      setRenderSuppressed: (on) => calls.push(`suppress:${on}`),
      persistRenderLogs: () => {},
    });
    const j = await res.json() as { level: string; render: boolean };
    expect(j).toEqual({ ok: true, level: 'diag', render: true, persisted: true } as never);
    expect(calls).toContain('lvl:diag');
    expect(calls).toContain('suppress:false');
  });

  it('OH9 — level·render 둘 다 없으면 400', async () => {
    const res = await handleLogsLevelPost(post({}), OPTS, {});
    expect(res.status).toBe(400);
    const j = await res.json() as { error: string };
    expect(j.error).toBe('no_level_or_render');
  });
});

describe('persistDebugLevelRaw — overlay-safe 사건 회귀 (2026-07-13)', () => {
  it('debug.level 외 어떤 필드도 건드리지 않는다 (telegram 토큰/채널 보존)', async () => {
    const { persistDebugLevelRaw } = await import('./log-fabric.js');
    const { mkdtempSync, readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'logfab-'));
    const p = join(dir, 'config.json');
    const original = {
      debug: { file: true, level: 'trail' },
      telegram: {
        botToken: 'PROD:token',
        reportChannel: { chatId: 1 },
        homeChannel: { chatId: 2 },
        testChannel: { botToken: 'TEST:token' },
      },
      discord: { enabled: true },
      voice: { stt: { provider: 'openai-realtime-stt' } },
    };
    wf(p, JSON.stringify(original, null, 2));
    persistDebugLevelRaw('diag', p);
    const after = JSON.parse(rf(p, 'utf-8'));
    expect(after.debug.level).toBe('diag');
    // 사건의 핵심 회귀 — overlay 프로세스에서 실행돼도 telegram/discord 원형 보존.
    expect(after.telegram).toEqual(original.telegram);
    expect(after.discord).toEqual(original.discord);
    expect(after.voice).toEqual(original.voice);
    expect(after.debug.file).toBe(true);
  });
});

describe('parseLogQuery — 파라미터 조합', () => {
  it('전체 파라미터 왕복', () => {
    const url = new URL('http://x/v1/logs?level=info&surface=pwa,tg&category=voice,webterm.tabs&grep=err&sessionId=s1&limit=50');
    const { query, error } = parseLogQuery(url);
    expect(error).toBeUndefined();
    expect(query).toEqual({
      minLevel: 'info',
      surfaces: ['pwa', 'tg'],
      categories: ['voice', 'webterm.tabs'],
      grep: 'err',
      sessionId: 's1',
      limit: 50,
    });
  });
});

describe('GET /v1/logs/facets · /v1/logs/histogram — 대시보드 데이터 (LF4)', () => {
  it('facets — surface/component/level distinct 카운트', async () => {
    const store = seededStore();
    const { handleLogsFacets } = await import('./log-fabric.js');
    const res = handleLogsFacets(get('/v1/logs/facets'), OPTS, { store: () => store });
    const j = await res.json() as { surfaces: Array<{ surface: string; count: number }>; components: Array<{ component: string }>; levels: Array<{ level: string }> };
    expect(j.surfaces.map((s) => s.surface).sort()).toEqual(['nexus', 'pwa', 'telegram']);
    expect(j.components.map((c) => c.component)).toContain('voice');
    expect(j.components.map((c) => c.component)).toContain('webterm');
    store.close();
  });

  it('histogram — 분당 버킷에 count/errors 스택', async () => {
    const store = seededStore();
    const { handleLogsHistogram } = await import('./log-fabric.js');
    const res = handleLogsHistogram(get('/v1/logs/histogram?since=1h'), OPTS, { store: () => store });
    const j = await res.json() as { buckets: Array<{ count: number; errors: number }> };
    const total = j.buckets.reduce((a, b) => a + b.count, 0);
    const errs = j.buckets.reduce((a, b) => a + b.errors, 0);
    expect(total).toBe(4);
    expect(errs).toBe(1); // handshake.error 1건
    store.close();
  });
});

describe('연합 조회 (LF7-d) — ?store= 리졸버 + /v1/logs/instances', () => {
  const mkView = (name: string, dbPath: string, dbExists = true, stateDirCount = 1): LogInstanceView => ({
    name, stateDir: dirname(dirname(dbPath)), pid: process.pid,
    startedAt: '2026-07-13T00:00:00.000Z', alive: true, liveness: 'alive', dbExists, dbPath,
    stateDirCount, ambiguous: stateDirCount > 1,
    kind: 'prod', configDir: dirname(dirname(dbPath)),
  });

  // ⛔ 여기서 «표본»의 두 값을 서로 비교하지 않는다 — mkView 가 그 식으로 만든 것을 같은 식으로 재면
  //   무엇을 넣어도 참이라 판별력이 «0» 이다(리뷰 must-fix 실측). 그 성질은 «제품 코드가 값을 만드는 자리»에서 잰다.
  it('미등록 prod fallback 은 두 값을 리터럴로 싣는다 — 단일 뿌리를 합성했으므로 「걸치지 않았다」', () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-lf7d-home-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    new LogStore(dbPath).close();
    const store = seededStore();
    let fallback: LogInstanceView | undefined;
    try {
      const res = handleLogsQuery(get('/v1/logs?store=prod'), OPTS, {
        store: () => store,
        instances: () => [],
        // ⛔ 환경 변수를 흔들지 않는다 — 그러면 플랫폼별 prod 경로 «계약» 자체가 달라진다.
        prodStateRoot: () => join(home, '.elanous'),
        openRemoteStore: (view) => { fallback = view; return store; },
      });
      expect(res.status).toBe(200);
      // ⭐ 리터럴 기대다 — 구현의 식을 되비추지 않는다. ambiguous 를 true 로 박으면 이 검사가 깨진다.
      expect(fallback).toMatchObject({ name: 'prod', dbPath, stateDirCount: 1, ambiguous: false });
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('/v1/logs/instances 응답은 두 새 필드를 «안 내보낸다» — 응답 형태는 이 착지가 지키는 계약이다', async () => {
    const { handleLogsInstances } = await import('./log-fabric.js');
    const res = handleLogsInstances(get('/v1/logs/instances'), OPTS, {
      instances: () => [mkView('test:monad-agent', '/x/.elanous-test/logs/logs.db', true, 2)],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { instances: Array<Record<string, unknown>> };
    const leaked = body.instances.flatMap((row) => ['stateDirCount', 'ambiguous'].filter((key) => key in row));
    expect(leaked).toEqual([]);
  });

  it('store 미지정/자기 이름 → 기본 스토어 · 미등록 이름 → 404', async () => {
    const store = seededStore();
    const { handleLogsQuery } = await import('./log-fabric.js');
    const ok = handleLogsQuery(get('/v1/logs'), OPTS, { store: () => store, instances: () => [] });
    expect(ok.status).toBe(200);
    const miss = handleLogsQuery(get('/v1/logs?store=ghost'), OPTS, { store: () => store, instances: () => [] });
    expect(miss.status).toBe(404);
    store.close();
  });

  it('store=<타 인스턴스> → 레지스트리 경로의 logs.db 를 read-only 조회', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-lf7d-'));
    const dbPath = join(dir, 'logs', 'logs.db');
    const remote = new LogStore(dbPath, { instance: 'test:remote-agent' });
    remote.insertBatch([{ rec: rec({ event: 'remote.ok' }), surface: 'nexus' }]);
    remote.close();
    const self = seededStore();
    const { handleLogsQuery } = await import('./log-fabric.js');
    const res = handleLogsQuery(get('/v1/logs?store=test:remote-agent'), OPTS, {
      store: () => self,
      instances: () => [mkView('test:remote-agent', dbPath)],
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { logs: Array<{ event: string; instance?: string }> };
    expect(j.logs.map((l) => l.event)).toEqual(['remote.ok']);
    expect(j.logs[0]!.instance).toBe('test:remote-agent');
    self.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('store=@active → 이 인스턴스 ⊕ 최근 24시간에 쓰인 우주만(최신순) · 응답에 본 목록', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-active-'));
    const fresh = join(dir, 'fresh', 'logs', 'logs.db');
    const stale = join(dir, 'stale', 'logs', 'logs.db');
    const a = new LogStore(fresh, { instance: 'test:fresh' });
    a.insertBatch([{ rec: rec({ event: 'fresh.ok' }), surface: 'nexus' }]);
    a.close();
    const self = seededStore();
    const now = Date.now();
    const res = handleLogsQuery(get('/v1/logs?store=@active&limit=50'), OPTS, {
      store: () => self,
      instances: () => [mkView('test:fresh', fresh), mkView('test:stale', stale), mkView('test:nodb', '/nope/logs.db', false)],
      dbMtimeMs: (path) => (path === fresh ? now - 60_000 : path === stale ? now - 3 * 86_400_000 : null),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { logs: Array<{ event: string; instance?: string }>; stores: string[] };
    expect(j.stores.slice(1)).toEqual(['test:fresh']);
    expect(j.logs.some((l) => l.event === 'fresh.ok' && l.instance === 'test:fresh')).toBe(true);
    self.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('스토어 없는 인스턴스(store 미생성) → 404', async () => {
    const self = seededStore();
    const { handleLogsQuery } = await import('./log-fabric.js');
    const res = handleLogsQuery(get('/v1/logs?store=test:empty'), OPTS, {
      store: () => self,
      instances: () => [mkView('test:empty', '/nope/logs/logs.db', false)],
    });
    expect(res.status).toBe(404);
    self.close();
  });

  it('중복 store 하나는 정규화된 이름으로 한 번만 해석·개방하며 기존 단일 응답 형태를 유지한다', async () => {
    const self = new LogStore(':memory:', { instance: 'test:self' });
    const remote = new LogStore(':memory:', { instance: 'test:remote' });
    remote.insertBatch([{ rec: rec({ event: 'remote.once' }), surface: 'nexus' }]);
    const opened: string[] = [];
    const res = handleLogsQuery(get('/v1/logs?store=test:remote,test:remote'), OPTS, {
      store: () => self,
      instances: () => [mkView('test:remote', '/tmp/remote.db')],
      openRemoteStore: (view) => { opened.push(view.name); return remote; },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, count: 1, logs: [{ event: 'remote.once', instance: 'test:remote' }] });
    expect(opened).toEqual(['test:remote']);
    self.close(); remote.close();
  });

  it('다중 store는 지정 대상만 병합·출처 보존·시간순 정렬하며 원격 store를 정리한다', async () => {
    const self = new LogStore(':memory:', { instance: 'test:self' });
    const early = new LogStore(':memory:', { instance: 'test:early' });
    const late = new LogStore(':memory:', { instance: 'test:late' });
    early.insertBatch([{ rec: rec({ ts: '2026-07-13T00:00:00.000Z', event: 'early' }), surface: 'nexus' }]);
    late.insertBatch([{ rec: rec({ ts: '2026-07-13T00:01:00.000Z', event: 'late' }), surface: 'nexus' }]);
    const opened: string[] = [];
    const closed: string[] = [];
    const res = handleLogsQuery(get('/v1/logs?store=test:early,test:late&limit=1'), OPTS, {
      store: () => self,
      instances: () => [mkView('test:early', '/tmp/early.db'), mkView('test:late', '/tmp/late.db')],
      openRemoteStore: (view) => { opened.push(view.name); return view.name === 'test:early' ? early : late; },
      closeRemoteStore: (store) => closed.push(store === early ? 'early' : 'late'),
    });
    const body = await res.json() as { logs: Array<{ event: string; instance: string }>; count: number };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ count: 1, logs: [{ event: 'late', instance: 'test:late' }] });
    expect(opened).toEqual(['test:early', 'test:late']);
    expect(closed.sort()).toEqual(['early', 'late']);
    self.close(); early.close(); late.close();
  });

  it('다중 store의 미등록 이름은 원격 store를 열기 전에 이름을 대고 거부한다', async () => {
    const self = new LogStore(':memory:', { instance: 'test:self' });
    const opened: string[] = [];
    const closed: string[] = [];
    const res = handleLogsQuery(get('/v1/logs?store=test:known,ghost'), OPTS, {
      store: () => self,
      instances: () => [mkView('test:known', '/tmp/known.db')],
      openRemoteStore: (view) => { opened.push(view.name); return self; },
      closeRemoteStore: () => closed.push('closed'),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: "unknown instance 'ghost'" });
    expect(opened).toEqual([]);
    expect(closed).toEqual([]);
    self.close();
  });

  it('다중 store의 before 커서는 명시적으로 거부하고 단일 store 커서는 보존한다', async () => {
    const self = new LogStore(':memory:', { instance: 'test:self' });
    self.insertBatch([
      { rec: rec({ ts: '2026-07-13T00:01:00.000Z', event: 'newer' }), surface: 'nexus' },
      { rec: rec({ ts: '2026-07-13T00:00:00.000Z', event: 'older' }), surface: 'nexus' },
    ]);
    const single = handleLogsQuery(get('/v1/logs?before=1'), OPTS, { store: () => self });
    expect(single.status).toBe(200);
    expect((await single.json() as { logs: Array<{ event: string }> }).logs.map((row) => row.event)).toEqual(['older']);
    const multi = handleLogsQuery(get('/v1/logs?store=test:self,test:other&before=1'), OPTS, {
      store: () => self,
      instances: () => [mkView('test:other', '/tmp/other.db')],
      openRemoteStore: () => self,
    });
    expect(multi.status).toBe(400);
    expect(await multi.json()).toMatchObject({ error: 'multi_store_cursor_unsupported', before: 1 });
    self.close();
  });

  it('다중 store의 같은 timestamp 행은 instance보다 id를 먼저 내림차순 정렬한다', async () => {
    const self = new LogStore(':memory:', { instance: 'test:self' });
    const alpha = new LogStore(':memory:', { instance: 'test:alpha' });
    const zulu = new LogStore(':memory:', { instance: 'test:zulu' });
    const ts = '2026-07-13T00:00:00.000Z';
    alpha.insertBatch([{ rec: rec({ ts, event: 'alpha-id-1' }), surface: 'nexus' }]);
    zulu.insertBatch([
      { rec: rec({ ts: '2026-07-12T00:00:00.000Z', event: 'zulu-id-1' }), surface: 'nexus' },
      { rec: rec({ ts, event: 'zulu-id-2' }), surface: 'nexus' },
    ]);
    const res = handleLogsQuery(get('/v1/logs?store=test:alpha,test:zulu'), OPTS, {
      store: () => self,
      instances: () => [mkView('test:alpha', '/tmp/alpha.db'), mkView('test:zulu', '/tmp/zulu.db')],
      openRemoteStore: (view) => view.name === 'test:alpha' ? alpha : zulu,
      closeRemoteStore: () => {},
    });
    expect((await res.json() as { logs: Array<{ event: string }> }).logs.map((row) => row.event)).toEqual(['zulu-id-2', 'alpha-id-1', 'zulu-id-1']);
    self.close(); alpha.close(); zulu.close();
  });

  it('다중 store의 일부 open 실패는 결과와 failedStores로 보이고 모두 실패하면 거부한다', async () => {
    const self = new LogStore(':memory:', { instance: 'test:self' });
    const good = new LogStore(':memory:', { instance: 'test:good' });
    good.insertBatch([{ rec: rec({ event: 'good' }), surface: 'nexus' }]);
    const deps = {
      store: () => self,
      instances: () => [mkView('test:good', '/tmp/good.db'), mkView('test:bad', '/tmp/bad.db')],
      openRemoteStore: (view: LogInstanceView) => view.name === 'test:good' ? good : null,
    };
    const partial = handleLogsQuery(get('/v1/logs?store=test:good,test:bad'), OPTS, deps);
    expect(await partial.json()).toMatchObject({ ok: true, logs: [{ event: 'good', instance: 'test:good' }], failedStores: [{ name: 'test:bad', reason: "instance 'test:bad' store open failed" }] });
    const none = handleLogsQuery(get('/v1/logs?store=test:bad,test:good'), OPTS, { ...deps, openRemoteStore: () => null });
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ error: 'log-store-unavailable', failedStores: [{ name: 'test:bad' }, { name: 'test:good' }] });
    self.close(); good.close();
  });

  it('다중 store는 중복을 한 번만 열고 20개 cap에서 고유 핸들을 각각 한 번 닫는다', async () => {
    const self = seededStore();
    const views = Array.from({ length: 21 }, (_, index) => mkView(`test:${index}`, `/tmp/${index}.db`));
    const names = views.map((view) => view.name).join(',');
    const handles = new Map<string, LogStore>();
    const opened: string[] = [];
    const closed: string[] = [];
    for (const view of views) handles.set(view.name, new LogStore(':memory:', { instance: view.name }));
    const capped = handleLogsQuery(get(`/v1/logs?store=test:0,${names},test:0`), OPTS, {
      store: () => self,
      instances: () => views,
      openRemoteStore: (view) => {
        opened.push(view.name);
        return handles.get(view.name) ?? null;
      },
      closeRemoteStore: (store) => {
        const name = [...handles].find(([, handle]) => handle === store)?.[0];
        if (name) closed.push(name);
      },
    });
    expect(await capped.json()).toMatchObject({ ok: true, storeLimitReached: true });
    expect(opened).toEqual(views.slice(0, 20).map((view) => view.name));
    expect(closed).toEqual(views.slice(0, 20).map((view) => view.name));
    const missing = handleLogsQuery(get('/v1/logs?store=test:0,ghost'), OPTS, {
      store: () => self, instances: () => views, openRemoteStore: () => self,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ reason: "unknown instance 'ghost'" });
    self.close();
    for (const handle of handles.values()) handle.close();
  });

  it('GET /v1/logs/instances — self 표시 + current 플래그 (자기 미등록 시 합성)', async () => {
    const { handleLogsInstances } = await import('./log-fabric.js');
    const res = handleLogsInstances(get('/v1/logs/instances'), OPTS, {
      instances: () => [mkView('test:monad-agent', '/x/.elanous-test/logs/logs.db')],
    });
    expect(res.status).toBe(200);
    const j = await res.json() as {
      self: string;
      instances: Array<{ name: string; alive: boolean; dbExists: boolean; stateDir: string; current: boolean }>;
    };
    expect(j.instances.some((i) => i.current)).toBe(true);
    const registered = j.instances.find((i) => i.name === 'test:monad-agent');
    expect(registered).toBeDefined();
    expect(Object.keys(registered!).sort()).toEqual(['alive', 'current', 'dbExists', 'name', 'stateDir']);
  });
});
