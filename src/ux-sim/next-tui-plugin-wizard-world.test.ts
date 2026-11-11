import { expect, test } from 'bun:test';
import { createPluginWizardConversation } from '../tui/branches/plugin-wizard.js';
import { createFakeNexusPluginWizard } from './fake-nexus-plugin-wizard.js';
import { runNextTuiPluginWizardWorld } from './next-tui-plugin-wizard-world.js';

test('next-tui-plugin-wizard: phrase routes to fake Nexus proposal and saves only after explicit confirmation', async () => {
  const receipt = await runNextTuiPluginWizardWorld('CSV를 내보내는 플러그인');
  expect(receipt.routeId).toBe('plugin.wizard');
  expect(receipt.confirmationText).toBe('네');
  expect(receipt.proposal).toMatchObject({
    kind: 'proposal',
    proposal: { id: 'csv-export', summary: 'CSV 내보내기 · 입력을 받아 파일로 내보냅니다.' },
  });
  expect(receipt.beforeConfirmationSaves).toBe(0);
  expect(receipt.ambiguousConfirmation).toEqual({ kind: 'confirmation-required' });
  expect(receipt.requests).toEqual([
    { method: 'POST', path: '/v1/graphs/wizard', body: { prompt: 'CSV를 내보내는 플러그인' } },
    { method: 'POST', path: '/v1/graphs', body: { id: 'csv-export', yaml: expect.stringContaining('graph_id: csv-export') } },
  ]);
  expect(receipt.savedGraphs).toEqual([{ id: 'csv-export', yaml: expect.stringContaining('graph_id: csv-export') }]);
  expect(receipt.saved).toEqual({ kind: 'saved', id: 'csv-export' });
});

test('next-tui-plugin-wizard: declining the proposal never calls graph save', async () => {
  const nexus = createFakeNexusPluginWizard();
  const wizard = createPluginWizardConversation({ baseUrl: 'http://nexus.test', fetch: nexus.fetch });
  expect((await wizard.propose('파일 정리 플러그인')).kind).toBe('proposal');
  expect(await wizard.confirmSave(false)).toEqual({ kind: 'declined' });
  expect(nexus.requests.map(({ path }) => path)).toEqual(['/v1/graphs/wizard']);
  expect(nexus.saved).toEqual([]);
});
