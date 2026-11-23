// TA-HEALTH-NORMAL-PROBE — ROSTER-0334 새 칸(OP 배정 · seat-state/OP/ROSTER-0334.md «새 칸 제안» 표 원문).
// 완료선 문면: «TA 정상» 정의 = 시간당 발사 성공률 · 자원 사망 0 · 미착 카드 0 을 매시 한 줄 ·
// 3시간 연속 초록이면 정상화 선언 · 증거 = 운영 우주 원장 + 합성 사망 사건 1(음성 대조) · 판정 JUD-2.
// 원장 원천(운영 우주): ~/.elanous/run-ledger/*.jsonl(발사) ⊕ resource-ledger/events.jsonl(자원) ⊕ task-cards/index.db(카드).
// r2 수리(판정본 jud-39689-9d11d6eef18b · JUD-2 hold mustFix ①②):
//   ① 발사 성공 = 같은 발사의 실제 child-first-llm-call 결과(status ok)만 집계 — 이벤트 종류 무관 status=ok 는 계상 안 함.
//   ② 원장 부재 = 0건이 아니라 미관측(observed)으로 구분 ⊕ 정상화 = 관측된 서로 다른 연속(1시간 간격) UTC 시간 3줄만 인정.
// r3 수리(판정본 jud-39689-a0e49b45e34f · JUD-2 hold 잔여 mustFix ②):
//   정상화는 완료된 UTC 시간만 사용(진행 중 현재·미래 시간 거부) ⊕ 실제 매시 경로(기본 CLI) = 직전 완료 시간부터
//   완료된 연속 3시간 창 관측 → 3시간 판정 연결 — 기본 CLI 는 진행 중 현재 시간을 출력하지 않는다.
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 매시 한 줄 — 완료선 세 지표(발사 성공률 · 자원 사망 0 · 미착 카드 0)⊕ 관측 여부 ⊕ 초록 판정. */
export interface TaHealthHourLine {
  hour: string;
  /** mustFix ②: 세 원장(run·resource·cards) 전부 실재해야 관측된 시간 — 부재는 0건이 아니라 미관측. */
  observed: boolean;
  launched: number;
  reachedOk: number;
  successRate: number;
  resourceDeaths: number;
  unlandedCards: number;
  green: boolean;
}

/** 출처: 음성 대조 정의(«합성 사망 사건 1») — 사망 사건 표기는 died/killed/crash/oom 포함. */
const DEATH_KEYS = ['died', 'killed', 'crash', 'oom'] as const;

/** 출처: 완료선 문면 «3시간 연속» — 정상화 판정에 쓸 연속 줄 수. */
const CONSECUTIVE_REQUIRED = 3;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** 발사 = run-ledger 파일(child-first-llm-call started)·run 1 = 파일 1(run-<id>.jsonl 관례).
 *  ok 도달은 파일 전체에서 본다 — 시간 경계를 넘는 긴 런도 그 발사의 성공으로 센다.
 *  mustFix ①: 성공(status ok)은 이 발사의 실제 child-first-llm-call 사건 결과만으로 집계 — tool 사건 ok 는 무시.
 *  mustFix ②: run-ledger 부재 = 발사 0이 아니라 미관측(observed=false). */
function countRuns(runDir: string, hour: string): { launched: number; reachedOk: number; observed: boolean } {
  let launched = 0;
  let reachedOk = 0;
  if (!existsSync(runDir)) return { launched, reachedOk, observed: false };
  for (const name of readdirSync(runDir)) {
    if (!name.endsWith('.jsonl')) continue;
    let started = false;
    let ok = false;
    for (const line of readFileSync(join(runDir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const ev = asRecord(parsed);
      if (!ev || ev['event'] !== 'child-first-llm-call') continue;
      const data = asRecord(ev['data']);
      const ts = ev['timestamp'];
      const status = data?.['status'];
      if (typeof ts === 'string' && ts.startsWith(hour) && status === 'started') started = true;
      if (status === 'ok') ok = true;
    }
    if (started) { launched += 1; if (ok) reachedOk += 1; }
  }
  return { launched, reachedOk, observed: true };
}

/** 자원 사망 = resource-ledger/events.jsonl 의 at(또는 timestamp)이 해당 시간인 사망 표기 사건.
 *  mustFix ②: 원장 파일 부재 = 사망 0건이 아니라 미관측(observed=false). */
function countDeaths(resourceEventsPath: string, hour: string): { deaths: number; observed: boolean } {
  let deaths = 0;
  if (!existsSync(resourceEventsPath)) return { deaths, observed: false };
  for (const line of readFileSync(resourceEventsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const ev = asRecord(parsed);
    if (!ev) continue;
    const at = ev['at'] ?? ev['timestamp'];
    if (typeof at !== 'string' || !at.startsWith(hour)) continue;
    const key = String(ev['event'] ?? '').toLowerCase();
    if (DEATH_KEYS.some(k => key.includes(k))) deaths += 1;
  }
  return { deaths, observed: true };
}

/** 미착 카드 = 해당 시간에 만들어졌으나 아직 open인 카드 — 출처: task-cards/index.db cards 표(created_at LIKE 시간접두어).
 *  mustFix ②: 카드 원장 DB 부재 = 미착 0건이 아니라 미관측(observed=false). */
function countUnlanded(cardsDbPath: string, hour: string): { unlanded: number; observed: boolean } {
  if (!existsSync(cardsDbPath)) return { unlanded: 0, observed: false };
  const db = new Database(cardsDbPath, { readonly: true });
  try {
    const row = db.query("SELECT count(*) AS c FROM cards WHERE created_at LIKE ? AND status = 'open'").get(`${hour}%`) as { c: number };
    return { unlanded: row.c, observed: true };
  } finally { db.close(); }
}

/** 한 시간의 프로브 줄 — 관측된 발사 없는 시간은 성공률을 관례상 1(빈 진리)로 둔다.
 *  mustFix ②: 세 원장 중 하나라도 부재하면 그 시간은 미관측 → green=false. */
export function probeHour(ledgerRoot: string, hour: string): TaHealthHourLine {
  const runs = countRuns(join(ledgerRoot, 'run-ledger'), hour);
  const deaths = countDeaths(join(ledgerRoot, 'resource-ledger', 'events.jsonl'), hour);
  const cards = countUnlanded(join(ledgerRoot, 'task-cards', 'index.db'), hour);
  const observed = runs.observed && deaths.observed && cards.observed;
  const successRate = runs.launched === 0 ? 1 : runs.reachedOk / runs.launched;
  const green = observed && successRate === 1 && deaths.deaths === 0 && cards.unlanded === 0;
  return { hour, observed, launched: runs.launched, reachedOk: runs.reachedOk, successRate, resourceDeaths: deaths.deaths, unlandedCards: cards.unlanded, green };
}

/** 매시 한 줄 포맷 — 원문 그대로 붙일 수 있는 형태(mustFix ②: 관측 여부 표기 포함). */
export function formatTaHealthLine(line: TaHealthHourLine): string {
  return `${line.hour}Z | observed=${line.observed ? 'yes' : 'NO'} | launched=${line.launched} | ok=${line.reachedOk} | rate=${line.successRate.toFixed(2)} | deaths=${line.resourceDeaths} | unlanded=${line.unlandedCards} | ${line.green ? 'GREEN' : 'RED'}`;
}

/** 출처: 완료선 문면 «3시간 연속» — UTC 시간 표기 «YYYY-MM-DDTHH» 를 시간 단위 정수로 바꾼다(mustFix ② 연속 판정용). */
function hourToEpochHours(hour: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(hour);
  if (!m) return null;
  // 출처: Date.UTC 밀리초 → 시간 환산(1시간 = 3,600,000ms).
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])) / 3_600_000;
}

/** 출처: 시간 단위 정수 → UTC 시간 표기 «YYYY-MM-DDTHH»(r3 잔여 mustFix ② 창 조성용) — 환산 1시간 = 3,600,000ms. */
function epochHoursToHour(epoch: number): string {
  const d = new Date(epoch * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0'); // 출처: «YYYY-MM-DDTHH» 월·일·시 2자리 패딩
  const month = d.getUTCMonth() + 1; // 출처: getUTCMonth 는 0-based(1월 = 0) → +1 보정
  return `${d.getUTCFullYear()}-${pad(month)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}`;
}

/** r3 잔여 mustFix ②: 완료된 UTC 시간 판정 — «YYYY-MM-DDTHH» 시간은 그 끝(다음 정시)이 now 이하여야 완료.
 *  진행 중 현재 시간·미래 시간은 false(정상화 재료 거부) · «YYYY-MM-DDTHH» 파싱 불가는 null.
 *  출처: 환산 1시간 = 3,600,000ms · 정시 경계 포함(04:00:00.000Z 에 03Z 완료). */
export function isCompletedHour(hour: string, nowMs: number = Date.now()): boolean | null {
  const epoch = hourToEpochHours(hour);
  if (epoch === null) return null;
  return (epoch + 1) * 3_600_000 <= nowMs; // 출처: (epoch + 1) = 그 시간의 끝(다음 정시)
}

/** r3 잔여 mustFix ②: 직전 완료 시간 — now 기준 마지막 완료 UTC 시간 «YYYY-MM-DDTHH».
 *  기본 CLI 는 이 시간부터의 창을 출력한다(진행 중 현재 시간 출력 금지).
 *  출처: 정시 내림 후 1시간 감 — 완료 판정과 동일 경계(04:00:00.000Z 에 03Z). */
export function lastCompletedHour(nowMs: number = Date.now()): string {
  const nowEpoch = Math.floor(nowMs / 3_600_000); // 출처: ms → 시간 단위 내림(1시간 = 3,600,000ms)
  return epochHoursToHour(nowEpoch - 1);
}

/** 실제 매시 관측 경로(r3 잔여 mustFix ②) — 자동·운영자 호출이 쓰는 경로:
 *  직전 완료 시간까지의 완료된 연속 3시간 창을 관측(probeHour)하고 3시간 판정(isNormalized)을 연결해 낸다.
 *  진행 중·미래 시간은 창에 없다(완료된 시간만 관측·판정 재료). */
export function observeHourly(ledgerRoot: string, nowMs: number = Date.now()): { lines: TaHealthHourLine[]; normalized: boolean } {
  const nowEpoch = Math.floor(nowMs / 3_600_000); // 출처: ms → 시간 단위 내림(1시간 = 3,600,000ms)
  // 출처: 창 = [nowEpoch-3, nowEpoch-2, nowEpoch-1] — 직전 완료 시간(lastCompletedHour) 포함 연속 CONSECUTIVE_REQUIRED(3) 칸.
  const hours = Array.from({ length: CONSECUTIVE_REQUIRED }, (_, i) => epochHoursToHour(nowEpoch - CONSECUTIVE_REQUIRED + i));
  const lines = hours.map(hour => probeHour(ledgerRoot, hour));
  return { lines, normalized: isNormalized(lines, nowMs) };
}

/** 정상화 판정 — 출처: 완료선 문면 «3시간 연속 초록이면 정상화 선언».
 *  mustFix ②: 마지막 3줄이 ① 관측된(observed) ② 초록(green) ③ 서로 다른 연속(1시간 간격) UTC 시간일 때만 선언.
 *  r3 잔여 ②: ③은 완료된 UTC 시간만 — 진행 중 현재·미래 시간 재료는 거부(isCompletedHour). */
export function isNormalized(lines: TaHealthHourLine[], nowMs: number = Date.now()): boolean {
  if (lines.length < CONSECUTIVE_REQUIRED) return false;
  const last = lines.slice(-CONSECUTIVE_REQUIRED);
  if (!last.every(line => line.observed && line.green)) return false;
  if (!last.every(line => isCompletedHour(line.hour, nowMs) === true)) return false; // r3: 완료된 시간만
  const epochs = last.map(line => hourToEpochHours(line.hour));
  if (epochs.some(e => e === null)) return false;
  for (let i = 1; i < epochs.length; i++) {
    if (epochs[i]! - epochs[i - 1]! !== 1) return false; // 간격·중복·역행 전부 거부
  }
  return true;
}

if (import.meta.main) {
  // 실제 매시 관측 경로(r3 잔여 mustFix ②): 인자 없으면 직전 완료 시간까지의 완료된 3시간 창을 관측해 줄들 ⊕ 3시간 판정을 출력 —
  // 진행 중 현재 시간은 출력하지 않는다. 인자를 주면 그 시간 한 줄만 관측(운영자 지정).
  const ledgerRoot = process.env['ELANOUS_HOME'] ?? join(process.env['HOME'] ?? '/', '.elanous');
  const arg = process.argv[2];
  if (arg) {
    console.log(formatTaHealthLine(probeHour(ledgerRoot, arg)));
  } else {
    const { lines, normalized } = observeHourly(ledgerRoot);
    for (const line of lines) console.log(formatTaHealthLine(line));
    console.log(`normalized=${normalized ? 'YES' : 'NO'}`); // 3시간 판정 결과 — 실제 매시 경로가 사용
  }
}