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
const SUPPLEMENTAL_MARKER = '<!-- elanous seat memory import: unindexed -->';

export interface SeatMemoryImportPlan {
  from: string;
  to: string;
  seat: string;
  files: Array<{ file: string; name: string; action: SeatMemoryImportAction; text: string; reference?: boolean }>;
  /** 거부·건너뛴 파일 — 이름만(본문 0). */
  skipped: Array<{ file: string; reason: SeatMemoryImportSkip }>;
  /** 손 고른 원본 주 색인 줄만 담는다. */
  index: string;
  /** 주 색인 밖 기억을 가리키는 하위 색인. 첫 턴 주 색인에는 자동으로 붙이지 않는다. */
  supplementalIndex?: { file: string; text: string };
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

function regularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function pathOccupied(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function supplementalFileName(from: string, to: string): string {
  for (let suffix = 0; suffix < 100; suffix++) {
    const name = suffix ? `MEMORY-UNINDEXED-${suffix + 1}.md` : 'MEMORY-UNINDEXED.md';
    if (pathOccupied(join(from, name))) continue;
    const target = join(to, name);
    let stat;
    try { stat = lstatSync(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return name;
      throw error;
    }
    if (stat.isFile() && readFileSync(target, 'utf8').startsWith(SUPPLEMENTAL_MARKER)) return name;
  }
  throw new Error('보조 색인 파일 이름을 안전하게 고를 수 없음');
}

/** 원본을 읽어 계획을 만든다(쓰기 0). */
export function planSeatMemoryImport(opts: { from: string; to: string; seat: string }): SeatMemoryImportPlan {
  const from = realOrSelf(opts.from);
  const to = realOrSelf(opts.to);
  if (!existsSync(from) || !lstatSync(from).isDirectory()) throw new Error('--from 은 기억 폴더(디렉터리)여야 한다');
  if (isInside(to, from) || isInside(from, to)) throw new Error('원본과 대상 폴더가 겹친다 — 원본은 읽기 전용이다');
  const existing = new Map(listSeatMemories(to).map(e => [e.file, e]));
  const existingByName = new Map(listSeatMemories(to).map(e => [e.name, e]));
  const sourceIndexPath = join(from, SEAT_MEMORY_INDEX_FILE);
  const sourceIndex = existsSync(sourceIndexPath) && lstatSync(sourceIndexPath).isFile()
    ? readFileSync(sourceIndexPath, 'utf8') : '';
  const linkOf = (line: string): string | null => /\]\(([^)\s]+\.md)\)/.exec(line)?.[1] ?? null;
  const sourceLinks = new Set(sourceIndex.split('\n').map(linkOf).filter((link): link is string => link !== null));
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
    if (!entry) {
      // A linked subindex is a reference document, not a malformed memory card.
      if (!sourceLinks.has(file)) { skipped.push({ file, reason: 'unparsable' }); continue; }
      const targetPath = join(to, file);
      const present = existsSync(targetPath) && lstatSync(targetPath).isFile();
      files.push({ file, name: file, reference: true, action: !present ? 'create'
        : readFileSync(targetPath, 'utf8') === text ? 'same' : 'update', text });
      continue;
    }
    // 같은 name 이 다른 파일로 이미 있으면 그 파일을 고친다(중복 0).
    const target = existingByName.get(entry.name)?.file ?? file;
    const current = existing.get(target);
    const action: SeatMemoryImportAction = !current ? 'create'
      : readFileSync(join(to, target), 'utf8') === text ? 'same' : 'update';
    files.push({ file: target, name: entry.name, action, text });
  }
  // 원본 주 색인 줄은 제자리 보존. 대상의 옛 자동 덧붙임과 새 미색인 기억은 하위 색인으로 이동.
  const imported = new Set(files.map(f => f.file));
  const out: string[] = [];
  let dropped = 0;
  const available = (link: string): boolean => basename(link) === link
    && (imported.has(link) || existing.has(link) || regularFile(join(to, link)));
  for (const line of sourceIndex.replace(/\n+$/, '').split('\n')) {
    if (!sourceIndex) break;
    const link = linkOf(line);
    if ((link && !available(link)) || looksSecret(line)) { dropped += 1; continue; }
    out.push(line);
  }
  const supplemental: string[] = [];
  const has = (lines: string[], file: string): boolean => lines.some(l => l.includes(`](${file})`));
  for (const line of readSeatMemoryIndex(to).replace(/\n+$/, '').split('\n')) {
    const link = linkOf(line);
    if (link && basename(link) === link && !looksSecret(line) && !has(out, link)
      && (imported.has(link) || existing.has(link)) && !has(supplemental, link)) supplemental.push(line);
  }
  for (const f of files) {
    if (!f.reference && !has(out, f.file) && !has(supplemental, f.file)) {
      const entry = parseSeatMemoryText(f.text, f.file)!;
      supplemental.push(seatMemoryIndexLine(entry));
    }
  }
  for (const entry of existing.values()) {
    if (!has(out, entry.file) && !has(supplemental, entry.file)) supplemental.push(seatMemoryIndexLine(entry));
  }
  const supplementalFile = supplemental.length ? supplementalFileName(from, to) : null;
  return { from, to, seat: opts.seat, files, skipped, index: out.length ? `${out.join('\n')}\n` : '',
    ...(supplementalFile ? { supplementalIndex: { file: supplementalFile, text: `${SUPPLEMENTAL_MARKER}\n${supplemental.join('\n')}\n` } } : {}),
    indexDroppedLines: dropped };
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
  if (plan.supplementalIndex) writeFileDurable(join(plan.to, plan.supplementalIndex.file), plan.supplementalIndex.text);
  writeFileDurable(join(plan.to, SEAT_MEMORY_INDEX_FILE), plan.index);
  const summary = summarizeSeatMemoryImport(plan, true);
  debug.log('memory', 'imported', {
    seat: plan.seat, create: summary.create, update: summary.update, same: summary.same,
    skipped: summary.skipped, refusedNames: summary.refusedNames, indexDroppedLines: plan.indexDroppedLines,
  });
  return summary;
}
