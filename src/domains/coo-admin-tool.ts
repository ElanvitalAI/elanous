import type { LLMToolSpec } from '../llm.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { fetchLinearProjectIssues, type LinearProjectIssue } from '../connectors/linear.js';
import { formatElanousCard } from './elanous-card.js';

export const COO_ADMIN_SPEC: LLMToolSpec = {
  name: 'coo_admin',
  description: '읽기 전용 Linear COO 행정 조회 — «행정 뭐 남았어 · COO 할 일 · 마감 다가오는 행정» 질문에 사용. 외부 행정 프로젝트의 열린 일을 마감 순으로 읽는다.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export interface CooAdminDeps {
  getSecret?: (id: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  project?: string;
  now?: Date;
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
    const daysUntil = (date: string) => Math.round((Date.parse(`${date.slice(0, 10)}T00:00:00Z`) - todayUtc) / 86_400_000);
    issues.sort((a, b) => {
      const deadlineOrder = a.dueDate == null ? (b.dueDate == null ? 0 : 1)
        : b.dueDate == null ? -1 : daysUntil(a.dueDate) - daysUntil(b.dueDate);
      return deadlineOrder || (a.priority === 0 ? 5 : a.priority) - (b.priority === 0 ? 5 : b.priority);
    });
    count = issues.length;
    const lines = issues.map((item: LinearProjectIssue) => {
      const days = item.dueDate ? daysUntil(item.dueDate) : null;
      if (days !== null && days < 0) overdue++;
      const deadline = days === null ? '마감 없음' : days < 0 ? `지남 ${-days}일` : `D-${days}`;
      return `${deadline} · ${item.title} · ${item.state.name} · ${item.assignee?.name ?? '미배정'}\n${item.url}`;
    });
    debug.log('coo.admin', 'read', { count, overdue, reason: 'ok' });
    const scope = issues.truncated ? '최대 250건 중 조회한 항목만 마감 순으로 표시 (이후 항목은 포함되지 않음)\n' : '';
    const prose = lines.length ? `${scope}${lines.join('\n')}` : '남은 행정 0건';
    const card = formatElanousCard({ kind: 'coo-admin', items: issues.map(item => ({
      title: item.title, due: item.dueDate?.slice(0, 10) ?? null,
      daysLeft: item.dueDate ? daysUntil(item.dueDate) : null,
      state: item.state.name, owner: item.assignee?.name ?? '미배정', url: item.url,
    })) });
    return `${prose}\n${card}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('coo.admin', 'failed', { count, overdue, reason: 'linear-read-failed' });
    return `못 읽었습니다(${reason})`;
  }
}
