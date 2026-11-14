import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChildPluginRuntimeContract } from './child-plugin-runtime.js';
import { dispatchGraphContract } from '../graph-runner/capabilities.js';
import { createAbsorbBriefMemberRegistry } from '../graph-runner/capability-providers/absorb-member-registry.js';

test('default brief route extracts only a verified member owned, already parsed scrap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'absorb-default-extract-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    const modelCalls: string[] = [];
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-a' }, graphDeps: { root },
      graphPrompt: async prompt => {
        const source = prompt.match(/Input:\s*(\{[\s\S]*\})\s*$/)?.[1];
        const input = source ? JSON.parse(source) as { context?: { graphNode?: { skill?: string } }; prior?: Record<string, unknown> } : {};
        const skill = input.context?.graphNode?.skill;
        modelCalls.push(skill ?? 'missing-skill');
        if (skill === 'absorb/card') {
          const items = (input.prior?.items ?? []) as Array<{ id: string; text: string }>;
          const cards = items.map(item => ({ scrapId: item.id, points: [item.text] }));
          return JSON.stringify({ outcome: 'done', result: { cards }, evidence: { cards } });
        }
        return JSON.stringify({ outcome: 'needs-human', result: {}, evidence: { reason: 'test-stops-after-card' } });
      } });
    expect(await bridge.dispatchPluginTool('scrap_add', { kind: 'text', text: 'real default text extraction' }))
      .toMatchObject({ ok: true, result: { status: 'done' } });
    const brief = await bridge.dispatchPluginTool('brief_today', {});
    expect(brief.ok).toBe(true);
    const graph = brief.ok ? brief.result as { nodes: Array<{ nodeId: string; ok?: boolean; executed?: boolean; output?: string; error?: string }> } : null;
    const extract = graph?.nodes.find(node => node.nodeId === 'extract');
    expect(extract?.ok).toBe(true);
    expect(JSON.parse(String(extract?.output))).toMatchObject({ result: { items: [{ text: 'real default text extraction' }] } });
    const card = graph?.nodes.find(node => node.nodeId === 'card');
    expect(card).toBeDefined();
    expect(card?.executed).toBe(true);
    expect(card?.ok).toBe(true);
    expect(card?.error).toBeUndefined();
    expect(JSON.parse(String(card?.output))).toMatchObject({ result: { cards: [{ points: ['real default text extraction'] }] } });
    expect(modelCalls).toContain('absorb/card');

    const registry = createAbsorbBriefMemberRegistry();
    const request = (verifiedOwnerId: string | undefined, owner: string, scrapOwner: string) =>
      dispatchGraphContract('extract.item@1', { graphId: 'absorb-brief', runId: 'owner-negative', nodeId: 'extract__map_0',
        verifiedOwnerId, input: { context: { memberId: owner } }, graphInput: { context: { memberId: owner } },
        nodeInput: { scrap: { id: 'scrap-a', kind: 'text', owner: scrapOwner, text: 'private text' } }, outputs: {},
      }, registry);
    expect(await request(undefined, 'member-a', 'member-a')).toMatchObject({ ok: false });
    expect(await request('member-a', 'member-b', 'member-a')).toMatchObject({ ok: false });
    expect(await request('member-a', 'member-a', 'member-b')).toMatchObject({ ok: false });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
