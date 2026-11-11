import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { resolveDaemonEndpoint } from '../../nexus/daemon-endpoint.js';

export interface GraphWizardProposal {
  readonly id: string;
  readonly yaml: string;
  readonly summary: string;
}

/** Classic dashboard has no branch host for the next-TUI wizard yet. */
export const CLASSIC_PLUGIN_WIZARD_NOTICE = '플러그인 마법사는 next TUI에서 지원합니다.';
export interface PluginWizardDeps {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
}

export type PluginWizardTurn =
  | { readonly kind: 'proposal'; readonly proposal: GraphWizardProposal }
  | { readonly kind: 'saved'; readonly id: string }
  | { readonly kind: 'declined' }
  | { readonly kind: 'error'; readonly message: string };

export function formatPluginWizardProposal(proposal: GraphWizardProposal): readonly string[] {
  return [
    `초안: ${proposal.summary}`,
    proposal.yaml,
    '이 플러그인 초안을 저장할까요? “네” 또는 “아니오”로 답해 주세요.',
  ];
}

export function parsePluginWizardConfirmation(input: string): boolean | null {
  const normalized = input.trim().toLocaleLowerCase();
  if (/^(네|예|응|저장|저장해|저장해 줘|저장해줘|yes|y)$/u.test(normalized)) return true;
  if (/^(아니오|아니요|아니|취소|저장 안 함|저장하지 마|no|n)$/u.test(normalized)) return false;
  return null;
}

export type PluginWizardFlowTurn = PluginWizardTurn | { readonly kind: 'confirmation-required' };

/** UI-facing state machine: ambiguous input never reaches the save endpoint. */
export function createPluginWizardFlow(deps: PluginWizardDeps = {}) {
  let conversation: ReturnType<typeof createPluginWizardConversation> | null = null;
  let proposal: GraphWizardProposal | null = null;

  return {
    async start(prompt: string): Promise<PluginWizardFlowTurn> {
      proposal = null;
      conversation = createPluginWizardConversation(deps);
      const result = await conversation.propose(prompt);
      if (result.kind === 'proposal') proposal = result.proposal;
      return result;
    },

    async answer(input: string): Promise<PluginWizardFlowTurn> {
      if (!conversation || !proposal) return { kind: 'error', message: '저장할 플러그인 초안이 없습니다.' };
      const approved = parsePluginWizardConfirmation(input);
      if (approved === null) return { kind: 'confirmation-required' };
      const active = conversation;
      const result = await active.confirmSave(approved);
      // Keep the approved draft visible and retryable when Nexus did not save it.
      if (result.kind !== 'error') {
        conversation = null;
        proposal = null;
      }
      return result;
    },

    get proposal(): GraphWizardProposal | null { return proposal; },
  };
}

function nexusAuth(deps: PluginWizardDeps): { baseUrl: string; token?: string; fetch: typeof fetch } {
  const baseUrl = deps.baseUrl ?? resolveDaemonEndpoint({ purpose: 'write' })?.baseUrl;
  if (!baseUrl) throw new Error('넥서스가 안 떠 있습니다. test 우주 넥서스를 먼저 실행하세요.');
  let token = deps.token;
  if (token === undefined) {
    try { token = readFileSync(join(getElanousConfigDir(), 'acp-token'), 'utf8').trim() || undefined; }
    catch { token = undefined; }
  }
  return { baseUrl, ...(token ? { token } : {}), fetch: deps.fetch ?? fetch };
}

async function postJson(path: string, body: unknown, deps: PluginWizardDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const auth = nexusAuth(deps);
  let response: Response;
  try {
    response = await auth.fetch(`${auth.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('넥서스에 연결할 수 없습니다.');
  }
  let parsed: unknown;
  try { parsed = await response.json(); }
  catch { throw new Error(`넥서스 응답을 읽지 못했습니다 (HTTP ${response.status}).`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('넥서스 응답 형식이 올바르지 않습니다.');
  return { status: response.status, body: parsed as Record<string, unknown> };
}

/** A conversation-scoped adapter: proposal generation never saves; only an explicit yes calls POST /v1/graphs. */
export function createPluginWizardConversation(deps: PluginWizardDeps = {}) {
  let pending: GraphWizardProposal | null = null;

  return {
    async propose(prompt: string): Promise<PluginWizardTurn> {
      pending = null;
      const trimmed = prompt.trim();
      if (!trimmed) return { kind: 'error', message: '만들 플러그인 설명을 입력해 주세요.' };
      try {
        const response = await postJson('/v1/graphs/wizard', { prompt: trimmed }, deps);
        const { status, body } = response;
        if (status < 200 || status >= 300 || body.ok !== true
            || typeof body.id !== 'string' || typeof body.yaml !== 'string' || typeof body.summary !== 'string') {
          return { kind: 'error', message: '플러그인 초안을 만들지 못했습니다. 설명을 바꾸어 다시 시도해 주세요.' };
        }
        pending = { id: body.id, yaml: body.yaml, summary: body.summary };
        return { kind: 'proposal', proposal: pending };
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : '플러그인 초안을 만들지 못했습니다.' };
      }
    },

    async confirmSave(approved: boolean): Promise<PluginWizardTurn> {
      const proposal = pending;
      if (!proposal) return { kind: 'error', message: '저장할 플러그인 초안이 없습니다.' };
      if (!approved) {
        pending = null;
        return { kind: 'declined' };
      }
      try {
        const { status, body } = await postJson('/v1/graphs', { id: proposal.id, yaml: proposal.yaml }, deps);
        if (status !== 201 || body.saved !== true || body.id !== proposal.id) {
          return { kind: 'error', message: `저장하지 못했습니다 (HTTP ${status}). 초안을 보존했습니다. 다시 시도하거나 “아니오”로 취소하세요.` };
        }
        pending = null;
        return { kind: 'saved', id: proposal.id };
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : '저장하지 못했습니다.' };
      }
    },

    get hasPendingProposal(): boolean { return pending !== null; },
  };
}
