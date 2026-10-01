import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';

import { createNexusClient, type NexusClient } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { ChannelBotSetupCard } from '@/components/settings/ChannelBotSetupCard';
import { ObsidianSkillsCard } from '@/components/settings/ObsidianSkillsCard';
import { recommendedSetup } from '../../../../../../src/cli/setup-recommend';
import { SetupNextSteps, SetupRecommendations } from './SetupNextSteps';

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

test('recommendations match the CLI for current true and false values without a smart line', async () => {
  for (const fastPath of [true, false]) {
    const configClient = { getChatFastPath: async () => ({ enabled: fastPath }) } as unknown as NexusClient;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<NexusProvider client={configClient}><SetupRecommendations /></NexusProvider>); });
    const section = tree.root.findByProps({ 'data-testid': 'setup-recommendations' });
    expect(section.findAllByType('p').map(p => p.props.children)).toEqual(recommendedSetup({ chat: { fastPath } }));
    const html = JSON.stringify(tree.toJSON());
    expect(html).toContain('elanous doctor --fix --yes');
    expect(html).toContain(`chat.fastPath=${fastPath}`);
    expect(html).toContain(`elanous config set chat.fastPath ${!fastPath}`); // 켜져 있으면 끄기 · 꺼져 있으면 켜기
    expect(html).not.toContain('smart');
    await act(async () => { tree.unmount(); });
  }
});

test('recommendations read the dedicated fastPath snapshot rather than the redacted Nexus config', async () => {
  const paths: string[] = [];
  const fetchImpl = Object.assign(async (input: RequestInfo | URL) => {
    paths.push(String(input));
    return new Response(JSON.stringify({ enabled: true }), { status: 200 });
  }, { preconnect: () => {} });
  const configClient = createNexusClient({ baseUrl: 'http://localhost', fetchImpl });
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<NexusProvider client={configClient}><SetupRecommendations /></NexusProvider>); });
  expect(paths).toEqual(['http://localhost/v1/config/chat-fast-path']);
  expect(JSON.stringify(tree.toJSON())).toContain('chat.fastPath=true');
  await act(async () => { tree.unmount(); });
});

test('unavailable config does not pretend fastPath is false', async () => {
  const configClient = { getChatFastPath: async () => ({ enabled: undefined }) } as unknown as NexusClient;
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<NexusProvider client={configClient}><SetupRecommendations /></NexusProvider>); });
  const html = JSON.stringify(tree.toJSON());
  expect(html).toContain('chat.fastPath 값을 읽을 수 없습니다');
  expect(html).not.toContain('chat.fastPath=false');
  await act(async () => { tree.unmount(); });
});

test('closed steps prerender without a daemon provider', () => {
  const html = renderToStaticMarkup(<SetupNextSteps />);
  expect(html).toContain('다음 셋업(선택)');
  expect(html).not.toContain('channel-bot-setup-card');
  expect(html).not.toContain('obsidian-skills-card');
});
