import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { debug } from '../debug/log.js';
import { requestConfirmation, type ConfirmOpts, type ConfirmResult } from '../hitl/confirm.js';
import { devVersion, checklistDevVersion, listChecklist, summarizeChecklist, type Checklist } from '../release-loop/checklist.js';
import { add, move, validateVersion } from '../release-loop/feature-store.js';
import { formatKst, getSchedule, setSchedule, type ReleaseSchedule } from '../release-loop/release-schedule.js';
import { latestGraphRun, type GraphRunState } from '../graph-runner/runner.js';
import { formatElanousCard, type ElanousCard } from './elanous-card.js';

export const RELEASE_STATUS_SPEC: LLMToolSpec = {
  name: 'release_status',
  description: '판 어디까지 · 컷 언제 · 릴리스 상황 · 판올림 · 체크리스트 · 남은 칸을 읽는다. 판 일정, 빨강 칸, 담당별 노랑, 최근 발행 런을 조회하는 읽기 전용 도구. 행정 업무는 coo_admin.',
  parameters: { type: 'object', properties: { version: { type: 'string', description: '조회할 판. 생략하면 개발 판과 다음 판.' } }, required: [] },
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

export function dispatchReleaseStatus(args: Record<string, unknown>, deps: ReleaseToolDeps = {}): { text: string; structured: Record<string, unknown> } {
  const requested = args.version;
  if (requested !== undefined && (typeof requested !== 'string' || !requested.trim())) throw new Error('판 이름이 필요합니다');
  const version = requested ? null : checklistDevVersion(deps.devVersion?.() ?? devVersion());
  const versions = requested ? [requested as string] : [version!, nextVersion(version!)];
  const now = deps.now ?? new Date();
  const run = (deps.latestRun ?? latestGraphRun)('release-loop');
  const latest = run ? { status: run.status, lastNode: run.path.at(-1) ?? null, startedAt: run.startedAt ?? null } : null;
  const entries = versions.map(v => {
    validateVersion(v);
    const schedule = (deps.schedule ?? getSchedule)(v);
    const data = (deps.checklist ?? listChecklist)(v);
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
    return { version: v, schedule: schedule ? { cutAt: schedule.cutAt, landBy: schedule.landBy, cutDaysLeft, landDaysLeft, cutHoursLeft, landHoursLeft } : null,
      counts: { green: summary.green, yellow: summary.yellow, red: summary.red, done: summary.done }, red, yellowByOwner };
  });
  const lines = entries.map(entry => {
    const schedule = entry.schedule;
    return `${entry.version} · 컷 ${schedule ? formatKst(schedule.cutAt) : '미정'}${schedule?.landBy ? ` · 착지 마감 ${formatKst(schedule.landBy)}` : ' · 착지 마감 미정'}${schedule ? ` · 컷 ${dDay(schedule.cutDaysLeft!)} (${schedule.cutHoursLeft}시간)${schedule.landDaysLeft !== null ? ` · 착지 ${dDay(schedule.landDaysLeft)} (${schedule.landHoursLeft}시간)` : ''}` : ''}\n` +
      `초록 ${entry.counts.green} · 노랑 ${entry.counts.yellow} · 빨강 ${entry.counts.red} · 끝 ${entry.counts.done}\n` +
      `빨강 칸: ${entry.red.length ? entry.red.map(item => `${item.id} ${item.title} (${item.owner})`).join(', ') : '없음'}\n` +
      `담당별 노랑: ${Object.keys(entry.yellowByOwner).length ? Object.entries(entry.yellowByOwner).map(([owner, count]) => `${owner} ${count}`).join(', ') : '없음'}`;
  });
  lines.push(latest ? `최근 발행 런: ${latest.status} · 끝 노드 ${latest.lastNode ?? '없음'} · 시작 ${latest.startedAt ?? '미상'}` : '최근 발행 런: 없음');
  const cards: ElanousCard[] = [
    { kind: 'release-schedule', items: entries.map(entry => ({ title: `${entry.version} 컷`, due: entry.schedule ? kstDate(entry.schedule.cutAt) : null, daysLeft: entry.schedule?.cutDaysLeft ?? null, state: entry.schedule ? 'scheduled' : 'undecided', owner: 'release' })), meta: { versions: entries.map(entry => entry.version) } },
    { kind: 'release-checklist', items: entries.flatMap(entry => entry.red.map(item => ({ title: `${item.id} ${item.title}`, due: null, daysLeft: null, state: 'red', owner: item.owner }))), meta: { counts: entries.map(entry => ({ version: entry.version, ...entry.counts })) } },
  ];
  const structured = { releases: entries, latestRun: latest };
  debug.log('release.tool', 'status', { action: 'status', version: versions.join(',') });
  return { text: `${lines.join('\n\n')}\n${cards.map(formatElanousCard).join('\n')}`, structured };
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
