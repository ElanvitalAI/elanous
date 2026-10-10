import type { LLMToolSpec } from '../llm.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { fetchLinearProjectIssues, type LinearProjectIssue } from '../connectors/linear.js';
import { formatElanousCard } from './elanous-card.js';
import recordedDateEvidence from './coo-admin-dates.evidence.json';

type CooDateEvidence = {
  project: string;
  verifiedIssues: Array<{
    identifier: string;
    title: string;
    url: string;
    officialDeadline: string | null;
    preparationPeriod: string | { start: string } | null;
    representativeActionDate: string | null;
  }>;
};

export const COO_ADMIN_SPEC: LLMToolSpec = {
  name: 'coo_admin',
  description: '읽기 전용 Linear COO 행정 조회 — «행정 뭐 남았어 · COO 할 일 · 마감 다가오는 행정» 질문에 사용. 외부 행정 프로젝트의 열린 일을 우선순위와 확인된 날짜 근거로 브리핑한다.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export interface CooAdminDeps {
  getSecret?: (id: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  project?: string;
  now?: Date;
  dateEvidence?: CooDateEvidence;
  briefing?: boolean;
}

/** Reads the configured Linear project without changing any Linear issue. */
export async function dispatchCooAdmin(_args: Record<string, unknown>, deps: CooAdminDeps = {}): Promise<string> {
  let count = 0;
  let overdue = 0;
  try {
    const apiKey = await (deps.getSecret ?? getSecretAsync)('connector.linear.apiKey');
    if (!apiKey) {
      debug.log('coo.admin', 'failed', { count, overdue, reason: 'missing-key' });
      return 'Linear 키가 없습니다 — `elanous connector linear set-key`';
    }
    const project = deps.project ?? getUserConfig().coo?.linearProject ?? '외부 행정·큰 일 (COO)';
    const issues = await fetchLinearProjectIssues({ apiKey, project, fetch: deps.fetch ?? fetch });
    const today = deps.now ?? new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const daysUntil = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - todayUtc) / 86_400_000);
    const dateEvidence = deps.dateEvidence ?? (recordedDateEvidence as CooDateEvidence);
    const verifiedDate = (date: string | null | undefined): string | null => {
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const time = Date.parse(`${date}T00:00:00Z`);
      return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? date : null;
    };
    const evidenceFor = (item: LinearProjectIssue) => dateEvidence.project === project
      ? dateEvidence.verifiedIssues.find(row => row.identifier === item.identifier && row.url === item.url && row.title === item.title)
      : undefined;
    const deadlineFor = (item: LinearProjectIssue) => verifiedDate(evidenceFor(item)?.officialDeadline);
    const rank = (item: LinearProjectIssue) => item.priority === 0 ? 5 : item.priority;
    if (deps.briefing) {
      const todayKst = new Date(today.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
      const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
      const todayDay = day(todayKst);
      const byDeadline = (a: LinearProjectIssue, b: LinearProjectIssue) =>
        day(deadlineFor(a)!) - day(deadlineFor(b)!) || rank(a) - rank(b) || a.identifier.localeCompare(b.identifier);
      const dated = issues.filter(item => deadlineFor(item) !== null).sort(byDeadline);
      const format = (item: LinearProjectIssue) => {
        const due = deadlineFor(item);
        const representative = verifiedDate(evidenceFor(item)?.representativeActionDate);
        const priority = item.priority === 1 ? 'Urgent' : item.priority === 2 ? 'High' : `우선순위 ${item.priority || '미지정'}`;
        const title = item.title.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
        const url = item.url.replace(/[\r\n\u2028\u2029]+/g, '');
        return `- ${due ? `확인된 마감일 ${due}` : '기한 미확인'} · ${priority} · ${title}${representative ? ` · 대표 손이 필요한 날 ${representative}` : ''}\n  ${url}`;
      };
      const overdueItems = dated.filter(item => day(deadlineFor(item)!) < todayDay);
      const upcoming = dated.filter(item => day(deadlineFor(item)!) >= todayDay && day(deadlineFor(item)!) <= todayDay + 14 * 86_400_000);
      const later = dated.filter(item => day(deadlineFor(item)!) > todayDay + 14 * 86_400_000);
      const unknown = issues.filter(item => deadlineFor(item) === null).sort((a, b) => rank(a) - rank(b) || a.identifier.localeCompare(b.identifier));
      debug.log('coo.admin', 'read', { count: issues.length, overdue: overdueItems.length, reason: 'ok' });
      return [issues.truncated ? '조회 상한 250건 · 아래 목록은 일부이며 빠진 항목의 기한은 측정 불가' : '',
        `지난 기한 ${overdueItems.length}건\n${overdueItems.map(format).join('\n') || '없음'}`,
        `14일 안 기한 ${upcoming.length}건\n${upcoming.map(format).join('\n') || '없음'}`,
        ...(later.length || unknown.length ? [`그 밖 · 14일 이후 ${later.length}건 · 기한 미확인 ${unknown.length}건\n${[...later, ...unknown].map(format).join('\n')}`] : []),
      ].filter(Boolean).join('\n');
    }
    issues.sort((a, b) => {
      const aDue = deadlineFor(a);
      const bDue = deadlineFor(b);
      return rank(a) - rank(b) || (aDue === null ? (bDue === null ? 0 : 1)
        : bDue === null ? -1 : daysUntil(aDue) - daysUntil(bDue));
    });
    count = issues.length;
    const lines = issues.map((item: LinearProjectIssue) => {
      const evidence = evidenceFor(item);
      const due = deadlineFor(item);
      const days = due ? daysUntil(due) : null;
      if (days !== null && days < 0) overdue++;
      const deadline = due ? `확인된 마감일 ${due} (${days !== null && days < 0 ? `지남 ${-days}일` : `D-${days}`})` : '기한 미확인 · 확인 예정일 미정';
      const preparation = verifiedDate(typeof evidence?.preparationPeriod === 'string'
        ? evidence.preparationPeriod : evidence?.preparationPeriod?.start);
      const representative = verifiedDate(evidence?.representativeActionDate);
      const dates = [preparation && `준비 시작일 ${preparation}`, representative && `대표 손이 필요한 날 ${representative}`].filter(Boolean);
      return `${deadline} · 우선순위 ${item.priority || '미지정'} · ${item.title} · ${item.state.name} · ${item.assignee?.name ?? '미배정'}${dates.length ? ` · ${dates.join(' · ')}` : ''}\n${item.url}`;
    });
    debug.log('coo.admin', 'read', { count, overdue, reason: 'ok' });
    const scope = issues.truncated ? '최대 250건 중 조회한 항목만 우선순위·확인된 마감 순으로 표시 (이후 항목은 포함되지 않음)\n' : '';
    const prose = lines.length ? `${scope}${lines.join('\n')}` : '남은 행정 0건';
    const card = formatElanousCard({ kind: 'coo-admin', items: issues.map(item => {
      const due = deadlineFor(item);
      return {
        title: item.title, due, daysLeft: due ? daysUntil(due) : null,
        state: item.state.name, owner: item.assignee?.name ?? '미배정', url: item.url,
      };
    }) });
    return `${prose}\n${card}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('coo.admin', 'failed', { count, overdue, reason: 'linear-read-failed' });
    return `못 읽었습니다(${reason})`;
  }
}
