// Integrated, test-only scene 2 device. Production coordinators run against fake external I/O.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTelegramAmbientMessageHandler } from '../intake-plane/adapters/telegram-ambient.js';
import { createLinearSecretaryBreakdown, updateLinearSecretaryProgress, type LinearSecretaryPlan } from '../intake-plane/linear-wish.js';
import { submitIntakeWork } from '../intake-plane/submit-intake-work.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { DecisionCardService, type CardRef, type CardTransport, type CardView } from '../decisions/decision-cards.js';
import { LogStore } from '../mss/logging/log-store.js';
import { simBrowserHand } from './browser-hand.js';

const NOW = new Date('2026-10-31T00:00:00.000Z');
const REQUEST = 'https://example.test/demo/brief 11-04 데모 준비를 리니어로 정리해줘';
const PLAN: LinearSecretaryPlan = {
  title: '11-04 데모 준비', rationale: '무대·흡수·브라우저·승인 경계를 근거가 보이게 나눴습니다.',
  assigneeId: 'fake-owner', dueDate: '2026-11-05',
  tasks: [
    { title: '무대 자료 확인', intent: '요청의 공개 근거를 확인한다', refs: ['https://example.test/demo/brief'], assigneeId: 'fake-owner', dueDate: '2026-11-05' },
    { title: '흡수 자료 연결', intent: '흡수한 자료를 하위 태스크에 연결한다', refs: ['https://example.test/demo/absorb'], assigneeId: 'fake-owner', dueDate: '2026-11-05' },
    { title: '브라우저 캡처 첨부', intent: '승인된 브라우저 캡처를 같은 태스크에 붙인다', refs: ['https://example.test/demo/browser'], assigneeId: 'fake-owner', dueDate: '2026-11-05' },
  ],
};

export interface LinearSecretarySimulationResult {
  runId: string;
  evidencePath: string;
  cleanup(): void;
  reply: string | null;
  parentIssueId: string;
  intakeIds: string[];
  childIssueIds: string[];
  completedIssueIds: string[];
  childEvidence: Array<{ issueId: string; description: string }>;
  linearAttachments: Array<{ issueId: string; url: string }>;
  progressCommentCount: number;
  browserAttachment: { issueId: string; url: string } | null;
  approvalCard: { id: string; text: string; buttons: CardView['buttons'] } | null;
  approvalCardStatus: string | null;
  browserRunId: string | null;
  browserActionRunIds: Array<string | null>;
  externalCalls: number;
  runEvents: string[];
  runEvidence: { category: string; event: string; persisted: boolean };
}

export async function simLinearSecretary(): Promise<LinearSecretarySimulationResult> {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-linear-secretary-'));
  const runId = randomUUID();
  const store = new LogStore(join(root, 'logs', 'logs.db'), { instance: 'ux-sim' });
  let retainEvidence = false;
  const eventNames: string[] = [];
  const event = (name: string, data: Record<string, unknown> = {}): void => {
    eventNames.push(name);
    store.insertBatch([{ surface: 'ux-sim', rec: { ts: NOW.toISOString(), category: 'ux.sim.linear-secretary', event: name,
      level: 'debug', data: { runId, ...data } } }]);
  };
  let externalCalls = 0;
  const descriptions = new Map<string, string>();
  const states = new Map<string, string>();
  const attachments: Array<{ issueId: string; url: string }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const childEvidence: Array<{ issueId: string; description: string }> = [];
  let nextIssue = 0;
  let parentIssueId = '';
  let intakeIds: string[] = [];
  let childIssueIds: string[] = [];
  let completedIssueIds: string[] = [];
  let browserAttachment: { issueId: string; url: string } | null = null;
  let reply: string | null = null;
  let approvalCard: LinearSecretarySimulationResult['approvalCard'] = null;
  let approvalCardStatus: string | null = null;
  let approvalDecisionId: string | undefined;
  let browserRunId: string | null = null;
  let browserActionRunIds: Array<string | null> = [];
  let failure: string | undefined;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    externalCalls++;
    if (typeof init?.body !== 'string') throw new Error('fake Linear expected a JSON GraphQL POST body');
    let body: { query?: unknown; variables?: Record<string, unknown> };
    try { body = JSON.parse(init.body) as typeof body; }
    catch { throw new Error('fake Linear expected valid JSON GraphQL POST body'); }
    if (typeof body.query !== 'string') throw new Error('fake Linear GraphQL body is missing its query');
    const id = String(body.variables?.id ?? '');
    if (body.query.includes('LinearIssueStatus')) return Response.json({ data: { issue: { state: { type: states.get(id) ?? 'started' } } } });
    if (body.query.includes('DecisionIssueStates')) return Response.json({ data: { issue: { team: { states: { nodes: [
      { id: 'todo', type: 'unstarted' }, { id: 'doing', type: 'started' }, { id: 'done', type: 'completed' },
    ] } } } } });
    if (body.query.includes('LinearAttachmentCreate')) {
      const input = body.variables?.input as { issueId: string; url: string };
      attachments.push({ issueId: input.issueId, url: input.url });
      return Response.json({ data: { attachmentCreate: { success: true, attachment: { id: `attachment-${attachments.length}` } } } });
    }
    if (body.query.includes('DecisionComment')) {
      const input = body.variables?.input as { issueId: string; body: string };
      comments.push(input);
      return Response.json({ data: { commentCreate: { success: true, comment: { id: `comment-${comments.length}` } } } });
    }
    if (body.query.includes('LinearIssueDescription($id')) return Response.json({ data: { issue: { description: descriptions.get(id) } } });
    if (body.query.includes('LinearIssueDescriptionUpdate')) {
      const input = body.variables?.input as { description: string };
      descriptions.set(id, input.description);
      return Response.json({ data: { issueUpdate: { success: true } } });
    }
    if (body.query.includes('DecisionIssueClose')) {
      const input = body.variables?.input as { stateId: string };
      states.set(id, input.stateId === 'done' ? 'completed' : 'started');
      return Response.json({ data: { issueUpdate: { success: true } } });
    }
    throw new Error(`unexpected fake Linear query: ${body.query}`);
  }) as typeof fetch;

  try {
    event('request-received');
    const runSecretary = async (request: string) => {
      try {
      if (request !== REQUEST) throw new Error('unexpected request');
      event('secretary-started');
      const absorbed = await submitIntakeWork({ text: request, track: 'absorb', origin: {
        kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram', ref: 'ux-sim:message-1',
      } }, {
        root: () => join(root, 'intake'), now: () => NOW.toISOString(),
        ingest: (_root, _source, raws) => ({ shaped: raws.length, added: raws.length, merged: 0, seen: 0, skipped: 0, badLines: 0 }),
        log: name => event(name === 'submitted' ? 'intake-submit-observed' : `intake-${name}`),
      });
      if (!absorbed.ok || absorbed.track !== 'absorb' || absorbed.ids.length !== 1) throw new Error('demo URL did not enter the absorb seam');
      intakeIds = absorbed.ids;
      const groundedPlan: LinearSecretaryPlan = { ...PLAN, tasks: PLAN.tasks.map((task, index) => index === 0
        ? { ...task, refs: [`elanous:intake:${intakeIds[0]}`] } : task) };
      event('intake-ledger-seam-completed', { intakeIds });
      const result = await createLinearSecretaryBreakdown({ apiKey: 'ux-sim-key', teamKey: 'DEMO', request, plan: groundedPlan,
        fetch: fakeFetch,
        deps: {
          createIssue: async input => {
            const id = `00000000-0000-4000-8000-${String(++nextIssue).padStart(12, '0')}`;
            if (input.parentId) { states.set(id, 'started'); childEvidence.push({ issueId: id, description: input.description ?? '' }); }
            else { parentIssueId = id; states.set(id, 'started'); descriptions.set(id, input.description ?? ''); }
            return id;
          },
          updateDescription: async input => { descriptions.set(input.issueId, input.description); },
        } });
      childIssueIds = result.childIssueIds;
      event('breakdown-created', { parentIssueId, childIssueIds });

      for (let index = 0; index < childIssueIds.length; index++) {
        const issueId = childIssueIds[index]!;
        const task = groundedPlan.tasks[index]!;
        let captureUrl: string | undefined;
        if (index === 1) {
          const browser = await simBrowserHand('attach', issueId, runId);
          browserRunId = browser.observedRunId;
          browserActionRunIds = [...browser.observedBrowserActionRunIds];
          if (!browserActionRunIds.includes(runId)) throw new Error('browser-act execution event did not consume the secretary runId');
          const attached = browser.linear.attachments.find(item => item.issueId === issueId);
          if (!attached) throw new Error('browser capture was not attached to its Linear child');
          browserAttachment = { issueId, url: attached.url };
          captureUrl = attached.url;
          event('browser-capture-attached', { issueId, url: attached.url });
        }
        await updateLinearSecretaryProgress({ apiKey: 'ux-sim-key', parentIssueId, taskIssueId: issueId, taskTitle: task.title,
          tasks: groundedPlan.tasks.map((item, taskIndex) => ({ issueId: childIssueIds[taskIndex]!, title: item.title })),
          completedIssueIds, state: 'started', summary: `흡수 근거로 ${task.title}을 시작`, fetch: fakeFetch });
        await updateLinearSecretaryProgress({ apiKey: 'ux-sim-key', parentIssueId, taskIssueId: issueId, taskTitle: task.title,
          tasks: groundedPlan.tasks.map((item, taskIndex) => ({ issueId: childIssueIds[taskIndex]!, title: item.title })),
          completedIssueIds, state: 'completed', summary: `${task.title} 완료`, ...(captureUrl ? { captureUrl } : {}), fetch: fakeFetch });
        completedIssueIds = [...completedIssueIds, issueId];
        event('subtask-absorbed', { issueId, completedIssueIds: [...completedIssueIds] });
      }
      const ledger = new DecisionLedger({ stateDir: join(root, 'state'), now: () => NOW,
        resolveVersion: () => ({ released: '0.2.42', dev: '0.2.43-dev.0', codename: null }) });
      const decision = ledger.raise({ title: '11-04 Linear 데모 게시 승인', category: 'publish',
        scqa: { s: '데모 산출물이 준비됐다.', c: '외부 공개는 대표 승인이 필요하다.' },
        options: [{ key: 'a', label: '승인', consequence: '공개를 진행한다' }, { key: 'b', label: '보류', consequence: '외부 공개를 멈춘다' }],
        recommendation: { option: 'b', why: '이 장치는 승인 전 경계까지만 재현한다' }, raisedBy: { agent: 'OPT', track: 'O' },
        refs: [parentIssueId, ...childIssueIds] });
      const sent: Array<{ view: CardView }> = [];
      const transport: CardTransport = {
        platform: 'telegram', async ownerChats() { return ['fake-owner']; },
        async send(_chat: string, view: CardView): Promise<CardRef> { sent.push({ view }); return { chat: 'fake-owner', message: String(sent.length) }; },
        async edit() {}, async notify() {},
      };
      await new DecisionCardService({ transport, ownerIds: ['fake-owner'], ledger, now: () => NOW }).tick();
      const card = sent.find(item => item.view.text.includes(decision.id));
      if (!card) throw new Error('approval card did not reach the fake owner transport');
      approvalDecisionId = decision.id;
      approvalCard = { id: decision.id, text: card.view.text, buttons: card.view.buttons };
      approvalCardStatus = ledger.show(decision.id).status;
      if (approvalCardStatus !== 'open') throw new Error(`approval card was not left open: ${approvalCardStatus}`);
      event('approval-card-opened', { decisionId: decision.id, status: approvalCardStatus });
      return { replyCard: result.replyCard };
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        event('failed', { message: failure });
        throw error;
      }
    };
    const handle = createTelegramAmbientMessageHandler({ runSecretary });
    reply = await handle({ text: REQUEST, chatId: 'fake-chat', userId: 'fake-owner' });
    if (reply === null) throw new Error('one-line Linear request was not routed');
    if (failure) throw new Error(`integrated secretary scene failed: ${failure}`);
    event('completed', { parentIssueId, childIssueIds, decisionId: approvalDecisionId });
    const runRows = store.queryByDataKeys({ exactCategories: ['ux.sim.linear-secretary'], runIds: [runId] });
    const linkedEvents = runRows.filter(row => row.event === 'completed');
    const result: LinearSecretarySimulationResult = { runId, evidencePath: store.path, cleanup: () => rmSync(root, { recursive: true, force: true }),
      reply, parentIssueId, intakeIds, childIssueIds, completedIssueIds,
      childEvidence: childEvidence.map(item => ({ ...item, description: descriptions.get(item.issueId) ?? item.description })),
      linearAttachments: attachments, progressCommentCount: comments.length, browserAttachment, browserRunId, browserActionRunIds, approvalCard, approvalCardStatus, externalCalls, runEvents: eventNames,
      runEvidence: { category: 'ux.sim.linear-secretary', event: 'completed', persisted: linkedEvents.length === 1 } };
    retainEvidence = true;
    return result;
  } finally {
    try { store.close(); }
    finally { if (!retainEvidence) rmSync(root, { recursive: true, force: true }); }
  }
}
