import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { ChannelBotSetupCard, type ChannelBotCardClient } from './ChannelBotSetupCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('saving before status loads does not erase the existing allowlist', async () => {
  let resolveStatus!: (value: Awaited<ReturnType<ChannelBotCardClient['getChannelBots']>>) => void;
  const calls: unknown[] = [];
  const client: ChannelBotCardClient = {
    getChannelBots: () => new Promise(resolve => { resolveStatus = resolve; }),
    setChannelBot: async body => { calls.push(body); return { ok: true, restartNeeded: true }; },
  };
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(ChannelBotSetupCard as (props: { client: ChannelBotCardClient }) => ReturnType<typeof ChannelBotSetupCard>, { client })); });
  const input = tree!.root.findByProps({ id: 'telegram-bot-token' });
  await act(async () => { input.props.onChange({ target: { value: 'private-token' } }); });
  const button = tree!.root.findAllByType('button').find(node => node.props.children === '확인하고 저장');
  await act(async () => { button!.props.onClick(); });
  expect(calls).toEqual([{ platform: 'telegram', token: 'private-token' }]);
  expect(tree!.root.findByProps({ id: 'telegram-bot-token' }).props.value).toBe('');
  await act(async () => { resolveStatus({ platforms: [
    { platform: 'telegram', configured: true, source: 'tokenRef', allowedUsers: ['19'] },
    { platform: 'discord', configured: false, source: null, allowedUsers: [] },
  ] }); });
  act(() => { tree!.unmount(); });
});

test('a delayed status response preserves an in-progress allowlist edit when saved', async () => {
  let resolveStatus!: (value: Awaited<ReturnType<ChannelBotCardClient['getChannelBots']>>) => void;
  const calls: unknown[] = [];
  const snapshot = { platforms: [
    { platform: 'telegram' as const, configured: true, source: 'tokenRef' as const, allowedUsers: ['19'] },
    { platform: 'discord' as const, configured: false, source: null, allowedUsers: [] },
  ] };
  let first = true;
  const client: ChannelBotCardClient = {
    getChannelBots: () => {
      if (!first) return Promise.resolve(snapshot);
      first = false;
      return new Promise(resolve => { resolveStatus = resolve; });
    },
    setChannelBot: async body => { calls.push(body); return { ok: true, restartNeeded: true }; },
  };
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(ChannelBotSetupCard as (props: { client: ChannelBotCardClient }) => ReturnType<typeof ChannelBotSetupCard>, { client })); });
  const input = () => tree!.root.findByProps({ id: 'telegram-allowed-users' });
  await act(async () => { input().props.onChange({ target: { value: '42, 43' } }); });
  await act(async () => { resolveStatus(snapshot); });
  expect(input().props.value).toBe('42, 43');
  const button = tree!.root.findAllByType('button').find(node => node.props.children === '확인하고 저장');
  await act(async () => { button!.props.onClick(); });
  expect(calls).toEqual([{ platform: 'telegram', allowedUsers: ['42', '43'] }]);
  act(() => { tree!.unmount(); });
});

test('a failed status request cannot turn an unknown allowlist into an empty update', async () => {
  const calls: unknown[] = [];
  const client: ChannelBotCardClient = {
    getChannelBots: async () => { throw new Error('status unavailable'); },
    setChannelBot: async body => { calls.push(body); return { ok: true, restartNeeded: true }; },
  };
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(ChannelBotSetupCard as (props: { client: ChannelBotCardClient }) => ReturnType<typeof ChannelBotSetupCard>, { client })); });
  await act(async () => { tree!.root.findByProps({ id: 'discord-bot-token' }).props.onChange({ target: { value: 'private-token' } }); });
  const button = tree!.root.findAllByType('button').filter(node => node.props.children === '확인하고 저장')[1];
  await act(async () => { button!.props.onClick(); });
  expect(calls).toEqual([{ platform: 'discord', token: 'private-token' }]);
  expect(tree!.root.findByProps({ id: 'discord-bot-token' }).props.value).toBe('');
  act(() => { tree!.unmount(); });
});

test('submitting a masked token clears its input and renders the bot name and restart guidance', async () => {
  const calls: unknown[] = [];
  const client: ChannelBotCardClient = {
    getChannelBots: async () => ({ platforms: [
      { platform: 'telegram', configured: true, source: 'tokenRef', allowedUsers: ['19'] },
      { platform: 'discord', configured: false, source: null, allowedUsers: [] },
    ] }),
    setChannelBot: async body => {
      calls.push(body);
      return { ok: true, botName: 'test_bot', restartNeeded: true };
    },
  };
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(ChannelBotSetupCard as (props: { client: ChannelBotCardClient }) => ReturnType<typeof ChannelBotSetupCard>, { client })); });
  const input = () => tree!.root.findByProps({ id: 'telegram-bot-token' });
  expect(input().props.type).toBe('password');
  await act(async () => { input().props.onChange({ target: { value: 'private-token' } }); });
  expect(input().props.value).toBe('private-token');
  const button = tree!.root.findAllByType('button').find(node => node.props.children === '확인하고 저장');
  expect(button).toBeDefined();
  await act(async () => { button!.props.onClick(); });
  expect(calls).toEqual([{ platform: 'telegram', token: 'private-token', allowedUsers: ['19'] }]);
  expect(input().props.value).toBe('');
  const text = JSON.stringify(tree!.toJSON());
  expect(tree!.root.findAllByType('p').map(node => node.children.join(''))).toContain('봇 이름: test_bot');
  expect(text).toContain('봇을 재시작해야 반영됩니다');
  expect(text).not.toContain('private-token');
  act(() => { tree!.unmount(); });
});
