import { debug } from '../debug/log.js';
import { listMemories, makeMemoryJudge, memoryRoot, saveMemory } from '../memory.js';

export interface OpsNowComment { body: string; createdAt: string; url: string }
export interface OpsNowDeps {
  listComments?: (sinceIso: string) => Promise<OpsNowComment[] | null>;
  summarize?: (prompt: string) => Promise<string>;
  now?: () => Date;
  root?: string;
  dryRun?: boolean;
}
export interface OpsNowResult {
  outcome: 'updated' | 'unchanged' | 'no-notices' | 'summarize-failed' | 'channel-unreadable';
  notices: number;
  memoryId?: string;
  /** Only populated for dry-run, so callers can inspect the proposed write. */
  body?: string;
}

const HEADER = /^갱신: [^\n]* · 출처 글 \d+개\n/;
const CITED_ITEM = /^- .+ \(출처: (https?:\/\/[^\s)]+)\)$/;

function citedItems(body: string): string[] | null {
  const lines = body.trim().split('\n').filter((line) => line.trim());
  if (!lines.length) return null;
  const sources: string[] = [];
  for (const line of lines) {
    const match = CITED_ITEM.exec(line);
    if (!match || line.match(/\(출처:/g)?.length !== 1) return null;
    sources.push(match[1]!);
  }
  return sources;
}

function channelIssue(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+$/.test(parsed.pathname) &&
      /^#issuecomment-\d+$/.test(parsed.hash) ? `${parsed.origin}${parsed.pathname}` : null;
  } catch { return null; }
}

export async function refreshOpsNow(deps: OpsNowDeps = {}): Promise<OpsNowResult> {
  const now = (deps.now ?? (() => new Date()))();
  const root = deps.root ?? memoryRoot();
  const finish = (outcome: OpsNowResult['outcome'], notices: number, chars: number, memoryId?: string, body?: string): OpsNowResult => {
    debug.log('ops-now.refresh', outcome, { notices, chars });
    return { outcome, notices, ...(memoryId ? { memoryId } : {}), ...(body !== undefined ? { body } : {}) };
  };
  let comments: OpsNowComment[] | null;
  try {
    const listComments = deps.listComments ?? (await import('../nexus/api/ops-seats-sources.js')).channelCommentsSince;
    comments = await listComments(new Date(now.getTime() - 86_400_000).toISOString());
  } catch {
    comments = null;
  }
  if (!comments) return finish('channel-unreadable', 0, 0);
  const notices = comments.filter((c) => c.body.includes('📌안내') &&
    Number.isFinite(Date.parse(c.createdAt)) && Date.parse(c.createdAt) >= now.getTime() - 86_400_000 && Date.parse(c.createdAt) <= now.getTime())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!notices.length) return finish('no-notices', 0, 0);

  const existing = listMemories({}, root).find((m) => m.name === 'ops-now');
  const oldBody = existing?.body.trim() ?? '';
  const issue = channelIssue(notices[0]!.url);
  const oldSources = (issue ? oldBody.replace(HEADER, '').split('\n').map((line) => CITED_ITEM.exec(line)?.[1]) : [])
    .filter((url): url is string => !!url && channelIssue(url) === issue);
  const allowedSources = new Set([...notices.map((c) => c.url), ...oldSources]);
  const prompt = [
    '너는 봇의 ops-now 고정 기억을 diff 갱신한다. 기존 본문과 채널 📌안내 글을 대조해 지금 유효한 안내만 한국어로 반환한다.',
    '새 글의 정정이 앞 글과 충돌하면 새 글이 이긴다. 이미 유효한 기존 안내는 유지하되 낡거나 정정된 안내는 제거한다.',
    '각 항목은 한 줄의 "- 안내 (출처: <코멘트 URL>)" 꼴로 쓰고 다른 문장은 출력하지 않는다. 출처는 아래 새 글 URL 또는 기존 본문의 검증 가능한 채널 URL만 사용한다. 출처가 확인되지 않는 항목은 쓰지 않는다.',
    '비밀 값·토큰·개인 메모·계정 이름은 옮기지 않는다.',
    '본문만 출력한다. 갱신 시각 헤더는 출력하지 않는다. 2,000자 이하.',
    '## 기존 ops-now 본문', oldBody || '(없음)', '## 📌안내 (오래된 글 → 새로운 글)',
    ...notices.map((c) => {
      const seat = /^\s*\*\*\[(OP|MK|TC|UX)\]\*/.exec(c.body)?.[1] ?? '미상';
      return `시각: ${c.createdAt} · 자리: ${seat} · URL: ${c.url}\n${c.body.slice(0, 1500)}`;
    }),
  ].join('\n\n');
  let summary: string;
  try {
    summary = (await (deps.summarize ?? makeMemoryJudge())(prompt)).trim().replace(HEADER, '').trim();
    const sources = citedItems(summary);
    if (!sources || sources.some((url) => !allowedSources.has(url)) ||
      `갱신: ${now.toISOString()} · 출처 글 ${notices.length}개\n${summary}`.length > 2000) throw new Error('invalid summary');
  } catch {
    return finish('summarize-failed', notices.length, 0, existing?.id);
  }
  if (summary === oldBody.replace(HEADER, '').trim() && existing?.pinned && existing.staleAfterMinutes === 120) {
    return finish('unchanged', notices.length, summary.length, existing.id, deps.dryRun ? existing.body.trimStart() : undefined);
  }
  const body = `갱신: ${now.toISOString()} · 출처 글 ${notices.length}개\n${summary}`;
  if (deps.dryRun) return finish('updated', notices.length, body.length, existing?.id, body);
  const saved = saveMemory({
    type: 'project', name: 'ops-now', description: existing?.description ?? '지금 운영 상태 — 채널 📌안내 갱신',
    body, id: existing?.id, priority: existing?.priority, pinned: true, staleAfterMinutes: 120,
  }, root);
  return finish('updated', notices.length, body.length, saved.id);
}
