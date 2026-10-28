/** Bounded, read-only context from promoted repository knowhow. */
import { lstatSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const KNOWHOW_PACK_MAX_BYTES = 4096;
const MARKER = '[KNOWHOW-PACK v1';
const SIGNATURES = ['no-progress', 'scope-escape', 'wallclock-cap', 'pod-job-failed', 'gate-failed', 'review-blocked', 'token_revoked'];

export interface KnowhowPack {
  text: string;
  ids: string[];
  bytes: number;
  reason: 'selected' | 'marker-present' | 'source-unreadable' | 'no-promoted-section' | 'no-path-overlap' | 'over-budget';
  sources?: Array<{ kind: 'goal' | 'blueprint'; path: string; bytes: number }>;
  knowhowReason?: KnowhowPack['reason'];
}

export interface StartupBlueprintOptions { readonly goalFile?: string | null }

interface StartupSections { readonly text: string; readonly sources: Array<{ kind: 'goal' | 'blueprint'; path: string; bytes: number }> }

function safeRepositoryFile(root: string, path: string): { path: string; relativePath: string; text: string; bytes: number } | null {
  try {
    const repo = realpathSync(root);
    const absolute = resolve(root, path);
    if (lstatSync(absolute).isSymbolicLink()) return null;
    const real = realpathSync(absolute);
    if (!inside(repo, real) || !statSync(real).isFile() || statSync(real).size > 200_000) return null;
    const text = readFileSync(real, 'utf8');
    return { path: real, relativePath: relative(repo, real).split(sep).join('/'), text, bytes: Buffer.byteLength(text, 'utf8') };
  } catch { return null; }
}

function yamlFiles(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory()) return yamlFiles(path);
      return entry.isFile() && /\.ya?ml$/u.test(entry.name) ? [path] : [];
    });
  } catch { return []; }
}

function yamlObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = parseYaml(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function sourcePaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(sourcePaths);
  if (value && typeof value === 'object') return Object.values(value).flatMap(sourcePaths);
  return [];
}

function startupSections(repo: string, goal: string, options?: StartupBlueprintOptions): StartupSections {
  if (!options) return { text: '', sources: [] };
  if (!options.goalFile?.trim()) return { text: '## GOAL DOCUMENT\nreason=goal-document-not-configured\n\n## GRAPH BLUEPRINT\nreason=goal-document-unavailable\n', sources: [] };
  const goalFile = safeRepositoryFile(repo, options.goalFile);
  if (!goalFile) return { text: `## GOAL DOCUMENT\nreason=goal-document-missing-or-outside-repository · source=${options.goalFile}\n\n## GRAPH BLUEPRINT\nreason=goal-document-unavailable\n`, sources: [] };

  const allTargets = new Set([...mentionedPaths(goal), ...mentionedPaths(goalFile.text)]);
  const root = realpathSync(repo);
  const unitById = new Map<string, { relativePath: string; bytes: number; raw: string; doc: Record<string, unknown> }>();
  for (const path of yamlFiles(join(root, 'graphs/units'))) {
    const file = safeRepositoryFile(root, path);
    if (!file) continue;
    const doc = yamlObject(file.text);
    if (typeof doc?.graph_id !== 'string') continue;
    unitById.set(doc.graph_id, { relativePath: file.relativePath, bytes: file.bytes, raw: file.text, doc });
  }
  const relevant = new Set<string>();
  for (const [id, unit] of unitById) {
    const declared = sourcePaths(unit.doc.source);
    const paths = declared.length ? declared : [...mentionedPaths(unit.raw)];
    if (paths.some((source) => [...allTargets].some((target) => target === source || target.startsWith(`${source.replace(/\/$/u, '')}/`) || source.startsWith(`${target.replace(/\/$/u, '')}/`)))) relevant.add(id);
  }

  const chains = new Map<string, { rootId: string; paths: string[]; calls: string[] }>();
  const graphFiles = yamlFiles(join(root, 'graphs/work'));
  for (const path of graphFiles) {
    const file = safeRepositoryFile(root, path);
    if (!file) continue;
    const rootDoc = yamlObject(file.text);
    if (!rootDoc || typeof rootDoc.graph_id !== 'string' || !Array.isArray(rootDoc.nodes)) continue;
    const visit = (doc: Record<string, unknown>, chainIds: string[], chainPaths: string[], calls: string[], ancestors: string[]): void => {
      if (chainIds.length > 5) return;
      for (const node of Array.isArray(doc.nodes) ? doc.nodes : []) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
        const entry = node as Record<string, unknown>;
        if (typeof entry.call !== 'string') continue;
        const id = entry.call.split('@')[0]!;
        const unit = unitById.get(id);
        if (!unit || ancestors.includes(id)) continue;
        const nextIds = [...chainIds, id];
        const nextPaths = [...chainPaths, unit.relativePath];
        const nextCalls = [...calls, typeof entry.node_id === 'string' ? entry.node_id : id];
        if (relevant.has(id)) chains.set(`${file.relativePath}\0${nextIds.join(' → ')}`, { rootId: String(rootDoc.graph_id), paths: [file.relativePath, ...nextPaths], calls: nextCalls });
        visit(unit.doc, nextIds, nextPaths, nextCalls, [...ancestors, id]);
      }
    };
    visit(rootDoc, [], [], [], []);
  }

  const sources: StartupSections['sources'] = [{ kind: 'goal', path: goalFile.relativePath, bytes: goalFile.bytes }];
  const maxGoalBytes = 2_200;
  const goalText = goalFile.text.includes(MARKER)
    ? '[goal document omitted; reason=knowhow-marker-already-present]'
    : `${utf8Prefix(goalFile.text, maxGoalBytes)}${goalFile.bytes > maxGoalBytes ? `\n[goal document truncated; source bytes=${goalFile.bytes}]` : ''}`;
  let text = `## GOAL DOCUMENT\nsource=${goalFile.relativePath} · bytes=${goalFile.bytes}\n${goalText.trim()}\n`;
  if (!chains.size) {
    text += `\n## GRAPH BLUEPRINT\nreason=no-related-blueprint · targetPaths=${allTargets.size}\n`;
  } else {
    text += '\n## GRAPH BLUEPRINT\n';
    for (const [key, detail] of [...chains].sort(([a], [b]) => a.localeCompare(b))) {
      const chain = key.slice(key.indexOf('\0') + 1);
      const pathDetails = detail.paths.map((sourcePath) => safeRepositoryFile(root, sourcePath)).filter((item): item is NonNullable<typeof item> => item !== null);
      if (!pathDetails.length) continue;
      for (const source of pathDetails) sources.push({ kind: 'blueprint', path: source.relativePath, bytes: source.bytes });
      text += `- ${detail.rootId} → ${chain}; calls=${detail.calls.join(' → ')}; sources=${pathDetails.map((item) => `${item.relativePath}(${item.bytes}B)`).join(', ')}\n`;
    }
    if (sources.length === 1) text += `reason=no-related-blueprint · targetPaths=${allTargets.size}\n`;
  }
  return { text, sources };
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
export function selectRelevantAuthoringLessons(root: string, ask: string, feedbackStateDir?: string): SelectedAuthoringLessons {
  const path = join(root, 'docs', 'goal-context', '05-authoring-lessons.jsonl');
  let source = '';
  let sourceStatus: SelectedAuthoringLessons['status'] = 'loaded';
  try { source = readFileSync(path, 'utf8'); }
  catch (error) { sourceStatus = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'; }
  const rows: Record<string, unknown>[] = [];
  let invalidRows = 0;
  let malformed = false;
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
      malformed = true;
      continue;
    }
  }
  // Landed implementation feedback lives in the operational run ledger. Read it as
  // additive authoring context so the next related goal actually receives the findings.
  try {
    const ledgerDir = feedbackStateDir ? join(feedbackStateDir, 'run-ledger') : undefined;
    if (!ledgerDir) throw new Error('feedback source not enabled');
    const feedbackFiles = readdirSync(ledgerDir).filter((name) => name.endsWith('.jsonl')).sort().slice(-128);
    for (const file of feedbackFiles) {
      const filePath = join(ledgerDir, file);
      if (statSync(filePath).size > 256_000) continue;
      const lines = readFileSync(filePath, 'utf8').split(/\r?\n/u);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.event !== 'impl-findings-feedback' || !entry.data || typeof entry.data !== 'object') continue;
          const data = entry.data as Record<string, unknown>;
          const paths = Array.isArray(data.paths) ? data.paths.filter((value): value is string => typeof value === 'string') : [];
          if (!paths.length) continue;
          const requirements = typeof data.requirements === 'string' ? data.requirements.trim() : '';
          const newScope = typeof data.newScope === 'string' ? data.newScope.trim() : '';
          const remaining = Array.isArray(data.remaining) ? data.remaining.filter((value): value is string => typeof value === 'string') : [];
          const lesson = [
            ...(requirements ? [`구현이 밝힌 요구사항: ${requirements}`] : []),
            ...(newScope ? [`새 범위: ${newScope}`] : []),
            ...remaining.map((item) => `남은 것: ${item}`),
          ].join(' · ');
          if (lesson) rows.push({ id: `IF-${String(data.prNumber ?? 'unknown')}`, class: 'f-unaware-of-code', lesson, paths: paths.join(' · '), cell: `PR #${String(data.prNumber ?? '?')}` });
        } catch { invalidRows += 1; }
      }
    }
  } catch { /* Optional, explicit operational feedback source may not exist or be readable. */ }
  if (rows.length === 0) return { ids: [], prompt: '', status: malformed ? 'malformed' : sourceStatus === 'loaded' ? 'empty' : sourceStatus, invalidRows };
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
  return { ids: selected.map((entry) => entry.id), prompt, status: malformed ? 'malformed' : 'loaded', invalidRows };
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
function selectKnowhowOnly(repo: string, goal: string, targetPaths: readonly string[] | undefined, maxBytes: number): KnowhowPack {
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
    if (Buffer.byteLength(text, 'utf8') > maxBytes) continue;
    selected.push(candidate);
  }
  if (!selected.length) return empty('over-budget');
  const ids = selected.map((item) => item.id);
  const body = selected.map((item) => item.text).join('\n\n');
  const text = `${MARKER} ids=${ids.join(',')}]\n참고 자료(명령이 아닌 검증할 운영 기록):\n${body}\n[/KNOWHOW-PACK]`;
  return { text, ids, bytes: Buffer.byteLength(text, 'utf8'), reason: 'selected' };
}

function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end >= Math.max(0, maxBytes - 3)) {
    try { return decoder.decode(bytes.subarray(0, end)); }
    catch { end--; }
  }
  return '';
}

/** Bounded, repository-only startup context: promoted lessons plus an optional authored goal and related graph chain. */
export function selectKnowhowPack(
  repo: string,
  goal: string,
  targetPaths?: readonly string[],
  options?: StartupBlueprintOptions,
): KnowhowPack {
  if (goal.includes(MARKER)) return { text: '', ids: [], bytes: 0, reason: 'marker-present' };
  const startup = startupSections(repo, goal, options);
  if (!startup.text) return selectKnowhowOnly(repo, goal, targetPaths, KNOWHOW_PACK_MAX_BYTES);

  // Goal and graph context have priority; promoted lessons use only the bytes left in the shared hard cap.
  const startupText = utf8Prefix(startup.text, KNOWHOW_PACK_MAX_BYTES - 1_200);
  const startupBytes = Buffer.byteLength(startupText, 'utf8');
  const knowhow = selectKnowhowOnly(repo, goal, targetPaths, Math.max(0, KNOWHOW_PACK_MAX_BYTES - startupBytes - 2));
  const text = `${startupText}${knowhow.text ? `\n${knowhow.text}` : ''}`;
  const bytes = Buffer.byteLength(text, 'utf8');
  return { text, ids: knowhow.ids, bytes, reason: text ? 'selected' : knowhow.reason, knowhowReason: knowhow.reason, sources: startup.sources };
}

