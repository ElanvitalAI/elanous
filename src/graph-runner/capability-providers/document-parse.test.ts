import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentBackendId, setCredentialSlotAsync, useBackend } from '../../nexus/config/secrets/index.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { startFakeUpstageServer } from '../../../test/fixtures/fake-upstage-server.js';
import { dispatchVerifiedDashboardGraph } from '../../dashboard/plugin-route-adapter.js';
import { registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } from '../capabilities.js';
import { runGraph } from '../runner.js';
import { createDocumentParseProvider, createDocumentParseRegistry, DOCUMENT_AI_DISCONNECTED, resolveOwnedPdfBytes } from './document-parse.js';
import type { InProcessHandlerContext } from '../in-process-registry.js';

const fixtures = [join(import.meta.dir, 'fixtures/briefing.pdf'), join(import.meta.dir, 'fixtures/requirements.pdf')];
const refs = ['scraps/briefing.pdf', 'scraps/requirements.pdf'];
const mediaRoot = mkdtempSync(join(tmpdir(), 'absorb-owned-pdf-'));
let server: ReturnType<typeof Bun.serve>;
let requests = 0;

beforeAll(() => {
  const owned = join(mediaRoot, 'member-synthetic', 'scraps');
  mkdirSync(owned, { recursive: true });
  for (const [index, fixture] of fixtures.entries()) copyFileSync(fixture!, join(owned, refs[index]!.slice('scraps/'.length)));
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    requests++;
    const form = await request.formData();
    if (form.get('model') !== 'document-parse' || !form.get('document')) return new Response('bad fixture request', { status: 400 });
    const filename = (form.get('document') as File).name;
    return Response.json({ content: { text: filename === 'briefing.pdf' ? 'Briefing source' : 'Requirement source',
      markdown: filename === 'briefing.pdf'
        ? '# Briefing\nContext paragraph\n| Item | Evidence |\n| --- | --- |\n| A | source-1 |'
        : '# Requirements\n| Need | Source |\n| --- | --- |\n| Export | source-2 |\nVerification paragraph',
    } });
  } });
});
afterAll(() => { server?.stop(true); rmSync(mediaRoot, { recursive: true, force: true }); });

function context(mediaRef: string): InProcessHandlerContext {
  const input = { kind: 'pdf', mediaRef, context: { memberId: 'member-synthetic' } };
  return { graphId: 'absorb-ingest', runId: 'synthetic', nodeId: 'docparse', input,
    graphInput: input, verifiedOwnerId: 'member-synthetic', outputs: {} };
}

test('fake parser serves both PDF fixtures and preserves structured source', async () => {
  const fakeFetch = ((_: unknown, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}/parse`, init)) as unknown as typeof fetch;
  const provider = createDocumentParseProvider({ apiKey: 'synthetic-test-token', mediaRoot, fetchImpl: fakeFetch });
  for (const [index, ref] of refs.entries()) {
    const result = await provider(context(ref!));
    expect(result.ok).toBe(true);
    const scrap = (result.result as { scrap: Record<string, unknown> }).scrap;
    expect(scrap.documentAiStatus).toBe('connected');
    expect((scrap.documentSource as { title: string }).title).toBe(index === 0 ? 'Briefing' : 'Requirements');
    expect((scrap.documentSource as { tables: string[][][] }).tables[0]?.length).toBe(2);
    expect(scrap.context).toEqual({ memberId: 'member-synthetic' });
  }
  expect(requests).toBe(2);
});

test('absent key uses local PDF text and reports disconnected without HTTP', async () => {
  const before = requests;
  const provider = createDocumentParseProvider({ apiKey: '', mediaRoot, fetchImpl: (() => { throw new Error('network forbidden'); }) as unknown as typeof fetch });
  for (const ref of refs) {
    const result = await provider(context(ref));
    expect(result.ok).toBe(true);
    const scrap = (result.result as { scrap: Record<string, unknown> }).scrap;
    expect(scrap.documentAiStatus).toBe(DOCUMENT_AI_DISCONNECTED);
    expect(typeof scrap.text).toBe('string');
    expect(scrap.text).not.toBe('');
    expect(result.evidence?.mode).toBe('local-pdf-text');
  }
  expect(requests).toBe(before);
});

test('non PDF scrap remains unchanged', async () => {
  const input = { kind: 'text', text: 'existing note' };
  const result = await createDocumentParseProvider({ apiKey: '' })({ ...context(refs[0]!), input, graphInput: input });
  expect(result.result).toEqual({ scrap: input });
});

test('absolute, relative, foreign and symlink refs cannot read or upload server files', async () => {
  const outside = fixtures[0]!;
  const owned = join(mediaRoot, 'member-synthetic', 'scraps');
  symlinkSync(outside, join(owned, 'linked.pdf'));
  for (const ref of [outside, '../briefing.pdf', 'member-other/scraps/briefing.pdf', 'scraps/linked.pdf']) {
    expect(await resolveOwnedPdfBytes(ref, 'member-synthetic', mediaRoot)).toBeNull();
  }
  const before = requests;
  const provider = createDocumentParseProvider({ apiKey: 'synthetic-test-token', mediaRoot,
    fetchImpl: (() => { throw new Error('network forbidden'); }) as unknown as typeof fetch });
  for (const ref of [outside, '../briefing.pdf', 'member-other/scraps/briefing.pdf', 'scraps/linked.pdf']) {
    const result = await provider(context(ref));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('pdf_media_not_owned_or_missing');
  }
  expect(requests).toBe(before);
});

test('intermediate scraps directory symlink cannot escape the verified member root', async () => {
  const escapeRoot = mkdtempSync(join(tmpdir(), 'absorb-symlink-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'absorb-symlink-outside-'));
  try {
    mkdirSync(join(escapeRoot, 'member-synthetic'));
    copyFileSync(fixtures[0]!, join(outside, 'briefing.pdf'));
    symlinkSync(outside, join(escapeRoot, 'member-synthetic', 'scraps'));
    expect(await resolveOwnedPdfBytes('scraps/briefing.pdf', 'member-synthetic', escapeRoot)).toBeNull();
    const before = requests;
    const result = await createDocumentParseProvider({ mediaRoot: escapeRoot, apiKey: 'synthetic-test-token',
      fetchImpl: (() => { throw new Error('network forbidden'); }) as unknown as typeof fetch })(context('scraps/briefing.pdf'));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('pdf_media_not_owned_or_missing');
    expect(requests).toBe(before);
  } finally {
    rmSync(escapeRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('canonical slot alone authorizes a loopback fake parser request', async () => {
  const configRoot = mkdtempSync(join(tmpdir(), 'absorb-upstage-slot-'));
  const previousBackend = currentBackendId();
  const previousKey = process.env.UPSTAGE_API_KEY;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousBase = process.env.UPSTAGE_BASE_URL;
  const fake = await startFakeUpstageServer();
  try {
    setElanousConfigDir(configRoot);
    useBackend('file');
    await setCredentialSlotAsync('cred:upstage.api_key', 'fake-upstage-key');
    delete process.env.UPSTAGE_API_KEY;
    process.env.NODE_ENV = 'test';
    process.env.UPSTAGE_BASE_URL = fake.baseUrl;
    const result = await createDocumentParseProvider({ mediaRoot })(context(refs[0]!));
    expect(result.ok).toBe(true);
    expect((result.result as { scrap: Record<string, unknown> }).scrap.documentAiStatus).toBe('connected');
    expect(fake.requests.map(request => request.path)).toEqual(['/v1/document-digitization']);
    expect(fake.requests.every(request => request.authorized)).toBe(true);
  } finally {
    useBackend(previousBackend);
    resetElanousConfigDir();
    if (previousKey === undefined) delete process.env.UPSTAGE_API_KEY; else process.env.UPSTAGE_API_KEY = previousKey;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousBase === undefined) delete process.env.UPSTAGE_BASE_URL; else process.env.UPSTAGE_BASE_URL = previousBase;
    await fake.close();
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test('parser throw falls back to authorized local PDF bytes with disconnected status', async () => {
  const result = await createDocumentParseProvider({ mediaRoot, apiKey: 'synthetic-test-token',
    parseDocument: async () => { throw new Error('synthetic parser fault'); } })(context(refs[0]!));
  expect(result.ok).toBe(true);
  const scrap = (result.result as { scrap: Record<string, unknown> }).scrap;
  expect(scrap.documentAiStatus).toBe(DOCUMENT_AI_DISCONNECTED);
  expect(scrap.text).toContain('Quarterly briefing source');
  expect(result.evidence?.mode).toBe('local-pdf-text');
});

test('actual ingest denies forged input owner and accepts only a host-verified owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'absorb-owner-graph-'));
  const graph = join(import.meta.dir, '../../../plugins/absorb/graph/absorb-ingest.yaml');
  let writes = 0;
  let registry = createDocumentParseRegistry({ mediaRoot, apiKey: '' });
  registry = registerGraphCapabilityContract(registry, { id: 'store.write@1',
    input: { type: 'object' }, output: { type: 'object' } });
  registry = registerGraphCapabilityProviderDeclaration(registry, { id: 'fake-owner-store',
    provides: ['store.write@1'], tier: 'free', invoke: () => {
      writes++;
      return { ok: true, outcome: 'done', result: { stored: true } };
    } });
  const args = { kind: 'pdf', mediaRef: refs[0], context: { memberId: 'member-forged' } };
  try {
    const denied = await runGraph(graph, { runId: 'forged-owner', input: args, verifiedOwnerId: 'member-synthetic',
      quiet: true, deps: { root, capabilityProviders: registry } });
    expect(denied.status).toBe('failed');
    expect(denied.nodes.find(node => node.nodeId === 'docparse')?.output).toContain('owner_mismatch');
    expect(writes).toBe(0);
    const unverified = await runGraph(graph, { runId: 'unverified-owner',
      input: { ...args, context: { memberId: 'member-synthetic' } }, quiet: true,
      deps: { root, capabilityProviders: registry } });
    expect(unverified.status).toBe('failed');
    expect(writes).toBe(0);
    const accepted = await dispatchVerifiedDashboardGraph(graph, args,
      { surface: 'dashboard', verifiedOwner: { id: 'member-synthetic' } },
      { runId: 'verified-owner', deps: { root, capabilityProviders: registry } });
    expect(accepted.status).toBe('done');
    expect(writes).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
