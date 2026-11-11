import { createFakeNexusPluginWizard } from './fake-nexus-plugin-wizard.js';
import { createPluginWizardFlow, type PluginWizardFlowTurn } from '../tui/branches/plugin-wizard.js';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../tui/core/registry.js';

export interface NextTuiPluginWizardReceipt {
  readonly routeId: string | null;
  readonly proposal: PluginWizardFlowTurn;
  readonly beforeConfirmationSaves: number;
  readonly ambiguousConfirmation: PluginWizardFlowTurn;
  readonly confirmationText: string;
  readonly saved: PluginWizardFlowTurn;
  readonly requests: Array<{ method: string; path: string; body: unknown }>;
  readonly savedGraphs: Array<{ id: string; yaml: string }>;
}

/** Fake Nexus response proves that proposal and persistence are separate production-client calls. */
export async function runNextTuiPluginWizardWorld(prompt = 'CSV를 내보내는 플러그인'): Promise<NextTuiPluginWizardReceipt> {
  const nexus = createFakeNexusPluginWizard();
  const wizard = createPluginWizardFlow({ baseUrl: 'http://nexus.test', token: 'fixture-token', fetch: nexus.fetch });
  const routeId = resolveNextTuiRoute(prompt, NEXT_TUI_INPUT_CONTEXT)?.id ?? null;
  const proposal = await wizard.start(prompt);
  const beforeConfirmationSaves = nexus.saved.length;
  const ambiguousConfirmation = await wizard.answer('생각해 볼게요');
  const confirmationText = '네';
  const saved = await wizard.answer(confirmationText);
  return { routeId, proposal, beforeConfirmationSaves, ambiguousConfirmation, confirmationText, saved, requests: nexus.requests, savedGraphs: nexus.saved };
}
