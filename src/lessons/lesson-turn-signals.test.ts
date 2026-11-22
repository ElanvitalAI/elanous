/**
 * POST-TURN-LESSON-REVIEW r2 — 턴 신호 검출기(완료선 원문: 10턴 주기 아님 · 하루 상한 5).
 * 출처: eln release checklist 0.3.33 POST-TURN-LESSON-REVIEW (OP #125575 CLI 원문) · ASK-SEAT-ROLE-RETRO-MEMORY-ENGINE-1117 «정정» §20-24
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTurnSignals, cheapLessonSummarizer, DAILY_CANDIDATE_CAP } from './lesson-turn-signals.js';
import { FrictionLedger } from './friction-ledger.js';

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'lesson-turn-'));
}

describe('scanTurnSignals — deterministic turn-signal detection', () => {
  test('human correction phrase fires a signal on the spot (no turn counting)', () => {
    const stateDir = freshStateDir();
    const out = scanTurnSignals({ stateDir }, [
      { kind: 'human-utterance', text: '아니 그게 아니라 가지를 잘못 짚었어', ref: '#125528' },
      { kind: 'human-utterance', text: '고마워 계속해', ref: '#125529' },
    ]);
    expect(out.outcomes.length).toBe(1); // 출처: #125563 완료선(신호 있을 때만)
    const ledger = new FrictionLedger({ stateDir });
    const today = new Date().toISOString().slice(0, 10);
    const rows = ledger.candidates(1);
    const correction = rows.find(r => r.signature.startsWith('human:correction:'));
    expect(correction).toBeDefined(); // r10 — 기본 결정적 요약이 한 줄 후보를 만든다(Terra mustFix ③)
    expect(correction!.count).toBe(1); // 출처: #125563(정정 1회 = 후보 1줄)
    // 요약 줄 검증(③) — note 는 friction 표 행에 있으므로 직접 조회: 결정적 줄만 있고 사람 원문 전문은 없다.
    const { Database } = require('bun:sqlite');
    const db = new Database(`${stateDir}/lessons/friction.sqlite`, { readonly: true });
    const noted = db.query("SELECT note FROM friction WHERE signature LIKE 'human:correction:%'").get() as { note: string };
    db.close();
    expect(noted.note).toContain('human:correction'); // 결정적 요약 줄(종류·서명 기반)
    expect(noted.note).not.toContain('가지를 잘못 짚었어'); // 사람 원문 전문은 미노출
    expect(ledger.countFiredOn(today)).toBe(1); // 발화 흔적은 fired 표에 내구 보관(r5) — 출처: #125563
  });

  test('«기억해» fires and does NOT count against the daily cap', () => {
    const stateDir = freshStateDir();
    const ledger = new FrictionLedger({ stateDir });
    for (let i = 0; i < DAILY_CANDIDATE_CAP; i++) ledger.recordFired({ actor: 'person', signal: 'review-mustfix', signature: `pre${i}`, ref: `pre-${i}` }); // 상한 선채움(r7 — 원장이 발화 수의 내구 메모리)
    const out = scanTurnSignals({ stateDir }, [
      { kind: 'human-utterance', text: '그 규칙 기억해 둬', ref: '#125530' },
      { kind: 'review-mustfix', signature: 'review:x:y', ref: 'pr-1' },
    ]);
    expect(out.outcomes.length).toBe(1); // 사람 지정만 발화 — 상한 밖(human:remember 예외)
    expect(out.capped).toBe(1); // 리뷰 신호는 상한 컷
  });

  test('same tool-error signature twice fires repeat-error-2 exactly once', () => {
    const stateDir = freshStateDir();
    const out = scanTurnSignals({ stateDir }, [
      { kind: 'tool-error', signature: 'tool:bash:enoent', ref: 'capsule-1' },
      { kind: 'tool-error', signature: 'tool:bash:enoent', ref: 'capsule-2' },
      { kind: 'tool-error', signature: 'tool:bash:enoent', ref: 'capsule-3' },
    ]);
    expect(out.outcomes.length).toBe(1); // 출처: #125563(«같은 오류 2회»)
    expect(out.outcomes[0]!.recorded).toBe(1); // r10 — 기본 결정적 요약 줄이 후보 행을 만든다(Terra mustFix ③)
    const ledger = new FrictionLedger({ stateDir });
    expect(ledger.countObservations('tool:bash:enoent')).toBe(3); // 관측 3행은 `observation` 표에(r7 · Terra mustFix ④)
    // r12 — Terra r11 [2]: 관측 표와 후보(friction)는 분리 — 요약 줄 있는 승격 행 1건만 후보, 카운트도 그 행만 센다.
    const group = ledger.candidates(1).find(g => g.signature === 'tool:bash:enoent');
    expect(group).toBeDefined();
    expect(group!.count).toBe(1); // 승격 1행 — 관측 3사건이 후보 횟수에 유출되지 않는다(r11 [2])
  });

  test('land-rejected · stalled · approval-refused each fire one signal', () => {
    const stateDir = freshStateDir();
    const out = scanTurnSignals({ stateDir }, [
      { kind: 'land-rejected', signature: 'land:L2', ref: 'pr-39500' },
      { kind: 'stalled', ref: 'run-1' },
      { kind: 'approval-refused', ref: 'approval-2' },
    ]);
    expect(out.outcomes.length).toBe(3); // 출처: #125563(착지 거부·멈춤·승인 거절/초과)
  });

  test('daily cap 5: the 6th signal is capped, not recorded', () => {
    const stateDir = freshStateDir();
    const observations = Array.from({ length: 7 }, (_, i) => ({ kind: 'review-mustfix' as const, signature: `review:r${i}:p`, ref: `pr-${i}` }));
    const out = scanTurnSignals({ stateDir, summarizer: (s) => `다음엔 ${s.signature} 서명을 먼저 대조한다` }, observations);
    expect(out.outcomes.length).toBe(DAILY_CANDIDATE_CAP); // 출처: #125563(하루 상한 5)
    expect(out.capped).toBe(2);
    const today = new Date().toISOString().slice(0, 10);
    const ledger = new FrictionLedger({ stateDir });
    expect(ledger.countFiredOn(today)).toBe(DAILY_CANDIDATE_CAP); // 발화 흔적은 fired 표가 actor별로 내구 보관(r7)
    expect(ledger.candidates(1).length).toBe(DAILY_CANDIDATE_CAP); // 요약 줄이 있는 5건만 후보 행(r7 — 0-줄은 후보 아님)
  });

  test('summarizer seam shapes the 0-1 line note (cheap-model contract)', () => {
    const stateDir = freshStateDir();
    const seen: string[] = [];
    const out = scanTurnSignals({ stateDir, summarizer: (s) => { seen.push(s.signature); return '다음엔 서명을 먼저 대조한다'; } }, [
      { kind: 'review-mustfix', signature: 'review:numguard:provenance', ref: 'pr-39493-r1' },
    ]);
    expect(out.outcomes.length).toBe(1);
    expect(seen).toEqual(['review:numguard:provenance']);
    const row = new FrictionLedger({ stateDir }).candidates(1)[0]!;
    expect(row.signature).toBe('review:numguard:provenance');
  });
});

describe('scanTurnSignals r4 — Terra mustFix (cross-call memory · durable daily cap · no-line candidate)', () => {
  test('T1: same tool-error across two scans fires on the 2nd and reaches friction candidates(2)', () => {
    const stateDir = freshStateDir();
    const first = scanTurnSignals({ stateDir }, [
      { kind: 'tool-error', signature: 'tool:bash:enoent', ref: 'capsule-1' },
    ]);
    expect(first.outcomes.length).toBe(0); // 1st error: memory only — no signal yet
    const second = scanTurnSignals({ stateDir }, [
      { kind: 'tool-error', signature: 'tool:bash:enoent', ref: 'capsule-2' },
    ]);
    expect(second.outcomes.length).toBe(1); // 출처: #125563(«같은 오류 2회» — 턴 간 이력 유지)
    expect(second.outcomes[0]!.recorded).toBe(1); // r10 — 기본 요약 줄 후보 행(Terra mustFix ③)
    const ledger = new FrictionLedger({ stateDir });
    expect(ledger.countObservations('tool:bash:enoent')).toBe(2); // 관측 이력 2행 — `observation` 표(r7 mustFix ④)
    // r12 — Terra r11 [2][3]: 후보는 승격된 friction 행만. observation 원천은 후보 집계에 유출되지 않는다.
    const promoted = ledger.candidates(1).find(g => g.signature === 'tool:bash:enoent');
    expect(promoted).toBeDefined(); // 2회 실오류 → 승격 행 1건
    expect(promoted!.count).toBe(1); // 승격 행 1건의 카운트 — 관측 2행과 이중계상 없음(r11 [3])
    // r16 — Terra r15b ④: 실제 관측 2회 → candidates(2) 자격(반복 오류 «2회» 문턱 복원).
    expect(ledger.candidates(2).find(g => g.signature === 'tool:bash:enoent')).toBeDefined();
  });

  test('T1b(r16): 값싼 모델 실패·빈줄은 0줄 후보 — 원문·서명 복사 폴백이 없음을 증명', async () => {
    const sig = { kind: 'review-mustfix' as const, actor: 'person' as const, signature: 'review:x:y', ref: 'pr-1' };
    expect(await cheapLessonSummarizer(sig, async () => { throw new Error('boom'); })).toBe(null); // 모델 실패 → 폴백 금지
    expect(await cheapLessonSummarizer(sig, async () => '')).toBe(null); // 빈 줄 → 후보 없음
    expect(await cheapLessonSummarizer(sig, async () => '같은 꼴이면 서명 대조를 먼저 한다')).toBe('같은 꼴이면 서명 대조를 먼저 한다');
  });

  test('T2: daily cap 5 is durable across scans and resets on date rollover', () => {
    const stateDir = freshStateDir();
    const clock = { value: new Date('2026-11-22T10:00:00Z') };
    const opts = { stateDir, now: () => clock.value };
    for (let i = 0; i < 5; i++) {
      scanTurnSignals(opts, [{ kind: 'review-mustfix', signature: `review:r${i}:p`, ref: `pr-${i}` }]);
    }
    const capped = scanTurnSignals(opts, [{ kind: 'review-mustfix', signature: 'review:capped:p', ref: 'pr-cap' }]);
    expect(capped.outcomes.length).toBe(0); // 출처: #125563(하루 상한 5 — 여러 호출에 걸쳐 유지)
    expect(capped.capped).toBe(1);
    clock.value = new Date('2026-11-23T10:00:00Z'); // 날짜 전환
    const nextDay = scanTurnSignals(opts, [{ kind: 'review-mustfix', signature: 'review:nextday:p', ref: 'pr-next' }]);
    expect(nextDay.outcomes.length).toBe(1); // 새 날에는 상한 리셋
    expect(nextDay.capped).toBe(0);
  });

  test('T3: a summarizer returning null records no candidate row (0-줄 후보 · r10 기본 요약 하에서도 유지)', () => {
    const stateDir = freshStateDir();
    const out = scanTurnSignals({ stateDir, summarizer: () => null }, [
      { kind: 'tool-error', signature: 'tool:x:e1', ref: 'a' },
      { kind: 'tool-error', signature: 'tool:x:e1', ref: 'b' },
    ]);
    expect(out.outcomes.length).toBe(1);
    expect(out.outcomes.every(o => o.recorded === 0)).toBe(true); // 요약 줄 없음 → 후보 행 없음(0-줄 계약 유지 · Terra mustFix ③)
    const ledger = new FrictionLedger({ stateDir });
    const today = new Date().toISOString().slice(0, 10);
    expect(ledger.countObservations('tool:x:e1')).toBe(2); // 관측 메모리 2행은 `observation` 표에(턴 간 이력 · r7 ④) — 출처: #125563
    // r12 — Terra r11 [2]: 요약 줄 없는 관측은 후보로 노출되지 않는다(관측/후보 분리 원상복원).
    expect(ledger.candidates(1).length).toBe(0); // 0-줄 후보 — 후보 행 0
    expect(ledger.countFiredOn(today)).toBe(1); // 발화 흔적 1(fired 표) — 출처: #125563
  });

  test('T5: a throwing summarizer must not propagate (fail-soft like emitLessonSignal)', () => {
    const stateDir = freshStateDir();
    const out = scanTurnSignals({ stateDir, summarizer: () => { throw new Error('boom'); } }, [
      { kind: 'review-mustfix', signature: 'review:throw:p', ref: 'pr-t' },
    ]);
    expect(out.outcomes.every(o => o.recorded === 0)).toBe(true); // 예외 전파 0 — 신호 처리 fail-soft
  });

  test('T6(r7): per-actor daily cap — another seat\'s firings never exhaust mine, human:remember never counts', () => {
    const stateDir = freshStateDir();
    const clock = new Date('2026-11-22T10:00:00Z');
    const now = () => clock;
    const ledger = new FrictionLedger({ stateDir, now });
    const day = '2026-11-22';
    // MVP-B 가 하루 상한을 이미 다 쓴 상태 — 다른 자리(OP)의 human:remember 는 그 상한을 침식하지 않는다.
    for (let i = 0; i < DAILY_CANDIDATE_CAP; i++) ledger.recordFired({ actor: 'OP', signal: 'human-correction', signature: `op-rem-${i}`, ref: `op-${i}`, capped: false }); // 상한 밖(예외)
    for (let i = 0; i < DAILY_CANDIDATE_CAP; i++) ledger.recordFired({ actor: 'OP', signal: 'review-mustfix', signature: `op-rv-${i}`, ref: `oprv-${i}` }); // OP 상한 선채움
    expect(ledger.countFiredOn(day, 'OP')).toBe(DAILY_CANDIDATE_CAP); // OP 의 상한 대상 발화만 5(Terra mustFix ⑤)
    expect(ledger.countFiredOn(day, 'MK')).toBe(0); // 자리별 분리 — OP 소진이 MK 상한을 안 먹는다(⑤)
    const mine = scanTurnSignals({ stateDir, actor: 'MK', now }, [
      { kind: 'review-mustfix', signature: 'review:mk:ok', ref: 'pr-mk' },
    ]);
    expect(mine.outcomes.length).toBe(1); // 다른 자리가 상한을 다 써도 MK 는 발화 가능 — 출처: #125563
    expect(mine.capped).toBe(0);
  });

  test('T7(r7): reserveFiredOrNone is atomic — a reservation already at cap rejects instead of double-firing', () => {
    const stateDir = freshStateDir();
    const ledger = new FrictionLedger({ stateDir });
    for (let i = 0; i < DAILY_CANDIDATE_CAP; i++) {
      const r = ledger.reserveFiredOrNone({ actor: 'TC', signal: 'review-mustfix', signature: `tc-${i}`, ref: `tc-${i}`, cap: DAILY_CANDIDATE_CAP });
      expect(r.reserved).toBe(true); // 원자 예약 — 상한 내
    }
    const over = ledger.reserveFiredOrNone({ actor: 'TC', signal: 'review-mustfix', signature: 'tc-over', ref: 'tc-over', cap: DAILY_CANDIDATE_CAP });
    expect(over.reserved).toBe(false); // 상한 도달 — 동시 호출이 같은 잔여량을 보지 못한다(원자 · Terra mustFix ⑥)
    expect(over.firedToday).toBe(DAILY_CANDIDATE_CAP);
    const pinned = ledger.reserveFiredOrNone({ actor: 'TC', signal: 'human-correction', signature: 'human:remember:x', ref: 'hr-1', humanPinned: true, cap: DAILY_CANDIDATE_CAP });
    expect(pinned.reserved).toBe(true); // 사람 직접 지정은 상한 밖 — 출처: #125563
  });
});

describe('scanTurnSignals r10 — Terra mustFix (legacy migration · fail-closed reservation)', () => {
  test('T8: a legacy fired table (no capped column) upgrades in place — index lands after ALTER', () => {
    const stateDir = freshStateDir();
    const { Database } = require('bun:sqlite');
    const { mkdirSync } = require('node:fs');
    mkdirSync(`${stateDir}/lessons`, { recursive: true });
    const raw = new Database(`${stateDir}/lessons/friction.sqlite`, { create: true, strict: true });
    raw.exec("CREATE TABLE fired (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, signal TEXT NOT NULL, signature TEXT NOT NULL, ref TEXT NOT NULL, recorded_at TEXT NOT NULL)");
    raw.query("INSERT INTO fired (actor, signal, signature, ref, recorded_at) VALUES ('OP', 'review-mustfix', 'legacy:sig', 'legacy-ref', '2026-11-01T00:00:00.000Z')").run();
    raw.close();
    const ledger = new FrictionLedger({ stateDir }); // open 이 마이그레이션을 수행 — 예외 없이 열려야 한다(Terra mustFix ⑥ 재지정)
    expect(ledger.countFiredOn('2026-11-01')).toBe(1); // capped 기본 1 — 구식 행도 상한 집계에 합류
    const again = new FrictionLedger({ stateDir });
    expect(again.countFiredOn('2026-11-01')).toBe(1); // 재오픈 안전(멱등)
  });

  test('T9: when the ledger reservation throws, the signal does not fire (fail-closed)', () => {
    const stateDir = freshStateDir();
    const { Database } = require('bun:sqlite');
    const { mkdirSync } = require('node:fs');
    mkdirSync(`${stateDir}/lessons`, { recursive: true });
    const raw = new Database(`${stateDir}/lessons/friction.sqlite`, { create: true, strict: true });
    raw.exec('CREATE TABLE fired (x INTEGER)'); // 예약 SELECT 가 깨지는 스키마 — reservation=null 경로
    raw.close();
    const out = scanTurnSignals({ stateDir, summarizer: () => '줄' }, [
      { kind: 'review-mustfix', signature: 'review:broken:p', ref: 'pr-x' },
    ]);
    expect(out.outcomes.length).toBe(0); // r10 — 예약 실패 시 발화 금지(Terra mustFix ⑦)
    expect(out.capped).toBe(1);
  });
});
