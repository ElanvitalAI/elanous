/**
 * ELN-SEAT-APPROVAL-POLICY r4 — 자리몫 승인 «절차» 시험. 판정표(56줄)는 src/security/shell-argv-policy.test.ts 로
 * 옮겼다(이동+증가); 여기는 자동 승인 게이트 · earlier-wins(자판 vs OP) · OP 우편 원장 · OP 허용 목록 파일
 * (버전·잠금·tombstone, Bloom 5 ⑥) 을 검사한다. 기대값은 독립 리터럴(규칙 11).
 */
import { createHash } from 'node:crypto';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APPROVAL_APPROVED, type ApprovalOutcome } from '../graph-runner/approval-outcome.js';
import { MsgStore } from '../msg/msg-store.js';
import { createSeatApprovalHandler, seatApprovalDecision, seatApprovalLedgerPorts, type SeatApprovalPorts } from './seat-approval-policy.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('seatApprovalDecision — 기본 거부 스키 (판정표는 shell-argv-policy.test.ts)', () => {
  test('목록 모양과 정확히 일치할 때만 자동 승인', () => {
    const decision = seatApprovalDecision('git status', 'bash');
    if (decision.decision !== 'allow') throw new Error(`expected allow, got ${JSON.stringify(decision)}`);
    expect(decision.rule).toBe('git-read');
  });

  test('모르는 명령은 자동 승인이 없다 — OP 로', () => {
    const decision = seatApprovalDecision('unknown-tool --flag x', 'bash');
    if (decision.decision !== 'ask-op') throw new Error('expected ask-op');
    expect(decision.reason).toBe('not on the seat allowlist: unknown-tool');
  });
});

describe('createSeatApprovalHandler — earlier wins (자판 vs OP)', () => {
  interface Harness { readonly ports: SeatApprovalPorts; readonly log: [string, Record<string, unknown>][]; readonly status: string[]; readonly bodies: string[]; readonly cancelled: string[] }
  const harness = (over: Partial<SeatApprovalPorts> = {}): Harness => {
    const log: [string, Record<string, unknown>][] = [];
    const status: string[] = [];
    const bodies: string[] = [];
    const cancelled: string[] = [];
    const ports: SeatApprovalPorts = {
      seat: 'MVP-B',
      local: async () => ({ approved: false, reason: 'timeout' }),
      cancelLocal: callId => { cancelled.push(callId); },
      postRequest: body => { bodies.push(body); return 1; },
      readDecision: () => null,
      setStatus: line => { status.push(line); },
      log: (event, data) => { log.push([event, data]); },
      pollMs: 1,
      ...over,
    };
    return { ports, log, status, bodies, cancelled };
  };

  test('자동 승인 — auto-approved 로그 · status 한 줄', async () => {
    const h = harness();
    const outcome = await createSeatApprovalHandler(h.ports)('git status', 'c1', 'bash');
    expect(outcome).toEqual(APPROVAL_APPROVED);
    expect(h.status[0]).toBe('자리 허용 목록 자동 승인 · git-read');
    const auto = h.log.find(([event]) => event === 'auto-approved');
    expect(auto?.[1]).toMatchObject({ seat: 'MVP-B', callId: 'c1', rule: 'git-read' });
    expect(h.cancelled).toEqual([]);
    expect(h.bodies).toEqual([]);
  });

  test('모양 밖 → OP 우편 · 자판 폴백 (decided: keyboard)', async () => {
    const h = harness();
    const outcome = await createSeatApprovalHandler(h.ports)('git push origin main', 'c2', 'bash');
    expect(outcome).toEqual({ approved: false, reason: 'timeout' });
    expect(h.bodies[0]).toContain('이유 not on the seat allowlist: git push');
    const asked = h.log.find(([event]) => event === 'asked-op');
    expect(asked?.[1]).toMatchObject({ seat: 'MVP-B', callId: 'c2', mailId: 1 });
    const decided = h.log.find(([event]) => event === 'decided');
    expect(decided?.[1]).toMatchObject({ source: 'keyboard', approved: false });
  });

  test('OP 승인 영수증이 이기면 — 승인 · 자판 취소 · status', async () => {
    const h = harness({ local: () => new Promise<ApprovalOutcome>(() => {}), readDecision: () => ({ approved: true, atMs: 1 }) });
    const outcome = await createSeatApprovalHandler(h.ports)('git push origin main', 'c3', 'bash');
    expect(outcome).toEqual(APPROVAL_APPROVED);
    expect(h.cancelled).toEqual(['c3']);
    expect(h.status.at(-1)).toBe('OP 승인 (#1)');
    const decided = h.log.find(([event]) => event === 'decided');
    expect(decided?.[1]).toMatchObject({ source: 'op', approved: true, mailId: 1 });
  });

  test('OP 거부 영수증 → 거부', async () => {
    const h = harness({ local: () => new Promise<ApprovalOutcome>(() => {}), readDecision: () => ({ approved: false, atMs: 1 }) });
    const outcome = await createSeatApprovalHandler(h.ports)('rm -rf build', 'c4', 'bash');
    expect(outcome).toEqual({ approved: false, reason: 'declined' });
    expect(h.status.at(-1)).toBe('OP 거부 (#1)');
  });

  test('자판 승인이 먼저면 — OP 대기 없이 승인 (자판)', async () => {
    const h = harness({ local: async () => APPROVAL_APPROVED });
    const outcome = await createSeatApprovalHandler(h.ports)('git push origin main', 'c5', 'bash');
    expect(outcome).toEqual(APPROVAL_APPROVED);
    expect(h.cancelled).toEqual([]);
    const decided = h.log.find(([event]) => event === 'decided');
    expect(decided?.[1]).toMatchObject({ source: 'keyboard', approved: true });
  });

  test('Terra ⑤ — 자판이 timeout 한 뒤 늦게 읽힌 OP 승인 영수증이 이긴다', async () => {
    let keyboardDone = false;
    const h = harness({
      local: async () => { await new Promise(resolve => setTimeout(resolve, 10)); keyboardDone = true; return { approved: false, reason: 'timeout' }; },
      readDecision: () => (keyboardDone ? { approved: true, atMs: 0 } : null),
    });
    const outcome = await createSeatApprovalHandler(h.ports)('git push origin main', 'c6', 'bash');
    expect(outcome).toEqual(APPROVAL_APPROVED);
    expect(h.cancelled).toEqual(['c6']);
    const decided = h.log.find(([event]) => event === 'decided');
    expect(decided?.[1]).toMatchObject({ source: 'op', approved: true });
  });

  test('op-decision-read-failed — 읽기 실패는 warn 1회 · 절차는 계속', async () => {
    const h = harness({ readDecision: () => { throw new Error('ledger down'); } });
    const outcome = await createSeatApprovalHandler(h.ports)('git push origin main', 'c7', 'bash');
    expect(outcome).toEqual({ approved: false, reason: 'timeout' });
    const warns = h.log.filter(([event]) => event === 'op-decision-read-failed');
    expect(warns.length).toBe(1);
    expect(warns[0]?.[1]).toMatchObject({ seat: 'MVP-B', callId: 'c7', mailId: 1 });
    expect(String(warns[0]?.[1].error)).toContain('ledger down');
  });

  test('postRequest 실패 → ask-op-failed warn · 자판 폴백', async () => {
    const h = harness({ postRequest: () => { throw new Error('post office down'); } });
    const outcome = await createSeatApprovalHandler(h.ports)('git push origin main', 'c8', 'bash');
    expect(outcome).toEqual({ approved: false, reason: 'timeout' });
    const failed = h.log.find(([event]) => event === 'ask-op-failed');
    expect(failed?.[1]).toMatchObject({ seat: 'MVP-B', callId: 'c8' });
    expect(String(failed?.[1].error)).toContain('post office down');
    expect(h.log.find(([event]) => event === 'decided')).toBe(undefined);
  });

  test('Terra ④ — OP 우편 본문에 원문 인자 없이 이유·명령 이름·sha256 만 (조항 5)', async () => {
    const command = 'deploy "--password" hunter2';
    const h = harness();
    const outcome = await createSeatApprovalHandler(h.ports)(command, 'c9', 'bash');
    expect(outcome).toEqual({ approved: false, reason: 'timeout' });
    const body = h.bodies[0]!;
    expect(body).toContain('[승인 요청 · MVP-B]');
    expect(body).toContain('이유 credential');
    expect(body).toContain('명령 이름: deploy');
    expect(body).toContain(`sha256:${sha256(command)}`);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('--password');
    const asked = h.log.find(([event]) => event === 'asked-op');
    expect(String(JSON.stringify(asked?.[1]))).not.toContain('hunter2');
  });
});

describe('seatApprovalLedgerPorts — 실제 우편 원장 · OP 허용 목록 파일 (Bloom 5 ⑥)', () => {
  let fx: string;
  let msgPath: string;
  beforeEach(() => {
    fx = mkdtempSync(join(tmpdir(), 'seat-approval-test-'));
    msgPath = join(fx, 'msg', 'msg.db');
  });
  afterEach(() => { rmSync(fx, { recursive: true, force: true }); });

  const opAllowFile = (): string => join(fx, 'OP', 'approval-allow', 'MVP-B');
  const writeList = (version: number, body: string): void => {
    const canonical = `version ${version}\n${body}`;
    mkdirSync(dirname(opAllowFile()), { recursive: true });
    writeFileSync(opAllowFile(), `${canonical}\nlock ${sha256(canonical)}\n`);
  };
  const eventsSink = (): { events: [string, Record<string, unknown>][]; log: (event: string, data: Record<string, unknown>) => void } => {
    const events: [string, Record<string, unknown>][] = [];
    return { events, log: (event, data) => { events.push([event, data]); } };
  };

  test('postRequest → 실제 원장 request 우편 (자리 → OP)', () => {
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath });
    const id = ports.postRequest('[승인 요청 테스트] 본문');
    const store = new MsgStore(msgPath);
    try {
      const got = store.listByRecipient('OP').at(-1)!;
      expect(got.id).toBe(id);
      expect(got.from).toBe('MVP-B');
      expect(got.to).toBe('OP');
      expect(got.intent).toBe('request');
      expect(got.body).toBe('[승인 요청 테스트] 본문');
    } finally { store.close(); }
  });

  test('readDecision — OP accepted/rejected 영수증 · 없으면 null', () => {
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath });
    const id = ports.postRequest('body-a');
    expect(ports.readDecision(id)).toBe(null);
    const store = new MsgStore(msgPath);
    try {
      store.recordReceipt({ messageId: id, recipient: 'OP', state: 'accepted', source: 'cli' });
      const decision = ports.readDecision(id)!;
      expect(decision.approved).toBe(true);
      // atMs 는 Date.parse 결과 — 숫자 상한 없이 «유효 타임스탬프»만 단언한다 (NUMGUARD)
      expect(Number.isFinite(decision.atMs)).toBe(true);
      const secondId = ports.postRequest('body-b');
      store.recordReceipt({ messageId: secondId, recipient: 'OP', state: 'rejected', source: 'cli', reason: 'unsafe' });
      expect(ports.readDecision(secondId)!.approved).toBe(false);
    } finally { store.close(); }
  });

  test('readDecision — 다른 우편의 OP 승인 영수증은 다른 요청을 승인 못 한다', () => {
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath });
    const id = ports.postRequest('body-c');
    const other = ports.postRequest('body-d');
    const store = new MsgStore(msgPath);
    try {
      store.recordReceipt({ messageId: other, recipient: 'OP', state: 'accepted', source: 'cli' });
      expect(ports.readDecision(id)).toBe(null);
      expect(ports.readDecision(other)?.approved).toBe(true);
    } finally { store.close(); }
  });

  test('extraAllowShapes — OP 목록 모양이 자동 승인을 넓힌다 (없으면 기본 거부)', () => {
    writeList(1, 'allow seat-demo demo-tool run');
    const { events, log } = eventsSink();
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath, seatStateRoot: fx, log });
    const shapes = (ports.extraAllowShapes?.() ?? []);
    expect(shapes.map(shape => shape.id)).toEqual(['seat-demo']);
    expect(seatApprovalDecision('demo-tool run', 'bash', shapes).decision).toBe('allow');
    expect(seatApprovalDecision('demo-tool run', 'bash').decision).toBe('ask-op');
    expect(seatApprovalDecision('demo-tool run --x', 'bash', shapes).decision).toBe('ask-op');
    expect(events).toEqual([]);
  });

  test('목록 파일이 없으면 [] · 보고도 없다', () => {
    const { events, log } = eventsSink();
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath, seatStateRoot: fx, log });
    expect((ports.extraAllowShapes?.() ?? [])).toEqual([]);
    expect(events).toEqual([]);
  });

  test('자기 폴더 안의 허용 파일은 무시·보고 (allow-file-ignored)', () => {
    writeList(1, 'allow seat-demo demo-tool run');
    const own = join(fx, 'MVP-B', 'approval-allow');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'x'), 'version 1\nallow bad git push origin main\nlock 0\n');
    const { events, log } = eventsSink();
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath, seatStateRoot: fx, log });
    const shapes = (ports.extraAllowShapes?.() ?? []);
    expect(shapes.map(shape => shape.id)).toEqual(['seat-demo']);
    const ignored = events.find(([event]) => event === 'allow-file-ignored')?.[1];
    expect(ignored?.path).toBe(own);
    expect(String(ignored?.reason)).toContain('seat-own-folder');
  });

  test('잠금 불일치 목록 → 거부·보고', () => {
    mkdirSync(dirname(opAllowFile()), { recursive: true });
    writeFileSync(opAllowFile(), `version 1\nallow seat-demo demo-tool run\nlock ${'0'.repeat(64)}\n`);
    const { events, log } = eventsSink();
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath, seatStateRoot: fx, log });
    expect((ports.extraAllowShapes?.() ?? [])).toEqual([]);
    const ignored = events.find(([event]) => event === 'allow-file-ignored')?.[1];
    expect(String(ignored?.reason)).toContain('lock mismatch');
  });

  test('version 줄 없는 목록 → 거부·보고 (unreadable allow list)', () => {
    mkdirSync(dirname(opAllowFile()), { recursive: true });
    writeFileSync(opAllowFile(), 'allow seat-demo demo-tool run\nlock 0\n');
    const { events, log } = eventsSink();
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath, seatStateRoot: fx, log });
    expect((ports.extraAllowShapes?.() ?? [])).toEqual([]);
    const ignored = events.find(([event]) => event === 'allow-file-ignored')?.[1];
    expect(String(ignored?.reason)).toContain('unreadable allow list');
  });

  test('심볼릭 링크 목록 → 거부·보고 (symlink)', () => {
    mkdirSync(dirname(opAllowFile()), { recursive: true });
    writeFileSync(join(fx, 'target'), 'version 1\nallow seat-demo demo-tool run\nlock 0\n');
    symlinkSync(join(fx, 'target'), opAllowFile());
    const { events, log } = eventsSink();
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath, seatStateRoot: fx, log });
    expect((ports.extraAllowShapes?.() ?? [])).toEqual([]);
    const ignored = events.find(([event]) => event === 'allow-file-ignored')?.[1];
    expect(String(ignored?.reason)).toBe('symlink');
  });

  test('목록 버전이 뒤로 밀리면 거부·보고 (단조 증가)', () => {
    const { events, log } = eventsSink();
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath, seatStateRoot: fx, log });
    writeList(3, 'allow seat-demo demo-tool run');
    expect((ports.extraAllowShapes?.() ?? []).map(shape => shape.id)).toEqual(['seat-demo']);
    writeList(2, 'allow seat-demo demo-tool run');
    expect((ports.extraAllowShapes?.() ?? [])).toEqual([]);
    const ignored = events.find(([event]) => event === 'allow-file-ignored')?.[1];
    expect(String(ignored?.reason)).toContain('went backwards');
  });

  test('철회 tombstone 이 되살아나면 거부·보고', () => {
    const { events, log } = eventsSink();
    const ports = seatApprovalLedgerPorts('MVP-B', { msgPath, seatStateRoot: fx, log });
    writeList(1, 'allow seat-demo demo-tool run');
    expect((ports.extraAllowShapes?.() ?? []).map(shape => shape.id)).toEqual(['seat-demo']);
    writeList(2, 'revoke seat-demo 2');
    expect((ports.extraAllowShapes?.() ?? [])).toEqual([]);
    writeList(3, 'allow seat-demo demo-tool run');
    expect((ports.extraAllowShapes?.() ?? [])).toEqual([]);
    const ignored = events.find(([event]) => event === 'allow-file-ignored')?.[1];
    expect(String(ignored?.reason)).toContain('resurrected');
  });
});
