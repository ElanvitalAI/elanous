/**
 * REVIEW-CONVERGE-PRIOR-FIX — TA 가 같은 PR 에 «다시» 거는 리뷰가 직전 라운드를 보게 한다.
 *
 * - 왜: `liveReviewIntent` 의 «직전 반영분» 칸은 늘 «런 X 이 Y 로 멈춤 — 수확 가능» 고정 문면이었다 — 직전 리뷰의 must-fix 도,
 *   그 뒤 바뀐 머리 범위도 없었다. 그래서 리뷰어가 head 마다 PR 전체를 처음부터 다시 보고 «새» must-fix 를 하나씩 냈고
 *   (실측 10-11 PR #26030: ecd32f7c02 → c35d7be0cd 라운드마다 새 지적) REJUDGE 상한 3 에 걸려 TA 경로가 닫혔다.
 * - 무엇을: 같은 PR 의 «두 번째 이후» 리뷰 요청에서만 intent 에 ① 직전 머리 → 지금 머리 diff 요약(파일·줄 수)
 *   ② 직전 리뷰의 must-fix 목록(결과 파일 `review-results/<card>-<pr>-<head12>.json` — 못 읽으면 «직전 결과 미회수»)
 *   ③ 스코프 경계 한 줄(바뀌지 않은 줄의 새 must-fix 는 근거 줄을 대라)을 싣는다. 첫 리뷰는 종전 문면 그대로다.
 * - 하지 않는 것: 판정 로직(must-fix 0 규칙 · #25962 · #26036)은 손대지 않는다. 새 결함을 «금지»하지 않는다 — 근거 줄을 요구할 뿐이다.
 * - 관측: `task-agent` · `review-prior-fix-filled {card, pr, fromHead, toHead, priorMustFix}`(호출부가 남긴다).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { TaskCard } from './task-hand.js';

const SHA40 = /^[0-9a-f]{40}$/i;
const MAX_ITEMS = 10;
const MAX_ITEM_CHARS = 600;
const MAX_FILES = 20;

export const PRIOR_RESULT_NOT_RECOVERED = '직전 결과 미회수';
export const PRIOR_FIX_SCOPE_LINE = '이번 리뷰는 직전 must-fix 가 해결됐는지 ⊕ 그 사이 바뀐 줄에서 새 결함이 생겼는지를 본다 · 직전에 이미 본 바뀌지 않은 줄에서 새 must-fix 를 만들지 말 것(새 결함이 확실하면 근거 줄을 대라)';

type ReviewRequest = NonNullable<TaskCard['reviewRequests']>[number];

export interface PriorDiffFile { path: string; added: number | null; deleted: number | null }
export interface PriorDiff { files: PriorDiffFile[]; added: number; deleted: number }
/** 직전 머리 → 지금 머리 diff — 못 재면 null(«0 줄»이 아니라 «미측정»). */
export type PriorDiffReader = (cwd: string | undefined, fromHead: string, toHead: string) => PriorDiff | null;

export type PriorMustFix =
  | { status: 'recovered'; items: string[] }
  | { status: 'not-recovered'; reason: string };

export interface PriorFixContext {
  fromHead: string;
  toHead: string;
  diff: PriorDiff | null;
  mustFix: PriorMustFix;
}

/** 같은 PR 의 직전 요청 — 지금 머리가 아닌 것 중 마지막(띄우기 오류가 난 요청은 리뷰가 안 돌았으니 건너뛴다). */
export function priorReviewRequest(requests: readonly ReviewRequest[] | undefined, pr: number, head: string): ReviewRequest | undefined {
  return (requests ?? []).filter((entry) => entry.pr === pr && entry.head !== head && !entry.error && SHA40.test(entry.head)).at(-1);
}

/**
 * 결과 파일에서 must-fix «문면»을 읽는다 — `self review --json` 의 결과 줄(뒤에서부터 첫 결과 모양)만.
 * 결과 모양 판정은 `parseReviewResultOutput` 과 같다(PR 번호 ⊕ (verdict ⊕ mustFix 배열 | error 문자열)).
 */
export function readPriorMustFix(path: string | undefined, pr: number, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): PriorMustFix {
  if (!path) return { status: 'not-recovered', reason: 'no result path' };
  let text: string;
  try { text = read(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { status: 'not-recovered', reason: code === 'ENOENT' ? 'result file not created' : `result file unreadable (${code ?? 'error'})` };
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const isResult = v.pr !== undefined && (('verdict' in v && Array.isArray(v.mustFix)) || typeof v.error === 'string');
    if (!isResult) continue;
    const prRaw = typeof v.pr === 'number' ? v.pr : typeof v.pr === 'string' ? Number(String(v.pr).replace(/^#/, '')) : NaN;
    if (prRaw !== pr) return { status: 'not-recovered', reason: `result PR ${Number.isFinite(prRaw) ? prRaw : 'unknown'} does not match #${pr}` };
    if (typeof v.error === 'string') return { status: 'not-recovered', reason: `prior review error: ${v.error.slice(0, 200)}` };
    if (v.reviewed === false) return { status: 'not-recovered', reason: 'prior review did not run (reviewed:false)' };
    if (!Array.isArray(v.mustFix) || !v.mustFix.every((fix) => typeof fix === 'string')) return { status: 'not-recovered', reason: 'must-fix list unreadable' };
    return { status: 'recovered', items: v.mustFix as string[] };
  }
  return { status: 'not-recovered', reason: text.trim() ? 'output has no JSON result line' : 'result file empty' };
}

/** 기본 diff — `git diff --numstat <from> <to>`(그 PR 의 저장소 cwd). 커밋이 없거나 git 이 실패하면 null. */
export const defaultPriorDiff: PriorDiffReader = (cwd, fromHead, toHead) => {
  if (!SHA40.test(fromHead) || !SHA40.test(toHead)) return null;
  const out = spawnSync('git', ['diff', '--numstat', fromHead, toHead], { encoding: 'utf8', timeout: 20_000, ...(cwd ? { cwd } : {}) });
  if (out.error || out.status !== 0 || typeof out.stdout !== 'string') return null;
  return parseNumstat(out.stdout);
};

export function parseNumstat(text: string): PriorDiff {
  const files: PriorDiffFile[] = [];
  let added = 0;
  let deleted = 0;
  for (const line of text.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const a = match[1] === '-' ? null : Number(match[1]);
    const d = match[2] === '-' ? null : Number(match[2]);
    files.push({ path: match[3]!, added: a, deleted: d });
    added += a ?? 0;
    deleted += d ?? 0;
  }
  return { files, added, deleted };
}

/** 두 번째 이후 리뷰의 맥락 — 직전 요청이 없으면 null(첫 리뷰 · 종전 문면). */
export function buildPriorFixContext(
  card: TaskCard, pr: number, head: string,
  opts: { cwd?: string; priorDiff?: PriorDiffReader; readFile?: (path: string) => string } = {},
): PriorFixContext | null {
  const prior = priorReviewRequest(card.reviewRequests, pr, head);
  if (!prior) return null;
  let diff: PriorDiff | null;
  try { diff = (opts.priorDiff ?? defaultPriorDiff)(opts.cwd, prior.head, head); } catch { diff = null; }
  return { fromHead: prior.head, toHead: head, diff, mustFix: readPriorMustFix(prior.resultPath, pr, opts.readFile) };
}

/** «직전 반영분» 블록 — 종전 런 줄 다음에 붙는다. */
export function priorFixBlock(ctx: PriorFixContext): string {
  const lines = [`직전 리뷰 머리 → 지금 머리: ${ctx.fromHead.slice(0, 12)} → ${ctx.toHead.slice(0, 12)}`];
  if (ctx.diff) {
    lines.push(`그 사이 바뀐 것: 파일 ${ctx.diff.files.length}개 · +${ctx.diff.added} −${ctx.diff.deleted}`);
    for (const file of ctx.diff.files.slice(0, MAX_FILES)) lines.push(`  - ${file.path} (+${file.added ?? '?'} −${file.deleted ?? '?'})`);
    if (ctx.diff.files.length > MAX_FILES) lines.push(`  - … 외 ${ctx.diff.files.length - MAX_FILES}개`);
  } else {
    lines.push('그 사이 바뀐 것: diff 미측정(이 저장소에서 두 머리를 비교하지 못했다)');
  }
  if (ctx.mustFix.status === 'recovered') {
    if (ctx.mustFix.items.length === 0) lines.push('직전 리뷰 must-fix: 0건');
    else {
      lines.push(`직전 리뷰 must-fix ${ctx.mustFix.items.length}건:`);
      ctx.mustFix.items.slice(0, MAX_ITEMS).forEach((item, index) => lines.push(`  ${index + 1}. ${item.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS)}`));
      if (ctx.mustFix.items.length > MAX_ITEMS) lines.push(`  … 외 ${ctx.mustFix.items.length - MAX_ITEMS}건`);
    }
  } else {
    lines.push(`직전 리뷰 must-fix: ${PRIOR_RESULT_NOT_RECOVERED} (${ctx.mustFix.reason}) — 목록이 없다고 «0건»으로 읽지 말 것`);
  }
  return lines.join('\n');
}

/** 관측 칸 — must-fix 수(미회수면 null). */
export function priorFixObservation(cardId: string, pr: number, ctx: PriorFixContext): Record<string, unknown> {
  return {
    card: cardId, pr, fromHead: ctx.fromHead, toHead: ctx.toHead,
    priorMustFix: ctx.mustFix.status === 'recovered' ? ctx.mustFix.items.length : null,
    ...(ctx.mustFix.status === 'not-recovered' ? { priorResult: 'not-recovered', priorResultReason: ctx.mustFix.reason } : {}),
    diffFiles: ctx.diff ? ctx.diff.files.length : null,
  };
}
