import { BriefItemsLedger } from '../briefing/brief-items.js';
import { EventLedger } from '../connectors/event-ledger.js';
import { commentLinearIssue, moveLinearIssueToStateType } from '../connectors/linear.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { captureAndDraftIntakeRecord } from './capture.js';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { addSource, canonicalSeat, listSources, removeSource, runDue, type RunDueDeps, type RegisteredIntakeSource } from './intake-sources.js';
import {
  applyClarifyAnswerToDraft,
  buildDecisionFromIntent,
} from './clarify.js';
import type { IntakeStore } from './store.js';
import {
  applyIntakeProposalToTox,
  createScheduledTaskFromIntakeSession,
  proposeIntakeSessionToTox,
} from './tox-adapter.js';
import type { IntakeSession, RawIntakeRecord } from './types.js';
import type { BriefItem } from '../briefing/brief-items.js';

export interface TopicBriefingDeliveryDeps {
  sendIssueCard: (input: { linearIssueId: string; text: string }) => Promise<void>;
  commentIssue: (linearIssueId: string, text: string) => Promise<void>;
  issueIsDone: (linearIssueId: string) => Promise<boolean>;
  isDecisionImpacting: (items: readonly BriefItem[]) => Promise<boolean>;
  reopenIssue: (linearIssueId: string) => Promise<void>;
  sendMemoUpdateCard: (input: { linearIssueId: string; text: string }) => Promise<void>;
}

interface TopicBriefingDeliveryReceipt {
  telegramSent: boolean;
  linearCommented: boolean;
  reopened: boolean;
  memoSent: boolean;
  updatedAt: string;
}

function topicBriefingReceiptsFile(stateDir: string): string { return join(stateDir, 'intake', 'topic-briefing-deliveries.json'); }

function readTopicBriefingReceipts(stateDir: string): Record<string, TopicBriefingDeliveryReceipt> {
  const file = topicBriefingReceiptsFile(stateDir);
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`topic briefing receipt ledger shape invalid: ${file}`);
  return parsed as Record<string, TopicBriefingDeliveryReceipt>;
}

function saveTopicBriefingReceipts(stateDir: string, receipts: Record<string, TopicBriefingDeliveryReceipt>): void {
  const file = topicBriefingReceiptsFile(stateDir);
  mkdirSync(join(stateDir, 'intake'), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(receipts, null, 2) + '\n'); } finally { closeSync(fd); }
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

/** Persist each external delivery stage so a later channel failure cannot resend a successful Telegram card/comment. */
export async function deliverTopicBriefingWithReceipts(input: {
  linearIssueId: string;
  issueLabel?: string;
  summary: string;
  items: readonly BriefItem[];
}, stateDir: string, deps: TopicBriefingDeliveryDeps, mode: 'live' | 'telegram-dry-run' = 'live'): Promise<{ related: number; reopened: boolean }> {
  const receiptKey = createHash('sha256').update(`${mode}\n${input.linearIssueId.toLowerCase()}\n${input.items.map(item => item.id).sort((a, b) => a - b).join(',')}`).digest('hex');
  const receipts = readTopicBriefingReceipts(stateDir);
  const receipt = receipts[receiptKey] ?? { telegramSent: false, linearCommented: false, reopened: false, memoSent: false, updatedAt: '' };
  const saveReceipt = (): void => {
    receipt.updatedAt = new Date().toISOString();
    receipts[receiptKey] = receipt;
    const expiry = Date.now() - 90 * 86_400_000;
    for (const [key, value] of Object.entries(receipts)) if (Date.parse(value.updatedAt) < expiry) delete receipts[key];
    saveTopicBriefingReceipts(stateDir, receipts);
  };
  return deliverTopicBriefing(input, {
    ...deps,
    sendIssueCard: async card => { if (!receipt.telegramSent) { await deps.sendIssueCard(card); receipt.telegramSent = true; saveReceipt(); } },
    commentIssue: async (issueId, text) => { if (!receipt.linearCommented) { await deps.commentIssue(issueId, text); receipt.linearCommented = true; saveReceipt(); } },
    issueIsDone: async issueId => receipt.reopened || await deps.issueIsDone(issueId),
    isDecisionImpacting: async items => receipt.reopened || await deps.isDecisionImpacting(items),
    reopenIssue: async issueId => { if (!receipt.reopened) { await deps.reopenIssue(issueId); receipt.reopened = true; saveReceipt(); } },
    sendMemoUpdateCard: async card => { if (!receipt.memoSent) { await deps.sendMemoUpdateCard(card); receipt.memoSent = true; saveReceipt(); } },
  });
}

export function isDecisionImpactingTopicEvidence(items: readonly BriefItem[]): boolean {
  const decisionTerms = /(?:파산|부도|법정관리|사업 철수|공장 폐쇄|생산 중단|공급 중단|제재|소송|(?:계약|주문|공급|생산|투자|가이던스|실적|매출|수익|전망)(?:이|가|을|를|은|는)?\s*(?:취소|파기|철회|중단|감산|급감|감소|축소|하향|하락|적자 전환|대폭 삭감)|\b(?:bankruptcy|default|plant closure|business exit|production halt|supply halt|sanction|lawsuit|withdrawn|terminated)\b|\b(?:contract|order|supply|production|investment|guidance|earnings|revenue|profit|outlook)\s+(?:cancelled?|terminated|withdrawn|suspended|cut|reduced|downgraded|loss|miss)\b)/iu;
  return items.some(item => decisionTerms.test(item.text));
}

/** Project only issue-linked findings; scheduled callers may invoke this after every run, including after Done. */
export async function deliverTopicBriefing(input: {
  linearIssueId: string;
  issueLabel?: string;
  summary: string;
  items: readonly BriefItem[];
}, deps: TopicBriefingDeliveryDeps): Promise<{ related: number; reopened: boolean }> {
  const related = input.items.filter(item => item.linearIssueId?.toLowerCase() === input.linearIssueId.toLowerCase());
  if (related.length === 0) return { related: 0, reopened: false };
  const sources = related.map(item => item.evidence).filter((url): url is string => !!url);
  const text = `관련 이슈 · ${input.issueLabel?.trim() || input.linearIssueId}\n\n${input.summary.trim()}${sources.length ? `\n\n출처\n${sources.map(url => `- ${url}`).join('\n')}` : ''}`;
  await deps.sendIssueCard({ linearIssueId: input.linearIssueId, text });
  await deps.commentIssue(input.linearIssueId, text);
  const reopened = await deps.issueIsDone(input.linearIssueId) && await deps.isDecisionImpacting(related);
  if (reopened) {
    await deps.reopenIssue(input.linearIssueId);
    await deps.sendMemoUpdateCard({ linearIssueId: input.linearIssueId,
      text: `관련 이슈 · ${input.issueLabel?.trim() || input.linearIssueId}\n메모 갱신?\n\n${input.summary.trim()}` });
  }
  return { related: related.length, reopened };
}

/** Production adapter used by both the immediate subscription run and each existing daemon schedule fire. */
export function appendTopicBriefingTelegramDryRun(file: string, input: { linearIssueId: string; text: string; kind: 'issue' | 'memo' }): void {
  appendFileSync(file, `${JSON.stringify({ recordedAt: new Date().toISOString(), ...input })}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function projectTopicBriefing(source: RegisteredIntakeSource, items: BriefItem[], stateDir = effectiveInstanceRoot(),
  options: { telegramDryRunFile?: string } = {}): Promise<void> {
  if (!source.linearIssueId || items.length === 0) return;
  const [{ getSecretAsync }, { commentLinearIssue, fetchLinearIssueStateType, moveLinearIssueToStateType },
    { kindRouteTarget }, { getUserConfig }, { sendTelegramTo }] = await Promise.all([
    import('../nexus/config/secrets/index.js'), import('../connectors/linear.js'), import('../domains/telegram-kind-route.js'),
    import('../user-config.js'), import('../autopilot/mission-notify.js'),
  ]);
  const target = options.telegramDryRunFile ? undefined : kindRouteTarget(getUserConfig(), 'ops-report');
  if (!options.telegramDryRunFile && !target) throw new Error('관련 이슈 브리핑 Telegram ops-report 대상이 없습니다');
  const send = async (text: string, kind: 'issue' | 'memo'): Promise<void> => {
    if (options.telegramDryRunFile) {
      appendTopicBriefingTelegramDryRun(options.telegramDryRunFile, { linearIssueId: source.linearIssueId!, text, kind });
      return;
    }
    if (!target || !sendTelegramTo(target.botToken, target.chatId, text)) throw new Error('관련 이슈 브리핑 Telegram 발송 실패');
  };
  const apiKey = await getSecretAsync('connector.linear.apiKey');
  if (!apiKey) throw new Error('Linear 키가 없습니다');
  await deliverTopicBriefingWithReceipts({ linearIssueId: source.linearIssueId, issueLabel: source.spec,
    summary: items.map(item => item.text).join('\n'), items }, stateDir, {
    sendIssueCard: async ({ text }) => send(text, 'issue'),
    commentIssue: async (issueId, body) => commentLinearIssue({ apiKey, issueId, body }),
    issueIsDone: async issueId => await fetchLinearIssueStateType({ apiKey, issueId }) === 'completed',
    isDecisionImpacting: async related => isDecisionImpactingTopicEvidence(related),
    reopenIssue: async issueId => moveLinearIssueToStateType({ apiKey, issueId, type: 'started' }),
    sendMemoUpdateCard: async ({ text }) => send(text, 'memo'),
  }, options.telegramDryRunFile ? 'telegram-dry-run' : 'live');
}

export interface SubscribeTopicSearchInput {
  seat: string;
  topic: string;
  /** Parent Linear issue.id UUID (`ExternalTaskEvent.ref` / task generatedBy.ref). */
  linearIssueId: string;
  every: string;
  /** Per-subscription five-field cron, e.g. `0 8 * * 1` for Mondays at 08:00. */
  scheduleCron: string;
  /** Absolute path receiving Telegram message bodies instead of live sends. */
  telegramDryRunFile?: string;
}

export interface SubscribeTopicSearchDeps {
  stateDir?: string;
  now?: Date;
  runDue?: typeof runDue;
  sourceAdd?: typeof addSource;
  sourceList?: typeof listSources;
  sourceRemove?: typeof removeSource;
  scheduleDispatch?: (args: Record<string, unknown>) => Promise<unknown>;
  runDeps?: RunDueDeps;
}

function scheduleError(result: unknown): string | null {
  return result && typeof result === 'object' && 'error' in result ? String((result as { error: unknown }).error) : null;
}

/**
 * Linear secretary handoff: register one issue-linked topic source, create and
 * migrate exactly one existing schedule-registry job to the workflow daemon,
 * then run that same source immediately through runDue.
 */
export async function subscribeTopicSearch(input: SubscribeTopicSearchInput, deps: SubscribeTopicSearchDeps = {}): Promise<{
  source: RegisteredIntakeSource;
  scheduleId: string;
  immediate: Awaited<ReturnType<typeof runDue>>;
}> {
  const stateDir = deps.stateDir ?? effectiveInstanceRoot();
  const normalizedTopic = input.topic.trim();
  if (!normalizedTopic) throw new Error('topic-search topic이 비었다');
  const seat = canonicalSeat(input.seat);
  const sourceId = `topic-${createHash('sha256').update(`${seat}\n${input.linearIssueId.toLowerCase()}\n${normalizedTopic.toLowerCase()}`)
    .digest('hex').slice(0, 20)}`;
  const sources = deps.sourceList ?? listSources;
  const add = deps.sourceAdd ?? addSource;
  const remove = deps.sourceRemove ?? removeSource;
  const existing = sources({}, stateDir).find((source) => source.id === sourceId);
  let source: RegisteredIntakeSource;
  let created = false;
  let scheduleCreatedNow = false;
  if (existing) {
    if (existing.kind !== 'topic-search' || existing.linearIssueId?.toLowerCase() !== input.linearIssueId.toLowerCase()
      || existing.spec.toLowerCase() !== normalizedTopic.toLowerCase() || existing.scheduleCron !== input.scheduleCron) {
      throw new Error(`topic-search source identity collision: ${sourceId}`);
    }
    source = existing;
  } else {
    source = add({ id: sourceId, seat, kind: 'topic-search', spec: normalizedTopic,
      every: input.every, scheduleCron: input.scheduleCron, linearIssueId: input.linearIssueId }, stateDir);
    created = true;
  }

  const dispatch = deps.scheduleDispatch ?? (async (args: Record<string, unknown>) => {
    const { dispatchScheduleManage } = await import('../domains/schedule-manage-tool.js');
    return dispatchScheduleManage(args);
  });
  const dryRunArg = input.telegramDryRunFile
    ? ` --telegram-dry-run-file '${input.telegramDryRunFile.replaceAll("'", "'\\''")}'` : '';
  const command = `eln intake source run-due --source-id ${sourceId} --project-issue-briefing${dryRunArg}`;
  let scheduleId: string | undefined;
  const createSchedule = async (): Promise<void> => {
      const creation = await dispatch({ action: 'create', cron: input.scheduleCron, command, category: 'ingest' });
      const createError = scheduleError(creation);
      if (createError) throw new Error(`topic-search 일정 등록 실패: ${createError}`);
      scheduleCreatedNow = true;
      // Crontab inventory derives category from the command, so the created
      // job may appear under maintenance instead of the requested ingest
      // category. Match by exact command + cron across the registry.
      const listing = await dispatch({ action: 'list' }) as { schedules?: Array<{ id?: string; command?: string; cron?: string }> };
      const listError = scheduleError(listing);
      if (listError) throw new Error(`topic-search 일정 목록 확인 실패: ${listError}`);
      const match = listing.schedules?.find((row) => row.command === command && row.cron === input.scheduleCron);
      if (!match?.id) throw new Error('topic-search 일정이 schedule registry에 나타나지 않았다');
      scheduleId = match.id;
      const migrated = await dispatch({ action: 'migrate', id: scheduleId, yes: true });
      const migrateError = scheduleError(migrated);
      if (migrateError) throw new Error(`topic-search 일정을 데몬으로 이관하지 못했다: ${migrateError}`);
      const noted = await dispatch({ action: 'note', id: scheduleId,
        note: `topic-search · ${sourceId} · parent Linear UUID ${input.linearIssueId}` });
      const noteError = scheduleError(noted);
      if (noteError) throw new Error(`topic-search 일정 설명 저장 실패: ${noteError}`);
  };
  try {
    if (!existing) await createSchedule();
    else {
      const listing = await dispatch({ action: 'list' }) as { schedules?: Array<{ id?: string; command?: string; cron?: string }> };
      const listError = scheduleError(listing);
      if (listError) throw new Error(`기존 topic-search 일정 목록 확인 실패: ${listError}`);
      const sourceCommandPrefix = `eln intake source run-due --source-id ${sourceId} --project-issue-briefing`;
      const conflicting = listing.schedules?.find((row) => row.cron === input.scheduleCron
        && row.command?.startsWith(sourceCommandPrefix) && row.command !== command);
      if (conflicting) throw new Error(`기존 topic-search 일정의 Telegram 실행 모드가 다르다; 중복 예약을 피하려면 기존 일정부터 제거해야 한다: ${conflicting.id ?? sourceId}`);
      const match = listing.schedules?.find((row) => row.command === command && row.cron === input.scheduleCron);
      if (match?.id) scheduleId = match.id;
      else await createSchedule();
    }
  } catch (error) {
    if (scheduleCreatedNow) {
      let orphan = scheduleId;
      if (!orphan) {
        try {
          const listing = await dispatch({ action: 'list' }) as { schedules?: Array<{ id?: string; command?: string; cron?: string }> };
          orphan = listing.schedules?.find((row) => row.command === command && row.cron === input.scheduleCron)?.id;
        } catch { /* source cleanup below remains primary */ }
      }
      if (orphan) try { await dispatch({ action: 'delete', id: orphan, yes: true }); } catch { /* preserve primary error */ }
    }
    if (created) {
      remove(sourceId, stateDir);
    }
    throw error;
  }

  const immediate = await (deps.runDue ?? runDue)({ now: deps.now ?? new Date(), seat, sourceId,
    deps: { ...deps.runDeps, stateDir, projectTopicBriefing: deps.runDeps?.projectTopicBriefing ?? (input.telegramDryRunFile
      ? (registered, items, dir) => projectTopicBriefing(registered, items, dir, { telegramDryRunFile: input.telegramDryRunFile })
      : projectTopicBriefing) } });
  return { source, scheduleId: scheduleId!, immediate };
}

export interface IntakeIssueBriefingEvidence {
  title: string;
  url: string;
  summary: string;
  reopensIssue?: boolean;
}

export interface IntakeIssueBriefingInput {
  issueRef: string;
  topic: string;
  state: 'open' | 'done';
  evidence: readonly IntakeIssueBriefingEvidence[];
  collected?: boolean;
}

export interface IntakeIssueBriefingDeps {
  stateDir: string;
  ledger?: BriefItemsLedger;
  registerSource?: (source: RegisteredIntakeSource) => void;
  runSources?: () => Promise<{ ran: Array<{ id: string; items: number; error?: string }> }>;
  commentIssue?: (issueRef: string, body: string) => Promise<void>;
  reopenIssue?: (issueRef: string) => Promise<void>;
}

function issueWatchId(issueRef: string): string {
  return `watch-${issueRef.replace(/[^\w.-]+/g, '-')}`;
}

function issueBriefingComment(input: IntakeIssueBriefingInput, evidence: readonly IntakeIssueBriefingEvidence[]): string {
  return [`## 흡수 브리핑 · ${input.issueRef}`, ...evidence.map(item => `- ${item.title}: ${item.summary} (${item.url})`)].join('\n');
}

async function defaultCommentIssue(stateDir: string, issueRef: string, body: string): Promise<void> {
  const apiKey = await getSecretAsync('connector.linear.apiKey');
  if (!apiKey?.trim()) return;
  await commentLinearIssue({ apiKey, issueId: issueRef, body });
  const hash = createHash('sha256').update(body).digest('hex');
  new EventLedger(join(stateDir, 'connectors', 'events.jsonl')).record('linear', `outgoing:comment:brief:${issueRef}:${hash}`, {
    ref: issueRef, occurredAt: new Date().toISOString(),
  });
}

async function defaultReopenIssue(stateDir: string, issueRef: string): Promise<void> {
  const apiKey = await getSecretAsync('connector.linear.apiKey');
  if (!apiKey?.trim()) return;
  await moveLinearIssueToStateType({ apiKey, issueId: issueRef, type: 'started' });
  new EventLedger(join(stateDir, 'connectors', 'events.jsonl')).record('linear', `outgoing:reopen:brief:${issueRef}:${Date.now()}`, {
    ref: issueRef, occurredAt: new Date().toISOString(),
  });
}

/**
 * The intake-daily bridge preserves the Linear secretary identifier from subscription through the briefing ledger.
 * Open issues receive evidence cards and Linear comments; a material event on a done issue records a memo-update card and reopens it.
 */
export async function runIntakeIssueBriefing(input: IntakeIssueBriefingInput, deps: IntakeIssueBriefingDeps): Promise<void> {
  if (!input.issueRef.trim() || !input.topic.trim()) throw new Error('issueRef and topic are required');
  const source: RegisteredIntakeSource = {
    id: issueWatchId(input.issueRef), seat: 'user', kind: 'github-query', spec: input.topic, every: '1d',
    why: `linear-secretary:${input.issueRef}`, issueRef: input.issueRef,
  };
  if (deps.registerSource) deps.registerSource(source);
  else if (!listSources({}, deps.stateDir).some(entry => entry.id === source.id)) addSource(source, deps.stateDir);
  if (!input.collected) await (deps.runSources ?? (() => runDue({ deps: { stateDir: deps.stateDir } })))();

  const relevant = input.state === 'open' ? input.evidence : input.evidence.filter(item => item.reopensIssue === true);
  if (relevant.length === 0) return;
  const ledger = deps.ledger ?? new BriefItemsLedger({ stateDir: deps.stateDir });
  for (const item of relevant) {
    ledger.add({
      text: input.state === 'done' ? `메모 갱신? ${item.title}: ${item.summary}` : `${item.title}: ${item.summary}`,
      domain: '흡수', priority: item.reopensIssue ? 'P0' : 'P1', source: 'intake-daily', evidence: item.url, issueRef: input.issueRef,
    });
  }
  const body = issueBriefingComment(input, relevant);
  await (deps.commentIssue ?? ((issueRef, comment) => defaultCommentIssue(deps.stateDir, issueRef, comment)))(input.issueRef, body);
  if (input.state === 'done' && relevant.some(item => item.reopensIssue)) {
    await (deps.reopenIssue ?? (issueRef => defaultReopenIssue(deps.stateDir, issueRef)))(input.issueRef);
  }
}

export interface ReplayIntakeResult {
  sourceId: string;
  session: IntakeSession;
}

export function replayIntakeSession(
  store: IntakeStore,
  sourceId: string,
  now: Date,
  intakeId: string,
): ReplayIntakeResult {
  const source = store.getSession(sourceId);
  if (!source) throw new Error(`Intake session not found: ${sourceId}`);
  const raw: RawIntakeRecord = {
    ...source.raw,
    intakeId,
    receivedAt: now.toISOString(),
    attachments: source.raw.attachments.map((attachment) => ({ ...attachment })),
    ...(source.raw.actor ? { actor: { ...source.raw.actor } } : {}),
    ...(source.raw.channelContext ? { channelContext: { ...source.raw.channelContext } } : {}),
  };
  const session = captureAndDraftIntakeRecord(store, raw, {
    normalizedDetailSource: `intake-replay:${sourceId}`,
  });
  return { sourceId, session };
}

export interface ApplyIntakeResult {
  output: string;
  session: IntakeSession;
  taskIds?: string[];
  taskId?: string;
}

export interface ProposeIntakeResult {
  output: string;
  session: IntakeSession;
  applyToken?: string;
}

export async function proposeIntakeSession(
  store: IntakeStore,
  intakeId: string,
): Promise<ProposeIntakeResult> {
  let session = store.getSession(intakeId);
  if (!session) throw new Error(`Intake session not found: ${intakeId}`);
  if (!session.draft) {
    return { output: `intake ${intakeId} has no draft yet`, session };
  }
  if (session.decision?.mode === 'schedule-followup') {
    return { output: `intake ${intakeId} is marked for scheduled follow-up`, session };
  }
  if (session.decision?.mode === 'backlog-only' || session.decision?.mode === 'discard') {
    return { output: `intake ${intakeId} is marked ${session.decision.mode}`, session };
  }
  const proposed = await proposeIntakeSessionToTox(session);
  if (proposed.applyToken) {
    store.saveProposal(
      intakeId,
      proposed.proposal,
      { applyToken: proposed.applyToken, nextState: 'proposed' },
    );
    session = store.getSession(intakeId)!;
  }
  return {
    output: proposed.output,
    session,
    applyToken: proposed.applyToken,
  };
}

export async function applyIntakeSession(
  store: IntakeStore,
  intakeId: string,
  force = false,
): Promise<ApplyIntakeResult> {
  let session = store.getSession(intakeId);
  if (!session) throw new Error(`Intake session not found: ${intakeId}`);
  if (session.decision?.mode === 'schedule-followup') {
    const scheduleText = String(session.decision.clarifiedAnswers.scheduleText ?? '').trim();
    if (!scheduleText) {
      return { output: `intake ${intakeId} has no scheduleText`, session };
    }
    const created = await createScheduledTaskFromIntakeSession(session, scheduleText);
    if (created.taskId) {
      session = store.setState(intakeId, 'scheduled', { taskId: created.taskId, scheduleText });
    }
    return { output: created.output, session, taskId: created.taskId };
  }
  if (session.decision?.mode === 'backlog-only') {
    return { output: `intake ${intakeId} is marked backlog-only`, session };
  }
  if (session.decision?.mode === 'review-later') {
    return { output: `intake ${intakeId} is marked review-later`, session };
  }
  if (session.decision?.mode === 'discard') {
    return { output: `intake ${intakeId} is marked discard`, session };
  }
  if (!session.applyToken) {
    if (!session.draft) {
      return { output: `intake ${intakeId} has no draft or stored proposal token`, session };
    }
    if (session.draft.openQuestions.length > 0) {
      return { output: `intake ${intakeId} still has open questions`, session };
    }
    const proposed = await proposeIntakeSession(store, intakeId);
    if (!proposed.applyToken) {
      return { output: proposed.output, session: proposed.session };
    }
    session = proposed.session;
  }
  if (!session.applyToken) {
    return { output: `intake ${intakeId} has no stored proposal token`, session };
  }
  const applied = await applyIntakeProposalToTox(session.applyToken, force);
  if (applied.taskIds && applied.taskIds.length > 0) {
    session = store.setState(intakeId, 'applied', { taskIds: applied.taskIds });
  } else {
    session = store.getSession(intakeId)!;
  }
  return {
    output: applied.output,
    session,
    taskIds: applied.taskIds,
  };
}

export interface AnswerIntakeResult {
  output: string;
  session: IntakeSession;
}

export function answerIntakeQuestion(
  store: IntakeStore,
  intakeId: string,
  questionId: string,
  answer: string,
): AnswerIntakeResult {
  const session = store.getSession(intakeId);
  if (!session) throw new Error(`Intake session not found: ${intakeId}`);
  if (!session.draft) throw new Error(`Intake session has no draft: ${intakeId}`);
  const updated = applyClarifyAnswerToDraft(session.draft, questionId, answer);
  if (!updated) throw new Error(`Clarify question not found: ${questionId}`);
  const clarifiedAnswers = {
    ...(session.decision?.clarifiedAnswers ?? {}),
    [questionId]: answer,
  };
  const decision = buildDecisionFromIntent(
    intakeId,
    updated.draft,
    clarifiedAnswers,
    updated.intent,
    session.decision?.mode,
  );
  store.saveDecision(intakeId, decision);
  const next = store.saveDraft(
    intakeId,
    updated.draft,
    { nextState: updated.draft.openQuestions.length > 0 ? 'clarifying' : 'review-ready' },
  );
  return {
    output: `intake ${intakeId} resolved ${questionId} as ${updated.intent}`,
    session: next,
  };
}

export interface DecideIntakeResult {
  output: string;
  session: IntakeSession;
}

export function decideIntakeSession(
  store: IntakeStore,
  intakeId: string,
  mode: 'apply-now' | 'review-later' | 'backlog-only' | 'discard',
): DecideIntakeResult {
  const session = store.getSession(intakeId);
  if (!session) throw new Error(`Intake session not found: ${intakeId}`);
  if (!session.draft) throw new Error(`Intake session has no draft: ${intakeId}`);
  const next = store.saveDecision(intakeId, {
    intakeId,
    mode,
    approvedItemIds: mode === 'backlog-only' || mode === 'discard'
      ? []
      : session.draft.items.map((item) => item.id),
    deferredItemIds: mode === 'backlog-only' || mode === 'review-later'
      ? session.draft.items.map((item) => item.id)
      : [],
    clarifiedAnswers: { ...(session.decision?.clarifiedAnswers ?? {}) },
  });
  return {
    output: `intake ${intakeId} -> ${mode}`,
    session: next,
  };
}

export interface ScheduleIntakeResult {
  output: string;
  session: IntakeSession;
}

export function scheduleIntakeSession(
  store: IntakeStore,
  intakeId: string,
  scheduleText: string,
): ScheduleIntakeResult {
  const session = store.getSession(intakeId);
  if (!session) throw new Error(`Intake session not found: ${intakeId}`);
  const next = store.saveDecision(intakeId, {
    intakeId,
    mode: 'schedule-followup',
    approvedItemIds: session.draft?.items.map((item) => item.id) ?? [],
    deferredItemIds: [],
    clarifiedAnswers: { scheduleText },
  });
  return {
    output: `intake ${intakeId} scheduled as "${scheduleText}"`,
    session: next,
  };
}

export interface ArchiveIntakeResult {
  output: string;
  session: IntakeSession;
}

export function archiveIntakeSession(
  store: IntakeStore,
  intakeId: string,
): ArchiveIntakeResult {
  const session = store.archive(intakeId);
  return {
    output: `intake ${intakeId} archived`,
    session,
  };
}
