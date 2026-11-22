// 출처: #9 CONTEXT-OWNER-ISOLATION-AUDIT (체크리스트 0.3.33 #40 · UX) — 완료선 ⑤ 판정표 시험.
// 소유자 A(회원) 턴에 다른 소유자·운영자 데이터(B 문자열)가 0임을 단언한다.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import { createNexusState } from '../state/state.js';
import { NexusEventBus } from './event-bus.js';
import { TabRegistry } from '../state/tab-registry.js';
import { startNexusHttpServer } from './http-server.js';
import { registerRelayHostChannelRequest, handlePromptPost } from './meta-api.js';
import type { ContextNowDeps } from '../../context-bus/context-now.js';

function serverFixture() {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  return { state, eventBus, registry: new TabRegistry(state) };
}

function uniquePort(): number {
  return 43000 + Math.floor(Math.random() * 2000);
}

const at = '2026-11-22T04:00:00.000Z';
// 다른 소유자(운영자 자리) 데이터 마커 — 회원 A 응답에 0이어야 한다.
const OP_RUN_MARKER = 'OPSECRET-run-mark-9d2f1';
const OP_EVENT_MARKER = 'OPSECRET-event-mark-4c8aa';
const OP_SEAT_MARKER = 'OPSECRET-seat-mark-7e31b';

const deps: ContextNowDeps = {
  now: () => new Date(at), version: () => '0.3.32',
  checklist: version => ({ version, released: '', dev: version, history: [], items: version === '0.3.32'
    ? [{ id: 'CTX-9', title: '공개 기능', status: 'red', owner: 'UX', updatedAt: at, updatedBy: 'UX' }] : [] }),
  decisions: () => [],
  seatEntries: () => [{ entry: { seat: 'UX', at, status: 'shadow', item: { id: 'CTX-9', title: '공개 기능', text: OP_SEAT_MARKER, source: 'checklist' } }, source: `elanous://seat-loop/UX/2026-11-22#1` }],
  events: () => [{ id: 'event-1', at, text: '', kind: 'report', summary: `보고 ${OP_EVENT_MARKER} at /home/alice/plan`, refs: { seat: 'OP', recipients: [], all: false, kind: 'report', slot: null, deadline: null, url: 'https://github.com/org/repo/pull/9999' } }],
  runningRuns: () => [{ kind: 'run', goal: OP_RUN_MARKER, phase: 'implementing', elapsed: '12m', source: 'elanous://runs/running' }],
};

describe('POST /v1/prompt owner isolation (CONTEXT-OWNER-ISOLATION-AUDIT #9 · ②″ · 출처: UX 감사)', () => {
  test('member relay-channel turn is forbidden on handlePromptPost — no operator-history turn for members', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-owner-iso-p3-'));
    setElanousConfigDir(dir);
    try {
      // 감사 ②″: 이 엔드포인트는 운영자 daemon history(opts.history) 위에서 도는
      // 소유자 전용 턴이다. decideAuth 는 오늘 회원 갈래를 채팅 쌍 밖에 열지 않아
      // 라우트 수준에선 401 이지만, 가드는 «인증이 어떤 미래 갈래로 회원을 승인해도
      // 회원 신원은 절대 운영자 history 턴을 돌리지 못한다»를 단위 수준에서 증명한다.
      // noAuth 갈래로 checkAuth 를 결정적으로 통과시킨 뒤 가드만을 시험한다.
      const memberReq = new Request('http://nexus.local/v1/prompt', { method: 'POST', headers: { authorization: 'Bearer emt_memberA' }, body: JSON.stringify({ userText: 'leak?' }) });
      registerRelayHostChannelRequest(memberReq, 'member-A');
      const res = await handlePromptPost(memberReq, { noAuth: true, relayHostChannelMember: () => ({ memberId: 'member-A', userSlug: 'a', plan: 'free', entitlements: {} }) } as never);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'member-forbidden-prompt' });
      // 대조: 신뢰채널 표시 없는(비회원) 턴은 계약 불변 — 가드가 선 뒤에도
      // history 미배선이면 503 runtime-not-wired(회원 가드가 소유자 표면을 흔들지 않는다).
      const opRes = await handlePromptPost(new Request('http://nexus.local/v1/prompt', { method: 'POST', body: JSON.stringify({ userText: 'ok' }) }), { noAuth: true } as never);
      expect(opRes.status).toBe(503);
    } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('GET /v1/context/now owner isolation (CONTEXT-OWNER-ISOLATION-AUDIT #9 · 출처: UX 감사)', () => {
  test('member relay-channel request is rejected on /v1/context/now (not a chat pair)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-owner-iso-'));
    setElanousConfigDir(dir);
    try {
      const server = startNexusHttpServer({ ...serverFixture(), startPort: uniquePort(), metaApi: { bearerToken: 'auth', noAuth: false }, contextNowDeps: deps });
      // 릴레이 배선이 새기는 표시를 시험이 직접 재현: 회원 A 신뢰채널 표시(출처: meta-api.ts registerRelayHostChannelRequest).
      registerRelayHostChannelRequest(new Request('http://relay.local/'), 'member-A');
      try {
        const res = await fetch(`${server.url}/v1/context/now`, { headers: { authorization: 'Bearer emt_memberA', 'sec-fetch-site': 'cross-site' } });
        expect(res.status).toBe(401);
        // 혹시 200이면(표시 누출) 운영자 마커가 흘러나오면 안 된다.
        if (res.status === 200) expect(JSON.stringify(await res.json())).not.toContain('OPSECRET');
      } finally { server.stop(); }
    } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('member turn cannot bypass via ?audience= — operator surface contract unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-owner-iso-2-'));
    setElanousConfigDir(dir);
    try {
      const server = startNexusHttpServer({ ...serverFixture(), startPort: uniquePort(), metaApi: { bearerToken: 'auth', noAuth: false }, contextNowDeps: deps });
      try {
        // 회원 턴은 채팅 2경로 밖에 승인 갈래가 없어 checkAuth 401(bearer-length-mismatch)
        // 로 폐쇄된다. 6710 member-forbidden 가드는 채팅 경로가 context/now 로 확장되는
        // 미래를 닫는 심층 수비 — 이 시험의 계약은 '닫힘(≠200)·운영자 마커 0' 이다.
        for (const q of ['?audience=user', '?audience=operator', '?audience=public-demo', '']) {
          const res = await fetch(`${server.url}/v1/context/now${q}`, { headers: { authorization: 'Bearer emt_memberA', 'sec-fetch-site': 'cross-site' } });
          expect([q, res.status]).not.toEqual([q, 200]);
          expect(JSON.stringify(await res.json())).not.toContain('OPSECRET');
        }
        // 대조: 소유자(bearer) 표면 계약은 불변 — audience=user 도 소유자에게 200·운영자 사실 그대로
        // (context-now-public.test.ts:143 · http-server.test.ts:466-482 기존 계약).
        const op = await fetch(`${server.url}/v1/context/now?audience=user`, { headers: { authorization: 'Bearer auth', 'sec-fetch-site': 'cross-site' } });
        expect(op.status).toBe(200);
        expect(JSON.stringify(await op.json())).toContain(OP_RUN_MARKER);
      } finally { server.stop(); }
    } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
  });
});
