// EV12d — 계획기가 맞는 그래프를 못 고르면(«요청에 맞는 설치된 실행 그래프가 없습니다») «문서 요청 실패» 대신
// 그 자리가 직접 답한다: 역할 파일(내부 문서 `<id>`) ⊕ 그 자리가 owner 인 체크리스트 칸 ⊕ 최근 요청 몇 줄을
// 맥락으로 LLM 한 번 → 같은 채널 회신(본문). 맥락에 없는 것은 «모른다»고 답하게 한다(지어내지 않는다).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { debug } from '../debug/log.js';
import { ExecRequestStore, type ExecRequest } from '../exec-requests/store.js';
import { devVersion, listChecklist, type ChecklistItem } from '../release-loop/checklist.js';
import { resolveSeat } from '../seat-address/seat-address.js';

const ROLE_CHARS = 6_000;

/** Cut by code points, never inside a surrogate pair. A `.slice` through an emoji (🎉 · 🟢) leaves a lone surrogate and
 *  the model API rejects the whole request («Codex API 400: Bad Request» · 10-02 07:4x — every «@CMO …» question failed). */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}
const ITEM_LIMIT = 25;
const RECENT_LIMIT = 5;

export interface SeatAnswerDeps {
  readRole?: (seatId: string) => string | null;
  ownedItems?: (seatId: string) => ChecklistItem[];
  recentRequests?: () => ExecRequest[];
  complete?: (prompt: string) => Promise<string>;
}

function defaultReadRole(seatId: string): string | null {
  const path = fileURLToPath(new URL(`../../docs/roles/${seatId}.md`, import.meta.url));
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function nextPatch(version: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : null;
}

/** Items this seat owns in the dev version's checklist and the next one (where 10-28 work lives). */
function defaultOwnedItems(seatId: string): ChecklistItem[] {
  const versions = [devVersion().replace(/-.*$/, '')];
  const next = nextPatch(versions[0]!);
  if (next) versions.push(next);
  const items: ChecklistItem[] = [];
  for (const version of versions) {
    try { items.push(...listChecklist(version).items.filter((item) => item.owner === seatId)); }
    catch { /* a version without a checklist contributes nothing */ }
  }
  return items;
}

async function defaultComplete(prompt: string): Promise<string> {
  const { streamLLM } = await import('../llm.js');
  const { tierModel } = await import('../llm/model-defaults.js');
  return streamLLM([{ role: 'user', content: prompt }], () => {}, { model: tierModel('better') });
}

const STATUS_MARK: Record<string, string> = { green: '🟢', yellow: '🟡', red: '🔴', done: '✅' };

export function seatAnswerPrompt(input: { title: string; seatId: string; question: string; role: string | null; items: ChecklistItem[]; recent: ExecRequest[] }): string {
  const items = input.items.slice(0, ITEM_LIMIT)
    .map((item) => `${STATUS_MARK[item.status] ?? item.status} ${item.id} ${cut(item.title, 140)}${item.evidence ? ` — 근거: ${cut(item.evidence, 160)}` : ''}`)
    .join('\n') || '(담당 칸 없음)';
  const recent = input.recent.slice(0, RECENT_LIMIT)
    .map((request) => `${request.createdAt.slice(0, 16)} ${request.status} · ${cut(request.text.replace(/\s+/g, ' '), 120)}`)
    .join('\n') || '(최근 요청 없음)';
  return [
    `너는 엘라누스 팀의 ${input.title}(${input.seatId}) 자리다. 아래 «역할 문서 · 담당 칸 · 최근 요청»만 근거로 질문에 답한다.`,
    '규칙: 한국어 존댓말 · 12줄 이내 · 맥락에 없는 사실·수치·일정은 지어내지 말고 «모른다/확인 필요»라고 쓴다 · 담당 칸을 인용할 땐 칸 ID 를 붙인다 · 내부 파일 경로·토큰·계정은 쓰지 않는다.',
    `\n## 역할 문서\n${cut(input.role ?? '(역할 문서 없음)', ROLE_CHARS)}`,
    `\n## 담당 칸(체크리스트 owner=${input.seatId})\n${items}`,
    `\n## 최근 자리 요청\n${recent}`,
    `\n## 질문\n${input.question}`,
  ].join('\n');
}

/** The seat's own answer, or null when the seat is unknown or the model gave nothing usable. */
export async function answerAsSeat(seatAddress: string, question: string, deps: SeatAnswerDeps = {}): Promise<{ title: string; text: string } | null> {
  const seat = resolveSeat(seatAddress);
  if (!seat?.title) return null;
  const role = (deps.readRole ?? defaultReadRole)(seat.id);
  const items = (deps.ownedItems ?? defaultOwnedItems)(seat.id);
  const recent = (deps.recentRequests ?? (() => new ExecRequestStore().list()))();
  const raw = await (deps.complete ?? defaultComplete)(seatAnswerPrompt({ title: seat.title, seatId: seat.id, question, role, items, recent }));
  const text = raw.trim();
  debug.log('intake.seat-doc', 'seat-answer', { seat: seat.id, roleFile: role !== null, items: items.length, recent: Math.min(recent.length, RECENT_LIMIT), chars: text.length });
  return text ? { title: seat.title, text: cut(text, 3_500) } : null;
}

/** «No installed graph fits» — the planner's own failure wording, so the seat should answer instead. */
export function isNoGraphFailure(result: { status: string; summary?: string; seats?: Array<{ graphId: string; reason?: string }> } | null): boolean {
  if (!result || result.status !== 'failed' || !result.seats?.length) return false;
  if (!result.seats.every((seat) => !seat.graphId)) return false;
  const NO_GRAPH = /설치된 실행 그래프가 없습니다/;
  return NO_GRAPH.test(result.summary ?? '') || result.seats.some((seat) => NO_GRAPH.test(seat.reason ?? ''));
}
