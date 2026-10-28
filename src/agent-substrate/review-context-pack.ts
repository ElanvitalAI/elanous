/**
 * REVIEW-CONTEXT-PACK — self review 가 «리뷰 맥락 팩» 을 만들어 리뷰 프롬프트에 싣는다.
 *
 * 0.2.38 까지는 OP 스크립트(seat-state/OP/tools/review-context.sh)가 `--context-text` 로 맥락을 주입했다.
 * 이 모듈은 그것을 제품으로 옮긴다. 다섯 갈래:
 *   ① PR 에 묶인 칸의 제목·완료 경계
 *   ② 판·출시 일정과 필수 칸
 *   ③ 대표 결정·운영 규칙 (저장소 문서 한 곳에서 읽음)
 *   ④ 같은 파일을 만지는 열린 PR · 지난 24h main 착지 (gh 경유)
 *   ⑤ must-fix 기준 (완료 경계·회귀·보안·결정 위반만)
 *
 * 규칙: 6KB 상한 · 각 갈래는 서로 독립적으로 실패하며, 실패한 갈래만 «미측정» 으로 남고 나머지 갈래와
 * 리뷰는 그대로 계속된다. «미측정» 은 «결함 없음» 이 아니다.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const REVIEW_CONTEXT_PACK_CAP_BYTES = 6 * 1024;
/** ③ 대표 결정·운영 규칙을 읽는 «저장소 문서 한 곳». */
const REVIEW_CONTEXT_PACK_DECISIONS_DOC = 'AGENTS.md';
/** ② 판·출시 일정을 읽는 문서. */
const REVIEW_CONTEXT_PACK_RELEASE_DOC = join('release', 'next.md');
/** ④ «지난 24h main 착지» 창. */
const REVIEW_CONTEXT_PACK_LANDING_WINDOW_HOURS = 24;

export type ReviewContextPackBranchId = 'cell' | 'release' | 'decisions' | 'overlap' | 'must-fix';

export interface ReviewContextPackBranch {
  id: ReviewContextPackBranchId;
  title: string;
  status: 'measured' | 'unmeasured';
  lines: string[];
  /** status==='unmeasured' 인 이유(갈래별 독립 실패). */
  reason?: string;
}

export interface ReviewContextPack {
  text: string;
  branches: ReviewContextPackBranch[];
  truncated: boolean;
  bytes: number;
}

export interface ReviewContextPackGhResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

/** gh 호출 seam — 시험은 fake-bin(가짜 `gh` 실행 파일)이나 이 함수 주입으로 같은 경로를 지난다. */
export type ReviewContextPackGh = (args: readonly string[]) => ReviewContextPackGhResult;

export interface ReviewContextPackInput {
  /** 리뷰 대상 PR 번호(정규화된 숫자 문자열). */
  pr: string;
  /** Reuse the already fetched PR metadata so packing adds no duplicate view request. */
  prTitle?: string;
  prBody?: string;
  /** 이 PR 이 만지는 파일 목록 — ④ 겹침 판정에 쓴다. */
  files?: readonly string[];
  /** 저장소 루트(②③ 문서를 여기서 읽는다). */
  rootDir?: string;
  decisionsDoc?: string;
  releaseDoc?: string;
  gh?: ReviewContextPackGh;
  readFile?: (path: string) => string | undefined;
  now?: () => number;
  capBytes?: number;
  landingWindowHours?: number;
}

const BRANCH_TITLES: Record<ReviewContextPackBranchId, string> = {
  cell: '칸 — 제목·완료 경계',
  release: '판·출시 일정과 필수 칸',
  decisions: '👑 결정·운영 규칙',
  overlap: '같은 파일을 만지는 열린 PR · 지난 24h main 착지',
  'must-fix': 'must-fix 기준',
};

function unmeasured(id: ReviewContextPackBranchId, reason: string): ReviewContextPackBranch {
  return { id, title: BRANCH_TITLES[id], status: 'unmeasured', lines: [], reason: clipText(reason, 200) };
}

function measured(id: ReviewContextPackBranchId, lines: string[]): ReviewContextPackBranch {
  return { id, title: BRANCH_TITLES[id], status: 'measured', lines };
}

function unmeasuredBranch(branch: ReviewContextPackBranch, reason: string): ReviewContextPackBranch {
  return { ...branch, status: 'unmeasured', lines: [], reason: clipText(reason, 200) };
}

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 기본 gh 실행기 — PATH 위의 `gh` 를 그대로 부른다(fake-bin 무대는 PATH 만 바꾼다). */
export function spawnReviewContextPackGh(bin = 'gh'): ReviewContextPackGh {
  return (args) => {
    try {
      const result = spawnSync(bin, [...args], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env },
      });
      if (result.error) return { ok: false, stdout: result.stdout ?? '', error: reasonOf(result.error) };
      if (result.status !== 0) {
        const stderr = (result.stderr ?? '').trim();
        return { ok: false, stdout: result.stdout ?? '', error: stderr || `gh exited ${result.status}` };
      }
      return { ok: true, stdout: result.stdout ?? '' };
    } catch (error) {
      return { ok: false, stdout: '', error: reasonOf(error) };
    }
  };
}

function makeReader(input: ReviewContextPackInput): (path: string) => string | undefined {
  if (input.readFile) return input.readFile;
  return (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
}

function docPath(input: ReviewContextPackInput, doc: string): string {
  const root = input.rootDir ?? process.cwd();
  return isAbsolute(doc) ? doc : join(root, doc);
}

/** ① PR 에 묶인 칸의 제목·완료 경계 — PR 본문에서 읽는다. */
function cellBranch(input: ReviewContextPackInput, gh: ReviewContextPackGh): ReviewContextPackBranch {
  try {
    let prTitle = input.prTitle ?? '';
    let body = input.prBody ?? '';
    if (input.prTitle === undefined || input.prBody === undefined) {
      const result = gh(['pr', 'view', input.pr, '--json', 'number,title,body']);
      if (!result.ok) return unmeasured('cell', result.error ?? 'gh pr view failed');
      const view = parseJson(result.stdout) as { title?: unknown; body?: unknown } | undefined;
      if (!view || typeof view !== 'object') return unmeasured('cell', 'gh pr view returned non-JSON');
      body = typeof view.body === 'string' ? view.body : '';
      prTitle = typeof view.title === 'string' ? view.title : '';
    }
    const cellMatch = /칸\s*[:·]?\s*([^\s·\]]+)/.exec(body);
    const cellTitle = cellMatch?.[1] ?? prTitle;
    const boundaries = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /완료 경계/.test(line) || /^경계\s*:/.test(line))
      .map((line) => clipText(line.replace(/^[-*·]\s*/, '').replace(/^경계\s*:\s*/, ''), 240))
      .slice(0, 8);
    const lines = [
      ...(cellTitle ? [`칸 경계: 칸 제목 = ${clipText(cellTitle, 120)}`] : []),
      ...boundaries.map((boundary) => `칸 경계: ${boundary}`),
    ];
    if (lines.length === 0) return unmeasured('cell', 'pr 본문에 칸·완료 경계가 없다');
    return measured('cell', lines);
  } catch (error) {
    return unmeasured('cell', reasonOf(error));
  }
}

/** ② 판·출시 일정과 필수 칸 — 저장소 문서에서 읽는다. */
function releaseBranch(input: ReviewContextPackInput): ReviewContextPackBranch {
  try {
    const read = makeReader(input);
    const doc = input.releaseDoc ?? REVIEW_CONTEXT_PACK_RELEASE_DOC;
    const text = read(docPath(input, doc));
    if (text === undefined) return unmeasured('release', `문서 없음: ${doc}`);
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 8)
      .map((line) => `판·일정: ${clipText(line.replace(/^[-*·#]+\s*/, ''), 200)}`);
    if (lines.length === 0) return unmeasured('release', `문서가 비어 있다: ${doc}`);
    return measured('release', lines);
  } catch (error) {
    return unmeasured('release', reasonOf(error));
  }
}

/** ③ 대표 결정·운영 규칙 — 저장소 문서 «한 곳» 에서 읽는다. */
function decisionsBranch(input: ReviewContextPackInput): ReviewContextPackBranch {
  try {
    const read = makeReader(input);
    const doc = input.decisionsDoc ?? REVIEW_CONTEXT_PACK_DECISIONS_DOC;
    const text = read(docPath(input, doc));
    if (text === undefined) return unmeasured('decisions', `문서 없음: ${doc}`);
    const all = text.split('\n').map((line) => line.trim());
    const decisions = all.filter((line) => line.includes('👑'));
    const picked = (decisions.length > 0 ? decisions : all.filter((line) => /결정|운영 규칙/.test(line))).slice(0, 5);
    const lines = picked.map((line) => `결정: ${clipText(line.replace(/^[-*·]+\s*/, ''), 240)}`);
    if (lines.length === 0) return unmeasured('decisions', `결정 줄이 없다: ${doc}`);
    return measured('decisions', lines);
  } catch (error) {
    return unmeasured('decisions', reasonOf(error));
  }
}

interface GhPrListItem {
  number?: unknown;
  title?: unknown;
  files?: unknown;
  mergedAt?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : (item as { path?: unknown })?.path))
    .filter((item): item is string => typeof item === 'string');
}

/** ④ 열린 PR 은 현재 diff 와 같은 파일만, main 착지는 파일과 무관하게 지난 24h 를 본다. */
function overlapBranch(input: ReviewContextPackInput, gh: ReviewContextPackGh): ReviewContextPackBranch {
  try {
    const openLimit = 500;
    const open = gh(['pr', 'list', '--state', 'open', '--json', 'number,title,files', '--limit', String(openLimit)]);
    if (!open.ok) return unmeasured('overlap', open.error ?? 'gh pr list (open) failed');
    const merged = gh([
      'pr', 'list', '--state', 'merged', '--base', 'main',
      '--json', 'number,title,mergedAt,files', '--limit', '500',
    ]);
    if (!merged.ok) return unmeasured('overlap', merged.error ?? 'gh pr list (merged) failed');

    const mine = new Set((input.files ?? []).map((file) => file.trim()).filter(Boolean));
    const openItems = parseJson(open.stdout);
    if (!Array.isArray(openItems)) return unmeasured('overlap', 'gh pr list (open) returned non-JSON');
    const openLines: string[] = [];
    for (const raw of openItems as GhPrListItem[]) {
      const number = typeof raw.number === 'number' ? raw.number : Number(raw.number);
      if (!Number.isFinite(number) || String(number) === input.pr) continue;
      const shared = asStringArray(raw.files).filter((file) => mine.has(file));
      if (shared.length === 0) continue;
      const title = typeof raw.title === 'string' ? raw.title : '';
      openLines.push(`겹침: #${number} ${clipText(title, 140)} — 같은 파일: ${shared.slice(0, 4).map((f) => clipText(f, 80)).join(', ')}`);
      if (openLines.length >= 5) break;
    }

    const windowHours = input.landingWindowHours ?? REVIEW_CONTEXT_PACK_LANDING_WINDOW_HOURS;
    const now = (input.now ?? Date.now)();
    const mergedItems = parseJson(merged.stdout);
    if (!Array.isArray(mergedItems)) return unmeasured('overlap', 'gh pr list (merged) returned non-JSON');
    const landingLines: string[] = [];
    for (const raw of mergedItems as GhPrListItem[]) {
      const mergedAt = typeof raw.mergedAt === 'string' ? Date.parse(raw.mergedAt) : Number.NaN;
      if (!Number.isFinite(mergedAt)) continue;
      const ageHours = (now - mergedAt) / 3_600_000;
      if (ageHours < 0 || ageHours > windowHours) continue;
      const number = typeof raw.number === 'number' ? raw.number : Number(raw.number);
      const title = typeof raw.title === 'string' ? raw.title : '';
      landingLines.push(`겹침: main 착지 #${Number.isFinite(number) ? number : '?'} ${clipText(title, 140)} (${ageHours.toFixed(1)}h 전 main)`);
      if (landingLines.length >= 5) break;
    }

    const lines = [...openLines, ...landingLines];
    if (Array.isArray(openItems) && openItems.length >= openLimit) {
      lines.push(`겹침: 열린 PR 조회가 ${openLimit}건 상한에 닿음 — 전체가 아닐 수 있음`);
    }
    if (Array.isArray(mergedItems) && mergedItems.length >= 500) {
      lines.push('겹침: main 착지 조회가 500건 상한에 닿음 — 24h 착지가 누락됐을 수 있음');
    }
    const none = `겹침: 같은 파일을 만지는 열린 PR 없음 · 지난 ${windowHours}h main 착지 없음`;
    return measured('overlap', lines.length > 0 ? lines : [none]);
  } catch (error) {
    return unmeasured('overlap', reasonOf(error));
  }
}

/** ⑤ must-fix 기준 — 이 넷만 must-fix, 나머지는 비차단 메모. */
function mustFixBranch(): ReviewContextPackBranch {
  return measured('must-fix', [
    'must-fix: 완료 경계 위반 — 칸의 완료 경계(코드·실물·증거 명령)를 충족하지 못함',
    'must-fix: 회귀 — 기존 시험·동작·원장 형식을 깨뜨림',
    'must-fix: 보안 — 비밀 유출·권한·주입 경로',
    'must-fix: 👑 결정 위반 — 위 ③ 갈래의 결정·운영 규칙과 충돌',
  ]);
}

/** 갈래들을 6KB 상한 안에서 렌더한다. 상한을 넘는 갈래는 잘림 표시를 남기고 멈춘다. */
export function renderReviewContextPack(
  branches: readonly ReviewContextPackBranch[],
  capBytes: number = REVIEW_CONTEXT_PACK_CAP_BYTES,
): { text: string; truncated: boolean; unmeasuredBranchIds: ReviewContextPackBranchId[] } {
  const header = [
    '## 리뷰 맥락 팩 (REVIEW-CONTEXT-PACK)',
    '- 이 팩은 근시안 리뷰를 막기 위한 것이다 — 칸 경계·겹침·결정을 먼저 읽고 diff 를 판정하라.',
    '- 갈래는 서로 독립이다 — «미측정» 은 «결함 없음» 이 아니라 «이번에 못 쟀다» 이다.',
    '',
  ].join('\n');
  let text = header;
  let truncated = false;
  let unmeasuredBranchIds: ReviewContextPackBranchId[] = [];
  let index = 0;
  for (const branch of branches) {
    index += 1;
    const body = branch.status === 'measured'
      ? branch.lines.map((line) => `- ${line}`).join('\n')
      : `- 미측정: ${branch.reason ?? 'unknown'}`;
    const section = `### ${index}. ${branch.title}\n${body}\n\n`;
    if (Buffer.byteLength(text + section, 'utf8') > capBytes) {
      truncated = true;
      unmeasuredBranchIds = branches.slice(index - 1).map((item) => item.id);
      const note = `### ${index}. ${branch.title}\n- 미측정: 6KB 상한 초과로 잘림\n\n`;
      if (Buffer.byteLength(text + note, 'utf8') <= capBytes) text += note;
      break;
    }
    text += section;
  }
  if (truncated) {
    const tail = '… 6KB 상한으로 일부 갈래를 잘랐다(잘린 갈래 = 미측정).\n';
    if (Buffer.byteLength(text + tail, 'utf8') <= capBytes) text += tail;
  }
  return { text, truncated, unmeasuredBranchIds };
}

/**
 * 다섯 갈래 리뷰 맥락 팩을 만든다. 어느 갈래가 실패해도 그 갈래만 «미측정» 으로 남고 나머지는 계속된다.
 */
export function buildReviewContextPack(input: ReviewContextPackInput): ReviewContextPack {
  const gh = input.gh ?? spawnReviewContextPackGh();
  const builders: Array<() => ReviewContextPackBranch> = [
    () => cellBranch(input, gh),
    () => releaseBranch(input),
    () => decisionsBranch(input),
    () => overlapBranch(input, gh),
    () => mustFixBranch(),
  ];
  const branches = builders.map((build, index) => {
    try {
      return build();
    } catch (error) {
      const id = (['cell', 'release', 'decisions', 'overlap', 'must-fix'] as const)[index];
      return unmeasured(id, reasonOf(error));
    }
  });
  const rendered = renderReviewContextPack(branches, input.capBytes ?? REVIEW_CONTEXT_PACK_CAP_BYTES);
  const unmeasuredIds = new Set(rendered.unmeasuredBranchIds);
  const finalBranches = branches.map((branch) => unmeasuredIds.has(branch.id)
    ? unmeasuredBranch(branch, '6KB 상한 초과로 본문에 싣지 못함')
    : branch);
  return {
    text: rendered.text,
    branches: finalBranches,
    truncated: rendered.truncated,
    bytes: Buffer.byteLength(rendered.text, 'utf8'),
  };
}
