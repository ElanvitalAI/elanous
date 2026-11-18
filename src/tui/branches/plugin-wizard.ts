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
export const CLASSIC_PLUGIN_WIZARD_NOTICE = 'Plugin wizard is supported in the next TUI.';
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
    `Draft: ${proposal.summary}`,
    proposal.yaml,
    'Save this plugin draft? Answer "yes" or "no".',
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
      if (!conversation || !proposal) return { kind: 'error', message: 'No plugin draft to save.' };
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
  if (!baseUrl) throw new Error('Nexus is not running. Start the test-universe nexus first.');
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
    throw new Error('Cannot connect to nexus.');
  }
  let parsed: unknown;
  try { parsed = await response.json(); }
  catch { throw new Error(`Could not read nexus response (HTTP ${response.status}).`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid nexus response format.');
  return { status: response.status, body: parsed as Record<string, unknown> };
}

/** A conversation-scoped adapter: proposal generation never saves; only an explicit yes calls POST /v1/graphs. */
export function createPluginWizardConversation(deps: PluginWizardDeps = {}) {
  let pending: GraphWizardProposal | null = null;

  return {
    async propose(prompt: string): Promise<PluginWizardTurn> {
      pending = null;
      const trimmed = prompt.trim();
      if (!trimmed) return { kind: 'error', message: 'Enter a description of the plugin to create.' };
      try {
        const response = await postJson('/v1/graphs/wizard', { prompt: trimmed }, deps);
        const { status, body } = response;
        if (status < 200 || status >= 300 || body.ok !== true
            || typeof body.id !== 'string' || typeof body.yaml !== 'string' || typeof body.summary !== 'string') {
          return { kind: 'error', message: 'Could not create the plugin draft. Try again with a different description.' };
        }
        pending = { id: body.id, yaml: body.yaml, summary: body.summary };
        return { kind: 'proposal', proposal: pending };
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : 'Could not create the plugin draft.' };
      }
    },

    async confirmSave(approved: boolean): Promise<PluginWizardTurn> {
      const proposal = pending;
      if (!proposal) return { kind: 'error', message: 'No plugin draft to save.' };
      if (!approved) {
        pending = null;
        return { kind: 'declined' };
      }
      try {
        const { status, body } = await postJson('/v1/graphs', { id: proposal.id, yaml: proposal.yaml }, deps);
        if (status !== 201 || body.saved !== true || body.id !== proposal.id) {
          return { kind: 'error', message: `Save failed (HTTP ${status}). Draft preserved. Retry or answer "no" to cancel.` };
        }
        pending = null;
        return { kind: 'saved', id: proposal.id };
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : 'Save failed.' };
      }
    },

    get hasPendingProposal(): boolean { return pending !== null; },
  };
}
