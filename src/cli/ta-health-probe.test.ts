// TA-HEALTH-NORMAL-PROBE 시험 — ROSTER-0334 완료선(«증거 = 운영 우주 원장 + 합성 사망 사건 1(음성 대조)» · 시험 1).
// 합성 원장 fixture(run-ledger ⊕ resource-ledger ⊕ task-cards)로 프로브 줄·음성 대조·정상화 판정을 증명.
// r2 수리 시험(판정본 jud-39689-9d11d6eef18b · JUD-2 hold mustFix ①②):
//   ① 발사 성공은 같은 발사의 실제 child-first-llm-call 결과만 집계 — 첫 LLM error 후 tool ok 만 있는 샘플은 RED(음성).
//   ② 원장 부재는 0건이 아니라 미관측(observed=false → RED) ⊕ 정상화는 관측된 서로 다른 연속 UTC 시간 3줄만 인정.
// r3 수리 시험(판정본 jud-39689-a0e49b45e34f · JUD-2 hold 잔여 mustFix ②):
//   완료된 UTC 시간만 정상화에 사용(진행 중 현재·미래 거부 — 완료 시각 경계 퇴행 입증) ⊕
//   기본 CLI 는 직전 완료 시간 출력 ⊕ 실제 매시 관측 경로 → 3시간 판정 연결 입증.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { formatTaHealthLine, isCompletedHour, isNormalized, lastCompletedHour, observeHourly, probeHour, type TaHealthHourLine } from './ta-health-probe.js';

const HOUR = '2026-11-22T23'; // 합성 시간 — 실 운영 원장과 무관
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** 관측된 원장 fixture — 세 원장(run·resource·cards) 전부 실재해야 그 시간은 관측됨(mustFix ②). */
function ledger(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mvpb-tahealth-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'run-ledger'), { recursive: true });
  mkdirSync(join(dir, 'resource-ledger'), { recursive: true });
  writeFileSync(join(dir, 'resource-ledger', 'events.jsonl'), ''); // 빈 자원 원장 = 관측됨 · 사망 0
  mkdirSync(join(dir, 'task-cards'), { recursive: true });
  const db = new Database(join(dir, 'task-cards', 'index.db'));
  // 출처: 실 index.db cards 표 스키마(task-cards/index.db .schema 원문)
  db.run('CREATE TABLE cards (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'open\', created_at TEXT NOT NULL)');
  db.close();
  return dir;
}

function run(root: string, id: string, events: Array<Record<string, unknown>>): void {
  writeFileSync(join(root, 'run-ledger', `run-${id}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function resource(root: string, event: string, at: string): void {
  writeFileSync(join(root, 'resource-ledger', 'events.jsonl'), JSON.stringify({ event, at }) + '\n');
}

function card(root: string, id: string, status: string, createdAt: string): void {
  const db = new Database(join(root, 'task-cards', 'index.db'));
  db.run('INSERT INTO cards (id, goal_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)', [id, id, id, status, createdAt]);
  db.close();
}

/** 합성 줄 — 시간은 UTC «YYYY-MM-DDTHH» 포맷(정상화 연속 판정이 파싱하는 형태) · 시간 값(21·22·23 등)은 전부 합성. */
function line(hour: string, green = true): TaHealthHourLine {
  return { hour, observed: true, launched: 0, reachedOk: 0, successRate: 1, resourceDeaths: 0, unlandedCards: 0, green };
}

describe('TA-HEALTH-NORMAL-PROBE(ROSTER-0334 완료선)', () => {
  test('깨끗한 시간: 발사 전부 ok · 자원 사망 0 · 미착 카드 0 → 관측됨 · GREEN', () => {
    const root = ledger();
    run(root, 'a', [
      { timestamp: `${HOUR}:01:00.000Z`, event: 'child-first-llm-call', data: { status: 'started' } },
      { timestamp: `${HOUR}:01:05.000Z`, event: 'child-first-llm-call', data: { status: 'ok' } },
    ]);
    resource(root, 'guardian-host-lease', `${HOUR}:02:00.000Z`); // 사망 아닌 자원 사건 — 음성
    const probed = probeHour(root, HOUR);
    expect(probed.observed).toBe(true);
    expect(probed.launched).toBe(1);
    expect(probed.reachedOk).toBe(1);
    expect(probed.successRate).toBe(1);
    expect(probed.resourceDeaths).toBe(0);
    expect(probed.unlandedCards).toBe(0);
    expect(probed.green).toBe(true);
  });

  test('합성 사망 사건 1(음성 대조): died 주입 → 사망 1로 세고 GREEN→RED', () => {
    const root = ledger();
    resource(root, 'ta-died', `${HOUR}:05:00.000Z`);
    const probed = probeHour(root, HOUR);
    expect(probed.observed).toBe(true);
    expect(probed.resourceDeaths).toBe(1);
    expect(probed.green).toBe(false);
  });

  test('발사 실패(started만 하고 ok 도달 없음) → 성공률 미달 · RED', () => {
    const root = ledger();
    run(root, 'stuck', [{ timestamp: `${HOUR}:03:00.000Z`, event: 'child-first-llm-call', data: { status: 'started' } }]);
    const probed = probeHour(root, HOUR);
    expect(probed.observed).toBe(true);
    expect(probed.launched).toBe(1);
    expect(probed.reachedOk).toBe(0);
    expect(probed.successRate).toBe(0);
    expect(probed.green).toBe(false);
  });

  test('경계 넘는 ok(다음 시간 타임스탬프)도 그 발사의 성공으로 센다', () => {
    const root = ledger();
    run(root, 'cross', [
      { timestamp: `${HOUR}:59:00.000Z`, event: 'child-first-llm-call', data: { status: 'started' } },
      { timestamp: '2026-11-23T00:01:00.000Z', event: 'child-first-llm-call', data: { status: 'ok' } },
    ]);
    const probed = probeHour(root, HOUR);
    expect(probed.observed).toBe(true);
    expect(probed.launched).toBe(1);
    expect(probed.reachedOk).toBe(1);
    expect(probed.green).toBe(true);
  });

  test('미착 카드(해당 시간 생성·open) → RED · 닫힌 카드는 미착 아님', () => {
    const root = ledger();
    card(root, 'pending', 'open', `${HOUR}:04:00.000Z`);
    card(root, 'done', 'closed', `${HOUR}:06:00.000Z`);
    const probed = probeHour(root, HOUR);
    expect(probed.observed).toBe(true);
    expect(probed.unlandedCards).toBe(1);
    expect(probed.green).toBe(false);
  });

  test('mustFix ①: 첫 LLM error 후 tool ok 만 있으면 발사 성공 아니다 — 같은 발사의 실제 child-first-llm-call 결과만 집계', () => {
    const root = ledger();
    run(root, 'toolok', [
      { timestamp: `${HOUR}:01:00.000Z`, event: 'child-first-llm-call', data: { status: 'started' } },
      { timestamp: `${HOUR}:01:30.000Z`, event: 'child-first-llm-call', data: { status: 'error' } },
      { timestamp: `${HOUR}:02:00.000Z`, event: 'tool-call', data: { status: 'ok' } },
    ]);
    const probed = probeHour(root, HOUR);
    expect(probed.launched).toBe(1);
    expect(probed.reachedOk).toBe(0); // tool 사건 ok 는 이 발사의 성공이 아님
    expect(probed.successRate).toBe(0);
    expect(probed.green).toBe(false);
  });

  test('mustFix ①(양성): child-first-llm-call ok 도달은 tool 사건과 섞여도 성공으로 센다', () => {
    const root = ledger();
    run(root, 'mixed', [
      { timestamp: `${HOUR}:01:00.000Z`, event: 'child-first-llm-call', data: { status: 'started' } },
      { timestamp: `${HOUR}:01:20.000Z`, event: 'tool-call', data: { status: 'ok' } },
      { timestamp: `${HOUR}:01:40.000Z`, event: 'child-first-llm-call', data: { status: 'ok' } },
    ]);
    const probed = probeHour(root, HOUR);
    expect(probed.reachedOk).toBe(1);
    expect(probed.green).toBe(true);
  });

  test('mustFix ②a: 원장 전부 부재(빈 우주)는 0건이 아니라 미관측 → observed=false · RED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvpb-tahealth-empty-')); // 세 원장 전부 부재 — 합성
    dirs.push(dir);
    const probed = probeHour(dir, HOUR);
    expect(probed.observed).toBe(false);
    expect(probed.launched).toBe(0);
    expect(probed.green).toBe(false);
  });

  test('mustFix ②a(부분): 카드 원장만 부재해도 그 시간은 미관측 → RED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvpb-tahealth-partial-')); // run·resource 실재, task-cards 부재 — 합성
    dirs.push(dir);
    mkdirSync(join(dir, 'run-ledger'), { recursive: true });
    mkdirSync(join(dir, 'resource-ledger'), { recursive: true });
    writeFileSync(join(dir, 'resource-ledger', 'events.jsonl'), '');
    const probed = probeHour(dir, HOUR);
    expect(probed.observed).toBe(false);
    expect(probed.green).toBe(false);
  });

  test('mustFix ②b: 정상화 = 관측된 서로 다른 연속 UTC 시간 3줄만 — 간격·중복·미관측·짧음·형식 오류는 거부', () => {
    expect(isNormalized([line('2026-11-22T21'), line('2026-11-22T22'), line('2026-11-22T23')])).toBe(true); // 연속
    expect(isNormalized([line('2026-11-22T23'), line('2026-11-23T00'), line('2026-11-23T01')])).toBe(true); // UTC 일 경계(23→00) 연속
    expect(isNormalized([line('2026-11-22T21'), line('2026-11-22T23'), line('2026-11-23T00')])).toBe(false); // 1시간 간격 뚫림(22 부재)
    expect(isNormalized([line('2026-11-22T23'), line('2026-11-22T23'), line('2026-11-22T23')])).toBe(false); // 동일 시간 중복
    expect(isNormalized([line('2026-11-22T21'), line('2026-11-22T22'), { ...line('2026-11-22T23'), observed: false, green: false }])).toBe(false); // 미관측 줄
    expect(isNormalized([line('2026-11-22T21'), line('2026-11-22T22'), { ...line('2026-11-22T23'), green: false }])).toBe(false); // RED 줄
    expect(isNormalized([line('2026-11-22T22'), line('2026-11-22T23')])).toBe(false); // 2줄(3 미만)
    expect(isNormalized([line('bogus'), line('bogus2'), line('bogus3')])).toBe(false); // «YYYY-MM-DDTHH» 파싱 불가
  });

  test('r3 mustFix ②: 완료 시각 경계 — 시간은 그 끝(다음 정시)이 now 이하여야 완료(정시 경계 포함)', () => {
    // 출처: 합성 시각 — 2026-11-23T03Z 의 끝은 04:00:00.000Z · Date.UTC 월은 0-based(10 = 11월)
    expect(isCompletedHour('2026-11-23T03', Date.UTC(2026, 10, 23, 4, 0, 0, 0))).toBe(true); // 정시 경계 — 03Z 방금 완료
    expect(isCompletedHour('2026-11-23T03', Date.UTC(2026, 10, 23, 3, 59, 59, 999))).toBe(false); // 끝 1ms 전 — 미완료
    expect(isCompletedHour('2026-11-23T03', Date.UTC(2026, 10, 23, 3, 32, 52))).toBe(false); // 진행 중 — JUD-2 격리 회귀 시각(03:32:52Z)
    expect(isCompletedHour('2026-11-23T05', Date.UTC(2026, 10, 23, 4, 0, 0, 0))).toBe(false); // 미래 시간
    expect(isCompletedHour('bogus', Date.UTC(2026, 10, 23, 4, 0, 0, 0))).toBe(null); // «YYYY-MM-DDTHH» 파싱 불가
  });

  test('r3 mustFix ②: 직전 완료 시간 — 기본 CLI 는 진행 중 현재 시간이 아니라 완료된 직전 시간을 출력', () => {
    // 출처: 합성 시각 · Date.UTC 월은 0-based(10 = 11월)
    expect(lastCompletedHour(Date.UTC(2026, 10, 23, 3, 32, 52))).toBe('2026-11-23T02'); // JUD-2 격리 회귀 — 03:32:52Z → 02Z
    expect(lastCompletedHour(Date.UTC(2026, 10, 23, 4, 0, 0, 0))).toBe('2026-11-23T03'); // 정시 경계 — 04:00:00Z 에 03Z 완료
    expect(lastCompletedHour(Date.UTC(2026, 10, 24, 0, 0, 0))).toBe('2026-11-23T23'); // UTC 일 경계(23 → 00)
  });

  test('r3 mustFix ②: 정상화는 완료된 UTC 시간만 사용 — 진행 중·미래 시간 재료는 거부', () => {
    const nowMs = Date.UTC(2026, 10, 23, 4, 0, 0, 0); // 출처: 합성 — 04:00:00Z(03Z 까지 완료)
    const completed = [line('2026-11-23T01'), line('2026-11-23T02'), line('2026-11-23T03')];
    expect(isNormalized(completed, nowMs)).toBe(true); // 전부 완료된 연속 3줄 → 정상화
    expect(isNormalized(completed, Date.UTC(2026, 10, 23, 3, 30))).toBe(false); // 03Z 진행 중(03:30) → 거부
    expect(isNormalized([line('2026-11-23T02'), line('2026-11-23T03'), line('2026-11-23T04')], nowMs)).toBe(false); // 04Z 진행 중 → 거부
    expect(isNormalized([line('2026-11-23T03'), line('2026-11-23T04'), line('2026-11-23T05')], nowMs)).toBe(false); // 미래 포함 → 거부
  });

  test('r3 mustFix ②: 실제 매시 관측/3시간 판정 연결 — 완료된 3시간 창만 관측해 판정에 넣는다', () => {
    const root = ledger(); // 빈 원장 — 관측됨 · 발사 0 · 전 시간 GREEN(합성)
    const nowMs = Date.UTC(2026, 10, 23, 4, 0, 0, 0); // 출처: 합성 — 04:00:00Z
    const observed = observeHourly(root, nowMs);
    expect(observed.lines.map(l => l.hour)).toEqual(['2026-11-23T01', '2026-11-23T02', '2026-11-23T03']); // 완료된 창
    expect(observed.lines.every(l => l.observed && l.green)).toBe(true);
    expect(observed.normalized).toBe(true); // 완료 3시간 연속 초록 → 정상화 선언
    const early = observeHourly(root, Date.UTC(2026, 10, 23, 3, 30)); // 진행 중 03Z 는 창에 없다
    expect(early.lines.map(l => l.hour)).toEqual(['2026-11-23T00', '2026-11-23T01', '2026-11-23T02']);
    expect(early.normalized).toBe(true); // 완료된 [00,01,02] 창 — 여전히 정상화
    const empty = mkdtempSync(join(tmpdir(), 'mvpb-tahealth-empty3-')); // 세 원장 전부 부재 — 합성
    dirs.push(empty);
    expect(observeHourly(empty, nowMs).normalized).toBe(false); // 미관측 창 → 정상화 아님
  });

  test('줄 포맷: 관측 표기(observed=yes/NO) ⊕ GREEN/RED — 원문 그대로 붙이는 형태', () => {
    expect(formatTaHealthLine(line('2026-11-22T21'))).toContain('observed=yes');
    expect(formatTaHealthLine(line('2026-11-22T21'))).toContain('GREEN');
    expect(formatTaHealthLine({ ...line('2026-11-22T21'), green: false })).toContain('RED');
    expect(formatTaHealthLine({ ...line('2026-11-22T21'), observed: false, green: false })).toContain('observed=NO');
  });
});