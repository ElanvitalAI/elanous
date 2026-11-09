// Summary recap — printed pre-finish so the user can review every
// answer before the wizard writes config.json. PLAN §3.5 / β-followup.
//
// PR-Δ13 (Sprint 13 · 2026-04-28) re-designed the recap to use the
// Sprint 12 horizontal Yes/No widget for the save prompt, then a
// chooseFrom edit-step picker when the user opts to revise. The
// previous lenient text-input flow ("yes", "Y", "telegram-bot",
// section name prefix matching) was friendly to power users but
// invisible to first-timers and inconsistent with the rest of the
// wizard which uses chooseFrom for every other prompt. Switching to
// pickers makes the recap discoverable + visually consistent.
//
// The recap is a small declarative spec: per-section heading + key/
// value rows. Secrets are masked (`***`). The user can:
//   - press Y / Enter / pick "Yes" → wizard saves
//   - press N / pick "No" → secondary picker offers each section to
//     edit (or "Cancel — discard config")
//   - Esc / Ctrl-C → cancel
//
// We don't expose this as a separate slash — it's part of the wizard
// flow, called from `runOnboarding()` between the last askDiscord
// and saveUserConfig.

import type { UserConfig } from '../user-config/types.js';
import type { WizardIO } from '../onboarding.js';
import { chooseFrom, type ChoiceOption } from './io-extended.js';

const SECTIONS = ['llm', 'skills', 'obsidian', 'telegram', 'discord'] as const;
type SectionId = (typeof SECTIONS)[number];

export interface SummaryRecapResult {
  /** What the user wants to do next. */
  action: 'accept' | 'edit' | 'cancel';
  /** When `action === 'edit'`, the section the user picked. */
  editSection?: SectionId;
}

/** Show the recap + collect the user's decision. Pure-IO; the
 *  caller drives the side effect (re-running a step, cancelling,
 *  saving). */
export async function showSummaryRecap(
  io: WizardIO,
  cfg: UserConfig,
): Promise<SummaryRecapResult> {
  io.print('');
  io.print('━━━ Review setup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const llmTrail =
    cfg.llm.provider +
    (cfg.llm.model ? ` (${cfg.llm.model})` : '') +
    (cfg.llm.apiKey ? ' ✓ key' : '');
  io.print(`  [llm]      ${llmTrail}`);

  const dirsCount = cfg.skills.dirs.length;
  io.print(`  [skills]   ${cfg.skills.activeSet} — ${dirsCount} dir(s)`);

  io.print(`  [obsidian] ${cfg.obsidian.vault}`);

  if (cfg.telegram.enabled) {
    const tag = cfg.telegram.botToken ? ' ✓ token' : '';
    io.print(`  [telegram] enabled · ${cfg.telegram.allowedUsers.length} user(s)${tag}`);
  } else {
    io.print(`  [telegram] disabled`);
  }

  if (cfg.discord.enabled) {
    const tag = cfg.discord.botToken ? ' ✓ token' : '';
    io.print(`  [discord]  enabled · ${cfg.discord.allowedUsers.length} user(s)${tag}`);
  } else {
    io.print(`  [discord]  disabled`);
  }

  io.print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Save Y/N — uses the Sprint 12 horizontal radio when fullScreenIO
  // is wired; falls back to numbered picker for scriptedIO/realIO.
  const save = await chooseFrom(
    io,
    'Save and finish?',
    [
      { key: 'y', label: 'Yes', value: true as const },
      { key: 'n', label: 'No', value: false as const },
    ],
    { defaultIndex: 0 },
  );
  if (save) {
    io.print('HQ connect (optional): `eln logs federate connect <instance> <HQ URL> <mode-0600 token file> --consent`');
    io.print('No logs are sent until this explicit consent command is run.');
    return { action: 'accept' };
  }

  // No → present an explicit edit picker. Cancel ("c") is the last
  // option so the default index stays on a benign first option (llm).
  type EditValue = SectionId | '__cancel__';
  const editOptions: ChoiceOption<EditValue>[] = [
    { key: '1', label: 'LLM provider', value: 'llm' },
    { key: '2', label: 'Skills', value: 'skills' },
    { key: '3', label: 'Obsidian vault', value: 'obsidian' },
    { key: '4', label: 'Telegram bot', value: 'telegram' },
    { key: '5', label: 'Discord bot', value: 'discord' },
    { key: 'c', label: 'Cancel — discard config', value: '__cancel__' },
  ];
  const pick = await chooseFrom(io, 'Edit which section?', editOptions, { defaultIndex: 0 });
  if (pick === '__cancel__') {
    return { action: 'cancel' };
  }
  return { action: 'edit', editSection: pick };
}
