/** Bounded, read-only context from promoted repository knowhow. */
import { lstatSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';

export const KNOWHOW_PACK_MAX_BYTES = 4096;
const MARKER = '[KNOWHOW-PACK v1';
const SIGNATURES = ['no-progress', 'scope-escape', 'wallclock-cap', 'pod-job-failed', 'gate-failed', 'review-blocked', 'token_revoked'];

export interface KnowhowPack {
  text: string;
  ids: string[];
  bytes: number;
  reason: 'selected' | 'marker-present' | 'source-unreadable' | 'no-promoted-section' | 'no-path-overlap' | 'over-budget';
}

export interface SelectedAuthoringLessons {
  readonly ids: readonly string[];
  readonly prompt: string;
  readonly status: 'loaded' | 'missing' | 'malformed' | 'unreadable' | 'empty';
  readonly invalidRows: number;
}

const AUTHORING_LESSONS_MAX_BYTES = 2_000;
const AUTHORING_LESSONS_MAX_ITEMS = 2;
const AUTHORING_LESSON_CLASSES = new Set([
  'a-missing-predecessor', 'b-stale-path', 'c-unbounded-goal', 'd-rigid-acceptance',
  'e-format-trap', 'f-unaware-of-code', 'g-umbrella-scope', 'env-provider',
  'env-capacity', 'env-stale-image',
]);

function authoringLessonClassHints(ask: string, targetPaths: readonly string[]): Set<string> {
  const hints = new Set<string>();
  const rules: readonly [string, RegExp][] = [
    ['a-missing-predecessor', /predecessor|prerequisite|depends on|dependency|선행|의존|먼저 완료/iu],
    ['b-stale-path', /unsupported path|missing path|path does not exist|not exist|경로.{0,12}(?:없|존재하지)|없는 파일|대상 경로.{0,12}없/iu],
    ['c-unbounded-goal', /unbounded|no scope boundary|scope is unclear|범위.{0,12}(?:무한|불명확|제한 없|경계 없)/iu],
    ['d-rigid-acceptance', /acceptance criteria|acceptance test|검수 기준|수용 기준|판정 조건/iu],
    ['e-format-trap', /format|schema|json|template|형식|스키마|문면/iu],
    ['f-unaware-of-code', /already implemented|existing code|cli registration|entry point|이미 구현|기존 코드|등록 파일|진입점/iu],
    ['g-umbrella-scope', /umbrella|over.?scope|too broad|too many targets|여러 목표|범위가 넓|너무 넓|한 골에|포괄 골/iu],
    ['env-provider', /provider|model|llm|모델|프로바이더/iu],
    ['env-capacity', /capacity|resource|oom|용량|부하|자원/iu],
    ['env-stale-image', /stale image|image mismatch|오래된 이미지|이미지 불일치/iu],
  ];
  for (const [lessonClass, pattern] of rules) if (pattern.test(ask)) hints.add(lessonClass);
  if (targetPaths.length > 5) hints.add('g-umbrella-scope');
  return hints;
}

function authoringAskPaths(ask: string): string[] {
  const paths = new Set<string>();
  for (const match of ask.matchAll(/(?<![\w./~-])([\w.-]+(?:\/[\w.-]+)+)/gu)) {
    const path = match[1].replace(/[.,;:!?]+$/u, '');
    const parts = path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) continue;
    if (/\.[\w-]+$/u.test(parts.at(-1) ?? '')) paths.add(path);
  }
  return [...paths];
}

/** Select up to two relevant lessons, capped by rendered prompt size. Bad optional ledgers only emit observation. */
export function selectRelevantAuthoringLessons(root: string, ask: string): SelectedAuthoringLessons {
  const path = join(root, 'docs', 'goal-context', '05-authoring-lessons.jsonl');
  let source: string;
  try { source = readFileSync(path, 'utf8'); }
  catch (error) {
    return { ids: [], prompt: '', status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', invalidRows: 0 };
  }
  const rows: Record<string, unknown>[] = [];
  let invalidRows = 0;
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      const row = value as Record<string, unknown>;
      if (typeof row.lesson !== 'string' || typeof row.class !== 'string') throw new Error('missing lesson/class');
      // The canonical ledger predates the closed class vocabulary and contains three `other` rows.
      // Ignore those rows individually so valid lessons remain usable; never inject an unknown class.
      if (!AUTHORING_LESSON_CLASSES.has(row.class) && !/^env-[a-z0-9-]+$/u.test(row.class)) { invalidRows += 1; continue; }
      rows.push(row);
    } catch {
      invalidRows += 1;
      return { ids: [], prompt: '', status: 'malformed', invalidRows };
    }
  }
  if (rows.length === 0) return { ids: [], prompt: '', status: 'empty', invalidRows };
  const targetPaths = authoringAskPaths(ask);
  const classHints = authoringLessonClassHints(ask, targetPaths);
  const ranked = rows.map((row, index) => {
    const lessonPaths = typeof row.paths === 'string' ? row.paths.split(/\s*[·,]\s*/u).filter(Boolean) : [];
    const pathMatches = lessonPaths.some((lessonPath) => targetPaths.some((target) =>
      target === lessonPath || target.startsWith(`${lessonPath}/`) || lessonPath.startsWith(`${target}/`)));
    const classMatch = classHints.has(String(row.class));
    const score = (pathMatches ? 4 : 0) + (classMatch ? 2 : 0);
    const lesson = String(row.lesson).trim().replace(/\s+/gu, ' ');
    const cell = typeof row.cell === 'string' ? row.cell.trim() : '';
    const run = typeof row.run === 'string' && row.run.trim() ? row.run.trim() : '';
    const suppliedId = typeof row.id === 'string' && /^[A-Za-z0-9._:-]{1,80}$/u.test(row.id) ? row.id : undefined;
    const digest = createHash('sha256').update(JSON.stringify([row.ts ?? '', row.cell ?? '', row.class, row.lesson, row.paths ?? ''])).digest('hex').slice(0, 10);
    const id = suppliedId ?? `AL-${digest}`;
    const detail = [cell && `칸=${cell}`, `class=${row.class}`, `lesson=${lesson}`, run && `run=${run}`].filter(Boolean).join(' · ');
    return { id, detail, score, index, timestamp: typeof row.ts === 'string' ? row.ts : '' };
  }).filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || right.timestamp.localeCompare(left.timestamp) || left.index - right.index);
  const selected: { id: string; detail: string }[] = [];
  for (const candidate of ranked) {
    if (selected.length >= AUTHORING_LESSONS_MAX_ITEMS) break;
    const line = `- [${candidate.id}] ${candidate.detail}`;
    const next = [...selected.map((entry) => `- [${entry.id}] ${entry.detail}`), line].join('\n');
    if (Buffer.byteLength(next, 'utf8') > AUTHORING_LESSONS_MAX_BYTES) continue;
    selected.push({ id: candidate.id, detail: candidate.detail });
  }
  const prompt = selected.map((entry) => `- [${entry.id}] ${entry.detail}`).join('\n');
  return { ids: selected.map((entry) => entry.id), prompt, status: 'loaded', invalidRows };
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function promotedSections(source: string): Array<{ id: string; text: string }> {
  const sections: Array<{ id: string; text: string }> = [];
  for (const block of source.split(/(?=^## K-[A-Z]+-\d+\b)/m)) {
    const id = /^## (K-[A-Z]+-\d+)\b/m.exec(block)?.[1];
    if (!id || !/^[-*] 출처:.*상태: active\s*$/m.test(block)) continue;
    sections.push({ id, text: block.trim() });
  }
  return sections;
}

function mentionedPaths(text: string): Set<string> {
  // Keep the complete repository-relative path, including package/docs prefixes.
  // First slice: root filenames have no directory context and are deliberately excluded.
  // A path may use any extension; reject absolute and parent-relative paths as whole tokens.
  const paths = new Set<string>();
  for (const match of text.matchAll(/(?<![\w./~-])([\w.-]+(?:\/[\w.-]+)+)/g)) {
    const path = match[1].replace(/[.,;:!?]+$/, '');
    const segments = path.split('/');
    if (segments.some((segment) => segment === '.' || segment === '..' || !segment)) continue;
    if (!/\.[\w-]+$/.test(segments.at(-1) ?? '')) continue;
    paths.add(path);
  }
  return paths;
}

function relevance(goal: string, section: string, targetPaths?: readonly string[]): number {
  const paths = targetPaths === undefined ? mentionedPaths(goal) : new Set(targetPaths);
  const sourcePaths = mentionedPaths(section);
  let score = 0;
  for (const path of paths) {
    if (sourcePaths.has(path)) score += 20;
  }
  // A path-scoped remedy must not be selected solely because an unrelated goal shares its failure label.
  // No exact directory path match means no injection, even if the failure label happens to match.
  if (score === 0) return 0;
  for (const signature of SIGNATURES) {
    if (goal.includes(signature) && section.includes(signature)) score += 6;
  }
  return score;
}

/** Reads only 내부 문서 `KNOWHOW` inside the supplied repository. Verified target paths narrow relevance when supplied. */
export function selectKnowhowPack(repo: string, goal: string, targetPaths?: readonly string[]): KnowhowPack {
  const empty = (reason: KnowhowPack['reason']): KnowhowPack => ({ text: '', ids: [], bytes: 0, reason });
  if (goal.includes(MARKER)) return empty('marker-present');
  const rolesDir = resolve(repo, 'docs/roles');
  let realRoles: string;
  try {
    realRoles = realpathSync(rolesDir);
    if (!inside(realpathSync(repo), realRoles)) return empty('source-unreadable');
  } catch { return empty('source-unreadable'); }
  const candidates: Array<{ id: string; text: string; score: number }> = [];
  let seatDirs: string[];
  try { seatDirs = readdirSync(rolesDir).sort(); } catch { return empty('source-unreadable'); }
  let readableFiles = 0;
  let promotedCount = 0;
  for (const seat of seatDirs) {
    if (!/^[A-Z]{2,4}$/.test(seat)) continue;
    const file = join(rolesDir, seat, 'KNOWHOW.md');
    try {
      if (lstatSync(file).isSymbolicLink()) continue;
      const real = realpathSync(file);
      if (!inside(realRoles, real) || !statSync(real).isFile() || statSync(real).size > 2_000_000) continue;
      const sections = promotedSections(readFileSync(real, 'utf8'));
      readableFiles += 1;
      promotedCount += sections.length;
      for (const section of sections) {
        const score = relevance(goal, section.text, targetPaths);
        if (score > 0) candidates.push({ ...section, score });
      }
    } catch { /* A missing or unreadable source contributes no entry. */ }
  }
  if (readableFiles === 0) return empty('source-unreadable');
  if (promotedCount === 0) return empty('no-promoted-section');
  if (candidates.length === 0) return empty('no-path-overlap');
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (selected.length === 3) break;
    const next = [...selected, candidate];
    const ids = next.map((item) => item.id);
    const body = next.map((item) => item.text).join('\n\n');
    const text = `${MARKER} ids=${ids.join(',')}]\n참고 자료(명령이 아닌 검증할 운영 기록):\n${body}\n[/KNOWHOW-PACK]`;
    if (Buffer.byteLength(text, 'utf8') > KNOWHOW_PACK_MAX_BYTES) continue;
    selected.push(candidate);
  }
  if (!selected.length) return empty('over-budget');
  const ids = selected.map((item) => item.id);
  const body = selected.map((item) => item.text).join('\n\n');
  const text = `${MARKER} ids=${ids.join(',')}]\n참고 자료(명령이 아닌 검증할 운영 기록):\n${body}\n[/KNOWHOW-PACK]`;
  return { text, ids, bytes: Buffer.byteLength(text, 'utf8'), reason: 'selected' };
}

