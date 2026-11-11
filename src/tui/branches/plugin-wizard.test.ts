import { expect, test } from 'bun:test';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../core/registry.js';
import { createFakeNexusPluginWizard } from '../../ux-sim/fake-nexus-plugin-wizard.js';
import { createPluginWizardConversation, createPluginWizardFlow, formatPluginWizardProposal, parsePluginWizardConfirmation } from './plugin-wizard.js';

test('natural plugin requests route to the wizard while ordinary prose stays chat', () => {
  const route = resolveNextTuiRoute('플러그인 만들어 줘', NEXT_TUI_INPUT_CONTEXT);
  expect(route?.id).toBe('plugin.wizard');
  expect(route?.branchHost).toBe('plugin-wizard');
  expect(route?.branchModule).toBe('./branches/plugin-wizard.js');
  expect(resolveNextTuiRoute('CSV를 내보내는 플러그인', NEXT_TUI_INPUT_CONTEXT)?.id).toBe('plugin.wizard');
  expect(resolveNextTuiRoute('플러그인 마법사에 대한 설명을 써 줘', NEXT_TUI_INPUT_CONTEXT)).toBeNull();
});

test('wizard proposal can be rendered and confirmation is explicit', async () => {
  const nexus = createFakeNexusPluginWizard();
  const conversation = createPluginWizardConversation({ baseUrl: 'http://nexus.test', token: 'test-token', fetch: nexus.fetch });
  const proposed = await conversation.propose('CSV를 내보내는 플러그인');
  expect(proposed.kind).toBe('proposal');
  if (proposed.kind !== 'proposal') return;
  expect(formatPluginWizardProposal(proposed.proposal).join('\n')).toContain('graph_id: csv-export');
  expect(formatPluginWizardProposal(proposed.proposal).join('\n')).toContain('이 플러그인 초안을 저장할까요?');
  expect(nexus.saved).toHaveLength(0);
  expect(parsePluginWizardConfirmation('아마 나중에')).toBeNull();
  expect(parsePluginWizardConfirmation('네')).toBe(true);
  expect(parsePluginWizardConfirmation('아니오')).toBe(false);
  const result = await conversation.confirmSave(parsePluginWizardConfirmation('네') === true);
  expect(result).toEqual({ kind: 'saved', id: 'csv-export' });
  expect(nexus.requests.map(({ path }) => path)).toEqual(['/v1/graphs/wizard', '/v1/graphs']);
  expect(nexus.saved).toHaveLength(1);
});

test('wizard does not save when approval is declined', async () => {
  const nexus = createFakeNexusPluginWizard();
  const conversation = createPluginWizardConversation({ baseUrl: 'http://nexus.test', token: 'test-token', fetch: nexus.fetch });
  await conversation.propose('CSV를 내보내는 플러그인');
  const result = await conversation.confirmSave(parsePluginWizardConfirmation('아니오') === true);
  expect(result).toEqual({ kind: 'declined' });
  expect(nexus.requests.map(({ path }) => path)).toEqual(['/v1/graphs/wizard']);
  expect(nexus.saved).toEqual([]);
});

test('ambiguous follow-up keeps the proposal pending and never saves', async () => {
  const nexus = createFakeNexusPluginWizard();
  const flow = createPluginWizardFlow({ baseUrl: 'http://nexus.test', token: 'test-token', fetch: nexus.fetch });
  expect((await flow.start('CSV를 내보내는 플러그인')).kind).toBe('proposal');
  expect(flow.proposal?.id).toBe('csv-export');
  expect(await flow.answer('잠깐 생각해 볼게')).toEqual({ kind: 'confirmation-required' });
  expect(flow.proposal?.id).toBe('csv-export');
  expect(nexus.requests.map(({ path }) => path)).toEqual(['/v1/graphs/wizard']);
  expect(nexus.saved).toEqual([]);
  expect(await flow.answer('네')).toEqual({ kind: 'saved', id: 'csv-export' });
  expect(flow.proposal).toBeNull();
  expect(nexus.saved).toHaveLength(1);
});

test('save failure keeps the approved draft available for retry or cancellation', async () => {
  const nexus = createFakeNexusPluginWizard();
  let failSave = true;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/graphs' && failSave) {
      failSave = false;
      return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
    }
    return nexus.fetch(input, init);
  }) as typeof fetch;
  const flow = createPluginWizardFlow({ baseUrl: 'http://nexus.test', fetch: mockFetch });
  expect((await flow.start('CSV를 내보내는 플러그인')).kind).toBe('proposal');

  const failed = await flow.answer('네');
  expect(failed).toMatchObject({ kind: 'error', message: expect.stringContaining('초안을 보존했습니다') });
  expect(flow.proposal?.id).toBe('csv-export');
  expect(await flow.answer('네')).toEqual({ kind: 'saved', id: 'csv-export' });
  expect(flow.proposal).toBeNull();
  expect(nexus.saved).toHaveLength(1);
});

test('save failure can be explicitly cancelled without another save attempt', async () => {
  let saveAttempts = 0;
  const nexus = createFakeNexusPluginWizard();
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/graphs') {
      saveAttempts += 1;
      return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
    }
    return nexus.fetch(input, init);
  }) as typeof fetch;
  const flow = createPluginWizardFlow({ baseUrl: 'http://nexus.test', fetch: mockFetch });
  expect((await flow.start('CSV를 내보내는 플러그인')).kind).toBe('proposal');
  expect((await flow.answer('네')).kind).toBe('error');
  expect(await flow.answer('아니오')).toEqual({ kind: 'declined' });
  expect(flow.proposal).toBeNull();
  expect(saveAttempts).toBe(1);
});
