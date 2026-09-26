import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';

import type { NexusClient } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { ChannelBotSetupCard } from '@/components/settings/ChannelBotSetupCard';
import { ObsidianSkillsCard } from '@/components/settings/ObsidianSkillsCard';
import { SetupNextSteps } from './SetupNextSteps';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const client = {
  getChannelBots: async () => ({ platforms: [] }),
  getObsidianSkills: async () => ({
    obsidian: { vault: '', exists: false, looksLikeVault: false },
    skills: { activeSet: 'custom', dirs: [], presets: [] },
  }),
} as unknown as NexusClient;

test('both optional steps start collapsed; opening and postponing each mounts and unmounts its original card', async () => {
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<NexusProvider client={client}><SetupNextSteps /></NexusProvider>); });
  const steps = tree.root.findByProps({ 'data-testid': 'setup-next-steps' });
  const buttons = () => steps.findAllByType('button');
  expect(steps.findAllByType(ChannelBotSetupCard)).toHaveLength(0);
  expect(steps.findAllByType(ObsidianSkillsCard)).toHaveLength(0);
  expect(buttons().filter(button => button.props['aria-expanded'] === false)).toHaveLength(2);

  await act(async () => { buttons().find(button => button.props.children === '텔레그램·디스코드 봇 연결')!.props.onClick(); });
  expect(steps.findAllByType(ChannelBotSetupCard)).toHaveLength(1);
  expect(steps.findByProps({ 'data-testid': 'channel-bot-setup-card' })).toBeDefined();
  expect(steps.findAllByType(ObsidianSkillsCard)).toHaveLength(0);
  await act(async () => { buttons().find(button => button.props.children === '나중에')!.props.onClick(); });
  expect(steps.findAllByType(ChannelBotSetupCard)).toHaveLength(0);

  await act(async () => { buttons().find(button => button.props.children === 'Obsidian 볼트·스킬 폴더')!.props.onClick(); });
  expect(steps.findAllByType(ObsidianSkillsCard)).toHaveLength(1);
  expect(steps.findByProps({ 'data-testid': 'obsidian-skills-card' })).toBeDefined();
  await act(async () => { buttons().find(button => button.props.children === '나중에')!.props.onClick(); });
  expect(steps.findAllByType(ObsidianSkillsCard)).toHaveLength(0);
  await act(async () => { tree.unmount(); });
});

test('closed steps prerender without a daemon provider', () => {
  const html = renderToStaticMarkup(<SetupNextSteps />);
  expect(html).toContain('다음 셋업(선택)');
  expect(html).not.toContain('channel-bot-setup-card');
  expect(html).not.toContain('obsidian-skills-card');
});
