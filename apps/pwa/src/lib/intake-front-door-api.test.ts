import { describe, expect, it } from 'bun:test';

import type { DaemonClient } from './daemon-client';
import {
  INTAKE_TEXT_PREVIEW_CHARS,
  absorbItemsFromText,
  getAbsorbStatus,
  getGraphStatus,
  getRunEvents,
  intakeTextPreview,
  routeIntake,
  submitAbsorb,
  submitGraph,
} from './intake-front-door-api';

interface Recorded {
  path: string;
  init?: RequestInit;
}

function fakeClient(body: unknown): { client: DaemonClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client = {
    fetchJson: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return body;
    },
    fetchResponse: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  } as unknown as DaemonClient;
  return { client, calls };
}

function posted(call: Recorded): unknown {
  return JSON.parse(String(call.init?.body));
}

describe('submitAbsorb', () => {
  it("submitAbsorb('보세요 https://a.example/x https://b.example/y') posts two url items", async () => {
    const { client, calls } = fakeClient({ ids: ['id-a', 'id-b'], added: 2, merged: 0, seen: 0, skipped: 0 });
    const result = await submitAbsorb(client, '보세요 https://a.example/x https://b.example/y');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/v1/intake-ledger/items');
    expect(calls[0]!.init?.method).toBe('POST');
    const body = posted(calls[0]!) as { items: { url?: string; text?: string }[]; source: string };
    expect(body.source).toBe('pwa');
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({ url: 'https://a.example/x' });
    expect(body.items[1]).toEqual({ url: 'https://b.example/y' });
    expect(result).toEqual({ ids: ['id-a', 'id-b'], added: 2, merged: 0 });
  });

  it('URL 없는 글은 text 한 항목', async () => {
    const { client, calls } = fakeClient({ ids: ['id-t'], added: 1, merged: 0 });
    await submitAbsorb(client, '분류기 없이 메모만');
    const body = posted(calls[0]!) as { items: { url?: string; text?: string }[]; source: string };
    expect(body.items).toEqual([{ text: '분류기 없이 메모만' }]);
    expect(body.source).toBe('pwa');
  });

  it('결과는 ids · added · merged 만 돌려준다', async () => {
    const { client } = fakeClient({ ids: ['x'], added: 0, merged: 1, seen: 3, skipped: 1 });
    const result = await submitAbsorb(client, '메모');
    expect(result).toEqual({ ids: ['x'], added: 0, merged: 1 });
    expect(result).not.toHaveProperty('seen');
  });
});

describe('submitGraph', () => {
  it('POST /v1/harness/ask 에 {text} 를 보내고 acceptanceId 를 돌려준다', async () => {
    const { client, calls } = fakeClient({ accepted: true, acceptanceId: 'acc-1' });
    const result = await submitGraph(client, '이 글을 그래프로');
    expect(calls[0]!.path).toBe('/v1/harness/ask');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(posted(calls[0]!)).toEqual({ text: '이 글을 그래프로' });
    expect(result).toEqual({ acceptanceId: 'acc-1' });
  });
});

describe('status getters', () => {
  it('getGraphStatus 는 GET /v1/harness/ask-status?acceptanceId= 그대로', async () => {
    const { client, calls } = fakeClient({ phase: 'accepted', runId: 'run-9' });
    const status = await getGraphStatus(client, 'acc/1');
    expect(calls[0]!.path).toBe('/v1/harness/ask-status?acceptanceId=acc%2F1');
    expect(calls[0]!.init).toBeUndefined();
    expect(status.phase).toBe('accepted');
    expect(status.runId).toBe('run-9');
  });

  it('getRunEvents 는 GET /v1/harness/run-events?runId=<id> 그대로', async () => {
    const events = [{ ts: '2026-09-27T00:00:00Z', event: 'implemented', runId: 'run/9', payload: { ok: true } }];
    const { client, calls } = fakeClient(events);
    expect(await getRunEvents(client, 'run/9')).toEqual(events);
    expect(calls).toEqual([{ path: '/v1/harness/run-events?runId=run%2F9', init: undefined }]);
  });

  it('getAbsorbStatus 는 GET /v1/intake-ledger/items/:id 그대로이고 원문을 요구하지 않는다', async () => {
    const { client, calls } = fakeClient({ id: 'abc', status: 'queued' });
    const status = await getAbsorbStatus(client, 'abc');
    expect(calls[0]!.path).toBe('/v1/intake-ledger/items/abc');
    expect(status).toEqual({ id: 'abc', status: 'queued' });
    expect(status).not.toHaveProperty('text');
  });
});

describe('routeIntake', () => {
  it("POST /v1/intake/route 에 { text, consent: 'route', source: 'pwa' }", async () => {
    const decision = { track: 'graph' as const, confidence: 0.9, reason: 'url-implement', decidedBy: 'rule', dryRun: true };
    const { client, calls } = fakeClient(decision);
    const result = await routeIntake(client, '이 저장소 보고 구현해줘 https://github.com/a/b');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/v1/intake/route');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(posted(calls[0]!)).toEqual({
      text: '이 저장소 보고 구현해줘 https://github.com/a/b',
      consent: 'route',
      source: 'pwa',
    });
    expect(result).toEqual(decision);
  });

  it('classify true 는 명시 요청에만 실어 보내며 결과는 그대로 반환한다', async () => {
    const decision = { track: 'tasks' as const, confidence: 0.8, reason: 'intent', decidedBy: 'classifier' };
    const { client, calls } = fakeClient(decision);
    expect(await routeIntake(client, '어느 갈래?', { classify: true })).toEqual(decision);
    expect(calls).toHaveLength(1);
    expect(posted(calls[0]!)).toEqual({ text: '어느 갈래?', consent: 'route', source: 'pwa', classify: true });
  });
});

describe('원문 미리보기', () => {
  it('앞 40자만 남긴다', () => {
    const raw = '가'.repeat(80);
    expect(intakeTextPreview(raw)).toHaveLength(INTAKE_TEXT_PREVIEW_CHARS);
    expect(intakeTextPreview(raw)).toBe(raw.slice(0, 40));
    expect(absorbItemsFromText('https://only.example/z')).toEqual([{ url: 'https://only.example/z' }]);
  });
});
