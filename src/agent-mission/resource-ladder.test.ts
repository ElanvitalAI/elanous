import { describe, expect, test } from 'bun:test';
import { generateIndexKeyPair, signIndex, verifyIndex, type MarketplaceIndex } from '../market/signed-index.js';
import { OFFICIAL_INDEX_KEYS } from '../market/official-keys.js';
import { planMissionResources, type ResourceLadderDeps } from './resource-ladder.js';

const pair = generateIndexKeyPair();
const index: MarketplaceIndex = {
  name: 'elanous', interface: { displayName: 'Official' }, sequence: 1,
  plugins: [{
    name: 'pdfsift', version: '1.0.0', description: 'pdf 텍스트 추출', source: { source: 'url' },
    artifact: { sha256: '0'.repeat(64), bytes: 0, key: 'pdfsift.tgz' },
    'ai.elanous': { capabilities: ['pdf 텍스트 추출'], connectors: [], pricing: { model: 'free' } },
  }],
};
const bytes = Buffer.from(JSON.stringify(index));
const signature = signIndex(bytes, pair.privateKeyPem, pair.keyId);
const originalKeys = [...OFFICIAL_INDEX_KEYS];

async function withFixtureKey<T>(run: () => Promise<T>): Promise<T> {
  try {
    (OFFICIAL_INDEX_KEYS as { keyId: string; publicKey: string }[]).push({ keyId: pair.keyId, publicKey: pair.publicKey });
    return await run();
  } finally {
    (OFFICIAL_INDEX_KEYS as { keyId: string; publicKey: string }[]).splice(0, OFFICIAL_INDEX_KEYS.length, ...originalKeys);
  }
}
const candidate = { url: 'https://example.org/tool', title: 'Tool', snippet: 'unverified', source: 'search' };

function fixture(overrides: Partial<ResourceLadderDeps> = {}): ResourceLadderDeps {
  return {
    inferNeeds: async () => JSON.stringify({ needs: ['github', 'pdf 텍스트 추출'] }),
    readers: { codex: () => [{ backend: 'codex', service: 'github', state: 'ready' }], claude: () => [], grok: () => [] },
    readOfficialIndex: async () => ({ marketplaceBytes: bytes, signatureText: signature }),
    readInstalledPlugins: () => [],
    discover: async () => [candidate],
    decide: () => {}, log: () => {},
    ...overrides,
  };
}

describe('planMissionResources', () => {
  test('rejects a valid index signed by a non-official key', async () => {
    const plan = await planMissionResources('PDF and github', fixture());
    expect(plan.plugin).toBeUndefined();
    expect(plan.gaps).toEqual([{ need: 'pdf 텍스트 추출', candidates: [candidate] }]);
    expect(verifyIndex({ marketplaceBytes: bytes, signatureText: signature, trustedKeys: OFFICIAL_INDEX_KEYS }).ok).toBe(false);
  });
  test('ready service is held; one signed official plugin is proposed and installed once by the injected installer', async () => {
    const installs: unknown[] = [];
    const plan = await withFixtureKey(() => planMissionResources('Extract text from PDF and open github PR', fixture({
      installPlugin: async request => { installs.push(request); return { outcome: 'installed' }; },
    })));
    expect(plan.needs).toEqual(['github', 'pdf 텍스트 추출']);
    expect(plan.have).toEqual(['github']);
    expect(plan.plugin).toEqual({ plugin: 'pdfsift', marketplace: 'elanous', source: 'official-index' });
    expect(installs).toEqual([{ plugin: 'pdfsift', marketplace: 'elanous' }]);
    expect(plan.gaps).toEqual([]);
    expect(plan.backend).toEqual({ name: 'codex', why: '필요 서비스의 ready 관측에 따른 선택' });
  });

  test('without an installer an official plugin remains a proposal and its capability remains a gap', async () => {
    const plan = await withFixtureKey(() => planMissionResources('PDF and github', fixture()));
    expect(plan.have).toEqual(['github']);
    expect(plan.plugin).toEqual({ plugin: 'pdfsift', marketplace: 'elanous', source: 'official-index' });
    expect(plan.gaps).toEqual([{ need: 'pdf 텍스트 추출', candidates: [candidate] }]);
  });

  test('an installer escalation does not satisfy the proposed plugin capability', async () => {
    const installs: unknown[] = [];
    const plan = await withFixtureKey(() => planMissionResources('PDF and github', fixture({
      installPlugin: async request => { installs.push(request); return { outcome: 'escalate', reason: 'unknown-menu' }; },
    })));
    expect(installs).toEqual([{ plugin: 'pdfsift', marketplace: 'elanous' }]);
    expect(plan.have).toEqual(['github']);
    expect(plan.plugin).toEqual({ plugin: 'pdfsift', marketplace: 'elanous', source: 'official-index' });
    expect(plan.gaps).toEqual([{ need: 'pdf 텍스트 추출', candidates: [candidate] }]);
  });

  test('an installer exception does not satisfy the proposed plugin capability', async () => {
    const plan = await withFixtureKey(() => planMissionResources('PDF and github', fixture({
      installPlugin: async () => { throw new Error('installation failed'); },
    })));
    expect(plan.have).toEqual(['github']);
    expect(plan.plugin).toEqual({ plugin: 'pdfsift', marketplace: 'elanous', source: 'official-index' });
    expect(plan.gaps).toEqual([{ need: 'pdf 텍스트 추출', candidates: [candidate] }]);
  });

  test('bad signature offers no plugin and only reports untrusted discovery candidates as a gap', async () => {
    const installs: unknown[] = [];
    const plan = await withFixtureKey(() => planMissionResources('PDF and github', fixture({
      readOfficialIndex: async () => ({ marketplaceBytes: Buffer.from(JSON.stringify({ ...index, sequence: 2 })), signatureText: signature }),
      installPlugin: async request => { installs.push(request); },
    })));
    expect(plan.plugin).toBeUndefined();
    expect(installs).toEqual([]);
    expect(plan.gaps).toEqual([{ need: 'pdf 텍스트 추출', candidates: [candidate] }]);
    expect(plan.decisions.some(text => text.includes('공식 마켓 거부'))).toBe(true);
  });

  test('caller backend and plugin are preserved; resources off does not call the ladder at all', async () => {
    const installs: unknown[] = [];
    const deps = fixture({ installPlugin: async request => { installs.push(request); } });
    const explicit = await withFixtureKey(() => planMissionResources('PDF and github', deps, { backend: 'claude', plugin: 'requested@custom' }));
    expect(explicit.backend).toBeUndefined();
    expect(explicit.plugin).toBeUndefined();
    const byDeps = await withFixtureKey(() => planMissionResources('PDF and github', { ...deps, backend: 'claude', plugin: 'requested@custom' }));
    expect(byDeps.backend).toBeUndefined();
    expect(byDeps.plugin).toBeUndefined();
    expect(installs).toEqual([]);
    let calls = 0;
    const off = await planMissionResources('PDF and github', {
      inferNeeds: async () => { calls++; return '{"needs":[]}'; },
      readers: { codex: () => { calls++; return []; }, claude: () => [], grok: () => [] },
      readOfficialIndex: async () => { calls++; throw new Error('not called'); },
      installPlugin: async () => { calls++; },
      discover: async () => { calls++; return []; },
      decide: () => { calls++; }, log: () => { calls++; },
    }, { resources: 'off' });
    expect(off).toEqual({ needs: [], have: [], gaps: [], decisions: [] });
    expect(calls).toBe(0);
    expect(await planMissionResources('PDF', { resources: 'off', inferNeeds: async () => { calls++; return '{"needs":[]}'; } })).toEqual(off);
    expect(calls).toBe(0);
  });

  test('installed official plugin skill is already held; unknown service never selects a backend', async () => {
    const plan = await withFixtureKey(() => planMissionResources('PDF', fixture({
      inferNeeds: async () => '{"needs":["pdf 텍스트 추출"]}',
      readInstalledPlugins: () => [{ market: 'elanous', name: 'pdfsift' }],
    })));
    expect(plan.have).toEqual(['pdf 텍스트 추출']);
    expect(plan.plugin).toBeUndefined();
    expect(plan.backend).toBeUndefined();
    expect(plan.gaps).toEqual([]);
  });

  test('each ladder stage emits a redacted decision and debug step', async () => {
    const events: Array<{ kind: string; what: string; reason: string }> = [];
    const logs: Array<{ step: string; data: Record<string, unknown> }> = [];
    const plan = await withFixtureKey(() => planMissionResources('token=supersecret github PDF', fixture({
      inferNeeds: async () => '{"needs":["github","pdf 텍스트 추출","unlisted tool"]}',
      installPlugin: async () => ({ outcome: 'installed' }),
      decide: event => { events.push(event); },
      log: (step, data) => { logs.push({ step, data }); },
    })));
    expect(plan.gaps).toEqual([{ need: 'unlisted tool', candidates: [candidate] }]);
    for (const step of ['needs', 'have', 'official-index', 'discover', 'backend']) {
      expect(logs.some(entry => entry.step === step)).toBe(true);
      expect(plan.decisions.some(decision => decision.startsWith(step + ':'))).toBe(true);
    }
    expect(events.map(event => event.kind)).toContain('ROUTE');
    expect(events.map(event => event.kind)).toContain('VERIFY');
    expect(events.map(event => event.kind)).toContain('ESCALATE');
    expect(JSON.stringify({ events, logs, plan })).not.toContain('supersecret');
  });

  test('ambiguous official matches are never installed; infer redacts credentials and bounds JSON needs', async () => {
    let input = '';
    const installs: unknown[] = [];
    const ambiguous: MarketplaceIndex = { ...index, plugins: [index.plugins[0]!, { ...index.plugins[0]!, name: 'pdfsecond' }] };
    const signed = Buffer.from(JSON.stringify(ambiguous));
    const plan = await withFixtureKey(() => planMissionResources('token=supersecret ghp_abcdefghi PDF', fixture({
      inferNeeds: async mission => { input = mission; return JSON.stringify({ needs: ['pdf 텍스트 추출', 'two', 'three', 'four', 'five', 'six', 'token=secret'] }); },
      readOfficialIndex: async () => ({ marketplaceBytes: signed, signatureText: signIndex(signed, pair.privateKeyPem, pair.keyId) }),
      installPlugin: async request => { installs.push(request); },
    })));
    expect(input).not.toContain('supersecret');
    expect(input).not.toContain('ghp_abcdefghi');
    expect(plan.needs).toHaveLength(5);
    expect(plan.plugin).toBeUndefined();
    expect(installs).toEqual([]);
    expect(plan.gaps[0]).toEqual({ need: 'pdf 텍스트 추출', candidates: [candidate] });
  });
});
