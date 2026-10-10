// 흡수 렌즈 — E1 outbox 와 같은 날 공개 GitHub·X 원장 항목을 판정해 outbox/lens/<day>.jsonl 에만 남긴다.
// 원 갈래(goals·manual·review·release)와 원장은 읽기만 한다. LLM 은 judge 한 번(id 당).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { judge } from '../llm/judge-layer.js';
import { loadIntakeLedger } from './items.js';
import { intakeOutboxDir, kstDay } from './route.js';

export const LENS_VERDICTS = ['대체 후보', '보강', '경쟁 대조', '참고'] as const;
export type LensVerdict = (typeof LENS_VERDICTS)[number];

export const LENS_BRANCHES = ['goals', 'manual', 'review', 'release'] as const;
export const LENS_DAILY_CAP = 20;
export const LENS_FACT_CAP = 12;

export interface LensRecord {
  id: string;
  at: string;
  lensVerdict: LensVerdict;
  why: string;
  target: string;
}

export interface LensJudgeInput {
  id: string;
  facts: { fact: string; current: string }[];
  url?: string;
}

export type LensJudge = (input: LensJudgeInput) => Promise<unknown>;

export interface AnnotateIntakeLensDeps {
  judge?: LensJudge;
  now?: () => string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface AnnotateIntakeLensResult {
  judged: number;
  skipped: number;
  failed: number;
  capped: boolean;
}

interface GroupedItem {
  id: string;
  facts: { fact: string; current: string }[];
  url?: string;
}

function readJsonl(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { const row = JSON.parse(line) as unknown; return row && typeof row === 'object' && !Array.isArray(row) ? [row as Record<string, unknown>] : []; }
    catch { return []; }
  });
}

function isTestProcess(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.ELANOUS_TEST_HOME);
}

function isLensVerdict(value: unknown): value is LensVerdict {
  return typeof value === 'string' && (LENS_VERDICTS as readonly string[]).includes(value);
}

/** 스키마 밖이면 null — 기록하지 않는다. why 는 한 문장이다. */
export function coerceLensVerdict(raw: unknown): Omit<LensRecord, 'id' | 'at'> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const why = typeof row.why === 'string' ? row.why.trim() : '';
  const target = typeof row.target === 'string' ? row.target.trim() : '';
  if (!isLensVerdict(row.lensVerdict) || !why || !target) return null;
  if (/[\r\n]/.test(why)) return null;
  return { lensVerdict: row.lensVerdict, why, target };
}

function groupOutbox(root: string, day: string): GroupedItem[] {
  const out = intakeOutboxDir(root);
  const order: string[] = [];
  const groups = new Map<string, GroupedItem>();
  for (const branch of LENS_BRANCHES) {
    for (const row of readJsonl(join(out, branch, `${day}.jsonl`))) {
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      const fact = typeof row.fact === 'string' ? row.fact.trim() : '';
      const current = typeof row.current === 'string' ? row.current.trim() : '';
      if (!id || !fact) continue;
      let group = groups.get(id);
      if (!group) {
        group = { id, facts: [] };
        groups.set(id, group);
        order.push(id);
      }
      if (!group.url && typeof row.url === 'string' && row.url.trim()) group.url = row.url.trim();
      if (group.facts.length < LENS_FACT_CAP) group.facts.push({ fact, current });
    }
  }
  return order.map((id) => groups.get(id)!);
}

function ledgerLensItems(root: string, day: string, existing: ReadonlySet<string>): GroupedItem[] {
  const items: GroupedItem[] = [];
  const seen = new Set(existing);
  const ledger = [...loadIntakeLedger(root).items.values()];
  for (const source of ['github', 'x'] as const) {
    for (const item of ledger) {
      if (!item.id || seen.has(item.id) || item.status === 'discarded' || item.privacy !== 'public'
        || !item.url || kstDay(item.lastSeenAt) !== day || !item.sources?.includes(source)) continue;
      const title = item.title?.trim();
      const text = item.text?.trim();
      const facts = [title, text].filter((value): value is string => Boolean(value)).slice(0, LENS_FACT_CAP)
        .map((fact) => ({ fact, current: '' }));
      if (!facts.length) continue;
      seen.add(item.id);
      items.push({ id: item.id, facts, url: item.url });
    }
  }
  return items;
}

function judgedIds(file: string): Set<string> {
  return new Set(readJsonl(file).flatMap((row) => typeof row.id === 'string' && row.id ? [row.id] : []));
}

function lensPrompt(item: GroupedItem): string {
  const lines = item.facts.map((row, i) => `${i + 1}. fact: ${row.fact}\n   current: ${row.current || '(없음)'}`);
  return [
    'SYSTEM:',
    '흡수 항목이 우리에게 무엇인가를 한 번만 판정한다. 경로를 나열하지 말고, 왜 우리에게 그 판정인지를 한 문장으로 말한다.',
    'lensVerdict 는 다음 넷 중 하나다: 대체 후보 · 보강 · 경쟁 대조 · 참고.',
    'target 은 닿는 우리 쪽 이름 하나(기능·칸·파일)다.',
    'JSON 만 답한다: {"lensVerdict":"...","why":"...","target":"..."}',
    '',
    `id: ${item.id}`,
    ...(item.url ? [`url: ${item.url}`] : []),
    ...lines,
  ].join('\n');
}

async function defaultJudge(item: GroupedItem): Promise<unknown> {
  const decision = await judge({
    site: 'intake.lens',
    prompt: lensPrompt(item),
    schema: (value) => coerceLensVerdict(value),
  });
  if (!decision.ok) {
    if (decision.reason === 'schema') return null;
    throw decision.error instanceof Error ? decision.error : new Error(String(decision.error));
  }
  return decision.value;
}

/** 그날 E1 outbox 뒤에 공개 GitHub·X 원장을 붙여 아직 없는 판정만 남긴다. 원천 파일은 쓰지 않는다. */
export async function annotateIntakeLens(
  root: string,
  day: string,
  deps: AnnotateIntakeLensDeps = {},
): Promise<AnnotateIntakeLensResult> {
  const log = deps.log ?? ((event, data) => { debug.log('intake.lens', event, data); });
  const empty = { judged: 0, skipped: 0, failed: 0, capped: false };
  if (!deps.judge && isTestProcess()) {
    log('skipped-test', {});
    return empty;
  }
  const outbox = groupOutbox(root, day);
  const ledger = ledgerLensItems(root, day, new Set(outbox.map((item) => item.id)));
  const items = [...outbox, ...ledger];
  const file = join(intakeOutboxDir(root), 'lens', `${day}.jsonl`);
  const done = judgedIds(file);
  const pending = items.filter((item) => !done.has(item.id));
  const remaining = Math.max(0, LENS_DAILY_CAP - done.size);
  const capped = pending.length > remaining;
  const batch = pending.slice(0, remaining);
  if (capped) {
    const skippedIds = pending.slice(remaining).map((item) => item.id);
    log('capped', { day, total: pending.length, judged: batch.length, skippedIds,
      ...(skippedIds.length ? { marker: `외 ${skippedIds.length}건 · 원장 \`elanous intake items\`` } : {}) });
  }
  const judgeOne = deps.judge ?? ((input: LensJudgeInput) => defaultJudge(input));
  const now = deps.now ?? (() => new Date().toISOString());
  let judged = 0;
  let failed = 0;
  for (const item of batch) {
    let raw: unknown;
    try {
      raw = await judgeOne({ id: item.id, facts: item.facts, ...(item.url ? { url: item.url } : {}) });
    } catch (error) {
      failed++;
      log('judge-failed', { id: item.id, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const verdict = coerceLensVerdict(raw);
    if (!verdict) {
      failed++;
      log('judge-failed', { id: item.id, reason: 'schema' });
      continue;
    }
    mkdirSync(join(intakeOutboxDir(root), 'lens'), { recursive: true });
    const record: LensRecord = { id: item.id, at: now(), ...verdict };
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    judged++;
  }
  return { judged, skipped: items.length - pending.length, failed, capped };
}
