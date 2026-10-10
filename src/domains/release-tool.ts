import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMToolSpec } from '../llm.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { contextNow, type ContextNowAnswer, type ContextFact } from '../context-bus/context-now.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { debug } from '../debug/log.js';
import { requestConfirmation, type ConfirmOpts, type ConfirmResult } from '../hitl/confirm.js';
import { devVersion, checklistDevVersion, listChecklist, summarizeChecklist, type Checklist, type ChecklistItem } from '../release-loop/checklist.js';
import { add, move, validateVersion } from '../release-loop/feature-store.js';
import { formatKst, formatSchedule, getSchedule, listSchedules, setSchedule, type ReleaseSchedule } from '../release-loop/release-schedule.js';
import { latestGraphRun, type GraphRunState } from '../graph-runner/runner.js';
import { formatElanousCard, type ElanousCard } from './elanous-card.js';

export const RELEASE_STATUS_SPEC: LLMToolSpec = {
  name: 'release_status',
  description: '판 어디까지 · 컷 언제 · 릴리스 상황 · 판올림 · 체크리스트 · 남은 칸을 읽는다. 판 일정, 빨강 칸, 담당별 노랑, 최근 발행 런을 조회하는 읽기 전용 도구. 행정 업무는 coo_admin.\n'
    + 'topic=status(기본): 개발·다음 판 현황과 발행 원장.\n'
    + 'topic=features: 지정 판의 모든 피처·칸(끝난 칸 포함).\n'
    + 'topic=cell: id 칸 하나의 상태·근거와 살핀 판.\n'
    + 'topic=schedule: 발행 이후 판의 컷·착지·발행·동결 일정.\n'
    + 'topic=ops: 도는 런·발행·늦은 스케줄·자리·열린 결정의 출처 있는 개관.\n'
    + '발행·버전·피처·체크리스트·칸·컷·일정·운영 상태 질문은 Grep·ListDir·파일 검색보다 이 도구를 먼저 부른다 — 그 답은 파일이 아니라 원장에 있다.',
  parameters: { type: 'object', properties: {
    version: { type: 'string', description: '조회할 판. 생략하면 개발 판과 다음 판.' },
    topic: { type: 'string', enum: ['status', 'features', 'cell', 'schedule', 'ops'], description: '읽을 대상(기본 status).' },
    id: { type: 'string', description: 'topic=cell 때 찾을 칸 id(필수).' },
  }, required: [] },
};

export const RELEASE_CHANGE_SPEC: LLMToolSpec = {
  name: 'release_change',
  description: '오너의 판올림 변경 요청 — 체크리스트 칸 추가, 칸을 다른 판으로 이동, 판 컷·착지 마감 수정. 실행 전에 사람에게 한 번 확인받는다. 읽기 요청에는 release_status 사용.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['add-item', 'move-item', 'set-schedule'] },
    version: { type: 'string', description: 'add-item 또는 set-schedule 대상 판' },
    id: { type: 'string', description: '칸 id (add-item 또는 move-item)' },
    title: { type: 'string', description: '추가할 칸 제목' },
    owner: { type: 'string', description: '추가할 칸 담당(선택)' },
    from: { type: 'string', description: '이동 전 판' },
    to: { type: 'string', description: '이동 후 판' },
    cutAt: { type: 'string', description: 'ISO 오프셋 포함 컷 시각(선택)' },
    landBy: { type: 'string', description: 'ISO 오프셋 포함 착지 마감(선택)' },
  }, required: ['action'] },
};

export interface ReleaseToolDeps {
  now?: Date;
  devVersion?: () => string;
  checklist?: (version: string) => Checklist;
  schedule?: (version: string) => ReleaseSchedule | null;
  schedules?: () => ReleaseSchedule[];
  publishedRecord?: (version: string) => unknown;
  contextNow?: (options: { topic?: string }) => ContextNowAnswer;
  latestRun?: (graphId: string) => GraphRunState | null;
  confirm?: (options: ConfirmOpts) => Promise<ConfirmResult>;
  add?: typeof add;
  move?: typeof move;
  setSchedule?: typeof setSchedule;
}

function nextVersion(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

function kstDate(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

function daysLeft(iso: string, now: Date): number {
  const due = Date.parse(`${kstDate(iso)}T00:00:00Z`);
  const today = Date.parse(`${kstDate(now.toISOString())}T00:00:00Z`);
  return (due - today) / 86_400_000;
}

function dDay(days: number): string {
  return days < 0 ? `D+${-days}` : days === 0 ? 'D-day' : `D-${days}`;
}

type Published = { version: string | null; publishedAt: string | null; state: 'published' | 'no-record' | 'unreadable' | 'unknown' };

function readPublishedRecord(version: string): unknown {
  return JSON.parse(readFileSync(join(releaseLedgerRoot(), 'release', version, 'release.json'), 'utf8'));
}

function publishedStatus(released: string, deps: ReleaseToolDeps): Published {
  if (!released) return { version: null, publishedAt: null, state: 'unknown' };
  try {
    const raw: unknown = (deps.publishedRecord ?? readPublishedRecord)(released);
    if (raw === undefined || raw === null) return { version: released, publishedAt: null, state: 'no-record' };
    const record: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (record && typeof record === 'object' && 'version' in record && 'publishedAt' in record
      && record.version === released && typeof record.publishedAt === 'string' && Number.isFinite(Date.parse(record.publishedAt))) {
      return { version: released, publishedAt: record.publishedAt, state: 'published' };
    }
    throw new Error('release.json 의 version 또는 publishedAt 가 잘못됨');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: released, publishedAt: null, state: 'no-record' };
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('release.tool', 'published-unreadable', { version: released, reason });
    return { version: released, publishedAt: null, state: 'unreadable' };
  }
}

function firstLine(text: string): string { return text.split(/\r?\n/, 1)[0] ?? ''; }

function versionOrder(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  return (left[0]! - right[0]!) || (left[1]! - right[1]!) || (left[2]! - right[2]!);
}

function cellView(item: ChecklistItem) {
  return { id: item.id, title: firstLine(item.title), status: item.status,
    owner: item.owner ?? null, priority: item.priority ?? null, evidence: item.evidence ? firstLine(item.evidence) : null };
}

export function dispatchReleaseStatus(args: Record<string, unknown>, deps: ReleaseToolDeps = {}): { text: string; structured: Record<string, unknown> } {
  const topic = args.topic === undefined ? 'status' : args.topic;
  if (typeof topic !== 'string' || !['status', 'features', 'cell', 'schedule', 'ops'].includes(topic)) throw new Error('topic 은 status, features, cell, schedule, ops 중 하나');
  const requested = args.version;
  if (requested !== undefined && (typeof requested !== 'string' || !requested.trim())) throw new Error('판 이름이 필요합니다');
  const checklist = deps.checklist ?? listChecklist;
  if (topic === 'ops') {
    const answer = (deps.contextNow ?? contextNow)({});
    const kinds: ContextFact['kind'][] = ['run', 'release', 'schedule-late', 'seat', 'decision'];
    const facts = answer.facts.filter(fact => kinds.includes(fact.kind));
    debug.log('release.tool', 'status', { action: 'status', topic, version: requested ?? null });
    return { text: facts.length ? facts.map(fact => JSON.stringify(fact)).join('\n') : '운영 개관: 관측된 사실 없음', structured: { facts } };
  }
  const dev = checklistDevVersion(deps.devVersion?.() ?? devVersion());
  if (topic === 'features' || topic === 'cell' || topic === 'schedule') {
    let result: { text: string; structured: Record<string, unknown> };
    if (topic === 'features') {
      const target = (requested as string | undefined) ?? dev;
      validateVersion(target);
      const data = checklist(target);
      const counts = summarizeChecklist(data);
      const items = data.items.slice(0, 60).map(({ id, title, status, owner, priority }) =>
        ({ id, title: firstLine(title), status, owner: owner ?? null, priority: priority ?? null }));
      const total = data.items.length;
      result = { text: `${target} 판 피처 ${total}칸 · 초록 ${counts.green} · 노랑 ${counts.yellow} · 빨강 ${counts.red} · 끝 ${counts.done}\n${items.map(item => `${item.id} ${item.title} · ${item.status} · ${item.owner ?? '미배정'}`).join('\n')}${total > 60 ? `\n앞 60칸만 표시(전체 ${total}칸)` : ''}`,
        structured: { version: target, items, counts: { green: counts.green, yellow: counts.yellow, red: counts.red, done: counts.done }, total, truncated: total > 60 } };
    } else if (topic === 'cell') {
      const id = requiredString(args, 'id');
      const searched = requested ? [requested as string] : [...new Set([dev, nextVersion(dev), checklist(dev).released].filter(Boolean))];
      let found: { version: string; item: ChecklistItem } | undefined;
      const examined: string[] = [];
      for (const v of searched) {
        validateVersion(v);
        examined.push(v);
        const item = checklist(v).items.find(item => item.id === id);
        if (item) { found = { version: v, item }; break; }
      }
      result = found
        ? { text: `${found.version} · ${id} ${firstLine(found.item.title)} · ${found.item.status} · 담당 ${found.item.owner ?? '미배정'}${found.item.evidence ? ` · 근거 ${firstLine(found.item.evidence)}` : ''}`,
          structured: { found: true, version: found.version, item: cellView(found.item) } }
        : { text: `${id} · 살핀 판(${examined.join(', ')})에 없음`, structured: { found: false, searched: examined } };
    } else {
      const released = checklist(dev).released;
      const schedules = (deps.schedules ?? listSchedules)().filter(row => !released || versionOrder(row.version, released) > 0)
        .sort((a, b) => versionOrder(a.version, b.version));
      result = { text: schedules.length ? schedules.map(formatSchedule).join('\n') : '살핀 판에 일정 없음',
        structured: { schedules: schedules.map(row => ({ version: row.version, cutAt: row.cutAt, landBy: row.landBy,
          publishAt: row.publishAt ?? null, freezeFrom: row.freezeFrom ?? null, freezeUntil: row.freezeUntil ?? null })) } };
    }
    debug.log('release.tool', 'status', { action: 'status', topic, version: requested ?? dev });
    return result;
  }
  const version = requested ? null : dev;
  const versions = requested ? [requested as string] : [version!, nextVersion(version!)];
  const now = deps.now ?? new Date();
  const run = (deps.latestRun ?? latestGraphRun)('release-loop');
  const latest = run ? { status: run.status, lastNode: run.path.at(-1) ?? null, startedAt: run.startedAt ?? null } : null;
  let devChecklist: Checklist | undefined;
  const entries = versions.map(v => {
    validateVersion(v);
    const schedule = (deps.schedule ?? getSchedule)(v);
    const data = (deps.checklist ?? listChecklist)(v);
    if (v === dev) devChecklist = data;
    const summary = summarizeChecklist(data);
    const red = data.items.filter(item => item.status === 'red').map(({ id, title, owner }) => ({ id, title, owner: owner ?? '미배정' }));
    const yellowByOwner: Record<string, number> = {};
    for (const item of data.items.filter(item => item.status === 'yellow')) {
      const owner = item.owner ?? '미배정';
      yellowByOwner[owner] = (yellowByOwner[owner] ?? 0) + 1;
    }
    const cutDaysLeft = schedule ? daysLeft(schedule.cutAt, now) : null;
    const landDaysLeft = schedule?.landBy ? daysLeft(schedule.landBy, now) : null;
    const cutHoursLeft = schedule ? Math.ceil((Date.parse(schedule.cutAt) - now.getTime()) / 3_600_000) : null;
    const landHoursLeft = schedule?.landBy ? Math.ceil((Date.parse(schedule.landBy) - now.getTime()) / 3_600_000) : null;
    return { version: v, schedule: schedule ? { cutAt: schedule.cutAt, landBy: schedule.landBy, publishAt: schedule.publishAt ?? null, cutDaysLeft, landDaysLeft, cutHoursLeft, landHoursLeft } : null,
      counts: { green: summary.green, yellow: summary.yellow, red: summary.red, done: summary.done }, red, yellowByOwner };
  });
  const lines = entries.map(entry => {
    const schedule = entry.schedule;
    return `${entry.version} · 컷 ${schedule ? formatKst(schedule.cutAt) : '미정'}${schedule?.landBy ? ` · 착지 마감 ${formatKst(schedule.landBy)}` : ' · 착지 마감 미정'}${schedule ? ` · 컷 ${dDay(schedule.cutDaysLeft!)} (${schedule.cutHoursLeft}시간)${schedule.landDaysLeft !== null ? ` · 착지 ${dDay(schedule.landDaysLeft)} (${schedule.landHoursLeft}시간)` : ''}` : ''}${schedule?.publishAt ? ` · 발행 ${formatKst(schedule.publishAt).split(' ')[1]} KST` : ''}\n` +
      `초록 ${entry.counts.green} · 노랑 ${entry.counts.yellow} · 빨강 ${entry.counts.red} · 끝 ${entry.counts.done}\n` +
      `빨강 칸: ${entry.red.length ? entry.red.map(item => `${item.id} ${item.title} (${item.owner})`).join(', ') : '없음'}\n` +
      `담당별 노랑: ${Object.keys(entry.yellowByOwner).length ? Object.entries(entry.yellowByOwner).map(([owner, count]) => `${owner} ${count}`).join(', ') : '없음'}`;
  });
  lines.push(latest ? `최근 발행 런: ${latest.status} · 끝 노드 ${latest.lastNode ?? '없음'} · 시작 ${latest.startedAt ?? '미상'}` : '최근 발행 런: 없음');
  const cards: ElanousCard[] = [
    { kind: 'release-schedule', items: entries.map(entry => ({ title: `${entry.version} 컷`, due: entry.schedule ? kstDate(entry.schedule.cutAt) : null, daysLeft: entry.schedule?.cutDaysLeft ?? null, state: entry.schedule ? 'scheduled' : 'undecided', owner: 'release' })), meta: { versions: entries.map(entry => entry.version) } },
    { kind: 'release-checklist', items: entries.flatMap(entry => entry.red.map(item => ({ title: `${item.id} ${item.title}`, due: null, daysLeft: null, state: 'red', owner: item.owner }))), meta: { counts: entries.map(entry => ({ version: entry.version, ...entry.counts })) } },
  ];
  const published = publishedStatus((devChecklist ?? checklist(dev)).released, deps);
  const publishedLine = published.state === 'published' ? `발행 판 ${published.version} · 발행 ${formatKst(published.publishedAt!)}`
    : published.state === 'no-record' ? `발행 판 ${published.version} · 발행 기록 없음`
    : published.state === 'unreadable' ? `발행 판 ${published.version} · 발행 기록 못 읽음` : '발행 판 모름';
  const structured = { releases: entries, latestRun: latest, published };
  debug.log('release.tool', 'status', { action: 'status', topic, version: versions.join(',') });
  return { text: `${lines.join('\n\n')}\n${cards.map(formatElanousCard).join('\n')}\n${publishedLine}`, structured };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 값이 필요합니다`);
  return value.trim();
}

/** Never accepts a user-supplied owner claim: only a human, server-assigned owner context can authorize a mutation. */
export async function dispatchReleaseChange(args: Record<string, unknown>, context?: ToolRuntimeContext, deps: ReleaseToolDeps = {}): Promise<string> {
  const action = typeof args.action === 'string' ? args.action : '';
  const version = typeof args.version === 'string' ? args.version : typeof args.from === 'string' ? args.from : '';
  const ownerId = context?.verifiedOwner?.id;
  if (context?.requestOrigin === 'external-agent' || !context?.sessionId || !ownerId?.trim()) {
    debug.log('release.tool', 'change-refused', { action, version });
    return '서버에서 검증한 오너의 사람 채팅 문맥에서만 판올림을 바꿀 수 있습니다.';
  }
  const channels = context.confirmChannels;
  if (!channels?.length) {
    debug.log('release.tool', 'change-refused', { action, version });
    return '원래 채팅의 확인 채널이 없어 판올림을 바꾸지 않았습니다.';
  }
  let prompt: string;
  let apply: () => void;
  if (action === 'add-item') {
    const v = requiredString(args, 'version');
    const id = requiredString(args, 'id');
    const title = requiredString(args, 'title');
    validateVersion(v);
    const owner = args.owner === undefined ? undefined : requiredString(args, 'owner');
    prompt = `${v} 에 칸 ${id} «${title}» 추가 — 진행할까요?`;
    apply = () => { (deps.add ?? add)(v, { id, title, status: 'yellow', ...(owner ? { owner } : {}), updatedAt: new Date().toISOString(), updatedBy: ownerId }); };
  } else if (action === 'move-item') {
    const id = requiredString(args, 'id');
    const from = requiredString(args, 'from');
    const to = requiredString(args, 'to');
    validateVersion(from); validateVersion(to);
    if (from === to) throw new Error('같은 판으로 옮길 수 없습니다');
    prompt = `${id} 칸을 ${from} 에서 ${to} 로 이동 — 진행할까요?`;
    apply = () => { (deps.move ?? move)(id, from, to, ownerId); };
  } else if (action === 'set-schedule') {
    const v = requiredString(args, 'version');
    validateVersion(v);
    const cutAt = args.cutAt === undefined ? undefined : requiredString(args, 'cutAt');
    const landBy = args.landBy === undefined ? undefined : requiredString(args, 'landBy');
    if (!cutAt && !landBy) throw new Error('cutAt 또는 landBy 가 필요합니다');
    // Validate offsets before asking for approval, not after.
    for (const iso of [cutAt, landBy].filter((value): value is string => !!value)) {
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(iso) || !Number.isFinite(Date.parse(iso))) throw new Error(`잘못된 ISO 시각: ${iso}`);
    }
    prompt = `${v} 판 일정 ${cutAt ? `컷 ${formatKst(cutAt)}` : ''}${landBy ? ` 착지 마감 ${formatKst(landBy)}` : ''} 변경 — 진행할까요?`;
    apply = () => { (deps.setSchedule ?? setSchedule)(v, { ...(cutAt ? { cutAt } : {}), ...(landBy ? { landBy } : {}) }, ownerId); };
  } else throw new Error('action 은 add-item, move-item, set-schedule 중 하나여야 합니다');
  debug.log('release.tool', 'change-requested', { action, version });
  const result = await (deps.confirm ?? requestConfirmation)({ prompt, onTimeout: () => false, failOpen: false,
    channels });
  if (!result.answer || !channels.some(channel => channel.name === result.channel)) {
    debug.log('release.tool', 'change-refused', { action, version });
    return `${prompt} — 승인되지 않아 변경하지 않았습니다.`;
  }
  apply();
  debug.log('release.tool', 'change-confirmed', { action, version });
  return `${prompt} — 변경했습니다.`;
}
