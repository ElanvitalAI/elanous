import type { AskUserQuestionRequest } from './elanous-ask-extensions';

export type DeployStatus = 'simulated' | 'published' | 'rejected' | 'failed';
export interface DeployResult { status: DeployStatus; publicUrl?: string }

const STATUSES = new Set<DeployStatus>(['simulated', 'published', 'rejected', 'failed']);

function safePublicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.pathname !== '/' || url.search || url.hash
      || !/^[a-z0-9-]+--[a-z0-9-]+\.elanous\.app$/i.test(url.hostname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

function parseCandidate(value: unknown): DeployResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'site-deploy' || typeof record.status !== 'string'
    || !STATUSES.has(record.status as DeployStatus)) return null;
  const publicUrl = safePublicUrl(record.publicUrl);
  return { status: record.status as DeployStatus,
    ...(record.status === 'published' && publicUrl ? { publicUrl } : {}) };
}

/** DEPLOY-1's result may arrive directly, under `structured`/`result`, or as MCP text. */
export function parseDeployResult(toolName: string, raw: unknown): DeployResult | null {
  if (toolName !== 'app_deploy') return null;
  const direct = parseCandidate(raw);
  if (direct) return direct;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const key of ['structured', 'result', 'output']) {
    const candidate = parseCandidate(record[key]);
    if (candidate) return candidate;
  }
  if (!Array.isArray(record.content)) return null;
  for (const item of record.content) {
    if (!item || typeof item !== 'object' || (item as Record<string, unknown>).type !== 'text') continue;
    const text = (item as Record<string, unknown>).text;
    if (typeof text !== 'string') continue;
    try {
      const candidate = parseCandidate(JSON.parse(text));
      if (candidate) return candidate;
    } catch { /* ordinary tool prose */ }
  }
  return null;
}

/** Route only a two-choice publication confirmation to the dedicated chat card. */
export function deployConfirmation(request: AskUserQuestionRequest | null): { yes: string; no: string; question: string } | null {
  if (!request || request.questions.length !== 1) return null;
  const question = request.questions[0]!;
  if (question.id !== 'confirm' || question.header !== '배포' || question.multiSelect || question.includeOther
    || question.options.length !== 2) return null;
  const yes = question.options.find((option) => /^(?:y|yes|예|네)$/i.test(option.label.trim()))?.label;
  const no = question.options.find((option) => /^(?:n|no|아니요)$/i.test(option.label.trim()))?.label;
  return yes && no ? { yes, no, question: question.question } : null;
}
