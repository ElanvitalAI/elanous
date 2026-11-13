import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleScraps, type ScrapsRouteOptions } from './scraps.js';
import { listAbsorbScraps } from '../../intake-plane/items.js';

function world() {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'scrap-stt-retry-'));
  const options: ScrapsRouteOptions = {
    instanceRoot, resolveOwner: async () => ({ memberId: 'member-a' }),
    extractors: {}, now: () => new Date('2026-11-13T00:00:00.000Z'),
  };
  return { options, close: () => rmSync(instanceRoot, { recursive: true, force: true }) };
}

function create(key: string, raw: Record<string, unknown>): Request {
  return new Request('http://nexus.test/v1/scraps', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ kind: 'voice', source: 'android-record', raw }),
  });
}

describe('voice STT and same-member recovery', () => {
  test('accepts a device transcript without a server STT adapter, preserving the summary field', async () => {
    const fixture = world();
    try {
      const response = await handleScraps(create('device-transcript-0001', {
        text: '기기 요약', transcript: '첫 강의 내용. 다음 주제.', mediaRef: 'scraps/device-voice',
      }), fixture.options);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ status: 'absorbed', raw: {
        text: '기기 요약', transcript: '첫 강의 내용. 다음 주제.',
      }, extractedBody: '첫 강의 내용. 다음 주제.' });
      expect((await handleScraps(create('invalid-transcript-0001', {
        mediaRef: 'scraps/device-voice', transcript: ' ',
      }), fixture.options)).status).toBe(400);
    } finally { fixture.close(); }
  });

  test('retries a failed recorded note by its server ID without a second create', async () => {
    const fixture = world();
    let transcriptions = 0;
    try {
      const options: ScrapsRouteOptions = { ...fixture.options, extractors: {
        transcribeAudio: async () => { if (++transcriptions === 1) throw new Error('STT offline'); return '복구된 전사'; },
      } };
      const first = await handleScraps(create('recorded-retry-0001', { mediaRef: 'scraps/recorded-audio' }), options);
      expect(first.status).toBe(502);
      const failed = await first.json() as { id: string; raw: { mediaRef: string } };
      expect(failed.raw.mediaRef).toBe('member-a/scraps/recorded-audio');
      const retry = () => new Request(`http://nexus.test/v1/scraps/${failed.id}/retry`, { method: 'POST' });
      const otherMember = await handleScraps(retry(), { ...options, resolveOwner: async () => ({ memberId: 'member-b' }) });
      expect(otherMember.status).toBe(404);
      const recovered = await handleScraps(retry(), options);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ id: failed.id, status: 'absorbed', raw: failed.raw });
      expect(transcriptions).toBe(2);
      expect((await handleScraps(retry(), options)).status).toBe(200);
    } finally { fixture.close(); }
  });

  test('returns the same completed receipt after the first retry response is lost', async () => {
    const fixture = world();
    let transcriptions = 0;
    try {
      const options: ScrapsRouteOptions = { ...fixture.options, extractors: {
        transcribeAudio: async () => { if (++transcriptions === 1) throw new Error('STT offline'); return '한 번 복구된 전사'; },
      } };
      const first = await handleScraps(create('lost-retry-response-0001', { mediaRef: 'scraps/recorded-audio' }), options);
      expect(first.status).toBe(502);
      const failed = await first.json() as { id: string };
      const retry = () => new Request(`http://nexus.test/v1/scraps/${failed.id}/retry`, { method: 'POST' });
      // The server finishes processing, but the device never receives this response.
      expect((await handleScraps(retry(), options)).status).toBe(200);
      const recovered = await handleScraps(retry(), options);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ id: failed.id, status: 'absorbed', extractedBody: '한 번 복구된 전사' });
      expect(transcriptions).toBe(2);
      const list = await handleScraps(new Request('http://nexus.test/v1/scraps'), options);
      const body = await list.json() as { scraps: Array<{ id: string }> };
      expect(body.scraps.map((scrap) => scrap.id)).toEqual([failed.id]);
      expect((await handleScraps(retry(), { ...options, resolveOwner: async () => ({ memberId: 'member-b' }) })).status).toBe(404);
    } finally { fixture.close(); }
  });

  test('replays settlement after a completed extraction loses its first settlement callback', async () => {
    const fixture = world();
    let settlements = 0;
    let transcriptions = 0;
    try {
      const options: ScrapsRouteOptions = { ...fixture.options,
        extractors: { transcribeAudio: async () => { transcriptions += 1; return '한 번 전사'; } },
        onSettled: async () => {
          settlements += 1;
          if (settlements === 1) throw new Error('event delivery offline');
        },
      };
      await expect(handleScraps(create('settlement-replay-0001', {
        mediaRef: 'scraps/recorded-audio',
      }), options)).rejects.toThrow('event delivery offline');
      const [saved] = listAbsorbScraps(fixture.options.instanceRoot, 'member-a');
      expect(saved?.absorb?.status).toBe('absorbed');
      const retry = new Request(`http://nexus.test/v1/scraps/${saved!.id}/retry`, { method: 'POST' });
      const recovered = await handleScraps(retry, options);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ id: saved!.id, status: 'absorbed' });
      expect(settlements).toBe(2);
      expect(transcriptions).toBe(1);
      expect(listAbsorbScraps(fixture.options.instanceRoot, 'member-a')).toHaveLength(1);
    } finally { fixture.close(); }
  });

  test('restarts a persisted extracting recording after the server process exits', async () => {
    const fixture = world();
    const childSource = `
      import { handleScraps } from './src/nexus/api/scraps.ts';
      const request = new Request('http://nexus.test/v1/scraps', { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'restart-extracting-0001' },
        body: JSON.stringify({ kind: 'voice', source: 'android-record', raw: { mediaRef: 'scraps/recorded-audio' } }),
      });
      void handleScraps(request, { instanceRoot: process.env.SCRAP_RESTART_ROOT!,
        resolveOwner: async () => ({ memberId: 'member-a' }),
        extractors: { transcribeAudio: async () => new Promise<string>(() => {}) },
      });
      setInterval(() => {}, 1000);
    `;
    const child = Bun.spawn([process.execPath, '-e', childSource], {
      cwd: process.cwd(), env: { ...process.env, SCRAP_RESTART_ROOT: fixture.options.instanceRoot },
      stdout: 'ignore', stderr: 'ignore',
    });
    try {
      const deadline = Date.now() + 5_000;
      let pending = listAbsorbScraps(fixture.options.instanceRoot, 'member-a').find((item) => item.absorb?.status === 'extracting');
      while (!pending && Date.now() < deadline) {
        await Bun.sleep(20);
        pending = listAbsorbScraps(fixture.options.instanceRoot, 'member-a').find((item) => item.absorb?.status === 'extracting');
      }
      expect(pending?.absorb?.status).toBe('extracting');
      const id = pending!.id;
      child.kill();
      await child.exited;
      let transcriptions = 0;
      const options: ScrapsRouteOptions = { ...fixture.options, extractors: {
        transcribeAudio: async () => { transcriptions += 1; return '재시작 뒤 복구된 전사'; },
      } };
      const retry = () => new Request(`http://nexus.test/v1/scraps/${id}/retry`, { method: 'POST' });
      expect((await handleScraps(retry(), { ...options, resolveOwner: async () => ({ memberId: 'member-b' }) })).status).toBe(404);
      const recovered = await handleScraps(retry(), options);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ id, status: 'absorbed', extractedBody: '재시작 뒤 복구된 전사' });
      expect(transcriptions).toBe(1);
      expect(listAbsorbScraps(fixture.options.instanceRoot, 'member-a').map((item) => item.id)).toEqual([id]);
      expect((await handleScraps(retry(), options)).status).toBe(200);
    } finally { child.kill(); await child.exited; fixture.close(); }
  });

  test('refuses a duplicate retry while the same process is still extracting', async () => {
    const fixture = world();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const extracting = new Promise<void>((resolve) => { started = resolve; });
    let transcriptions = 0;
    try {
      const options: ScrapsRouteOptions = { ...fixture.options, extractors: {
        transcribeAudio: async () => { transcriptions += 1; started(); await gate; return '한 번만 전사'; },
      } };
      const first = handleScraps(create('active-extracting-0001', { mediaRef: 'scraps/recorded-audio' }), options);
      await extracting;
      const [item] = listAbsorbScraps(fixture.options.instanceRoot, 'member-a');
      expect(item?.absorb?.status).toBe('extracting');
      const retry = new Request(`http://nexus.test/v1/scraps/${item!.id}/retry`, { method: 'POST' });
      expect((await handleScraps(retry, options)).status).toBe(409);
      expect((await handleScraps(create('active-extracting-0001', { mediaRef: 'scraps/recorded-audio' }), options)).status).toBe(409);
      release();
      expect((await first).status).toBe(201);
      expect(transcriptions).toBe(1);
    } finally { release(); fixture.close(); }
  });

  test('holds one flight across a delayed receipt and same-key POST replay', async () => {
    const fixture = world();
    let releaseReceipt!: () => void;
    let receiptStarted!: () => void;
    const receiptGate = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    const accepted = new Promise<void>((resolve) => { receiptStarted = resolve; });
    let transcriptions = 0;
    try {
      const options: ScrapsRouteOptions = { ...fixture.options,
        onAccepted: async () => { receiptStarted(); await receiptGate; },
        extractors: { transcribeAudio: async () => { transcriptions += 1; return '한 번만 전사'; } },
      };
      const request = () => create('receipt-overlap-0001', { mediaRef: 'scraps/recorded-audio' });
      const original = handleScraps(request(), options);
      await accepted;
      const [pending] = listAbsorbScraps(fixture.options.instanceRoot, 'member-a');
      expect(pending?.absorb?.status).toBe('new');
      const replayDuringReceipt = await handleScraps(request(), options);
      expect(replayDuringReceipt.status).toBe(409);
      expect(transcriptions).toBe(0);
      releaseReceipt();
      const first = await original;
      expect(first.status).toBe(201);
      const firstBody = await first.json() as { id: string; status: string };
      expect(firstBody.status).toBe('absorbed');
      const replayAfter = await handleScraps(request(), options);
      expect(replayAfter.status).toBe(200);
      expect((await replayAfter.json() as { id: string }).id).toBe(firstBody.id);
      expect(transcriptions).toBe(1);
      expect(listAbsorbScraps(fixture.options.instanceRoot, 'member-a').map((item) => item.id)).toEqual([firstBody.id]);
    } finally { releaseReceipt(); fixture.close(); }
  });
});
