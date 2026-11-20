// NEXUS · LLM 지출 정책 저장소 — «한 벌» 정본·원자 쓰기·버전·변경 원장 (LLM-SPEND-POLICY-ONE-SHOT)
//
// ⛔⭐ 정본은 넥서스 한 벌이다(OP #107839): <config-dir>/nexus/llm-spend-policy/policy.yaml —
//   호스트별 사본이 아니다(같은 결정 함수·같은 조회 — CLI 는 이 한 벌을 읽는다). 원격 자리에
//   «정책 + 금고 임대»를 함께 나르는 배선은 후속 칸(secret supply · GUARD)이고, 넥서스에 안 닿은
//   자리는 마지막 정상 정책 + 남은 임대만 쓴다(새 임대 0 = fail-closed).
//
// 쓰기 규약(«패널» 칸이 이 함수들을 부른다 — 이 PR 은 CLI 노출 0 · 조회만):
//   · 검증 먼저: 틀린 키·범위 밖·모르는 공급자·비밀 모양이면 «한 글자도 쓰지 않고» 사유를 돌려준다
//     (fail-closed — 이전 정상 정책 유지).
//   · 직렬화 허용 목록: 알려진 필드만 YAML 로 적는다(schema.serializeSpendPolicyDoc).
//   · 원자 쓰기: tmp+chmod 0600+rename · 파일 잠금 안에서 정본·메타·변경 원장을 함께 넘긴다.
//   · 버전: policy.meta.json {version, updatedAt} — 쓰기마다 +1.
//   · 변경 원장 1줄: policy-changes.jsonl 에 {at, actor, version, changedKeys}(바뀐 키 목록).
//   · 마지막 정상 사본: policy.last-good.yaml — 받아들인 쓰기마다 갱신. 정본이 외부에서 망가졌으면
//     읽기가 이 사본으로 되돌아간다(«이전 정상 정책 유지»).
//
// 읽기 규약: 파일을 매번 새로 읽는다 — 파일이 바뀌면 «다음 호출부터» 반영(재기동 0 · 대표 07:2x).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { isScalar } from 'yaml';
import { withFileLockSync } from '../../storage/file-lock.js';
import {
  applySpendPolicyOverlay, defaultSpendPolicyDoc, defaultSpendPolicySources, safeToken, serializeSpendPolicyDoc, serializeSpendPolicyRow, validateSpendPolicyDoc,
} from './schema.js';
import type { LlmSpendPolicyDoc, LlmSpendRowPolicy, LlmSpendPolicySource, LlmSpendPolicyValidation, LlmSpendRowKind, LlmSpendRowState } from './types.js';
import { llmSpendPolicyDir } from './ledger.js';

export const SPEND_POLICY_FILE = 'policy.yaml';
export const SPEND_POLICY_META_FILE = 'policy.meta.json';
export const SPEND_POLICY_CHANGES_FILE = 'policy-changes.jsonl';
export const SPEND_POLICY_LAST_GOOD_FILE = 'policy.last-good.yaml';

export async function spendPolicyFiles(dirOverride?: string): Promise<{ dir: string; policy: string; meta: string; changes: string; lastGood: string; lock: string }> {
  const dir = await llmSpendPolicyDir(dirOverride);
  return {
    dir, policy: join(dir, SPEND_POLICY_FILE), meta: join(dir, SPEND_POLICY_META_FILE),
    changes: join(dir, SPEND_POLICY_CHANGES_FILE), lastGood: join(dir, SPEND_POLICY_LAST_GOOD_FILE), lock: join(dir, 'policy.lock'),
  };
}

/** 원자 쓰기 0600 — tmp+chmod+rename(lease-store 와 같은 규약: 사본이 절반쯤 남지 않는다). */
function writeAtomic0600(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 이미 없다 */ }
    throw error;
  }
}

// ── 읽기(정본 → 무효면 마지막 정상 사본 → 그래도 없으면 기본 문서) ─────────────────

export interface StoredSpendPolicyRead {
  readonly present: boolean;
  readonly valid: boolean;
  /** 검증을 통과한 «원시 파싱 문서» — applySpendPolicyOverlay 의 입력. */
  readonly parsed: unknown;
  readonly errors: string[];
  readonly warnings: string[];
  readonly meta: { readonly version: number; readonly updatedAt: string } | undefined;
  /** 정본이 무효여서 마지막 정상 사본(policy.last-good.yaml)으로 읽었다(fail-closed 되돌림). */
  readonly fromLastGood: boolean;
}

/** 문서 검증 — 저장 문서는 기본 행을 참조·부분 덮어씀 하므로 기본 문서를 문맥으로 넣는다. */
function validateStored(input: unknown, storedRows: Readonly<Record<string, LlmSpendRowKind>> = {}): LlmSpendPolicyValidation {
  const defaults = defaultSpendPolicyDoc();
  const baseRows: Record<string, LlmSpendRowKind> = { ...storedRows, ...Object.fromEntries(Object.entries(defaults.providers).map(([key, row]) => [key, row.kind])) };
  return validateSpendPolicyDoc(input, { knownRows: Object.keys(baseRows), baseRows });
}

const ABSENT = Symbol('absent');

/**
 * 정책 YAML 하나를 읽는다: ENOENT/ENOTDIR 이면 ABSENT(=«파일이 없다» — 정상 상태),
 * 읽기·파싱·검증 실패는 사유를 errors 에 남기고 undefined — «파일이 있지만 못 쓴다».
 */
function readPolicyYaml(file: string, errors: string[], warnings: string[]): unknown | typeof ABSENT | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return ABSENT;
    errors.push(`cannot read ${file}: ${code ?? 'unknown'}`);
    return undefined;
  }
  try {
    const doc = parseDocument(raw, { uniqueKeys: true });
    // ⛔ YAML 오류 message 는 원문 조각(코드 프레임)을 담는다 — 코드·위치만 싣는다(비밀 원문 0).
    if (doc.errors.length) throw new Error(doc.errors.map((e) => `${e.code}${e.linePos?.[0] ? ` at line ${e.linePos[0].line}, column ${e.linePos[0].col}` : ''}`).join('; '));
    const emptyDocument = doc.contents === null || (isScalar(doc.contents) && doc.contents.type === 'PLAIN' && doc.contents.source === '');
    const parsed: unknown = emptyDocument ? {} : doc.toJS();
    const validation = validateStored(parsed);
    errors.push(...validation.errors);
    warnings.push(...validation.warnings);
    if (!validation.valid) return undefined;
    return parsed;
  } catch (error) {
    errors.push(`invalid ${file}: ${(error instanceof Error ? error.message : String(error)).split(/[\s,;:'"()=<>]+/).map(safeToken).join(' ')}`);
    return undefined;
  }
}

function readMeta(metaFile: string): { version: number; updatedAt: string } | undefined {
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { version?: unknown; updatedAt?: unknown };
    if (typeof meta.version === 'number' && Number.isFinite(meta.version) && typeof meta.updatedAt === 'string') {
      return { version: meta.version, updatedAt: meta.updatedAt };
    }
  } catch { /* 메타가 없거나 못 읽으면 버전 없음 — 정책 문서는 여전히 유효할 수 있다 */ }
  return undefined;
}

export async function readStoredSpendPolicy(dirOverride?: string): Promise<StoredSpendPolicyRead> {
  const paths = await spendPolicyFiles(dirOverride);
  const meta = readMeta(paths.meta);
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = readPolicyYaml(paths.policy, errors, warnings);
  if (parsed === ABSENT) {
    return { present: false, valid: true, parsed: undefined, errors, warnings, meta, fromLastGood: false };
  }
  if (parsed !== undefined) {
    return { present: true, valid: true, parsed, errors, warnings, meta, fromLastGood: false };
  }
  // 정본이 무효하다 — «이전 정상 정책 유지»: 마지막 정상 사본으로 읽는다(fail-closed · 대표 07:2x).
  warnings.push(`정본이 무효 — 마지막 정상 사본으로 읽는다: ${errors.join(' · ')}`);
  const lastGoodErrors: string[] = [];
  const lastGoodWarnings: string[] = [];
  const lastGood = readPolicyYaml(paths.lastGood, lastGoodErrors, lastGoodWarnings);
  if (lastGood !== ABSENT && lastGood !== undefined) {
    return { present: true, valid: true, parsed: lastGood, errors, warnings: [...warnings, ...lastGoodWarnings], meta, fromLastGood: true };
  }
  return { present: true, valid: false, parsed: undefined, errors, warnings, meta, fromLastGood: false };
}

// ── 적용 정책(코드 기본 + 저장 덮어씀 · 각 값 출처 default/stored) ────────────────

export interface AppliedSpendPolicyView {
  readonly policy: LlmSpendPolicyDoc;
  readonly sources: Record<string, LlmSpendPolicySource>;
  readonly stored: StoredSpendPolicyRead;
  /** 주입된 공급자 상태(«주입된 것만» — CLI·판정이 여기에 넣는다). */
  readonly states: readonly LlmSpendRowState[];
  readonly dir: string;
  readonly overlayErrors: string[];
}

export async function readAppliedSpendPolicy(opts: { dir?: string; states?: readonly LlmSpendRowState[] } = {}): Promise<AppliedSpendPolicyView> {
  const dir = await llmSpendPolicyDir(opts.dir);
  const stored = await readStoredSpendPolicy(opts.dir);
  const fallback = (): AppliedSpendPolicyView => ({
    policy: defaultSpendPolicyDoc(),
    sources: defaultSpendPolicySources(),
    stored, states: opts.states ?? [], dir, overlayErrors: [],
  });
  if (!stored.valid || stored.parsed === undefined) return fallback();
  const applied = applySpendPolicyOverlay(stored.parsed);
  if ('error' in applied) {
    return { ...fallback(), overlayErrors: [applied.error] };
  }
  return { policy: applied.policy, sources: applied.sources, stored, states: opts.states ?? [], dir, overlayErrors: [] };
}

// ── 쓰기(검증 먼저 · 원자 · 버전 · 변경 원장 1줄 · 마지막 정상 사본 갱신) ───────────

export interface SpendPolicyChangeLine {
  readonly at: string;
  readonly actor: string;
  readonly version: number;
  readonly changedKeys: readonly string[];
}

export type WriteSpendPolicyResult =
  | { readonly ok: true; readonly version: number; readonly changedKeys: readonly string[]; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[]; readonly warnings: readonly string[] };

function leafPathsOf(value: unknown, prefix = ''): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    return prefix ? { [prefix]: value } : {};
  }
  return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, item]) => {
    Object.assign(acc, leafPathsOf(item, prefix ? `${prefix}.${key}` : key));
    return acc;
  }, {});
}

/** 이전 적용 값과 새 적용 값의 «잎 경로» 차이 — 변경 원장의 «바뀐 키» 목록. */
function changedLeafKeys(before: LlmSpendPolicyDoc, after: LlmSpendPolicyDoc): string[] {
  const beforeLeaves = leafPathsOf(before);
  const afterLeaves = leafPathsOf(after);
  const changed: string[] = [];
  for (const [path, value] of Object.entries(afterLeaves)) {
    if (!Object.hasOwn(beforeLeaves, path) || JSON.stringify(beforeLeaves[path]) !== JSON.stringify(value)) changed.push(path);
  }
  for (const path of Object.keys(beforeLeaves)) {
    if (!Object.hasOwn(afterLeaves, path)) changed.push(path);
  }
  return changed.sort();
}

type RawObj = Record<string, unknown>;
const isRawObj = (v: unknown): v is RawObj => v !== null && typeof v === 'object' && !Array.isArray(v);

function defineOwn(target: RawObj, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
}

/** 키 단위 병합 — 매핑은 재귀로 합치고, 배열·스칼라는 새 값이 통째로 바꾼다. 입력에 없는 저장 키는 그대로 남는다. */
function mergeRaw(base: unknown, patch: unknown): unknown {
  if (!isRawObj(base) || !isRawObj(patch)) return structuredClone(patch);
  const out: RawObj = {};
  for (const [key, value] of Object.entries(base)) defineOwn(out, key, structuredClone(value));
  for (const [key, value] of Object.entries(patch)) {
    defineOwn(out, key, Object.hasOwn(out, key) ? mergeRaw(out[key], value) : structuredClone(value));
  }
  return out;
}

/** «명시 삭제» — providers.<행>: null · roles.<역할>: null 만 저장된 행·역할을 지운다(기본 행은 코드 기본으로 돌아간다). */
function splitExplicitDeletes(document: unknown): { cleaned: unknown; deletes: { providers: string[]; roles: string[] } } {
  const deletes = { providers: [] as string[], roles: [] as string[] };
  if (!isRawObj(document)) return { cleaned: document, deletes };
  const cleaned: RawObj = {};
  for (const [section, value] of Object.entries(document)) {
    if ((section === 'providers' || section === 'roles') && isRawObj(value)) {
      const kept: RawObj = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === null) deletes[section].push(key);
        else defineOwn(kept, key, item);
      }
      defineOwn(cleaned, section, kept);
    } else defineOwn(cleaned, section, value);
  }
  return { cleaned, deletes };
}

/**
 * 정책 정본을 쓴다(«패널» 칸 전용 — CLI 노출 0). 검증을 통과한 것만 원자 쓰기된다.
 * ⛔ 병합 쓰기: 입력은 «부분 문서» 여도 된다 — 저장돼 있던 문서와 키 단위로 병합해 쓴다(입력에 없는 다른 행·역할·키 보존).
 *   제거는 명시 삭제(providers.<행>: null · roles.<역할>: null)만. 병합본 전체를 다시 검증한 뒤 정본·last-good 에 같은 병합본을 쓴다.
 * 실패하면 {ok:false, errors} — 디스크는 그대로(이전 정상 정책 유지 · fail-closed).
 */
export async function writeStoredSpendPolicy(input: {
  readonly actor: string;
  readonly document: unknown;
  readonly now?: Date;
  readonly dir?: string;
}): Promise<WriteSpendPolicyResult> {
  const { cleaned, deletes } = splitExplicitDeletes(input.document);
  const paths = await spendPolicyFiles(input.dir);
  const now = input.now ?? new Date();
  const at = now.toISOString();
  mkdirSync(dirname(paths.policy), { recursive: true }); // 잠금 파일도 이 폴더에 생긴다.

  return withFileLockSync(paths.lock, (): WriteSpendPolicyResult => {
    // 저장돼 있던 문서(정본 → 마지막 정상 사본 → 없음) — 병합 바탕·바뀐 키 계산용.
    const beforeStored = readStoredSpendPolicySync(paths);
    const storedRaw: unknown = beforeStored.valid && isRawObj(beforeStored.parsed) ? beforeStored.parsed : {};
    const storedRows = isRawObj(storedRaw) && isRawObj(storedRaw.providers)
      ? Object.fromEntries(Object.entries(storedRaw.providers).flatMap(([key, row]) => (isRawObj(row) && isRowKindValue(row.kind) ? [[key, row.kind] as const] : [])))
      : {};
    // 1) 입력 단독 검증(비밀 모양·틀린 키·범위) — 부분 행은 기본 행·저장 행의 kind 를 따른다.
    const inputValidation = validateStored(cleaned, storedRows);
    if (!inputValidation.valid) return { ok: false as const, errors: inputValidation.errors, warnings: inputValidation.warnings };

    // 2) 병합 + 명시 삭제 → 병합본 전체 재검증(교차 참조·kind·필수 칼럼).
    let merged = mergeRaw(storedRaw, cleaned) as RawObj;
    for (const section of ['providers', 'roles'] as const) {
      const sectionValue = merged[section];
      if (deletes[section].length > 0 && isRawObj(sectionValue)) {
        const kept: RawObj = {};
        for (const [key, item] of Object.entries(sectionValue)) if (!deletes[section].includes(key)) defineOwn(kept, key, item);
        merged = { ...merged, [section]: kept };
      }
    }
    const mergedValidation = validateStored(merged);
    if (!mergedValidation.valid) return { ok: false as const, errors: mergedValidation.errors, warnings: mergedValidation.warnings };

    // 3) 직렬화 허용 목록을 통과한 병합본만 쓴다(kind 는 기본 행·저장 행에서 확정).
    const serialized = serializeMergedRaw(merged, storedRows);
    const afterApplied = applySpendPolicyOverlay(serialized);
    if ('error' in afterApplied) {
      // overlay 오류 = 적용 불가한 정책 — 저장하지 않는다(이전 정상 정책 유지 · fail-closed).
      return { ok: false as const, errors: [afterApplied.error], warnings: mergedValidation.warnings };
    }
    const beforeOverlay = beforeStored.valid && beforeStored.parsed !== undefined ? applySpendPolicyOverlay(beforeStored.parsed) : undefined;
    const beforeApplied = beforeOverlay !== undefined && !('error' in beforeOverlay) ? beforeOverlay.policy : defaultSpendPolicyDoc();
    const changedKeys = changedLeafKeys(beforeApplied, afterApplied.policy);

    // 최신 정상 정책(= 병합본)을 항상 last-good 으로(첫 쓰기 포함) — 정본이 이후 손상돼도 «최신 병합본» 으로 복구된다.
    const policyText = `${stringify(serialized, { indentSeq: false })}# 이 파일은 넥서스 «한 벌» 정본이다 — 편집은 «패널» 칸(owner 인증 · POST+Origin)만.\n`;
    // 커밋 순서: 정본 먼저 · last-good 나중(Terra 리뷰 must) — 두 쓰기 사이에서 중단·실패해도 last-good 에는 «이미 커밋된» 정책만 남는다.
    writeAtomic0600(paths.policy, policyText);
    writeAtomic0600(paths.lastGood, policyText);
    const previous = readMeta(paths.meta);
    const version = (previous?.version ?? 0) + 1;
    writeAtomic0600(paths.meta, `${JSON.stringify({ version, updatedAt: at })}\n`);
    const line: SpendPolicyChangeLine = { at, actor: input.actor, version, changedKeys };
    appendFileSync(paths.changes, `${JSON.stringify(line)}\n`, 'utf8');
    return { ok: true as const, version, changedKeys, warnings: mergedValidation.warnings };
  });
}

const isRowKindValue = (v: unknown): v is LlmSpendRowKind => v === 'subscription' || v === 'credit' || v === 'acp-device';

/** 병합된 «원시» 문서를 허용 목록으로 직렬화 — 행 kind 가 비면 기본 행·저장 행 kind 로 채운다(부분 행이 kind 없이 적히지 않게). */
function serializeMergedRaw(merged: RawObj, storedRows: Readonly<Record<string, LlmSpendRowKind>>): RawObj {
  const defaults = defaultSpendPolicyDoc();
  const providers: RawObj = {};
  if (isRawObj(merged.providers)) {
    for (const [rowKey, rowRaw] of Object.entries(merged.providers)) {
      const row = rowRaw as RawObj;
      const kind = isRowKindValue(row.kind) ? row.kind : (defaults.providers[rowKey]?.kind ?? storedRows[rowKey]);
      const out = serializeSpendPolicyRow({ ...row, kind } as unknown as LlmSpendRowPolicy);
      // 기본 행을 부분 덮어쓴 행은 kind 를 적지 않는다(없는 키 = 코드 기본값 · 출처 표기 default 유지) — 직렬화 분기에만 kind 를 썼다.
      if (!isRowKindValue(row.kind) && defaults.providers[rowKey] !== undefined) delete out.kind;
      defineOwn(providers, rowKey, out);
    }
  }
  const doc = serializeSpendPolicyDoc({ ...merged, providers: {} } as unknown as LlmSpendPolicyDoc);
  return { ...doc, providers };
}

/** 잠금 안에서 쓰기가 다시 읽어 쓰는 동기 읽기(정본 → 마지막 정상 사본 — 읽기 규약과 같은 순서). */
function readStoredSpendPolicySync(paths: { policy: string; lastGood: string }): { valid: boolean; parsed: unknown } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = readPolicyYaml(paths.policy, errors, warnings);
  if (parsed !== ABSENT && parsed !== undefined) return { valid: true, parsed };
  const lastGood = readPolicyYaml(paths.lastGood, errors, warnings);
  if (lastGood !== ABSENT && lastGood !== undefined) return { valid: true, parsed: lastGood };
  return { valid: false, parsed: undefined };
}

/** 변경 원장 최근 n줄(최신순). */
export async function readRecentSpendPolicyChanges(limit = 20, dirOverride?: string): Promise<SpendPolicyChangeLine[]> {
  const paths = await spendPolicyFiles(dirOverride);
  if (!existsSync(paths.changes)) return [];
  const lines = readFileSync(paths.changes, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const parsed: SpendPolicyChangeLine[] = [];
  for (const line of lines.slice(-Math.max(1, limit))) {
    try {
      const candidate = JSON.parse(line) as SpendPolicyChangeLine;
      if (typeof candidate.at === 'string' && typeof candidate.actor === 'string' && typeof candidate.version === 'number' && Array.isArray(candidate.changedKeys)) {
        parsed.push(candidate);
      }
    } catch { /* 끊긴 줄 — 건너뛴다 */ }
  }
  return parsed.reverse();
}
