// COORD-WORLD-TRANSFORM — 세계 변경 원장 (JSONL append).
// 각 세계 변형마다 «무엇·왜·되돌리기·지표» 한 줄 기록: append 전용 JSONL, 되돌리기 표시는 원자적 재작성(temp+rename).
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type WorldChangeHandle = 'seat' | 'structure' | 'device' | 'rule' | 'resource' | 'goal';
export type WorldChangeAction = 'relocate' | 'modify' | 'create';

/** 원장 한 줄 — 변형의 «무엇(what)·왜(why)·되돌리기(revert)·지표(metricsBefore)». */
export interface WorldChangeEntry {
  id: string;
  /** ISO 시각. */
  at: string;
  goal: string;
  handle: WorldChangeHandle;
  action: WorldChangeAction;
  what: string;
  why: string;
  /** 되돌리기 단계 — 빈 배열 금지(되돌릴 수 없는 변형은 없다). */
  revert: string[];
  metricsBefore: Record<string, number>;
  world: 'sim' | 'ops';
  status: 'applied' | 'reverted';
}

export type WorldChangeDraft = Omit<WorldChangeEntry, 'id' | 'status'> & { id?: string; status?: WorldChangeEntry['status'] };

let seq = 0;
const newId = (): string => `wc-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** 한 줄 원자적 append — 원장은 한 번 쓴 기록을 지우지 않는다. */
export function recordWorldChange(file: string, draft: WorldChangeDraft): WorldChangeEntry {
  const entry: WorldChangeEntry = { ...draft, id: draft.id ?? newId(), status: draft.status ?? 'applied' };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

const isEntry = (v: unknown): v is WorldChangeEntry =>
  typeof v === 'object' && v !== null && typeof (v as WorldChangeEntry).id === 'string'
  && typeof (v as WorldChangeEntry).goal === 'string' && Array.isArray((v as WorldChangeEntry).revert);

/** 손상된 줄(반쯤 쓴 행 등)은 건너뛰고 유효한 기록만 반환한다. 파일 없으면 빈 목록. */
export function listWorldChanges(file: string): WorldChangeEntry[] {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  const out: WorldChangeEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const parsed = JSON.parse(line) as unknown; if (isEntry(parsed)) out.push(parsed); } catch { /* 반쯤 쓴 줄은 건너뛴다 */ }
  }
  return out;
}

/** 되돌리기 표시 — 해당 id 의 status 만 'reverted' 로 바꾼다(파일은 temp+rename 원자적 재작성). 없는 id 면 null. */
export function markReverted(file: string, id: string): WorldChangeEntry | null {
  const entries = listWorldChanges(file);
  let flipped: WorldChangeEntry | null = null;
  const updated = entries.map((e): WorldChangeEntry => {
    if (e.id !== id) return e;
    flipped = { ...e, status: 'reverted' };
    return flipped;
  });
  if (!flipped) return null;
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, updated.map((e) => JSON.stringify(e)).join('\n') + '\n');
  renameSync(temp, file);
  return flipped;
}
