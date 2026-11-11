import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeTelegramOutbound } from '../../ux-sim/fake-telegram-outbound.js';
import { getUserConfig, resetUserConfig, setUserConfigOverlay } from '../../user-config.js';
import { resolveReportTarget } from '../../telegram-report.js';
import { debug } from '../../debug/log.js';
import { runGraph } from '../runner.js';
import type { InProcessHandlerContext } from '../in-process-registry.js';
import { createNotifyCapabilityProvider, createNotifyCapabilityRegistry, NOTIFY_CHANNEL_CONTRACT, notifyCapabilityProviders, toNotifyOutboundMessage } from './notify.js';

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const originalStateDir = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  setUserConfigOverlay(null);
  resetUserConfig();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(input: unknown): InProcessHandlerContext {
  return { graphId: 'notify-sim', runId: 'run-1', nodeId: 'notify', input, outputs: {} };
}

function graph(root: string, input: unknown, requiredContract?: string, nodeInput: unknown = input): string {
  const path = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(path, `graph_id: notify-sim\nversion: 1\nentry_node: notify\nterminal_nodes: [done, failed]\nnodes:\n  - node_id: notify\n    kind: capability\n    recipe: ${requiredContract ? 'none' : 'cap:notify'}\n    ${requiredContract ? `requires: ${requiredContract}\n    ` : ''}max_visits: 1\n    input: ${JSON.stringify(nodeInput)}\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: notify, on: outcome, map: { done: done, failed: failed } }\n`);
  return path;
}

describe('notify capability provider', () => {
  test('validates and invokes with the same node-scoped payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-node-input-sim-'));
    roots.push(root);
    const globalInput = { unrelated: true };
    const nodeInput = { text: 'node-scoped message', refId: 'brief-node' };
    let sentText = '';
    let providerInput: unknown;
    const state = await runGraph(graph(root, globalInput, 'notify.channel@1', nodeInput), {
      input: globalInput, quiet: true, deps: { root: join(root, 'state'), capabilityProviders: createNotifyCapabilityRegistry((message, context) => {
        sentText = message.text;
        providerInput = context.input;
        return true;
      }) },
    });
    expect(state.status).toBe('done');
    expect(sentText).toBe(nodeInput.text);
    expect(providerInput).toEqual(nodeInput);
  });

  test('only forwards an explicit dedup key while refId remains the action target', () => {
    expect(toNotifyOutboundMessage({ text: 'Brief', refId: 'brief-1', actions: [{ id: 'suggest_accept', label: 'OK' }] }))
      .toMatchObject({ buttons: [{ label: 'OK', value: 'suggest_accept:brief-1' }] });
    expect(toNotifyOutboundMessage({ text: 'Brief', refId: 'brief-1', dedupKey: 'briefing:brief-1' })?.dedupKey).toBe('briefing:brief-1');
  });

  test('keeps same-text notifications for different targets distinct without using refId alone', () => {
    const first = toNotifyOutboundMessage({ text: 'Brief', refId: 'brief-1' })?.dedupKey;
    const repeated = toNotifyOutboundMessage({ text: 'Brief', refId: 'brief-1' })?.dedupKey;
    const second = toNotifyOutboundMessage({ text: 'Brief', refId: 'brief-2' })?.dedupKey;
    const updated = toNotifyOutboundMessage({ text: 'Updated brief', refId: 'brief-1' })?.dedupKey;
    expect(first).toBe(repeated);
    expect(first).not.toBe(second);
    expect(first).not.toBe(updated);
    expect(first).not.toBe('brief-1');
  });

  test('includes action metadata in the default target-scoped dedup identity', () => {
    const first = toNotifyOutboundMessage({ text: 'Brief', refId: 'brief-1', actions: [{ id: 'open', label: 'Open' }] })?.dedupKey;
    const changedId = toNotifyOutboundMessage({ text: 'Brief', refId: 'brief-1', actions: [{ id: 'accept', label: 'Open' }] })?.dedupKey;
    const changedLabel = toNotifyOutboundMessage({ text: 'Brief', refId: 'brief-1', actions: [{ id: 'open', label: 'Review' }] })?.dedupKey;
    expect(first).not.toBe(changedId);
    expect(first).not.toBe(changedLabel);
  });

  test('runGraph injects the provider map and forwards the message through its transport boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-capability-sim-'));
    roots.push(root);
    const fake = createFakeTelegramOutbound();
    let observedOwner: unknown;
    const providers = createNotifyCapabilityRegistry((message, context) => {
      observedOwner = (context.input as Record<string, unknown>).memberId;
      return fake.send(message);
    });
    const input = {
      memberId: 'member-a', text: 'Graph complete', kind: 'graph', refId: 'proposal-1', dedupKey: 'briefing:proposal-1',
      actions: [{ id: 'suggest_accept', label: 'OK' }],
    };
    const state = await runGraph(graph(root, input, 'notify.channel@1'), {
      input, quiet: true, deps: { root: join(root, 'state'), capabilityProviders: providers },
    });
    expect(state.status).toBe('done');
    expect(JSON.parse(state.nodes[0]!.output as string)).toMatchObject({ outcome: 'done', evidence: { delivered: true } });
    expect(observedOwner).toBe('member-a');
    expect(fake.calls()).toBe(1);
    expect(fake.receipts()).toEqual([{
      text: input.text, kind: input.kind, refId: input.refId, dedupKey: input.dedupKey,
      actions: input.actions, buttons: [],
    }]);
  });

  test('runGraph default provider reaches the Telegram router and reports confirmed delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-router-sim-'));
    roots.push(root);
    process.env.ELANOUS_STATE_DIR = join(root, 'state');
    setUserConfigOverlay((config) => ({
      ...config,
      telegram: { ...config.telegram, enabled: true, botToken: '123:test-token', homeChannel: 77 },
      raw: { ...config.raw, outbound: { channels: [{ type: 'telegram' }], routes: { notify: ['telegram'] } } },
    }));
    expect(resolveReportTarget(getUserConfig(), 'notify')).toEqual({ botToken: '123:test-token', chatId: 77 });
    const reportEvents: Array<{ event: string; data: unknown }> = [];
    const off = debug.registerSink({ name: 'notify-router-integration', emit: (record) => {
      if (record.category === 'telegram.report') reportEvents.push({ event: record.event, data: record.data });
    } });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ ok: true, result: { message_id: 41 } });
    }) as typeof fetch);
    const input = {
      text: 'Proposal ready', kind: 'notify', refId: 'proposal-7', dedupKey: 'proposal:7',
      actions: [{ id: 'suggest_accept', label: 'OK' }],
    };
    try {
      const state = await runGraph(graph(root, input), {
        input, quiet: true, deps: { root: join(root, 'graph-state'), capabilityProviders: notifyCapabilityProviders },
      });
      expect(reportEvents).toEqual([{ event: 'sent', data: expect.objectContaining({ kind: 'notify' }) }]);
      expect(state.status).toBe('done');
      expect(JSON.parse(state.nodes[0]!.output as string)).toMatchObject({ outcome: 'done', result: { delivered: true } });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toContain('/bot123:test-token/sendMessage');
      expect(requests[0]!.body).toMatchObject({ chat_id: 77, text: input.text, reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: 'suggest_accept:proposal-7' }]] } });
    } finally { fetchSpy.mockRestore(); off(); }
  });

  test('runGraph default provider fails closed when Telegram delivery is unconfirmed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-router-failure-sim-'));
    roots.push(root);
    process.env.ELANOUS_STATE_DIR = join(root, 'state');
    setUserConfigOverlay((config) => ({
      ...config,
      telegram: { ...config.telegram, enabled: true, botToken: '123:test-token', homeChannel: 77 },
      raw: { ...config.raw, outbound: { channels: [{ type: 'telegram' }], routes: { notify: ['telegram'] } } },
    }));
    let requests = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      requests += 1;
      return Response.json({ ok: true, result: {} });
    }) as typeof fetch);
    const input = { text: 'Proposal ready', kind: 'notify', dedupKey: 'proposal:unconfirmed' };
    try {
      const state = await runGraph(graph(root, input), {
        input, quiet: true, deps: { root: join(root, 'graph-state'), capabilityProviders: notifyCapabilityProviders },
      });
      expect(state.status).toBe('failed');
      expect(state.path).toEqual(['notify', 'failed']);
      expect(requests).toBe(1);
    } finally { fetchSpy.mockRestore(); }
  });

  test('runGraph router sends changed actions again for the same target and text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-router-actions-sim-'));
    roots.push(root);
    process.env.ELANOUS_STATE_DIR = join(root, 'state');
    setUserConfigOverlay((config) => ({
      ...config,
      telegram: { ...config.telegram, enabled: true, botToken: '123:test-token', homeChannel: 77 },
      raw: { ...config.raw, outbound: { channels: [{ type: 'telegram' }], routes: { notify: ['telegram'] } } },
    }));
    const requests: Array<{ body: Record<string, unknown> }> = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ ok: true, result: { message_id: 51 + requests.length } });
    }) as typeof fetch);
    try {
      for (const action of [
        { id: 'suggest_accept', label: 'OK' },
        { id: 'suggest_review', label: 'Review' },
      ]) {
        const input = { text: 'Proposal ready', kind: 'notify', refId: 'proposal-7', actions: [action] };
        const state = await runGraph(graph(root, input), {
          input, quiet: true, deps: { root: join(root, 'graph-state'), capabilityProviders: notifyCapabilityProviders },
        });
        expect(state.status).toBe('done');
      }
      expect(requests).toHaveLength(2);
      expect(requests.map(({ body }) => (body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data))
        .toEqual(['suggest_accept:proposal-7', 'suggest_review:proposal-7']);
    } finally { fetchSpy.mockRestore(); }
  });

  test('runGraph router sends identical text and actions to distinct refId targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-router-targets-sim-'));
    roots.push(root);
    process.env.ELANOUS_STATE_DIR = join(root, 'state');
    setUserConfigOverlay((config) => ({
      ...config,
      telegram: { ...config.telegram, enabled: true, botToken: '123:test-token', homeChannel: 77 },
      raw: { ...config.raw, outbound: { channels: [{ type: 'telegram' }], routes: { notify: ['telegram'] } } },
    }));
    const requests: Array<{ body: Record<string, unknown> }> = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ ok: true, result: { message_id: 61 + requests.length } });
    }) as typeof fetch);
    try {
      const refIds = [`proposal-${root.slice(-8)}-7`, `proposal-${root.slice(-8)}-8`];
      for (const refId of refIds) {
        const runRoot = mkdtempSync(join(tmpdir(), 'notify-router-target-run-'));
        roots.push(runRoot);
        const input = {
          text: 'Proposal ready', kind: 'notify', refId,
          actions: [{ id: 'suggest_accept', label: 'OK' }],
        };
        expect(toNotifyOutboundMessage(input)?.dedupKey).toBeTruthy();
        const state = await runGraph(graph(runRoot, input), {
          input, quiet: true, deps: { root: join(runRoot, 'graph-state'), capabilityProviders: notifyCapabilityProviders },
        });
        expect(state.status).toBe('done');
      }
      expect(requests).toHaveLength(2);
      expect(requests.map(({ body }) => (body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data))
        .toEqual(refIds.map((refId) => `suggest_accept:${refId}`));
    } finally { fetchSpy.mockRestore(); }
  });

  test('exports a capability provider map with the notify binding', () => {
    expect(notifyCapabilityProviders.notify).toBeTypeOf('function');
    expect(Object.keys(notifyCapabilityProviders)).toEqual(['notify']);
    expect(NOTIFY_CHANNEL_CONTRACT.id).toBe('notify.channel@1');
  });

  test('a failed fake delivery fails the graph instead of advancing as success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-capability-failure-'));
    roots.push(root);
    const fake = createFakeTelegramOutbound({ fail: true });
    const input = { text: 'Graph complete' };
    const state = await runGraph(graph(root, input, 'notify.channel@1'), {
      input, quiet: true, deps: { root: join(root, 'state'), capabilityProviders: createNotifyCapabilityRegistry((message) => fake.send(message)) },
    });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['notify', 'failed']);
    expect(state.nodes[0]).toMatchObject({ ok: false, error: 'contract-exhausted' });
    expect(fake.calls()).toBe(1);
    expect(fake.receipts()).toEqual([]);
  });

  test('rejects malformed input before invoking the transport', async () => {
    let calls = 0;
    const provider = createNotifyCapabilityProvider(() => { calls += 1; return true; });
    await expect(provider(context({ text: '  ' }))).resolves.toEqual({ ok: false, outcome: 'failed', error: 'invalid_input' });
    expect(calls).toBe(0);
  });

  test('fails closed on malformed optional action metadata', async () => {
    let calls = 0;
    const provider = createNotifyCapabilityProvider(() => { calls += 1; return true; });
    await expect(provider(context({ text: 'proposal', actions: [{ id: 'suggest_accept', label: ' ' }] })))
      .resolves.toEqual({ ok: false, outcome: 'failed', error: 'invalid_input' });
    expect(calls).toBe(0);
  });

  test('rejects colon delimiters that could make action targets ambiguous', async () => {
    let calls = 0;
    const provider = createNotifyCapabilityProvider(() => { calls += 1; return true; });
    for (const input of [
      { text: 'Proposal', refId: 'c', actions: [{ id: 'a:b', label: 'OK' }] },
      { text: 'Proposal', refId: 'b:c', actions: [{ id: 'a', label: 'OK' }] },
    ]) {
      await expect(provider(context(input))).resolves.toEqual({ ok: false, outcome: 'failed', error: 'invalid_input' });
    }
    expect(calls).toBe(0);
  });

  test('does not fall back from an explicit null node input to the graph input', async () => {
    let calls = 0;
    const provider = createNotifyCapabilityProvider(() => { calls += 1; return true; });
    await expect(provider({ ...context({ text: 'outer graph message' }), nodeInput: null }))
      .resolves.toEqual({ ok: false, outcome: 'failed', error: 'invalid_input' });
    expect(calls).toBe(0);
  });

  test('maps an unconfirmed delivery to failed and does not claim a receipt', async () => {
    const receipts: string[] = [];
    const provider = createNotifyCapabilityProvider(({ text }) => { receipts.push(text); return false; });
    await expect(provider(context({ text: 'Graph complete' }))).resolves.toEqual({ ok: false, outcome: 'failed', error: 'delivery_failed' });
    expect(receipts).toEqual(['Graph complete']);
  });

  test('maps thrown transport failures to a closed failure outcome', async () => {
    const provider = createNotifyCapabilityProvider(async () => { throw new Error('transport secret'); });
    await expect(provider(context({ text: 'Graph complete' }))).resolves.toEqual({ ok: false, outcome: 'failed', error: 'delivery_failed' });
  });
});
