// NEXUS · LLM 지출 전환 원장 — 결정·전환·되돌아오기 각 1줄 (LLM-SPEND-POLICY-ONE-SHOT)
//
// 대표 07:2x: 전환 원장은 «누가·무엇·이전→이후·사유·시각» 한 줄씩 남는다. 이 모듈은 그 «줄» 의
//   append 와 «최근 20줄» 조회만 한다 — 판정은 src/oauth/llm-spend-decision.ts, 정책 정본은 store.ts.
//   저장 위치: 정책 저장소(D) 곁 넥서스 데이터 영역(<config-dir>/nexus/llm-spend-policy/transitions.jsonl).
//   한 줄 = JSONL 1행 · 비밀 값은 애초에 이 줄에 들어올 수 없다(decideLlmSpend 는 이름·사유만 낸다).
//
// 후속 칸 인터페이스: «패널» 칸이 readRecentSpendTransitions 로 최근 전환을 화면에 뿌리고,
//   CODEX-SUBSCRIPTION-CREDIT-GUARD 배선이 decideLlmSpend(...).ledger 줄을 appendSpendTransition 로
//   남긴다. 소진 속도 자동 이동 칸은 이 줄들의 연속(행별 체류 시간)을 읽는다.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLockSync } from '../../storage/file-lock.js';
import { nexusRootDir } from '../paths.js';
import type { LlmSpendLedgerAction, LlmSpendLedgerEntry } from './types.js';

/** 지출 정책 데이터 영역(정책 정본·변경 원장·전환 원장이 함께 사는 «한 벌» 폴더). */
export async function llmSpendPolicyDir(override?: string): Promise<string> {
  if (override) return override;
  return join(await nexusRootDir(), 'llm-spend-policy');
}

export function spendTransitionsFile(dir: string): string {
  return join(dir, 'transitions.jsonl');
}

const ACTIONS: readonly LlmSpendLedgerAction[] = ['decision', 'switch', 'return', 'observe'];

export function isSpendTransitionEntry(entry: unknown): entry is LlmSpendLedgerEntry {
  if (entry === null || typeof entry !== 'object') return false;
  const candidate = entry as Record<string, unknown>;
  return typeof candidate.at === 'string' && Number.isFinite(Date.parse(candidate.at))
    && typeof candidate.actor === 'string' && candidate.actor.length > 0
    && (ACTIONS as readonly string[]).includes(candidate.action as string)
    && typeof candidate.what === 'string' && candidate.what.length > 0
    && (candidate.from === null || typeof candidate.from === 'string')
    && (candidate.to === null || typeof candidate.to === 'string')
    && typeof candidate.reason === 'string' && candidate.reason.length > 0;
}

/** 필수 필드 중 모양이 틀린 «필드 이름» 만 모은다(값은 절대 담지 않는다 — 비밀이 오류 메시지로 새지 않게). */
function invalidSpendEntryFields(entry: unknown): string[] {
  if (entry === null || typeof entry !== 'object') return ['(entry)'];
  const c = entry as Record<string, unknown>;
  const bad: string[] = [];
  if (!(typeof c.at === 'string' && Number.isFinite(Date.parse(c.at)))) bad.push('at');
  if (!(typeof c.actor === 'string' && c.actor.length > 0)) bad.push('actor');
  if (!(ACTIONS as readonly string[]).includes(c.action as string)) bad.push('action');
  if (!(typeof c.what === 'string' && c.what.length > 0)) bad.push('what');
  if (!(c.from === null || typeof c.from === 'string')) bad.push('from');
  if (!(c.to === null || typeof c.to === 'string')) bad.push('to');
  if (!(typeof c.reason === 'string' && c.reason.length > 0)) bad.push('reason');
  return bad;
}

/**
 * 전환 원장에 한 줄 남긴다(결정·전환·되돌아오기 각각 호출). 잠금 안에서 1행 append.
 * ⛔ 모양이 틀린 줄은 절반쯤 적다가 두는 일이 없게 아예 거부한다(throw) — 원장은 믿고 읽는다.
 */
export async function appendSpendTransition(entry: LlmSpendLedgerEntry, dirOverride?: string): Promise<LlmSpendLedgerEntry> {
  if (!isSpendTransitionEntry(entry)) {
    throw new Error(`appendSpendTransition: invalid ledger entry (누가·무엇·사유·시각 필수) — 잘못된 필드: ${invalidSpendEntryFields(entry).join(', ')}`);
  }
  // 허용 목록(화이트리스트): 알려진 7개 필드(+ synthetic:true 표시)만 기록한다 — 추가 필드(비밀 모양 값 포함)는 원장에 닿지 않는다.
  const safe: LlmSpendLedgerEntry = {
    at: entry.at, actor: entry.actor, action: entry.action, what: entry.what, from: entry.from, to: entry.to, reason: entry.reason,
    ...(entry.synthetic === true ? { synthetic: true as const } : {}),
  };
  const dir = await llmSpendPolicyDir(dirOverride);
  const file = spendTransitionsFile(dir);
  mkdirSync(dirname(file), { recursive: true }); // 잠금 파일도 이 폴더에 생긴다 — 먼저 만든다.
  return withFileLockSync(`${file}.lock`, () => {
    appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
    return safe;
  });
}

/**
 * 최근 전환 원장 줄을 읽는다(기본 20줄 · 최신순). 못 읽는 행(끊긴 JSONL)은 조용히 건너뛴다 —
 * 원장 읽기가 시스템을 멈추게 하지 않는다(fail-soft 읽기 · 쓰기는 fail-closed).
 */
export async function readRecentSpendTransitions(limit = 20, dirOverride?: string): Promise<LlmSpendLedgerEntry[]> {
  const dir = await llmSpendPolicyDir(dirOverride);
  const file = spendTransitionsFile(dir);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const want = Math.max(1, limit);
  const parsed: LlmSpendLedgerEntry[] = [];
  // 뒤에서부터 읽어 손상 행은 건너뛰고 «정상 N개» 를 채운다.
  for (let i = lines.length - 1; i >= 0 && parsed.length < want; i -= 1) {
    try {
      const entry: unknown = JSON.parse(lines[i]!);
      if (isSpendTransitionEntry(entry)) parsed.push(entry);
    } catch {
      // 끊긴 줄 — 건너뛴다.
    }
  }
  return parsed;
}
