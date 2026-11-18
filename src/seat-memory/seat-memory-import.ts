// 🧠 OP-MEMORY-PARITY (O6) — Claude Code 기억 폴더 → eln 자리 기억 저장소 가져오기.
// 원본은 읽기만 한다(readdir·lstat·readFile 뿐 · 쓰기·이동·지우기 0). 기본은 미리보기(dry-run)이고 `apply` 일 때만 쓴다.
// 비밀처럼 보이는 파일은 통째로 거부하고 «이름만» 알린다 — 본문·일치한 값은 출력·로그 어디에도 싣지 않는다.
// 파일은 원문 그대로 옮긴다(최근 Claude Code 의 `metadata:` 아래 type 꼴도 자리 저장소가 그대로 읽는다).
// 색인은 원본 MEMORY.md 의 손 고른 순서·묶음을 지키고, 거부·누락 파일을 가리키는 줄만 뺀다.

import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { writeFileDurable } from '../memory.js';
import {
  SEAT_MEMORY_INDEX_FILE, listSeatMemories, looksSecret, parseSeatMemoryText, seatMemoryIndexLine,
  readSeatMemoryIndex,
} from './seat-memory.js';

export type SeatMemoryImportAction = 'create' | 'update' | 'same';
export type SeatMemoryImportSkip = 'secret-pattern' | 'unparsable' | 'not-regular-file';

export interface SeatMemoryImportPlan {
  from: string;
  to: string;
  seat: string;
  files: Array<{ file: string; name: string; action: SeatMemoryImportAction; text: string }>;
  /** 거부·건너뛴 파일 — 이름만(본문 0). */
  skipped: Array<{ file: string; reason: SeatMemoryImportSkip }>;
  /** 새 색인 문면(원본 순서 보존 ⊕ 기존 자리 줄 ⊕ 빠진 줄 보충). */
  index: string;
  indexDroppedLines: number;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 실재하는 가장 가까운 조상까지 realpath 로 풀고 나머지를 붙인다 — 아직 없는 대상 폴더도 원본과 겹침을 바르게 잰다(맥 /var → /private/var). */
function realOrSelf(path: string): string {
  const abs = resolve(path);
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return abs;
    tail.unshift(basename(head));
    head = parent;
  }
  try { return join(realpathSync(head), ...tail); } catch { return abs; }
}

/** 원본을 읽어 계획을 만든다(쓰기 0). */
export function planSeatMemoryImport(opts: { from: string; to: string; seat: string }): SeatMemoryImportPlan {
  const from = realOrSelf(opts.from);
  const to = realOrSelf(opts.to);
  if (!existsSync(from) || !lstatSync(from).isDirectory()) throw new Error('--from 은 기억 폴더(디렉터리)여야 한다');
  if (isInside(to, from) || isInside(from, to)) throw new Error('원본과 대상 폴더가 겹친다 — 원본은 읽기 전용이다');
  const existing = new Map(listSeatMemories(to).map(e => [e.file, e]));
  const existingByName = new Map(listSeatMemories(to).map(e => [e.name, e]));
  const files: SeatMemoryImportPlan['files'] = [];
  const skipped: SeatMemoryImportPlan['skipped'] = [];
  for (const file of readdirSync(from).sort()) {
    if (file === SEAT_MEMORY_INDEX_FILE || !file.endsWith('.md')) continue;
    const path = join(from, file);
    let st;
    try { st = lstatSync(path); } catch { continue; }
    if (!st.isFile()) { skipped.push({ file, reason: 'not-regular-file' }); continue; }
    const text = readFileSync(path, 'utf8');
    if (looksSecret(text)) { skipped.push({ file, reason: 'secret-pattern' }); continue; }
    const entry = parseSeatMemoryText(text, file);
    if (!entry) { skipped.push({ file, reason: 'unparsable' }); continue; }
    // 같은 name 이 다른 파일로 이미 있으면 그 파일을 고친다(중복 0).
    const target = existingByName.get(entry.name)?.file ?? file;
    const current = existing.get(target);
    const action: SeatMemoryImportAction = !current ? 'create'
      : readFileSync(join(to, target), 'utf8') === text ? 'same' : 'update';
    files.push({ file: target, name: entry.name, action, text });
  }
  // 색인: 원본 줄(거부·누락 파일 가리키는 줄과 비밀처럼 보이는 줄은 뺌) → 대상에만 있는 기존 줄 → 줄 없는 가져온 기억.
  const imported = new Set(files.map(f => f.file));
  const sourceIndex = existsSync(join(from, SEAT_MEMORY_INDEX_FILE)) && lstatSync(join(from, SEAT_MEMORY_INDEX_FILE)).isFile()
    ? readFileSync(join(from, SEAT_MEMORY_INDEX_FILE), 'utf8') : '';
  const linkOf = (line: string): string | null => /\]\(([^)\s]+\.md)\)/.exec(line)?.[1] ?? null;
  const out: string[] = [];
  let dropped = 0;
  for (const line of sourceIndex.replace(/\n+$/, '').split('\n')) {
    if (!sourceIndex) break;
    const link = linkOf(line);
    if ((link && !imported.has(link) && !existing.has(link)) || looksSecret(line)) { dropped += 1; continue; }
    out.push(line);
  }
  const has = (file: string): boolean => out.some(l => l.includes(`](${file})`));
  for (const line of readSeatMemoryIndex(to).replace(/\n+$/, '').split('\n')) {
    const link = linkOf(line);
    if (link && !has(link)) out.push(line);
  }
  for (const f of files) {
    if (!has(f.file)) {
      const entry = parseSeatMemoryText(f.text, f.file)!;
      out.push(seatMemoryIndexLine(entry));
    }
  }
  return { from, to, seat: opts.seat, files, skipped, index: out.length ? `${out.join('\n')}\n` : '', indexDroppedLines: dropped };
}

export interface SeatMemoryImportSummary {
  create: number; update: number; same: number; skipped: number;
  skippedByReason: Partial<Record<SeatMemoryImportSkip, number>>;
  /** 거부된 파일 이름(본문 0). */
  refusedNames: string[];
  applied: boolean;
}

export function summarizeSeatMemoryImport(plan: SeatMemoryImportPlan, applied: boolean): SeatMemoryImportSummary {
  const count = (a: SeatMemoryImportAction): number => plan.files.filter(f => f.action === a).length;
  const byReason: Partial<Record<SeatMemoryImportSkip, number>> = {};
  for (const s of plan.skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  return {
    create: count('create'), update: count('update'), same: count('same'), skipped: plan.skipped.length,
    skippedByReason: byReason, refusedNames: plan.skipped.filter(s => s.reason === 'secret-pattern').map(s => s.file), applied,
  };
}

/** 계획대로 대상 폴더에 쓴다. 원본은 다시 읽지도 않는다(계획에 담긴 문면만 쓴다). */
export function applySeatMemoryImport(plan: SeatMemoryImportPlan): SeatMemoryImportSummary {
  mkdirSync(plan.to, { recursive: true });
  for (const f of plan.files) if (f.action !== 'same') writeFileDurable(join(plan.to, f.file), f.text);
  writeFileDurable(join(plan.to, SEAT_MEMORY_INDEX_FILE), plan.index);
  const summary = summarizeSeatMemoryImport(plan, true);
  debug.log('memory', 'imported', {
    seat: plan.seat, create: summary.create, update: summary.update, same: summary.same,
    skipped: summary.skipped, refusedNames: summary.refusedNames, indexDroppedLines: plan.indexDroppedLines,
  });
  return summary;
}
