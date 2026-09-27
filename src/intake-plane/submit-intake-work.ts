/**
 * X6 앞문 — `submitIntakeWork`: 앞문 판정의 갈래를 «이미 있는 문»으로 실행하고 추적 id 를 돌려준다.
 * RFC `내부 문서 `RFC-external-tasks-plugins-and-the-task-loop-2026-09-27`` A6 · `내부 문서 `RFC-pwa-intake-front-door-2026-09-26``.
 *
 * - absorb → 흡수 원장(`ingestIntakeItems`) — URL 이 있으면 URL 마다, 없으면 글 한 덩이(PWA `absorbItemsFromText` 와 같은 규칙).
 * - tasks  → TOX(`dispatchTaskCreate`) — 외부 출처(텔레그램 등)는 `external` 로 실어 M1(backlog ⊕ 승인 대기)을 탄다.
 * - graph  → 하니스 ask(`handleHarnessAskPost` 를 요청 하나로 부른다 — 흐름을 복제하지 않는다).
 * - ask-human → 실행하지 않는다. 고를 갈래를 돌려준다.
 *
 * 로그엔 원문이 아니라 길이만 남긴다(앞문 RFC · `user-private`).
 */
import { debug } from '../debug/log.js';
import type { MissionOrigin } from '../autopilot/mission-origin.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { ExternalTaskSource } from '../task-orchestrator/types.js';
import { TASK_DEFAULTS } from '../task-orchestrator/types.js';
import { decideIntakeFrontRoute, type IntakeFrontRouteDecision } from './front-route-rules.js';
import { ingestIntakeItems, intakeItemId, type IntakeSource, type RawIntakeItem } from './items.js';

export type IntakeWorkTrack = 'absorb' | 'tasks' | 'graph';

/** 누가 보냈나. `owner` = PWA 칸(사람 본인) · `external` = 텔레그램·공급자 등(승인 대기로 들어간다). */
export type IntakeWorkOrigin =
  | { kind: 'owner'; ledgerSource: IntakeSource }
  | { kind: 'external'; ledgerSource: IntakeSource; provider: ExternalTaskSource['provider']; ref: string; url?: string; reportTo?: MissionOrigin };

export type SubmitIntakeWorkResult =
  | { ok: true; track: 'absorb'; ids: string[]; added: number; merged: number }
  | { ok: true; track: 'tasks'; taskId: string; deduplicated: boolean }
  | { ok: true; track: 'graph'; acceptanceId: string }
  | { ok: false; track: IntakeWorkTrack; reason: string };

export type RouteAndSubmitResult =
  | { decision: IntakeFrontRouteDecision; submitted: SubmitIntakeWorkResult }
  | { decision: IntakeFrontRouteDecision; askHuman: readonly IntakeWorkTrack[] };

export interface SubmitIntakeWorkDeps {
  root?: () => string;
  now?: () => string;
  ingest?: typeof ingestIntakeItems;
  createTask?: (input: CreateTaskInput) => Promise<{ taskId?: string; deduplicated?: boolean; output: string }>;
  askHarness?: (text: string, origin?: MissionOrigin) => Promise<{ acceptanceId?: string; error?: string }>;
  handleHarnessAskPost?: typeof import('../nexus/api/harness-api.js').handleHarnessAskPost;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  surface: { kind: 'llm-direct'; prompt: string };
  external?: { provider: ExternalTaskSource['provider']; ref: string; url?: string };
  externalSurfaceDefaulted?: boolean;
}

const URL_RE = /https?:\/\/\S+/gi;
export const INTAKE_WORK_TRACKS: readonly IntakeWorkTrack[] = ['absorb', 'tasks', 'graph'];

/** PWA `absorbItemsFromText` 와 같은 규칙 — URL 마다 한 항목, 없으면 글 한 덩이. */
export function absorbItemsFromText(text: string): RawIntakeItem[] {
  const urls = text.match(URL_RE) ?? [];
  return urls.length === 0 ? [{ text }] : urls.map((url) => ({ url }));
}

/** 첫 줄 = 제목(80자 안) · 나머지 = 설명(4000자 안). 제목이 비면 글 앞부분. */
export function taskFieldsFromText(text: string): { title: string; description?: string } {
  const trimmed = text.trim();
  const [first = '', ...rest] = trimmed.split(/\r?\n/);
  const title = (first.trim() || trimmed).slice(0, TASK_DEFAULTS.titleMaxLen);
  const description = rest.join('\n').trim().slice(0, TASK_DEFAULTS.descriptionMaxLen);
  return description ? { title, description } : { title };
}

async function defaultCreateTask(input: CreateTaskInput) {
  const { dispatchTaskCreate } = await import('../task-orchestrator/runtimes/create.js');
  return dispatchTaskCreate(input as Parameters<typeof dispatchTaskCreate>[0]);
}

async function defaultAskHarness(text: string, origin?: MissionOrigin, handler?: NonNullable<SubmitIntakeWorkDeps['handleHarnessAskPost']>): Promise<{ acceptanceId?: string; error?: string }> {
  const handleHarnessAskPost = handler ?? (await import('../nexus/api/harness-api.js')).handleHarnessAskPost;
  const res = await handleHarnessAskPost(
    new Request('http://intake.local/v1/harness/ask', { method: 'POST', body: JSON.stringify({ text, ...(origin ? { origin } : {}) }) }),
    {} as Parameters<typeof handleHarnessAskPost>[1],
  );
  const body = await res.json().catch(() => ({})) as { acceptanceId?: unknown; error?: unknown };
  if (res.ok && typeof body.acceptanceId === 'string') return { acceptanceId: body.acceptanceId };
  return { error: typeof body.error === 'string' ? body.error : `harness ask HTTP ${res.status}` };
}

/** 갈래 하나를 실행한다. 판정은 하지 않는다(호출자가 이미 골랐다). */
export async function submitIntakeWork(
  input: { text: string; track: IntakeWorkTrack; origin: IntakeWorkOrigin },
  deps: SubmitIntakeWorkDeps = {},
): Promise<SubmitIntakeWorkResult> {
  const log = deps.log ?? ((event, data) => debug.log('intake.submit', event, data));
  const text = input.text.trim();
  const base = { track: input.track, origin: input.origin.kind, textLength: text.length };
  if (!text) {
    log('rejected', { ...base, reason: 'empty-text' });
    return { ok: false, track: input.track, reason: 'empty-text' };
  }
  try {
    if (input.track === 'absorb') {
      const raws = absorbItemsFromText(text);
      const res = (deps.ingest ?? ingestIntakeItems)(
        (deps.root ?? effectiveInstanceRoot)(),
        input.origin.ledgerSource,
        raws,
        deps.now?.() ?? new Date().toISOString(),
      );
      // HTTP 입구(`intake-ledger-api.ts`)와 같은 id 규칙 — 추적은 이 id 로 `GET /v1/intake-ledger/items/:id`.
      const ids = raws.map((raw) => intakeItemId(input.origin.ledgerSource, raw));
      log('submitted', { ...base, ids: ids.length, added: res.added, merged: res.merged });
      return { ok: true, track: 'absorb', ids, added: res.added, merged: res.merged };
    }
    if (input.track === 'tasks') {
      const fields = taskFieldsFromText(text);
      const external = input.origin.kind === 'external'
        ? { provider: input.origin.provider, ref: input.origin.ref, ...(input.origin.url ? { url: input.origin.url } : {}) }
        : undefined;
      const res = await (deps.createTask ?? defaultCreateTask)({
        ...fields,
        surface: { kind: 'llm-direct', prompt: fields.description ? `${fields.title}\n${fields.description}` : fields.title },
        ...(external ? { external, externalSurfaceDefaulted: true } : {}),
      });
      if (!res.taskId) {
        log('failed', { ...base, reason: res.output.slice(0, 200) });
        return { ok: false, track: 'tasks', reason: res.output };
      }
      log('submitted', { ...base, taskId: res.taskId, deduplicated: res.deduplicated ?? false });
      return { ok: true, track: 'tasks', taskId: res.taskId, deduplicated: res.deduplicated ?? false };
    }
    const reportTo = input.origin.kind === 'external' ? input.origin.reportTo : undefined;
    const res = await (deps.askHarness ? deps.askHarness(text, reportTo) : defaultAskHarness(text, reportTo, deps.handleHarnessAskPost));
    if (!res.acceptanceId) {
      log('failed', { ...base, reason: res.error ?? 'no-acceptance-id' });
      return { ok: false, track: 'graph', reason: res.error ?? 'no-acceptance-id' };
    }
    log('submitted', { ...base, acceptanceId: res.acceptanceId });
    return { ok: true, track: 'graph', acceptanceId: res.acceptanceId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('failed', { ...base, reason: reason.slice(0, 200) });
    return { ok: false, track: input.track, reason };
  }
}

/** 판정 ⊕ 실행 한 번 — 텔레그램 입구가 부른다. 규칙이 갈래를 못 고르면 실행하지 않고 고를 갈래를 돌려준다.
 *  (분류기는 여기서 부르지 않는다 — 앞문 RFC: 사용자가 누를 때만.) */
export async function routeAndSubmitIntakeWork(
  input: { text: string; origin: IntakeWorkOrigin; hint?: string },
  deps: SubmitIntakeWorkDeps = {},
): Promise<RouteAndSubmitResult> {
  const decision = decideIntakeFrontRoute({
    text: input.text,
    consent: 'route',
    ...(input.hint ? { hint: input.hint } : {}),
  });
  if (decision.track === 'ask-human') return { decision, askHuman: INTAKE_WORK_TRACKS };
  return { decision, submitted: await submitIntakeWork({ text: input.text, track: decision.track, origin: input.origin }, deps) };
}
