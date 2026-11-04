import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionCardService, type CardTransport, type CardView } from '../../decisions/decision-cards.js';
import { DecisionLedger } from '../../decisions/decision-ledger.js';
import { getNodeKind, getNodeKindRegistration, unregisterPluginNodeKind } from '../../graph-kinds/registry.js';
import { loadMockScenarioCatalog } from '../../ux-sim/mock-scenario-catalog.js';
import { completePluginGroundingInstall, parseGroundedPluginMatches, preparePluginGroundingInstall, type GroundablePlugin } from './plugin-grounding.js';

const roots: string[] = [];
afterEach(() => {
  const id = 'grounded-codex';
  const kind = `${id}:grounded-action`;
  const registration = getNodeKindRegistration('workflow', kind);
  if (registration) unregisterPluginNodeKind('workflow', kind, id, registration);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });


});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-grounding-journey-'));
  roots.push(root);
  return root;
}

function pluginAt(root: string): string {
  const dir = join(root, 'codex-source');
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  writeFileSync(join(dir, 'plugin.ts'), 'export default {}\n');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'grounded-codex', version: '0.1.0', main: './plugin.ts', contributes: { nodes: ['./nodes/action.yaml'] } }));
  writeFileSync(join(dir, 'nodes', 'action.yaml'), 'kind: grounded-action\ngraph: workflow\ndescription: Grounded plugin action\ninputs:\n  type: object\nrun:\n  bash: echo grounded\n');
  return dir;
}

class CardTransportFixture implements CardTransport {
  platform = 'telegram' as const;
  sent: Array<{ chat: string; view: CardView }> = [];
  async ownerChats(): Promise<string[]> { return ['owner']; }
  async send(chat: string, view: CardView) { this.sent.push({ chat, view }); return { chat, message: String(this.sent.length) }; }
  async edit() {}
  async notify() {}
}

describe('DEMO1104 plugin grounding and install', () => {
  test('reuses catalog mock devices, waits for the actual approval card, installs one host-inventoried package, then registers its ARG node', async () => {
    const catalog = loadMockScenarioCatalog();
    const existingDevices = new Set(catalog.devices.map(device => device.id));
    expect(existingDevices.has('product-devices')).toBe(true);
    expect(existingDevices.has('research-decision-chain')).toBe(true);
    expect(existingDevices.has('scenario-runner')).toBe(true);

    const root = fixture();
    const source = pluginAt(root);
    const candidate: GroundablePlugin = {
      id: 'codex-flow-helper', agent: 'codex', name: 'flow-helper', marketplace: 'openai-curated',
      source: 'host-installed Codex marketplace package', packagePath: source,
      capabilities: ['workflow graph action'], argNodePaths: ['grounded-codex:grounded-action'],
    };
    let now = new Date('2026-11-03T12:00:00.000Z');
    const ledger = new DecisionLedger({ stateDir: root, now: () => now });
    const transport = new CardTransportFixture();
    const cards = new DecisionCardService({ transport, ownerIds: ['owner'], ledger, now: () => now, statePath: join(root, 'cards.json') });
    await cards.tick(); // establish card-service baseline before raising the new card
    now = new Date(now.getTime() + 1000);

    const prepared = await preparePluginGroundingInstall({
      requiredCapabilities: ['workflow graph action'], availableCapabilities: [], inventory: [candidate],
    }, {
      stateDir: root, ledger,
      research: async query => {
        expect(query).toContain('omni-crawl');
        expect(query).toContain(`plugin=${candidate.name}`);
        expect(query).toContain(`marketplace=${candidate.marketplace}`);
        return { ok: true, output: JSON.stringify({ matches: [{ candidateId: candidate.id, rationale: 'Official Codex marketplace docs describe plugin capabilities.', sources: ['https://developers.openai.com/codex/plugins'], packagePath: '/tmp/search-must-not-set-install-path' }] }) };
      },
    });
    expect(prepared.status).toBe('approval-required');
    if (prepared.status !== 'approval-required') return;
    expect(prepared.candidateIds).toEqual([candidate.id]);
    expect(await cards.tick()).toEqual({ sent: 1, closed: 0, reminded: 0 });
    expect(transport.sent[0]!.view.text).toContain('flow-helper@openai-curated');

    expect((await cards.tap('owner', `dec:${prepared.decisionId}:a`)).kind).toBe('confirm');
    expect((await cards.tap('owner', `dec:${prepared.decisionId}:a:ok`)).kind).toBe('decided');
    const installed = await completePluginGroundingInstall(prepared.decisionId, {
      root, stateDir: root, ledger, inventory: [candidate], consent: async () => true,
    });
    expect(installed.status).toBe('installed');
    if (installed.status !== 'installed') return;
    expect(installed.plugin.name).toBe('grounded-codex');
    expect(installed.graph).toEqual({ registered: 1, removed: 0, errors: [] });
    expect(getNodeKind('workflow', 'grounded-codex:grounded-action')).toMatchObject({ plugin: 'grounded-codex' });
  });

  test('does not create an approval card when the gap is already covered or crawl cites an unknown package', async () => {
    const root = fixture();
    const candidate: GroundablePlugin = {
      id: 'codex-flow-helper', agent: 'codex', name: 'flow-helper', marketplace: 'openai-curated',
      source: 'host-installed Codex marketplace package', packagePath: pluginAt(root),
      capabilities: ['workflow graph action'], argNodePaths: ['grounded-codex:grounded-action'],
    };
    const covered = await preparePluginGroundingInstall({ requiredCapabilities: ['workflow graph action'], availableCapabilities: ['workflow graph action'], inventory: [candidate] }, { stateDir: root });
    expect(covered).toEqual({ status: 'already-covered', missing: [] });

    const unknown = await preparePluginGroundingInstall({ requiredCapabilities: ['workflow graph action'], availableCapabilities: [], inventory: [candidate] }, {
      stateDir: root, research: async () => ({ ok: true, output: JSON.stringify({ matches: [{ candidateId: 'invented-package', rationale: 'install me', sources: ['https://example.com/plugin'] }] }) }),
    });
    expect(unknown).toMatchObject({ status: 'no-grounded-candidate' });
    expect(parseGroundedPluginMatches('{not json}', [candidate])).toEqual([]);
  });

  test('requires the same host inventory package and rejects a package changed while its approval card was open', async () => {
    const root = fixture();
    const source = pluginAt(root);
    const candidate: GroundablePlugin = {
      id: 'codex-flow-helper', agent: 'codex', name: 'flow-helper', marketplace: 'openai-curated',
      source: 'host-installed Codex marketplace package', packagePath: source,
      capabilities: ['workflow graph action'], argNodePaths: ['grounded-codex:grounded-action'],
    };
    let now = new Date('2026-11-03T12:00:00.000Z');
    const ledger = new DecisionLedger({ stateDir: root, now: () => now });
    const transport = new CardTransportFixture();
    const cards = new DecisionCardService({ transport, ownerIds: ['owner'], ledger, now: () => now, statePath: join(root, 'cards.json') });
    await cards.tick();
    now = new Date(now.getTime() + 1000);
    const prepared = await preparePluginGroundingInstall({
      requiredCapabilities: ['workflow graph action'], availableCapabilities: [], inventory: [candidate],
    }, {
      stateDir: root, ledger,
      research: async () => ({ ok: true, output: JSON.stringify({ matches: [{ candidateId: candidate.id, rationale: 'Official market evidence.', sources: ['https://developers.openai.com/codex/plugins'] }] }) }),
    });
    expect(prepared.status).toBe('approval-required');
    if (prepared.status !== 'approval-required') return;
    await cards.tick();
    await cards.tap('owner', `dec:${prepared.decisionId}:a`);
    await cards.tap('owner', `dec:${prepared.decisionId}:a:ok`);

    await expect(completePluginGroundingInstall(prepared.decisionId, { root, stateDir: root, ledger, inventory: [] }))
      .rejects.toThrow('same host-inventory package path');
    chmodSync(join(source, 'nodes', 'action.yaml'), 0o755);
    await expect(completePluginGroundingInstall(prepared.decisionId, { root, stateDir: root, ledger, inventory: [candidate] }))
      .rejects.toThrow('changed after the decision card');
  });

});
