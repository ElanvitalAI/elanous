import { PR_LABELS } from '../../github/pr-labels.js';
import type { Task } from '../types.js';

export type IdeaApprovalGh = (args: string[]) => Promise<string>;

interface ApprovalInput {
  task: Task;
  runId?: string;
  prUrl: string;
  ok: boolean;
}

const missing = '해설에 없음';
const summaryEnd = '<!-- elanous:approval-summary-end -->';
const approvalLabel = PR_LABELS.find((label) => label.axis === 'state' && label.name.endsWith(':idea-approval'))!.name;
const intakeLabel = PR_LABELS.find((label) => label.axis === 'origin' && label.name.endsWith(':from-intake'))!.name;

function approvalDetails({ task, runId, prUrl, ok }: ApprovalInput): { markdown: string; missingFields: string[] } {
  const lines = task.description.split(/\r?\n/);
  const field = (name: string) => lines.find((line) => line.trim().startsWith(`${name}:`))?.trim().slice(name.length + 1).trim();
  const firstSection = lines.findIndex((line) => /^(수용기준|원문):/.test(line.trim()));
  const why = field('why') ?? lines.slice(0, firstSection < 0 ? lines.length : firstSection)
    .filter((line) => line.trim()).join('\n').trim();
  const criteria = field('수용기준');
  const source = field('원문') ?? (task.generatedBy?.kind === 'external' ? task.generatedBy.url : undefined)
    ?? task.description.match(/https?:\/\/[^\s)]+/)?.[0];
  const missingFields: string[] = [];
  const value = (name: string, text?: string) => {
    if (text) return text;
    missingFields.push(name);
    return missing;
  };
  const markdown = [
    '## 승인 요약',
    `**한 줄** — ${value('한 줄', task.title)}`,
    `**원문 (출발점)** — ${value('원문', source)} · 작성자: ${value('작성자')} · 저장 시각: ${value('저장 시각')} · 원문 요지: ${value('원문 요지')}`,
    `**SCQA** — S ${value('S')} · C ${value('C', why)} · Q ${value('Q')} · A ${value('A', criteria)}`,
    `**과정** — 저장: ${value('저장')} → 흡수: ${value('흡수', task.generatedBy?.kind === 'external' ? task.generatedBy.ref : undefined)} → 사전 아이디어: ${value('사전 아이디어')} → 중복 확인: ${value('중복 확인')} → 결정: ${value('결정')} → 골: ${value('골', criteria)} → 런: ${value('런', runId)} → 시험 결과: ${value('시험 결과', ok ? undefined : '런 실패')}`,
    `**머지하면 좋아지는 것** — 바로: ${value('바로', criteria)} · 다음 결정: ${value('다음 결정')}`,
    `**바뀌는 것 / 위험** — 파일 범위: ${value('파일 범위')} · 운영 동작 변화: ${value('운영 동작 변화')} · 한계: ${value('한계')} · PR: ${prUrl}`,
  ].join('\n');
  return { markdown, missingFields };
}

export function buildApprovalSummary(input: ApprovalInput): string {
  return approvalDetails(input).markdown;
}

export async function finalize(input: ApprovalInput & { gh: IdeaApprovalGh }): Promise<{
  pr: string; labeled: boolean; ready: boolean; summaryChars: number; missingFields: string[];
}> {
  const { task, gh } = input;
  if (task.generatedBy?.kind !== 'external' || task.generatedBy.provider !== 'intake' || !task.generatedBy.ref.trim()) {
    throw new Error('intake origin and ledger ref required');
  }
  const url = new URL(input.prUrl);
  const match = url.protocol === 'https:' && url.hostname === 'github.com' && !url.search && !url.hash
    && url.pathname.match(/^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/);
  if (!match) throw new Error(`invalid GitHub PR URL: ${input.prUrl}`);
  const pr = match[1]!;
  if (!input.ok) return { pr, labeled: false, ready: false, summaryChars: 0, missingFields: [] };
  // Pass the full PR URL, not its number: the tool cwd may point at another repository.
  const target = input.prUrl;
  const raw = await gh(['pr', 'view', target, '--json', 'body,isDraft,labels']);
  const view: { body?: unknown; isDraft?: boolean; labels?: { name: string }[] } = JSON.parse(raw);
  if (typeof view.body !== 'string') throw new Error('PR body missing');
  const { markdown, missingFields } = approvalDetails(input);
  const marker = `아이디어: ${task.generatedBy.ref}`;
  const existing = view.body;
  let original = existing.startsWith('아이디어: ')
    ? existing.replace(/^아이디어: [^\n]*\n+/, '')
    : existing;
  if (original.startsWith('## 승인 요약\n')) {
    const headings = ['한 줄', '원문 (출발점)', 'SCQA', '과정', '머지하면 좋아지는 것', '바뀌는 것 / 위험'];
    let cursor = '## 승인 요약\n'.length;
    for (const heading of headings) {
      const headingLine = `**${heading}** — `;
      const at = original.indexOf(headingLine, cursor);
      if (at < cursor || (at > 0 && original[at - 1] !== '\n')) throw new Error('PR approval summary incomplete');
      // The next heading must be separated only by summary text, not a new Markdown section.
      if (/^#{1,6} /m.test(original.slice(cursor, at))) throw new Error('PR approval summary incomplete');
      cursor = at + headingLine.length;
    }
    const markerAt = original.indexOf(`\n\n${summaryEnd}\n\n`, cursor);
    if (markerAt >= 0) {
      if (!original.slice(cursor, markerAt).trim()) throw new Error('PR approval summary incomplete');
      original = original.slice(markerAt + summaryEnd.length + 4);
    } else {
      const rest = original.indexOf('\n\n', cursor);
      if (rest < 0) throw new Error('PR approval summary incomplete');
      const finalField = original.slice(cursor, rest);
      if (finalField.includes('\n') || (finalField.trim() && !/· PR: https:\/\/github\.com\/[^\s]+$/.test(finalField))) {
        throw new Error('PR approval summary incomplete');
      }
      const remaining = original.slice(rest + 2);
      if (!remaining || remaining.includes('\n\n') || remaining.includes(summaryEnd)) {
        throw new Error('PR approval summary incomplete');
      }
      original = remaining;
    }
  }
  const desired = `${marker}\n\n${markdown}\n\n${summaryEnd}\n\n${original}`;
  if (existing !== desired) await gh(['pr', 'edit', target, '--body', desired]);
  if (view.isDraft !== false) await gh(['pr', 'ready', target]);
  const labels = new Set(view.labels?.map((label) => label.name) ?? []);
  const conflicting = PR_LABELS.filter((label) =>
    ((label.axis === 'state' && label.name !== approvalLabel)
      || (label.axis === 'origin' && label.name !== intakeLabel))
    && labels.has(label.name),
  );
  if (!labels.has(approvalLabel) || !labels.has(intakeLabel) || conflicting.length > 0) {
    await gh([
      'pr', 'edit', target, '--add-label', approvalLabel, '--add-label', intakeLabel,
      ...conflicting.flatMap((label) => ['--remove-label', label.name]),
    ]);
  }
  return { pr, labeled: true, ready: true, summaryChars: markdown.length, missingFields };
}
