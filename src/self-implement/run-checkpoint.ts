/**
 * run-checkpoint/v1 묶음 스키마 — 런의 «체크포인트» 스냅샷을 판 번호 있는 타입으로 직렬화한다.
 *
 * ⛔ 이 판은 «묶음 정의 ⊕ 조립 ⊕ 디스크 기록»까지만 담는다. orchestrator 배선 · run-ledger
 *    additive 이벤트('checkpoint'/'resumed'/'checkpoint-failed') · salvage CLI 명령은
 *    같은 골의 형제 조각이 담당한다(의도적 경계 — 분해 판 4조각의 1번).
 *
 * 📐 run-ledger 패턴을 «어느 것을 왜» 따르나(원문이 'writeCheckpoi'에서 끊겨 임의로 정하지 않는다):
 *   ① `runLedgerDir`(run-ledger.ts:205) — 상태 뿌리에서 «자기 저장소 이름»의 디렉터리를 여는 방식.
 *      여기도 `elanousStateRoot()` 아래 `run-checkpoint/` 디렉터리로 열어, 저장 위치가 run-ledger 와
 *      같은 축(state root)에 있게 한다. 원문이 저장 위치의 경로를 정하지 않았으므로 이 패턴을 따른다.
 *   ② `runLedgerPath`(run-ledger.ts:209) — runId 를 «normalizeRunId 의 산출 집합»으로 검증하고
 *      거부는 유지하되 정규화는 «하지 않는다»(경로 탈출 방어). 여기도 같은 검사를 쓰되 파일은
 *      스냅샷이므로 JSONL 추가가 아니라 «덮어쓰기» 하나로 `<runId>.checkpoint.json` 을 쓴다.
 *      JSONL 이 아닌 이유: 원장은 사건의 «추가», 체크포인트는 마지막 상태의 «스냅샷»이다 —
 *      appendRunLedgerEntry 가 줄을 «쌓는» 것과 달리 resume 은 «최신 하나»만 읽으면 된다.
 *   ③ `appendRunLedgerEntry`(run-ledger.ts:411) — 쓰기 전 ①`refuseProductionLedgerWriteInTest`
 *      가드(테스트 중 운영 원장 쓰기 차단) ② `mkdirSync(dir, { recursive: true })` 순서를 그대로 따른다.
 *      «run-ledger 줄 하나»가 아니라 «JSON 파일 하나»이지만 쓰기 관문·디렉터리 보증은 같아야 한다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refuseProductionLedgerWriteInTest } from '../harness/ledger-write-guard.js';
import { normalizeRunId } from '../harness/harness-space.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';

/** 판 번호 — 묶음 필드 구성이 바뀌면 이 값을 올리고 읽는 쪽은 판을 검사한다. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

/** 판 번호가 문자열 표면(직렬화된 JSON 안)에 남는 형태. */
export const CHECKPOINT_SCHEMA_ID = 'run-checkpoint/v1';

/** 라운드 카드 — 조립 시점에 판을 정하지 않는다(원문이 카드의 필드를 정하지 않았다). */
export type CheckpointRoundCard = Record<string, unknown>;

/** 미배달 감독 지시 한 줄 — 조립자가 주는 문면 그대로. */
export type UndeliveredSupervisorDirective = string;

/**
 * run-checkpoint/v1 묶음 — 전 필드의 원문 명세:
 * runId · 골 문면(goalText) · 판정 상태(verdictStatus) · salvage 가지 sha(salvageBranchSha) ·
 * 세션 대화 기록(sessionTranscript) · 라운드 카드(roundCards) · EVIDENCE/RESULT(evidenceResult) ·
 * 미배달 감독 지시(undeliveredSupervisorDirectives) · 자식 모델(childModel) · 쓴 토큰(tokensUsed) ·
 * sha256(«전 필드 포함» — sha256 자기 자신만 제외한 나머지 전 필드의 정규화 직렬화에 걸친다).
 */
export interface RunCheckpointBundle {
  /** 판이자 종류 표지 — 항상 `${CHECKPOINT_SCHEMA_ID}`. */
  schema: typeof CHECKPOINT_SCHEMA_ID;
  /** 판 번호(정수) — CHECKPOINT_SCHEMA_VERSION 과 같다. */
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  runId: string;
  goalText: string;
  verdictStatus: string;
  /** 없으면 null — «모름»과 «없음»을 나눈다. */
  salvageBranchSha: string | null;
  /** null = «미확인»(조립자가 주지 않음) — 빈 문자열(«실제로 비어 있음»)과 구별한다. */
  sessionTranscript: string | null;
  /** null = «미확인» — 빈 배열(«카드 0장»)과 구별한다. */
  roundCards: readonly CheckpointRoundCard[] | null;
  /** null = «미확인» — 빈 문자열과 구별한다. */
  evidenceResult: string | null;
  /** null = «미확인» — 빈 배열(«미배달 지시 0건»)과 구별한다. */
  undeliveredSupervisorDirectives: readonly UndeliveredSupervisorDirective[] | null;
  childModel: string | null;
  tokensUsed: number | null;
  /** sha256 — 자기를 제외한 전 필드 정규화 직렬화에 대한 sha256 hex. */
  sha256: string;
  recordedAt: string;
}

/** 조립 재료 — run 사실 원형. `buildCheckpointBundle` 이 여기서 묶음을 만든다. */
export interface RunCheckpointFacts {
  runId: string;
  goalText: string;
  verdictStatus: string;
  salvageBranchSha?: string | null;
  sessionTranscript?: string | null;
  roundCards?: readonly CheckpointRoundCard[] | null;
  evidenceResult?: string | null;
  undeliveredSupervisorDirectives?: readonly UndeliveredSupervisorDirective[] | null;
  childModel?: string | null;
  tokensUsed?: number | null;
  recordedAt?: string;
}

/** 정렬된 키 직렬화 — 입력은 이미 «JSON 값»(toJSON·undefined·NaN 이 풀린 뒤)이어야 한다. */
function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => sortedJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
}

/**
 * 객체 키를 «정렬된» 안정 직렬화로 — 같은 값이면 같은 문자열(sha256 재현성).
 * ⭐ 해시와 저장이 «같은 직렬화»를 보도록 먼저 `JSON.stringify` 의미론(toJSON·Date→ISO ·
 *    배열 속 undefined→null · 객체 속 undefined 제거 · NaN→null)으로 한 번 풀고 키만 정렬한다.
 *    그래야 `writeCheckpoint` 가 쓴 파일을 `readCheckpoint` 가 다시 해시해도 같은 값이 나온다.
 */
function canonicalJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return sortedJson(JSON.parse(json));
}

/** sha256 조수 — hex 문자열. 묶음의 sha256 필드에 넣는 값과 같은 계산이다. */
export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** sha256 자기 자신을 제외한 «전 필드»를 걸치는 다이제스트(원문: 'sha256 전 필드 포함'). */
export function bundleSha256(bundle: Omit<RunCheckpointBundle, 'sha256'>): string {
  const { sha256: _omit, ...rest } = bundle as RunCheckpointBundle;
  return sha256Hex(rest);
}

const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isNullableString = (v: unknown): boolean => v === null || typeof v === 'string';

/**
 * 묶음의 판(schema ⊕ schemaVersion)과 필수 필드의 존재·타입을 검증한다 — 쓰기·읽기 공통 관문.
 * 판 번호는 «지원하는 판»과 정확히 같아야 한다(다른 판을 v1 으로 받아들이지 않는다).
 */
export function assertCheckpointShape(value: unknown): asserts value is RunCheckpointBundle {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid checkpoint: not an object');
  }
  const b = value as Record<string, unknown>;
  if (b.schema !== CHECKPOINT_SCHEMA_ID) {
    throw new Error(`unknown checkpoint schema: ${String(b.schema)}`);
  }
  if (b.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(`unsupported checkpoint schemaVersion: ${String(b.schemaVersion)}`);
  }
  const bad: string[] = [];
  for (const key of ['runId', 'goalText', 'verdictStatus', 'sha256', 'recordedAt']) {
    if (typeof b[key] !== 'string') bad.push(key);
  }
  if (!isNullableString(b.salvageBranchSha)) bad.push('salvageBranchSha');
  // null = «미확인» 을 받아들인다(빈 값과 다른 값) — 키 자체가 없으면(undefined) 거부한다.
  if (!isNullableString(b.sessionTranscript)) bad.push('sessionTranscript');
  if (!isNullableString(b.evidenceResult)) bad.push('evidenceResult');
  if (!isNullableString(b.childModel)) bad.push('childModel');
  if (!(b.tokensUsed === null || (typeof b.tokensUsed === 'number' && Number.isFinite(b.tokensUsed)))) {
    bad.push('tokensUsed');
  }
  if (b.roundCards !== null && (!Array.isArray(b.roundCards) || !b.roundCards.every((c) => c !== null && typeof c === 'object' && !Array.isArray(c)))) {
    bad.push('roundCards');
  }
  if (b.undeliveredSupervisorDirectives !== null && !isStringArray(b.undeliveredSupervisorDirectives)) bad.push('undeliveredSupervisorDirectives');
  if (bad.length > 0) throw new Error(`invalid checkpoint fields: ${bad.join(', ')}`);
}

/** run 사실에서 run-checkpoint/v1 묶음을 조립한다 — sha256 도 이 안에서 계산해 넣는다. */
export function buildCheckpointBundle(facts: RunCheckpointFacts): RunCheckpointBundle {
  const runId = facts.runId;
  // runLedgerPath 패턴: 정규화는 하지 않고, normalizeRunId 의 «산출 집합»만 받아들인다.
  if (!runId || runId !== normalizeRunId(runId)) throw new Error(`invalid runId: ${runId}`);
  const partial: Omit<RunCheckpointBundle, 'sha256'> = {
    schema: CHECKPOINT_SCHEMA_ID,
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId,
    goalText: facts.goalText,
    verdictStatus: facts.verdictStatus,
    salvageBranchSha: facts.salvageBranchSha ?? null,
    // 생략 = «미확인»(null) — 빈 값으로 채워 «실제로 비어 있음»으로 위장하지 않는다.
    sessionTranscript: facts.sessionTranscript ?? null,
    roundCards: facts.roundCards ?? null,
    evidenceResult: facts.evidenceResult ?? null,
    undeliveredSupervisorDirectives: facts.undeliveredSupervisorDirectives ?? null,
    childModel: facts.childModel ?? null,
    tokensUsed: facts.tokensUsed ?? null,
    recordedAt: facts.recordedAt ?? new Date().toISOString(),
  };
  // 저장될 꼴(JSON 값)로 한 번 풀어, 메모리 묶음 = 파일에서 읽은 묶음이 되게 한다(Date→ISO 등).
  const stored = JSON.parse(JSON.stringify(partial)) as Omit<RunCheckpointBundle, 'sha256'>;
  return { ...stored, sha256: bundleSha256(stored) };
}

/** runLedgerDir 패턴 — state root 아래 «자기 저장소 이름» 디렉터리. */
export function checkpointDir(stateDir?: string): string {
  return join(stateDir ?? elanousStateRoot(), 'run-checkpoint');
}

/** runLedgerPath 패턴 — runId 검증(정규화 아님) 후 경로 결정. */
export function checkpointPath(runId: string, dir = checkpointDir()): string {
  if (runId !== normalizeRunId(runId) || !runId) throw new Error(`invalid runId: ${runId}`);
  return join(dir, `${runId}.checkpoint.json`);
}

/**
 * 묶음을 디스크에 기록한다(appendRunLedgerEntry 의 쓰기 관문·디렉터리 보증을 따른다).
 * 반환값은 기록한 파일 경로 — 형제 조각의 원장 이벤트 'checkpoint' {bundleRef} 가 여기 담긴다.
 *
 * ⛔ 스냅샷은 «최신 하나»라 덮어쓰기가 곧 이전 상태의 소실이다. 그래서
 *    ① 쓰기 «전»에 판·sha256 을 검증해 무효 묶음이면 던지고 기존 파일을 건드리지 않는다.
 *    ② 임시 파일에 쓴 뒤 rename 으로 원자 교체한다(쓰다 죽어도 반쪽 파일이 남지 않는다).
 */
export function writeCheckpoint(bundle: RunCheckpointBundle, dir = checkpointDir()): string {
  assertCheckpointShape(bundle);
  const path = checkpointPath(bundle.runId, dir);
  const body = `${JSON.stringify(bundle, null, 2)}\n`;
  // 저장될 꼴 그대로를 다시 해시한다 — 읽기 쪽 검증과 같은 입력이다.
  const expected = bundleSha256(JSON.parse(body) as RunCheckpointBundle);
  if (bundle.sha256 !== expected) {
    throw new Error(`checkpoint sha256 mismatch: ${bundle.sha256} != ${expected}`);
  }
  if (refuseProductionLedgerWriteInTest(dir, 'run-checkpoint')) return '';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return path;
}

/** 기록된 묶음을 읽어 sha256 이 전 필드에 대해 아직 성립하는지 검증과 함께 돌려준다. */
export function readCheckpoint(runId: string, dir = checkpointDir()): RunCheckpointBundle {
  const raw: unknown = JSON.parse(readFileSync(checkpointPath(runId, dir), 'utf8'));
  assertCheckpointShape(raw);
  if (raw.runId !== runId) {
    throw new Error(`checkpoint runId mismatch: requested ${runId}, file has ${raw.runId}`);
  }
  const expected = bundleSha256(raw);
  if (raw.sha256 !== expected) {
    throw new Error(`checkpoint sha256 mismatch: ${raw.sha256} != ${expected}`);
  }
  return raw;
}