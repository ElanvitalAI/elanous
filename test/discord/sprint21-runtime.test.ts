// Test: src/discord/sprint21-runtime.ts
//
// Coverage: wireSprint21Runtime composes registry + pool + adapter +
// gate + router. Slash command registration uses fake REST. Default
// spawnLanes / snapshot / postPoll callbacks behave correctly.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wireSprint21Runtime } from '../../src/discord/sprint21-runtime.js';
import { botCommandDeclarations } from '../../src/bots/command-surface.js';

let personasDir: string;

function makeFakeFetch(responses: { url: RegExp; status?: number; body?: unknown }[]): {
  fetchImpl: typeof fetch;
  captured: { url: string; method: string; body: any }[];
} {
  const captured: { url: string; method: string; body: any }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    captured.push({
      url, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const match = responses.find((r) => r.url.test(url));
    const status = match?.status ?? 200;
    const body = match?.body ?? [];
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { fetchImpl, captured };
}

beforeEach(async () => {
  personasDir = await mkdtemp(join(tmpdir(), 'sp21-runtime-'));
  await writeFile(join(personasDir, 'sage.yaml'),
    'personaId: sage\ndisplayName: Sage', 'utf8');
});

afterEach(async () => {
  await rm(personasDir, { recursive: true, force: true });
});

describe('wireSprint21Runtime — composition', () => {
  test('loads personas + exposes registry/pool/adapter/gate/router', async () => {
    const { fetchImpl } = makeFakeFetch([]);
    const runtime = await wireSprint21Runtime({
      bot: {} as any,  // bot is only consulted by callbacks, not by init
      token: 'tok', appId: 'app',
      personasDir, watchPersonas: false,
      fetchImpl,
    });
    expect(runtime.registry.size()).toBe(1);
    expect(runtime.registry.get('sage')?.displayName).toBe('Sage');
    expect(runtime.webhookPool).toBeDefined();
    expect(runtime.webhookAdapter).toBeDefined();
    expect(runtime.approvalGate).toBeDefined();
    expect(runtime.router).toBeDefined();
    runtime.shutdown();
  });

  /**
   * 🩸⛔⭐⭐ **「이름·수를 «정확값»으로 건 자」가 늙었다** (2026-09-02 · 43차 · 전수 스위트가 잡았다)
   *
   * 🚨 실물: 이 자는 8개를 «정확값»으로 걸었는데 실제는 ***11***이었다(`screen`·`chart`·`routines` 가 늘었다).
   *    ⛔ 더한 것이 «잘못»이 아니다 — ***자가 낡은 것***이다. 인계 §3e-3 이 그 처방을 이미 적어 뒀다:
   *    ***「부분집합으로 — 추가는 통과·삭제만 빨강」***.
   *    🩸 그리고 그때 텔레그램 쪽 같은 자는 «고쳤는데» ***디스코드 쪽은 놓쳤다.***
   * ⇒ ⭐ 봇 명령은 ***선언(`botCommandDeclarations`)에서 «파생»***한다 — 그 목록이 늘면 이 자가 «따라 늘어난다».
   * ⛔ 그래도 «삭제»는 빨강이다 — 그것이 이 자가 지키는 계약이다.
   */
  test('router binds every declared command — ⛔ 추가는 통과, 삭제는 빨강', async () => {
    const { fetchImpl } = makeFakeFetch([]);
    const runtime = await wireSprint21Runtime({
      bot: {} as any, token: 'tok', appId: 'app',
      personasDir, watchPersonas: false, fetchImpl,
    });
    const names = runtime.router.schemas().map((s) => s.name).sort();
    for (const schema of runtime.router.schemas()) expect(schema).not.toHaveProperty('supported');
    // ⛔ 봇 «아닌» 명령은 이 파일이 계약으로 갖는다(이 축이 늘면 여기도 손댈 일이다).
    for (const required of ['persona', 'poll', 'relay', 'showroom', 'status']) {
      expect(names, `«${required}» 가 사라졌다`).toContain(required);
    }
    // ⭐ 봇 명령은 «선언»이 정본 — 목록을 여기 복제하지 않는다.
    for (const declared of botCommandDeclarations) {
      expect(names, `봇 명령 «${declared.name}» 이 디스코드 라우터에 «안 걸렸다»`).toContain(declared.name);
    }
    runtime.shutdown();
  });
});

describe('registerSlashCommands', () => {
  test('guild scope when devGuildId provided', async () => {
    const { fetchImpl, captured } = makeFakeFetch([
      { url: /\/applications\/app\/guilds\/g-1\/commands/, body: [
        { id: 'c1', name: 'showroom', description: '', type: 1 },
        { id: 'c2', name: 'persona', description: '', type: 1 },
        { id: 'c3', name: 'relay', description: '', type: 1 },
        { id: 'c4', name: 'status', description: '', type: 1 },
        { id: 'c5', name: 'poll', description: '', type: 1 },
        { id: 'c6', name: 'bots', description: '', type: 1 },
        { id: 'c7', name: 'bot', description: '', type: 1 },
        { id: 'c8', name: 'botsay', description: '', type: 1 },
      ] },
    ]);
    const runtime = await wireSprint21Runtime({
      bot: {} as any, token: 'tok', appId: 'app',
      personasDir, watchPersonas: false, devGuildId: 'g-1', fetchImpl,
    });
    const count = await runtime.registerSlashCommands();
    // ⛔ 이 수는 «가짜 응답»이 돌려준 것이다(위 fixture 8줄) — 코드가 «몇 개를 만들었나»가 아니다.
    expect(count).toBe(8);
    expect(captured[0]!.method).toBe('PUT');
    expect(captured[0]!.url).toContain('/applications/app/guilds/g-1/commands');
    // ⛔⭐ «보낸» 개수는 정확값으로 걸지 않는다 — 라우터가 «실제로 가진» 수에서 파생한다(자가 안 늙는다).
    const putBody = captured[0]!.body as Array<Record<string, unknown> & { name: string }>;
    expect(putBody.length).toBe(runtime.router.schemas().length);
    expect(putBody.some((command) => command.name === 'showroom')).toBe(true);
    expect(putBody.some((command) => command.name === 'persona' && String(command.description).includes('미지원'))).toBe(false);
    for (const command of putBody) expect(command).not.toHaveProperty('supported');
    runtime.shutdown();
  });

  test('global scope when devGuildId omitted', async () => {
    const { fetchImpl, captured } = makeFakeFetch([
      { url: /\/applications\/app\/commands/, body: [{ id: 'c1', name: 'showroom', description: '', type: 1 }] },
    ]);
    const runtime = await wireSprint21Runtime({
      bot: {} as any, token: 'tok', appId: 'app',
      personasDir, watchPersonas: false, fetchImpl,
    });
    await runtime.registerSlashCommands();
    expect(captured[0]!.url).toContain('/applications/app/commands');
    expect(captured[0]!.url).not.toContain('/guilds/');
    expect(captured[0]!.method).toBe('PUT');
    for (const command of captured[0]!.body as Array<Record<string, unknown>>) {
      expect(command).not.toHaveProperty('supported');
    }
    runtime.shutdown();
  });
});

describe('default spawnLanes / snapshot / postPoll callbacks', () => {
  test('default spawnLanes ensures webhooks per token (uses pool)', async () => {
    const { fetchImpl, captured } = makeFakeFetch([
      { url: /\/channels\/ch-1\/webhooks/, body: { id: 'wh-1', token: 't1', name: 'elanous-persona:lane-1', channel_id: 'ch-1' } },
    ]);
    const runtime = await wireSprint21Runtime({
      bot: {} as any, token: 'tok', appId: 'app',
      personasDir, watchPersonas: false, fetchImpl,
    });
    // Use the router's showroom handler with default ctx.
    const intr = {
      id: 'i', token: 't', applicationId: 'app',
      commandName: 'showroom', channelId: 'ch-1', userId: 'u-1',
      options: new Map<string, string | number | boolean>([
        ['lanes', 'plan:claude build:codex review:gemini'],
      ]),
    };
    const resp = await runtime.router.dispatch(intr);
    expect(resp.content).toContain('Spawned 3 webhook');
    // 3 POSTs (one per lane) to the webhooks endpoint
    const webhookPosts = captured.filter((c) => c.url.includes('/webhooks') && c.method === 'POST');
    expect(webhookPosts.length).toBe(3);
    runtime.shutdown();
  });

  test('default snapshot reports persona count + uptime', async () => {
    const { fetchImpl } = makeFakeFetch([]);
    const runtime = await wireSprint21Runtime({
      bot: {} as any, token: 'tok', appId: 'app',
      personasDir, watchPersonas: false, fetchImpl,
    });
    const intr = {
      id: 'i', token: 't', applicationId: 'app',
      commandName: 'status', channelId: 'ch', userId: 'u',
      options: new Map<string, string | number | boolean>(),
    };
    const resp = await runtime.router.dispatch(intr);
    expect(resp.content).toContain('personas** 1');
    expect(resp.content).toContain('uptime');
    runtime.shutdown();
  });

  test('postPoll callback sends to /channels/{id}/messages with poll body', async () => {
    const { fetchImpl, captured } = makeFakeFetch([
      { url: /\/channels\/ch-1\/messages/, body: { id: 'msg-9' } },
    ]);
    const runtime = await wireSprint21Runtime({
      bot: {} as any, token: 'tok', appId: 'app',
      personasDir, watchPersonas: false, fetchImpl,
    });
    const intr = {
      id: 'i', token: 't', applicationId: 'app',
      commandName: 'poll', channelId: 'ch-1', userId: 'u',
      options: new Map<string, string | number | boolean>([
        ['question', '진행?'], ['answers', 'A | B'],
      ]),
    };
    const resp = await runtime.router.dispatch(intr);
    expect(resp.content).toContain('msg-9');
    const msgPost = captured.find((c) => c.url.includes('/channels/ch-1/messages'));
    expect(msgPost?.body?.poll).toBeDefined();
    expect(msgPost?.body?.poll.question.text).toBe('진행?');
    runtime.shutdown();
  });
});

describe('shutdown', () => {
  test('stops persona fs.watch idempotently', async () => {
    const { fetchImpl } = makeFakeFetch([]);
    const runtime = await wireSprint21Runtime({
      bot: {} as any, token: 'tok', appId: 'app',
      personasDir, watchPersonas: true, fetchImpl,
    });
    runtime.shutdown();
    runtime.shutdown();  // 2번 — no-op
    // No assertion — verify no throw.
    expect(runtime.registry.size()).toBe(1);
  });
});
