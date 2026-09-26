import { expect, test } from 'bun:test';
import { reconcileSetupDraft } from './ObsidianSkillsCard';

const server = {
  obsidian: { vault: '/saved-vault', exists: true, looksLikeVault: true },
  skills: { activeSet: 'codex', dirs: ['/saved-skills'], presets: [] },
};

test('saving vault preserves unsaved custom skills selection and directory input', () => {
  const draft = { vault: '/draft-vault', selection: 'custom', dirs: '/draft-skills\n/other-skills' };
  expect(reconcileSetupDraft(draft, server, 'vault')).toEqual({
    vault: '/saved-vault', selection: 'custom', dirs: '/draft-skills\n/other-skills',
  });
});

test('saving skills preserves unsaved vault input', () => {
  const draft = { vault: '/draft-vault', selection: 'custom', dirs: '/draft-skills' };
  expect(reconcileSetupDraft(draft, server, 'skills')).toEqual({
    vault: '/draft-vault', selection: 'codex', dirs: '/saved-skills',
  });
});

test('explicit refresh rehydrates both areas from server', () => {
  expect(reconcileSetupDraft({ vault: '/draft-vault', selection: 'custom', dirs: '/draft-skills' }, server, 'all'))
    .toEqual({ vault: '/saved-vault', selection: 'codex', dirs: '/saved-skills' });
});
