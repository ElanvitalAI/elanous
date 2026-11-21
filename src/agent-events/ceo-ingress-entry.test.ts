// CEO-CHANNEL-INGRESS ③ JUD hold #122410 + #122913 mustFix — RED first: bind the seen
// receipt to ACTUAL TURN INTAKE. The entry's socket answer HOLDS past the queue's drain-time
// `delivered` transition (that fires when the idle boundary hands the batch to the caller
// that submits it — BEFORE the turn accepts it) until the TUI's intake acknowledgement says
// a real turn took the frame as its input: queue-only → no answer (no 👀); drained but
// submission failed/cancelled → refusal (no 👀); cancelled/superseded while queued →
// refusal (no 👀); failed delivery (an unauthenticated producer) → the turn-input door never
// even opens (no 👀); accepted intake → exactly one answer(0) — the honest 👀.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CEO_INGRESS_PROTOCOL_VERSION, ENV_CEO_INGRESS_AUTH, ENV_CEO_INGRESS_SOCKET, ceoFrameAuth,
  type CeoIngressFrame,
} from './ceo-ingress.js';
import { wireCeoIngressEntry, type CeoIngressDoors } from './ceo-ingress-entry.js';
import { sendFrameOverSocket, type FrameAnswer } from './transport.js';

const SECRET = 'test-ceo-entry-secret-1';
const oneFrame = (over: Partial<CeoIngressFrame['event']> = {}): CeoIngressFrame => ({
  op: 'ceo', v: CEO_INGRESS_PROTOCOL_VERSION, ws: 'test-ws', seq: 1, at: 1732190000_000,
  event: { kind: 'ceo-message', source: 'telegram', sender: 'CEO-TG-1', threadId: 'tg-9', messageId: 'm-1', text: '지금 착지 몇 개?', ...over },
});

/** Manual doors: the entry's structural doors with the transition AND intake firing handed to the test. */
const manualDoors = () => {
  const landed: Array<{ id: string; text: string; source: string }> = [];
  const knocks: string[] = [];
  const listeners = new Set<(item: { id: string; status: 'delivered' | 'cancelled' | 'superseded' }) => void>();
  // #122913 — the intake ack channel: accepted/failed/cancelled of the REAL turn submission.
  const intakeListeners = new Set<(item: { id: string; status: 'accepted' | 'failed' | 'cancelled' }) => void>();
  const doors: CeoIngressDoors = {
    enqueueNotice: (text, source) => {
      const id = `q${landed.length + 1}`;
      landed.push({ id, text, source });
      return { id };
    },
    knock: () => { knocks.push('knock'); },
    onTransition: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onIntake: (listener) => { intakeListeners.add(listener); return () => { intakeListeners.delete(listener); }; },
  };
  return {
    doors, landed, knocks,
    fire: (id: string, status: 'delivered' | 'cancelled' | 'superseded') => { for (const l of listeners) l({ id, status }); },
    intake: (id: string, status: 'accepted' | 'failed' | 'cancelled') => { for (const l of intakeListeners) l({ id, status }); },
  };
};

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('CEO ingress entry — the socket answer rides ACTUAL TURN INTAKE (JUD hold #122410 + #122913 mustFix)', () => {
  test('queue-only → 답 없음(👀 경로 0) — enqueue+knock 대기만으로는 소비 영수가 나오지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-entry-'));
    const socketPath = join(dir, 'op-ceo-ingress.sock');
    const d = manualDoors();
    const listener = await wireCeoIngressEntry({ [ENV_CEO_INGRESS_SOCKET]: socketPath, [ENV_CEO_INGRESS_AUTH]: SECRET }, d.doors);
    expect(listener).toBeDefined();
    try {
      let answer: FrameAnswer | undefined;
      const base = oneFrame();
      void sendFrameOverSocket(socketPath, { ...base, auth: ceoFrameAuth(base, SECRET) }, { answerTimeoutMs: 2_000 })
        .then((a) => { answer = a; });
      await settle(250);
      expect(d.landed.length).toBe(1);   // the frame landed as a queued turn-input notice…
      expect(d.knocks.length).toBe(1);   // …and knocked the idle door
      await settle(250);
      expect(answer).toBeUndefined();    // queue-only: no answer — 👀 never at queue time
    } finally { await listener!.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('drain(delivered 전환) → 아직 답 없음 → 제출 수락(intake accepted) → 답 1회(0) — 👀는 실제 터 입력 수락 시점', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-entry-'));
    const socketPath = join(dir, 'op-ceo-ingress.sock');
    const d = manualDoors();
    const listener = await wireCeoIngressEntry({ [ENV_CEO_INGRESS_SOCKET]: socketPath, [ENV_CEO_INGRESS_AUTH]: SECRET }, d.doors);
    expect(listener).toBeDefined();
    try {
      let answer: FrameAnswer | undefined;
      const base = oneFrame();
      const sent = sendFrameOverSocket(socketPath, { ...base, auth: ceoFrameAuth(base, SECRET) }, { answerTimeoutMs: 2_000 })
        .then((a) => { answer = a; return a; });
      await settle(250);
      expect(answer).toBeUndefined();               // BEFORE consumption: the answer is held
      d.fire(d.landed[0]!.id, 'delivered');         // #122913 — the idle boundary DRAINED it (batch handed to the caller)
      await settle(150);
      expect(answer).toBeUndefined();               // …drain is NOT intake: the answer is STILL held
      d.intake(d.landed[0]!.id, 'accepted');        // the turn really accepted it as its input
      const a = await sent;
      expect(a.exitCode).toBe(0);                   // exactly one answer(0) — the honest 👀 moment
      expect(a.message).toBe('ok');
      await settle(200);
      expect(answer).toEqual(a);                   // …and it stays one (no second answer)
    } finally { await listener!.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('#122913 — dequeue(delivered) → 제출 실패(intake failed) → 거부 답(👀 경로 0): 드레인은 수락이 아니다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-entry-'));
    const socketPath = join(dir, 'op-ceo-ingress.sock');
    const d = manualDoors();
    const listener = await wireCeoIngressEntry({ [ENV_CEO_INGRESS_SOCKET]: socketPath, [ENV_CEO_INGRESS_AUTH]: SECRET }, d.doors);
    expect(listener).toBeDefined();
    try {
      const base = oneFrame();
      const sent = sendFrameOverSocket(socketPath, { ...base, auth: ceoFrameAuth(base, SECRET) }, { answerTimeoutMs: 2_000 });
      await settle(250);
      expect(d.landed.length).toBe(1);
      d.fire(d.landed[0]!.id, 'delivered');         // dequeued into the caller's batch…
      await settle(100);
      d.intake(d.landed[0]!.id, 'failed');          // …but the turn submission FAILED — never accepted
      const a = await sent;
      expect(a.exitCode).toBe(1);                  // refusal — never a 👀
      expect(a.message).toContain('failed');
    } finally { await listener!.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('#122913 — dequeue(delivered) → 제출 취소(intake cancelled) → 거부 답(👀 경로 0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-entry-'));
    const socketPath = join(dir, 'op-ceo-ingress.sock');
    const d = manualDoors();
    const listener = await wireCeoIngressEntry({ [ENV_CEO_INGRESS_SOCKET]: socketPath, [ENV_CEO_INGRESS_AUTH]: SECRET }, d.doors);
    expect(listener).toBeDefined();
    try {
      const base = oneFrame({ messageId: 'm-2' });
      const sent = sendFrameOverSocket(socketPath, { ...base, auth: ceoFrameAuth(base, SECRET) }, { answerTimeoutMs: 2_000 });
      await settle(250);
      expect(d.landed.length).toBe(1);
      d.fire(d.landed[0]!.id, 'delivered');         // dequeued…
      await settle(100);
      d.intake(d.landed[0]!.id, 'cancelled');      // …but the submission was CANCELLED before intake
      const a = await sent;
      expect(a.exitCode).toBe(1);                  // refusal — never a 👀
      expect(a.message).toContain('cancelled');
    } finally { await listener!.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('cancelled/superseded(대기 중) → 거부 답(👀 경로 0) — 대기 항목이 취소·대체된 것은 소비가 아니다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-entry-'));
    const socketPath = join(dir, 'op-ceo-ingress.sock');
    const d = manualDoors();
    const listener = await wireCeoIngressEntry({ [ENV_CEO_INGRESS_SOCKET]: socketPath, [ENV_CEO_INGRESS_AUTH]: SECRET }, d.doors);
    expect(listener).toBeDefined();
    try {
      const first = oneFrame();
      const sent1 = sendFrameOverSocket(socketPath, { ...first, auth: ceoFrameAuth(first, SECRET) }, { answerTimeoutMs: 2_000 });
      await settle(200);
      expect(d.landed.length).toBe(1);
      d.fire(d.landed[0]!.id, 'cancelled');        // the person cancelled the queued frame
      const a1 = await sent1;
      expect(a1.exitCode).toBe(1);                  // refusal — never a 👀
      expect(a1.message).toContain('cancelled');

      const second = oneFrame({ messageId: 'm-2' });
      const sent2 = sendFrameOverSocket(socketPath, { ...second, auth: ceoFrameAuth(second, SECRET) }, { answerTimeoutMs: 2_000 });
      await settle(200);
      expect(d.landed.length).toBe(2);
      d.fire(d.landed[1]!.id, 'superseded');       // superseded by a newer frame — not consumed either
      const a2 = await sent2;
      expect(a2.exitCode).toBe(1);
      expect(a2.message).toContain('superseded');
    } finally { await listener!.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('failed delivery(비인증 생산자) → 턴 입력 문 0 — enqueue/knock 없이 거부 답', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-entry-'));
    const socketPath = join(dir, 'op-ceo-ingress.sock');
    const d = manualDoors();
    // the listener carries THIS tab's secret; the producer signs with another → fail-closed.
    const listener = await wireCeoIngressEntry({ [ENV_CEO_INGRESS_SOCKET]: socketPath, [ENV_CEO_INGRESS_AUTH]: SECRET }, d.doors);
    expect(listener).toBeDefined();
    try {
      const forged = oneFrame();
      const a = await sendFrameOverSocket(socketPath, { ...forged, auth: ceoFrameAuth(forged, 'another-secret') }, { answerTimeoutMs: 2_000 });
      expect(a.exitCode).toBe(1);                  // refused before the turn-input hook
      expect(a.message).toContain('unauthorized');
      expect(d.landed.length).toBe(0);             // the door never opened
      expect(d.knocks.length).toBe(0);
    } finally { await listener!.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});