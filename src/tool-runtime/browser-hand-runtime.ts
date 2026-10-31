import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { awaitGlobalPersonaLoad, getGlobalPersonaRegistry } from '../persona/global-registry.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { commentLinearIssue, createLinearAttachment, uploadLinearFile } from '../connectors/linear.js';
import { performBrowserAction, type BrowserActionDeps } from '../harness/browser-act.js';
import { decideActionBoundary } from '../harness/browser-act-boundary.js';
import { BROWSER_ACT_CATEGORY, BROWSER_ACT_EVENT } from '../harness/browser-act-step.js';
import type { BrowserActionResult } from '../harness/browser-act.js';
import { createCdpClientFromEndpoint } from '../browser-cdp/client.js';
import { orchestrationId } from '../grounding/ref-index.js';
import { debug } from '../debug/log.js';
import { requestConfirmation } from '../hitl/confirm.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';
import { coordinateBrowserRoundtrip } from '../agent-mission/browser-roundtrip-coordinator.js';
import { appendRunLedgerEntry } from '../self-implement/run-ledger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SELECTION_COMMENT = '이것도 반영';
const PAYWALL_PATTERN = /(paywall|subscribe\s?to\s?continue|subscription\srequired|유료\s?구독)/i;
const LOGIN_PATTERN = /(login\srequired|please\s+log\s?in|sign\s?in\s+to\s+continue|authentication\srequired|로그인\s*(이|가)?\s*필요|로그인\s*후\s*계속)/i;
const ASIDE_HAND_NODE_BRANCH = 'ASIDE-HAND-NODE·BROWSER-ROUNDTRIP-ASIDE' as const;
const PAGE_INSPECT_TIMEOUT_MS = 3_000;

export interface BrowserHandArgs {
  url: string;
  target: string;
  armed: boolean;
  linearSubtaskId: string;
  persona?: string;
  alternateUrl?: string;
  includeThisToo?: boolean;
  selection?: { text?: string; tab?: string };
}

export interface BrowserHandRepairNode extends Record<string, unknown> {
  branch: typeof ASIDE_HAND_NODE_BRANCH;
  orchestrationId: string;
  blockedOn: string;
  detourUrl: string;
  outcome: 'detoured' | 'detour-failed';
  graphEvent: {
    seq: number;
    ts: string;
    type: 'node-added';
    node: string;
    kind: 'hand';
    decider: 'browser-hand';
    reason: string;
    who: 'Elanous';
    what: string;
    missionId: string;
    runId?: string;
  };
}

export interface BrowserHandResult extends Record<string, unknown> {
  ok: boolean;
  output: string;
  captureUrl?: string;
  attachmentId?: string;
  selectionReflected?: boolean;
  blocked?: boolean;
  detoured?: boolean;
  repairNode?: BrowserHandRepairNode;
  reason?: string;
}

export interface BrowserHandDeps {
  browserAct?: (request: Parameters<typeof performBrowserAction>[0], deps?: BrowserActionDeps) => Promise<BrowserActionResult>;
  browserActDeps?: BrowserActionDeps;
  readCapture?: (path: string) => Promise<Buffer>;
  getApiKey?: (name: string) => Promise<string | undefined>;
  upload?: typeof uploadLinearFile;
  attach?: typeof createLinearAttachment;
  reflectSelection?: (input: { issueId: string; body: string }) => Promise<boolean>;
  resolvePersona?: (id: string) => Promise<NonNullable<Parameters<typeof performBrowserAction>[0]['persona']> | undefined>;
  /** Read-only inspection seam. A missing/unavailable observation is unknown, not unblocked. */
  readPageText?: (url: string, port: number) => Promise<string | undefined>;
  confirmHuman?: (input: { url: string; target: string }, ctx?: ToolRuntimeContext) => Promise<boolean>;
}

async function readPageTextWithCdp(url: string, port: number): Promise<string | undefined> {
  let client: Awaited<ReturnType<typeof createCdpClientFromEndpoint>> | undefined;
  try {
    client = await createCdpClientFromEndpoint(port, { attachTimeoutMs: PAGE_INSPECT_TIMEOUT_MS, timeoutMs: PAGE_INSPECT_TIMEOUT_MS });
    const page = await client.evaluate('({ href: location.href, text: document.body?.innerText ?? "" })');
    if (!page || typeof page !== 'object' || !('href' in page) || !('text' in page)) return undefined;
    const inspected = page as { href?: unknown; text?: unknown };
    if (typeof inspected.href !== 'string' || typeof inspected.text !== 'string') return undefined;
    const observedUrl = new URL(inspected.href);
    const requestedUrl = new URL(url);
    if (observedUrl.origin !== requestedUrl.origin || observedUrl.pathname !== requestedUrl.pathname || observedUrl.search !== requestedUrl.search) return undefined;
    return inspected.text.slice(0, 20_000);
  } catch {
    return undefined;
  } finally {
    try { await client?.close(); } catch { /* attached browser remains user-owned */ }
  }
}

function blockedKind(value: string | undefined): 'login' | 'paywall' | undefined {
  if (!value) return undefined;
  if (PAYWALL_PATTERN.test(value)) return 'paywall';
  return LOGIN_PATTERN.test(value) ? 'login' : undefined;
}

function failureBlockKind(action: BrowserActionResult): 'login' | 'paywall' | undefined {
  return action.ok ? undefined : blockedKind(action.error);
}

function recordRepairNode(node: BrowserHandRepairNode, deps: BrowserHandDeps): void {
  try { debug.log('agent-mission', 'browser-repair-node', node); } catch { /* observability is fail-soft */ }
  try { deps.browserActDeps?.observe?.('repair-node', node); } catch { /* observers must not alter the browser result */ }
  const graphEvent = node.graphEvent;
  if (!graphEvent.runId) return;
  try {
    // The external browser result and its one-retry repair decision become a real
    // sequenced node-added row on the active research run, not just a debug event.
    appendRunLedgerEntry({
      timestamp: graphEvent.ts,
      runId: graphEvent.runId,
      event: graphEvent.type,
      data: {
        node: graphEvent.node,
        kind: graphEvent.kind,
        decider: graphEvent.decider,
        reason: graphEvent.reason,
        who: graphEvent.who,
        what: graphEvent.what,
        missionId: graphEvent.missionId,
        orchestrationId: node.orchestrationId,
        outcome: node.outcome,
        blockedOn: node.blockedOn,
        detourUrl: node.detourUrl,
      },
    });
    debug.log('agent-mission', 'browser-repair-node-ledger-recorded', {
      runId: graphEvent.runId, node: graphEvent.node, orchestrationId: node.orchestrationId,
    });
  } catch (error) {
    try { debug.log('agent-mission', 'browser-repair-node-ledger-failed', {
      runId: graphEvent.runId, node: graphEvent.node,
      error: error instanceof Error ? error.message : String(error),
    }, { level: 'warn' }); } catch { /* graph evidence must remain fail-soft */ }
  }
}

function createRepairNode(input: {
  block: 'login' | 'paywall';
  sourceUrl: string;
  detourUrl: string;
  outcome: 'detoured' | 'detour-failed';
  issueId: string;
  deps: BrowserHandDeps;
}): BrowserHandRepairNode {
  const runId = input.deps.browserActDeps?.getRunId?.() ?? undefined;
  const orchestration = orchestrationId('aside-hand-node', runId ?? input.issueId);
  const ts = new Date().toISOString();
  const graphEvent = {
    seq: 1 as const,
    ts,
    type: 'node-added' as const,
    node: `browser-repair-${orchestration}`,
    kind: 'hand' as const,
    decider: 'browser-hand' as const,
    reason: `${input.block} blocked source; one alternate source checked`,
    who: 'Elanous' as const,
    what: input.outcome === 'detoured' ? `Continue browser work from ${input.detourUrl}` : 'Stop after blocked browser source',
    missionId: input.issueId,
    ...(runId ? { runId } : {}),
  };
  return {
    branch: ASIDE_HAND_NODE_BRANCH,
    orchestrationId: orchestration,
    blockedOn: `${input.block}:${input.sourceUrl}`,
    detourUrl: input.detourUrl,
    outcome: input.outcome,
    graphEvent,
  };
}

async function reflectSelectionWithLinearIssueTool(input: { issueId: string; body: string }, deps: BrowserHandDeps): Promise<boolean> {
  const apiKey = await (deps.getApiKey ?? getSecretAsync)('connector.linear.apiKey');
  if (!apiKey?.trim()) return false;
  await commentLinearIssue({ apiKey, issueId: input.issueId, body: input.body });
  return true;
}

async function loadPersona(id: string) {
  await awaitGlobalPersonaLoad();
  return getGlobalPersonaRegistry().get(id);
}

/** Attached-CDP browser action stays behind harness browser-act's armed, host and reversibility checks. */
export async function dispatchBrowserHand(args: BrowserHandArgs, _ctx?: ToolRuntimeContext, deps: BrowserHandDeps = {}): Promise<BrowserHandResult> {
  const url = args.url.trim();
  const target = args.target.trim();
  const issueId = args.linearSubtaskId.trim();
  if (!args.armed) return { ok: false, reason: 'unarmed', output: '브라우저 조작은 사람의 명시적 armed 승인 뒤에만 실행합니다.' };
  if (!url || !target || !UUID.test(issueId)) return { ok: false, reason: 'invalid-input', output: 'URL, CSS 대상, Linear 서브태스크 UUID가 필요합니다.' };
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid-url', output: '절대 URL이 필요합니다.' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: 'invalid-url', output: 'http(s) URL만 허용합니다.' };
  let humanApproved = false;
  try {
    if (deps.confirmHuman) humanApproved = await deps.confirmHuman({ url, target }, _ctx);
    else humanApproved = (await requestConfirmation({
      prompt: `Browser hand action on ${url}`,
      detail: `Target: ${target}\nExplicit human approval is required before navigation or click.`,
      ...(_ctx?.confirmChannels ? { channels: _ctx.confirmChannels } : {}),
      onTimeout: () => false,
    })).answer === true;
  } catch { /* approval failure is denial */ }
  if (!humanApproved) return { ok: false, reason: 'human-approval-required', output: '사람의 확인 승인을 받지 못해 브라우저를 조작하지 않았습니다.' };

  if (!args.persona?.trim()) return { ok: false, reason: 'persona-required', output: '허용 호스트가 선언된 브라우저 페르소나가 필요합니다.' };
  const persona = await (deps.resolvePersona ?? loadPersona)(args.persona);
  if (!persona) return { ok: false, reason: 'persona-not-found', output: '브라우저 페르소나를 찾지 못했습니다.' };
  if (!persona.actionHosts?.some(host => host.trim())) {
    return { ok: false, reason: 'host-boundary-undeclared', output: '브라우저 페르소나에 허용 호스트가 선언되지 않아 이동을 시작하지 않았습니다.' };
  }
  const entryBoundary = decideActionBoundary({ hosts: persona.actionHosts, url, href: null });
  if (!entryBoundary.allowed) return { ok: false, reason: 'host-boundary-blocked', output: `허용 호스트 경계가 시작 URL을 차단했습니다: ${entryBoundary.detail}` };
  const pagePort = persona.browserPort ?? 9222;
  const inspect = deps.readPageText ?? readPageTextWithCdp;
  let actionUrl = url;
  let blocked = false;
  let detoured = false;
  let repairNode: BrowserHandRepairNode | undefined;
  let sourceText: string | undefined;
  let capturedPath: string | undefined;
  const runBrowserAction = async (actionUrl: string) => {
    const observe = (event: string, data: Record<string, unknown>) => {
      if (event === BROWSER_ACT_EVENT) {
        const attachmentRef = data.attachmentRef;
        if (typeof attachmentRef === 'string' && attachmentRef.trim()) capturedPath = attachmentRef;
      }
      (deps.browserActDeps?.observe ?? ((name, value) => debug.log(BROWSER_ACT_CATEGORY, name, value)))(event, data);
    };
    return (deps.browserAct ?? performBrowserAction)({
      url: actionUrl, target, armed: true, entryPoint: 'tool-runtime/browser-hand', ...(persona ? { persona } : {}),
    }, { ...deps.browserActDeps, observe, reversibilityPolicy: 'navigation-only' });
  };
  try { sourceText = await inspect(url, pagePort); } catch { /* unavailable observation stays unknown */ }
  let block = blockedKind(sourceText);
  if (block) {
    blocked = true;
    const alternate = args.alternateUrl?.trim() ?? '';
    let alternateAllowed = false;
    let alternateParsed: URL | undefined;
    try { alternateParsed = new URL(alternate); } catch { /* no valid fallback */ }
    if (alternateParsed && ['http:', 'https:'].includes(alternateParsed.protocol)) {
      const boundary = decideActionBoundary({ hosts: persona.actionHosts, url: alternate, href: null });
      alternateAllowed = boundary.allowed;
    }
    let alternateText: string | undefined;
    if (alternateAllowed) {
      try { alternateText = await inspect(alternate, pagePort); } catch { /* unknown is allowed only after the source was verified blocked */ }
    }
    if (alternateAllowed && !blockedKind(alternateText)) {
      actionUrl = alternate;
      detoured = true;
    }
    if (!detoured) {
      repairNode = createRepairNode({ block, sourceUrl: url, detourUrl: '', outcome: 'detour-failed', issueId, deps });
      recordRepairNode(repairNode, deps);
      return { ok: false, blocked, detoured, repairNode, reason: 'blocked-source-no-safe-alternate', output: '로그인·페이월이 관측됐지만 허용된 대체 출처를 확인하지 못해 브라우저 조작을 멈췄습니다.' };
    }
  }

  let action = await runBrowserAction(actionUrl);
  if (!action.ok && !blocked) {
    block = failureBlockKind(action);
    const alternate = args.alternateUrl?.trim() ?? '';
    let alternateParsed: URL | undefined;
    try { alternateParsed = new URL(alternate); } catch { /* no valid fallback */ }
    let alternateText: string | undefined;
    if (block && alternateParsed && ['http:', 'https:'].includes(alternateParsed.protocol)
      && decideActionBoundary({ hosts: persona.actionHosts, url: alternate, href: null }).allowed) {
      try { alternateText = await inspect(alternate, pagePort); } catch { /* unknown is allowed after an explicit login/paywall error */ }
    }
    if (block && alternateParsed && ['http:', 'https:'].includes(alternateParsed.protocol)
      && decideActionBoundary({ hosts: persona.actionHosts, url: alternate, href: null }).allowed
      && !blockedKind(alternateText)) {
      blocked = true;
      actionUrl = alternate;
      action = await runBrowserAction(actionUrl);
      detoured = true;
    } else if (block) {
      blocked = true;
    }
    if (block) {
      repairNode = createRepairNode({ block, sourceUrl: url, detourUrl: detoured ? alternate : '', outcome: detoured && action.ok ? 'detoured' : 'detour-failed', issueId, deps });
      recordRepairNode(repairNode, deps);
    }
  }
  if (block && !repairNode) {
    repairNode = createRepairNode({ block, sourceUrl: url, detourUrl: detoured ? actionUrl : '', outcome: detoured && action.ok ? 'detoured' : 'detour-failed', issueId, deps });
    recordRepairNode(repairNode, deps);
  }
  if (!action.ok) return { ok: false, blocked, detoured, ...(repairNode ? { repairNode } : {}), reason: action.reason, output: `브라우저 작업이 안전 경계에서 중단되었습니다: ${action.reason}` };

  let captureUrl: string | undefined;
  let attachmentId: string | undefined;
  const observedPath = (action.observed as unknown as { attachmentRef?: unknown } | undefined)?.attachmentRef;
  const capturePath = capturedPath ?? (typeof observedPath === 'string' ? observedPath : undefined);
  if (!capturePath || action.observed?.captureOutcome !== 'ok') {
    return { ok: false, reason: 'capture-missing', output: '브라우저 동작은 끝났지만 캡처 증거가 없어 Linear 첨부 완료로 처리하지 않았습니다.' };
  }
  const apiKey = await (deps.getApiKey ?? getSecretAsync)('connector.linear.apiKey');
  if (!apiKey?.trim()) return { ok: false, reason: 'linear-key-missing', output: '캡처는 생성했지만 Linear 키가 없어 서브태스크 첨부를 보류했습니다.' };
  const bytes = await (deps.readCapture ?? (async path => readFile(path)))(capturePath);
  captureUrl = await (deps.upload ?? uploadLinearFile)({ apiKey, filename: basename(capturePath), contentType: 'image/png', body: bytes });
  attachmentId = await (deps.attach ?? createLinearAttachment)({ apiKey, issueId, title: '브라우저 캡처', url: captureUrl });

  let selectionReflected = false;
  if (args.includeThisToo === true) {
    const text = args.selection?.text?.trim().slice(0, 3000) ?? '';
    const tab = args.selection?.tab?.trim().slice(0, 500) ?? '';
    if (!text && !tab) return { ok: false, reason: 'empty-selection', ...(captureUrl ? { captureUrl } : {}), ...(attachmentId ? { attachmentId } : {}), output: '선택 문장 또는 탭 정보가 없어 Linear 반영을 건너뛰었습니다.' };
    try {
      selectionReflected = deps.reflectSelection
        ? await deps.reflectSelection({
        issueId, body: `${SELECTION_COMMENT}: ${[tab, text].filter(Boolean).join(' — ')}`,
        })
        : await reflectSelectionWithLinearIssueTool({
          issueId, body: `${SELECTION_COMMENT}: ${[tab, text].filter(Boolean).join(' — ')}`,
        }, deps);
    } catch {
      return { ok: false, reason: 'linear-reflection-failed', ...(captureUrl ? { captureUrl } : {}), ...(attachmentId ? { attachmentId } : {}), output: '캡처는 첨부했지만 Linear 선택 반영에 실패했습니다.' };
    }
    if (!selectionReflected) return { ok: false, reason: 'linear-reflection-failed', ...(captureUrl ? { captureUrl } : {}), ...(attachmentId ? { attachmentId } : {}), output: '캡처는 첨부했지만 Linear 서브태스크 선택 반영이 실패했습니다.' };
  }

  return {
    ok: true,
    ...(captureUrl ? { captureUrl } : {}),
    ...(attachmentId ? { attachmentId } : {}),
    ...(args.includeThisToo === true ? { selectionReflected } : {}),
    blocked,
    detoured,
    ...(repairNode ? { repairNode } : {}),
    output: `브라우저 캡처를 Linear 서브태스크에 첨부했습니다${selectionReflected ? ' · 선택을 “이것도 반영”으로 기록했습니다' : ''}.`,
  };
}

export const browserHandRuntime: ToolRuntime<BrowserHandArgs, BrowserHandResult> = {
  id: 'browser_hand',
  spec: {
    name: 'BrowserHand',
    description: '사람이 armed 승인한 브라우저 요소 하나를 기존 harness browser-act 안전 경로로 조작·캡처하고, 캡처와 명시적 “이것도 반영” 선택을 지정한 Linear 서브태스크에 기록합니다. 로그인·페이월이면 허용된 대체 출처로 한 번 우회하고 기존 그래프 갈래에 수리 노드를 기록합니다. 메일 발송은 없습니다.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' }, target: { type: 'string', description: 'CSS selector of the element to click.' },
        armed: { type: 'boolean', description: 'Must be true only after explicit human approval.' },
        linearSubtaskId: { type: 'string', description: 'Linear issue UUID of the active subtask.' },
        alternateUrl: { type: 'string', description: '로그인·페이월 시 1회만 이동할 대체 출처. persona actionHosts에 포함되어야 합니다.' },
        persona: { type: 'string', description: '허용 호스트가 선언된 브라우저 페르소나 ID.' }, includeThisToo: { type: 'boolean' },
        selection: { type: 'object', properties: { text: { type: 'string' }, tab: { type: 'string' } }, additionalProperties: false },
      },
      required: ['url', 'target', 'armed', 'linearSubtaskId', 'persona'], additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const { result } = await coordinateBrowserRoundtrip({
      url: args.url,
      target: args.target,
      armed: args.armed,
      ...(args.persona ? { persona: args.persona } : {}),
      ...(args.alternateUrl ? { alternateUrl: args.alternateUrl } : {}),
      humanSelection: {
        linearSubtaskId: args.linearSubtaskId,
        ...(args.selection ? { selection: args.selection } : {}),
      },
      ...(args.includeThisToo === undefined ? {} : { includeThisToo: args.includeThisToo }),
    }, {}, dispatchBrowserHand, ctx);
    return result;
  },
};
