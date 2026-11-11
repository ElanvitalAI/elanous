import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parsePluginManifest } from '../plugins/core/manifest.js';
import { buildToolRouteIndex, dispatchToolRoute, routeToolIntentWithFallback } from '../tool-router/index.js';
import {
  emptyGraphCapabilityRegistry,
  registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityContract,
  type GraphCapabilityProvider,
  type GraphCapabilityRegistry,
} from '../graph-runner/capabilities.js';
import type { InProcessHandlerResult } from '../graph-runner/in-process-registry.js';
import { decideGraphApproval, runGraph, type GraphRunOptions, type GraphRunState } from '../graph-runner/runner.js';
import { createFakeAppHost, type FakeAppHost } from './fake-app-host.js';
import { withSimClock } from './fake-clock.js';

type Row = Record<string, unknown>;
type ProviderResult = InProcessHandlerResult;

function declaredGraphIds(pluginPath: string, declaration: Row): Set<string> {
  const pluginRoot = dirname(pluginPath);
  const graphPaths = Array.isArray(declaration.graphs) ? declaration.graphs.map(text) : [];
  return new Set(graphPaths.map((graphPath) => {
    const file = resolve(pluginRoot, graphPath);
    if (!file.startsWith(`${pluginRoot}${sep}`)) throw new Error('graph declaration escapes plugin root');
    return text(object(object(parseYaml(readFileSync(file, 'utf8'))).graph).id);
  }));
}

function declaredHitlNodeIds(graphFile: string): string[] {
  const graph = object(parseYaml(readFileSync(graphFile, 'utf8')));
  const policy = object(graph.policy);
  return Array.isArray(policy.hitl) ? policy.hitl.map(text) : [];
}

type AbsorbContractId = 'store.read@1' | 'store.write@1' | 'store.events@1' | 'extract.item@1' | 'notify.channel@1' | 'app-publish.action@1';
type AbsorbSimulationProviders = Partial<Record<AbsorbContractId, GraphCapabilityProvider>>;

const ABSORB_SIMULATION_CONTRACTS: readonly GraphCapabilityContract[] = [
  { id: 'store.read@1', input: { type: 'object' }, output: { type: 'object' } },
  { id: 'store.write@1', input: { type: 'object' }, output: { type: 'object' } },
  { id: 'store.events@1', input: { type: 'object' }, output: { type: 'object' } },
  { id: 'extract.item@1', input: { type: 'object' }, output: { type: 'object' } },
  { id: 'notify.channel@1', input: { type: 'object' }, output: { type: 'object' } },
  { id: 'app-publish.action@1', input: { type: 'object' }, output: { type: 'object' } },
];

/** Build the same contract-registry overlay used by the Graph v2 runGraph simulations. */
function absorbSimulationCapabilityRegistry(providers: AbsorbSimulationProviders): GraphCapabilityRegistry {
  let registry = emptyGraphCapabilityRegistry();
  for (const contract of ABSORB_SIMULATION_CONTRACTS) registry = registerGraphCapabilityContract(registry, contract);
  for (const [contractId, invoke] of Object.entries(providers) as [AbsorbContractId, GraphCapabilityProvider][]) {
    registry = registerGraphCapabilityProviderDeclaration(registry, {
      id: `sim-${contractId.replace(/[.@]/g, '-')}`,
      provides: [contractId],
      tier: 'free',
      invoke,
    });
  }
  return registry;
}

export function publishFakeSimulatedArtifact(input: { host: FakeAppHost; appId: string; owner: string; artifact: Row;
  receipt: Row; calls: string[] }): ProviderResult {
  const artifactId = text(input.artifact.id);
  if (input.receipt.status !== 'passed' || input.receipt.artifactId !== artifactId || input.receipt.owner !== input.owner || !artifactId) {
    return { ok: false, outcome: 'failed', evidence: { reason: 'missing-or-mismatched-simulation-receipt', receipt: input.receipt, artifactId }, error: 'simulation receipt rejected' };
  }
  const version = { id: artifactId, files: object(input.artifact.files) as Record<string, string> };
  input.host.deployArtifact(input.appId, version);
  const response = input.host.fetch(`${input.appId}.app.sim.invalid`, '/');
  if (response.status !== 200) return { ok: false, outcome: 'failed', evidence: { status: response.status }, error: 'fake app host did not serve the artifact' };
  const resultUrl = `https://${input.appId}.app.sim.invalid/`;
  input.calls.push(`${input.appId}@${version.id}`);
  return { ok: true, outcome: 'done', result: { artifactId, resultUrl }, evidence: { version: version.id, resultUrl,
    lifecycleId: `lifecycle-${version.id}`, simReceiptId: input.receipt.id, artifactId } };
}

export async function runAbsorbPublishReceiptGraphSimulation(): Promise<Row> {
  const result = await runAbsorbGraphSimulation({ confirmation: 'y', receiptScenariosOnly: true });
  return { ok: result.ok === true, graph: 'plugins/absorb/graph/absorb-build.yaml',
    storedSuggestionId: result.storedSuggestionId, scenarios: result.receiptScenarios };
}

export async function runAbsorbStoreRouteSimulation(): Promise<Row> {
  const graphRoot = resolve(join(import.meta.dir, '../../plugins/absorb/graph'));
  const briefGraph = object(parseYaml(readFileSync(join(graphRoot, 'absorb-brief.yaml'), 'utf8')));
  const briefGraphId = text(object(briefGraph.graph).id);
  const briefNodes = Array.isArray(briefGraph.nodes) ? briefGraph.nodes.map(object) : [];
  const collectNodeId = text(briefNodes.find((node) => object(node.with).collection === 'scraps')?.id);
  const suggestionsGraph = object(parseYaml(readFileSync(join(graphRoot, 'absorb-suggest-list.yaml'), 'utf8')));
  const suggestionsListNodeId = text(suggestionsGraph.entry);
  const pluginPath = resolve(join(import.meta.dir, '../../plugins/absorb/plugin.yaml'));
  const declaration = object(parseYaml(readFileSync(pluginPath, 'utf8')));
  const manifest = parsePluginManifest({ id: declaration.id, name: declaration.name, version: declaration.version, contributes: declaration.contributes });
  const allowedGraphIds = declaredGraphIds(pluginPath, declaration);
  const index = buildToolRouteIndex([{ pluginId: manifest.id, tools: manifest.contributes.aiTools ?? [] }],
    { allowedGraphIdsByPlugin: new Map([[manifest.id, allowedGraphIds]]) });
  const decision = routeToolIntentWithFallback('이 링크 저장해', () => index, {
    enabledPluginIds: new Set([manifest.id]), allowedGraphIds,
  });
  const match = decision.matches.find((candidate) => candidate.name === 'scrap_add');
  if (!match) throw new Error('absorb simulation could not route scrap_add');
  const handler = manifest.contributes.aiTools?.find((tool) => tool.name === match.name)?.handler;
  if (handler !== './graph:absorb-ingest') throw new Error(`scrap_add must dispatch to absorb-ingest, received ${String(handler)}`);
  const dispatch = dispatchToolRoute(match, false, () => handler,
    { allowedGraphIds: declaredGraphIds(pluginPath, declaration) });
  if (dispatch.status !== 'dispatched') throw new Error('scrap_add unexpectedly requires confirmation');

  const root = mkdtempSync(join(tmpdir(), 'absorb-store-route-sim-'));
  const scraps: Row[] = [{ id: 'private-other-member', owner: 'member-empty', status: 'new', kind: 'text' }];
  const suggestions: Row[] = [
    { id: 'suggestion-owned', owner: 'member-demo', appId: 'lecture-scrap-demo' },
    { id: 'suggestion-private', owner: 'member-empty', appId: 'private-app' },
  ];
  const storeProvider: GraphCapabilityProvider = ({ nodeInput, input, graphInput }) => {
      const config = object(nodeInput);
      const runInput = object(graphInput ?? input);
      const context = inputContext(runInput);
      if (config.op === 'create' && config.collection === 'scraps') {
        const row = { ...runInput, id: 'scrap-added-by-route', owner: text(context.memberId), status: text(config.status) || 'new' };
        scraps.push(row);
        return { ok: true, outcome: 'done', result: row, evidence: { stored: row } };
      }
      if (config.op === 'list' && config.collection === 'scraps') {
        const items = scraps.filter((row) => row.owner === context.memberId && row.status === 'new');
        return { ok: true, outcome: 'done', result: { items }, evidence: { items, owner: context.memberId, count: items.length } };
      }
      if (config.op === 'list' && config.collection === 'suggestions') {
        const items = suggestions.filter((row) => row.owner === context.memberId);
        return { ok: true, outcome: 'done', result: { items }, evidence: { items, owner: context.memberId, count: items.length } };
      }
      return { ok: false, outcome: 'failed', error: `unsupported fake store operation: ${String(config.op)}` };
  };
  const extractProvider: GraphCapabilityProvider = () => ({ ok: true, outcome: 'done', result: { text: 'fake extracted text' }, evidence: { text: 'fake extracted text' } });
  const providers = absorbSimulationCapabilityRegistry({
    'store.read@1': storeProvider,
    'store.write@1': storeProvider,
    'extract.item@1': extractProvider,
  });
  const run = (graphFile: string, runId: string, input: Row) => runGraph(resolve(join(import.meta.dir, '../../plugins/absorb/graph', graphFile)),
    { runId, quiet: true, input, deps: { root: join(root, runId), capabilityProviders: providers } } as unknown as GraphRunOptions);
  try {
    const ingest = await run('absorb-ingest.yaml', 'absorb-ingest-route', { kind: 'text', text: 'new owner-scoped note', context: { memberId: 'member-demo' } });
    const collect = await run('absorb-brief.yaml', 'absorb-owner-collect', { ask: 'collect member scraps', context: { memberId: 'member-demo', kstDay: '2026-11-09' } });
    const ownSuggestions = await run('absorb-suggest-list.yaml', 'absorb-list-owned-suggestions', { ask: 'list', context: { memberId: 'member-demo' } });
    const added = scraps.find((row) => row.id === 'scrap-added-by-route');
    const collectRecord = collect.nodes.find((node) => node.nodeId === collectNodeId);
    const collectedItems = object(object(typeof collectRecord?.output === 'string' ? JSON.parse(collectRecord.output) : collectRecord?.output).evidence).items;
    const listedRecord = ownSuggestions.nodes.find((node) => node.nodeId === suggestionsListNodeId);
    const listedItems = object(object(typeof listedRecord?.output === 'string' ? JSON.parse(listedRecord.output) : listedRecord?.output).evidence).items;
    const ok = ingest.status === 'done' && added?.owner === 'member-demo' && added.status === 'new' && added.text === 'new owner-scoped note'
      && Array.isArray(collectedItems) && collectedItems.some((row) => object(row).id === added.id)
      && !collectedItems.some((row) => object(row).id === 'private-other-member')
      && ownSuggestions.status === 'done' && Array.isArray(listedItems) && listedItems.length === 1 && object(listedItems[0]).id === 'suggestion-owned';
    return { ok, route: match.name, handler, ingestStatus: ingest.status, addedScrap: added,
      collectedOwnerItems: collectedItems, readOnlySuggestionList: listedItems, dailyBriefStatus: collect.status };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function object(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Fake-only board handoff matching the checked-in GCP demo artifact manifest. */
export function fakeBoardAttachmentReferences(): Row[] {
  const manifestPath = resolve(import.meta.dir, '../../plugins/gcp-architect-expand/sim/sample-output/board-attachments.json');
  const manifest = object(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (manifest.status !== 'artifacts-ready' || manifest.deploymentStatus !== 'unverified')
    throw new Error('fake board attachment manifest has an unexpected readiness boundary');
  const attachments = Array.isArray(manifest.attachments) ? manifest.attachments.map(object) : [];
  const selected = attachments.filter((attachment) => attachment.kind === 'diagram' || attachment.kind === 'pdf');
  if (selected.length !== 2 || selected.filter((attachment) => attachment.kind === 'diagram').length !== 1
    || selected.filter((attachment) => attachment.kind === 'pdf').length !== 1
    || selected.some((attachment) => typeof attachment.url !== 'string' || !attachment.url.startsWith('./')))
    throw new Error('fake board attachment manifest must provide diagram and PDF artifact paths');
  return selected;
}

function resultFrom(output: unknown): Row {
  const parsed = typeof output === 'string' ? (() => { try { return JSON.parse(output) as unknown; } catch { return {}; } })() : output;
  return object(object(parsed).result);
}

function inputContext(value: unknown): Row {
  return object(object(value).context);
}

function parsePromptInput(prompt: string): Row {
  const match = prompt.match(/Input:\s*(\{[\s\S]*\})\s*$/);
  if (!match?.[1]) return {};
  try { return object(JSON.parse(match[1]) as unknown); } catch { return {}; }
}

function fakeModel(prompt: string, world: Row, calls: string[], fallbackKstDay: string): string {
  const input = parsePromptInput(prompt);
  const context = object(input.context);
  const prior = object(input.prior);
  const kstDay = text(context.kstDay) || fallbackKstDay;
  const fixture = object(world.fixtures);
  const fixtureMember = Array.isArray(fixture.members)
    ? fixture.members.map(object).find((member) => member.id === 'member-demo')
    : undefined;
  const apps = fixtureMember?.apps;
  calls.push(prompt.includes('absorb/card') ? 'absorb/card' : prompt.includes('absorb/brief') ? 'absorb/brief'
    : prompt.includes('absorb/build') ? 'absorb/build' : 'absorb/suggest');
  if (prompt.includes('absorb/card')) {
    const items = Array.isArray(prior.items) ? prior.items.map(object) : [];
    const cards = items.map((item) => ({ id: `card-${text(item.id)}`, scrapId: item.id, title: item.title ?? item.kind, points: [item.text], tags: [item.kind] }));
    return JSON.stringify({ outcome: 'done', result: { cards }, evidence: { cards, scrapIds: cards.map((card) => card.scrapId) } });
  }
  if (prompt.includes('absorb/brief')) {
    const cards = Array.isArray(prior.cards) ? prior.cards.map(object) : [];
    // Source: 내부 문서 `DEMO-INTEGRATED-NORTH-STAR` scene 2; 300 is the declared synthetic scenario load.
    const summary = '티켓 예매 서비스 · 동시 300명. 쟁점: 동시 접속 · 중복 예매 · 공정 대기열.';
    return JSON.stringify({ outcome: 'done', result: { id: `brief-${text(context.memberId)}-${kstDay}`, summary, groups: cards, todos: [], scrapIds: cards.map((card) => card.scrapId) },
      evidence: { briefing: { id: `brief-${text(context.memberId)}-${kstDay}`, summary, groups: cards, todos: [], scrapIds: cards.map((card) => card.scrapId) },
        memberId: context.memberId, kstDay, scrapIds: cards.map((card) => card.scrapId) } });
  }
  if (prompt.includes('absorb/build')) {
    const artifact = { id: `artifact-${text(context.suggestionId) || 'member-demo'}`, files: { '/index.html': '<main>simulated ticketing service</main>' } };
    // Source: 내부 문서 `DEMO-INTEGRATED-NORTH-STAR` scene 2; 300 is the declared synthetic scenario load.
    const capacityAssumption = { concurrentUsers: 300, rationale: 'North-star test scenario declares 300 concurrent ticketing users.', source: 'docs/conductor/DEMO-INTEGRATED-NORTH-STAR.md#scene-2', userSpecified: true };
    const service = 'ticketing service';
    return JSON.stringify({ outcome: 'done', result: { artifact, service, capacityAssumption }, evidence: { artifact, service, capacityAssumption, suggestionId: context.suggestionId, owner: context.memberId } });
  }
  const slotList = Array.isArray(context.appSlots) ? context.appSlots.map(object) : Array.isArray(apps) ? apps.map(object) : [];
  const scrapIds = Array.isArray(prior.scrapIds) ? prior.scrapIds : [];
  const sourceMarker = scrapIds.find((id) => /^[a-f0-9]{16}$/u.test(id));
  const suggestions = slotList.length && scrapIds.length ? [1, 2].map((index) => ({
    id: `suggestion-${kstDay}-${index}${sourceMarker ? `-${sourceMarker}` : ''}`, appId: slotList[0]!.id,
    ask: `우리 행사용 티켓팅 서비스 만들어 볼까요?${sourceMarker ? ` · 원본 스크랩 ${sourceMarker}` : ''}`,
    change: `브리핑 근거를 반영한 티켓팅 서비스 ${index}`, evidenceScrapIds: scrapIds })) : [];
  return JSON.stringify({ outcome: 'done', result: { items: suggestions }, evidence: { suggestions, matchedSlotIds: slotList.map((slot) => slot.id) } });
}

/** Run the plugin's graph through the production runGraph with a fully local fake capability world. */
export async function runAbsorbGraphSimulation(options: {
  confirmation?: string; worldPath?: string; briefOnly?: boolean; buildOnly?: boolean; receiptScenariosOnly?: boolean; routeReceiptOnly?: boolean; buildGraphFile?: string;
  routeSuggestionId?: string; memberId?: string;
  boardAttachments?: readonly Row[];
  dispatchGraph?: (graphFile: string, options: GraphRunOptions) => Promise<GraphRunState>;
  approvalRunId?: string;
  onSuggestion?: (records: { briefing: Row; suggestions: readonly Row[] }) => Promise<void>;
  onAppPublish?: (event: { action: 'simulate' | 'publish'; runId: string; suggestion: Row; artifact: Row; result: Row; evidence: Row }) => Promise<void>;
  onAcceptedBuild?: (state: Awaited<ReturnType<typeof runGraph>>) => Promise<void>;
} = {}): Promise<Row> {
  const worldPath = resolve(options.worldPath ?? join(import.meta.dir, '../../plugins/absorb/sims/absorb-demo-world.yaml'));
  const world = object(parseYaml(readFileSync(worldPath, 'utf8')));
  const graphRoot = resolve(join(import.meta.dir, '../../plugins/absorb/graph'));
  const buildHitlNodeIds = declaredHitlNodeIds(join(graphRoot, 'absorb-build.yaml'));
  const briefGraphId = text(object(object(parseYaml(readFileSync(join(graphRoot, 'absorb-brief.yaml'), 'utf8'))).graph).id);
  const buildGraphId = text(object(object(parseYaml(readFileSync(join(graphRoot, 'absorb-build.yaml'), 'utf8'))).graph).id);
  const pluginPath = resolve(join(import.meta.dir, '../../plugins/absorb/plugin.yaml'));
  const pluginDeclaration = object(parseYaml(readFileSync(pluginPath, 'utf8')));
  const manifest = parsePluginManifest({ id: pluginDeclaration.id, name: pluginDeclaration.name,
    version: pluginDeclaration.version, contributes: pluginDeclaration.contributes });
  const allowedGraphIds = declaredGraphIds(pluginPath, pluginDeclaration);
  const routeDecision = routeToolIntentWithFallback('제안 적용해줘',
    () => buildToolRouteIndex([{ pluginId: manifest.id, tools: manifest.contributes.aiTools ?? [] }],
      { allowedGraphIdsByPlugin: new Map([[manifest.id, allowedGraphIds]]) }),
    { enabledPluginIds: new Set([manifest.id]), allowedGraphIds: declaredGraphIds(pluginPath, pluginDeclaration) });
  const acceptMatch = routeDecision.matches.find((match) => match.name === 'suggest_accept');
  if (!acceptMatch) throw new Error('absorb simulation could not route suggest_accept');
  const acceptHandler = manifest.contributes.aiTools?.find((tool) => tool.name === acceptMatch.name)?.handler;
  if (acceptHandler !== './graph:absorb-build') throw new Error(`suggest_accept must dispatch to absorb-build, received ${String(acceptHandler)}`);
  let acceptHandlerCalls = 0;
  const confirmationDispatch = dispatchToolRoute(acceptMatch, options.confirmation?.toLowerCase() === 'y', () => {
    acceptHandlerCalls += 1;
    return acceptHandler.slice('./graph:'.length);
  }, { allowedGraphIds: declaredGraphIds(pluginPath, pluginDeclaration) });
  const fixture = object(world.fixtures);
  const members = Array.isArray(fixture.members) ? fixture.members.map(object) : [];
  const fixtureMember = members.find((candidate) => candidate.id === 'member-demo');
  const member: Row | undefined = fixtureMember ? { ...fixtureMember, ...(options.memberId ? { id: options.memberId } : {}) } : undefined;
  if (!member) throw new Error('absorb simulation requires the declared member-demo fixture');
  if (!options.briefOnly && confirmationDispatch.status === 'confirmation-required') {
    if (acceptHandlerCalls !== 0) throw new Error('suggest_accept dispatched before confirmation');
    return { ok: true, started: false, reason: 'confirmation-default-n', route: acceptMatch.name,
      dispatch: confirmationDispatch.status, handlerCalls: acceptHandlerCalls, appHostCalls: 0, llmCalls: 0 };
  }
  if (!options.briefOnly && confirmationDispatch.status !== 'dispatched') throw new Error('suggest_accept graph route is not allowlisted');

  const scraps = Array.isArray(fixture.scraps) ? fixture.scraps.map(value => {
    const row = object(value);
    return options.memberId && row.owner === fixtureMember!.id ? { ...row, owner: member.id } : row;
  }) : [];
  const storedScraps = [...scraps];
  const storedBriefings: Row[] = [];
  const storedSuggestions: Row[] = Array.isArray(fixture.suggestions)
    ? fixture.suggestions.map((suggestion: unknown) => {
      const row = object(suggestion);
      return options.memberId && row.owner === fixtureMember!.id ? { ...row, owner: member.id } : row;
    }) : [];
  const appSlots: Row[] = Array.isArray(member.apps) ? member.apps.map((value: unknown) => {
    const row = object(value);
    return options.memberId && row.owner === fixtureMember!.id ? { ...row, owner: member.id } : row;
  }) : [];
  const calls = { llm: [] as string[], notifications: [] as string[], appHost: [] as string[], appHostByRun: new Map<string, string[]>(),
    boardEvents: [] as Row[],
    llmPrompts: [] as string[],
    appHostBodyByRun: new Map<string, string>(),
    appPublishSimulations: [] as Array<{ runId: string; suggestionId: string; outcome: string; requireOwnerRef: string; suggestionRef: string; artifactRef: string }>,
    appPublishAttempts: [] as Array<{ runId: string; requirePassingReceipt: boolean; receiptRef: string; artifactRef: string }>,
    extractionKinds: [] as string[], ownersRead: [] as string[], storeWrites: [] as string[], suggestionLookups: [] as string[],
    suggestionLookupsByRun: new Map<string, Array<{ owner: string; suggestionId: string; found: boolean; reason?: string }>>() };
  const delivered = new Set<string>();
  const app = appSlots[0];
  if (!app || typeof app.id !== 'string') throw new Error('absorb simulation has no fake member app slot');
  const host = createFakeAppHost([{ slug: app.id, current: 'v1', versions: [{ id: 'v1', files: { '/index.html': '<main>v1</main>' } }] }]);

  const fakeStt: GraphCapabilityProvider = async ({ nodeId }) => ({ ok: true, outcome: 'done', result: { text: `fake stt ${nodeId}` }, evidence: { provider: 'fake-stt' } });
  const fakeOcr: GraphCapabilityProvider = async ({ nodeId }) => ({ ok: true, outcome: 'done', result: { text: `fake ocr ${nodeId}` }, evidence: { provider: 'fake-ocr' } });
  const storeProvider: GraphCapabilityProvider = async ({ runId, nodeInput, input, graphInput, outputs }) => {
      const config = object(nodeInput);
      const query = config;
      const context = inputContext(graphInput ?? input);
      const runInput = object(graphInput ?? input);
      if (query.op === 'list' && query.collection === 'scraps') {
        calls.ownersRead.push(text(context.memberId));
        const owned = storedScraps.filter((scrap) => scrap.owner === context.memberId && scrap.status === 'new');
        return { ok: true, outcome: 'done', result: { items: owned }, evidence: { owner: context.memberId, items: owned, count: owned.length } };
      }
      if (query.op === 'list' && query.collection === 'member-app-slots') {
        const owned = appSlots.filter((slot) => slot.owner === context.memberId || slot.owner === undefined);
        return { ok: true, outcome: 'done', result: { items: owned }, evidence: { owner: context.memberId, count: owned.length } };
      }
      if (query.op === 'list' && query.collection === 'suggestions') {
        const owned = storedSuggestions.filter((suggestion) => suggestion.owner === context.memberId);
        return { ok: true, outcome: 'done', result: { items: owned }, evidence: { owner: context.memberId, items: owned, count: owned.length } };
      }
      if (query.op === 'get' && query.collection === 'suggestions') {
        const suggestionId = text(runInput.suggestionId);
        calls.suggestionLookups.push(`${text(context.memberId)}:${suggestionId}`);
        const runLookups = calls.suggestionLookupsByRun.get(runId) ?? [];
        const suggestion = storedSuggestions.find((row) => row.id === suggestionId && row.owner === context.memberId);
        if (!suggestion) {
          const reason = storedSuggestions.some((row) => row.id === suggestionId) ? 'owner-mismatch' : 'not-found';
          runLookups.push({ owner: text(context.memberId), suggestionId, found: false, reason });
          calls.suggestionLookupsByRun.set(runId, runLookups);
          return { ok: false, outcome: 'failed', evidence: { owner: context.memberId, suggestionId, reason }, error: 'suggestion unavailable for verified member' };
        }
        runLookups.push({ owner: text(context.memberId), suggestionId, found: true });
        calls.suggestionLookupsByRun.set(runId, runLookups);
        return { ok: true, outcome: 'done', result: suggestion, evidence: { owner: context.memberId, suggestion } };
      }
      if (query.op === 'create' && query.collection === 'scraps') {
        const saved = { ...runInput, id: text(runInput.id) || `scrap-added-${storedScraps.length + 1}`,
          owner: text(context.memberId), status: text(query.status) || 'new' };
        storedScraps.push(saved);
        calls.storeWrites.push(`scraps:${text(saved.id)}:${text(saved.owner)}:${text(saved.status)}`);
        return { ok: true, outcome: 'done', result: saved, evidence: { stored: saved } };
      }
      if (query.op === 'upsert' && query.collection === 'briefings') {
        const briefing = object(object(outputs.brief).evidence).briefing;
        if (briefing && object(briefing).id) {
          const row = { ...object(briefing), id: text(object(briefing).id), owner: text(context.memberId), kstDay: text(context.kstDay) };
          const index = storedBriefings.findIndex((candidate) => candidate.owner === row.owner && candidate.kstDay === row.kstDay);
          if (index >= 0) storedBriefings[index] = row; else storedBriefings.push(row);
          calls.storeWrites.push(`briefings:${row.owner}:${row.kstDay}`);
        }
        return { ok: true, outcome: 'done', result: { stored: true }, evidence: { stored: true, count: storedBriefings.length } };
      }
      if (query.op === 'upsert' && query.collection === 'suggestions') {
        const suggestion = object(query.suggestion);
        const id = query.key;
        const value = query.value;
        const rowValue = object(value);
        if (typeof id !== 'string' || !id || rowValue.id !== id)
          return { ok: false, outcome: 'failed', evidence: { reason: 'mapped-key-value-mismatch', key: query.key, value: query.value }, error: 'suggestion upsert key/value must resolve to the same mapped id' };
        const row = { ...rowValue, owner: text(context.memberId) };
        const index = storedSuggestions.findIndex((candidate) => candidate.id === id && candidate.owner === row.owner);
        if (index >= 0) storedSuggestions[index] = row; else storedSuggestions.push(row);
        calls.storeWrites.push(`suggestions:${row.owner}:${id}`);
        return { ok: true, outcome: 'done', result: { stored: true, id }, evidence: { stored: true, suggestionId: id } };
      }
      return { ok: true, outcome: 'done', result: { operation: query.op ?? 'read' }, evidence: { operation: query.op ?? 'read' } };
  };
  const extractProvider: GraphCapabilityProvider = async ({ input, nodeInput, graphInput, outputs }) => {
      const collectResult = object(object(outputs.collect).result);
      const rows = Array.isArray(collectResult.items) ? collectResult.items.map(object) : [];
      const mappedScrap = object(nodeInput).scrap;
      const candidates = mappedScrap && typeof mappedScrap === 'object' ? [object(mappedScrap)] : rows;
      const owned = candidates.filter((scrap) => scrap.owner === inputContext(graphInput ?? input).memberId);
      let items: Row[];
      try {
        items = await Promise.all(owned.map(async (scrap) => {
          const kind = text(scrap.kind);
          calls.extractionKinds.push(kind);
          let extracted: string;
          if (kind === 'photo') {
            const result = await fakeOcr({ graphId: briefGraphId, runId: 'absorb-sim-extract', nodeId: `ocr-${text(scrap.id)}`, input: scrap, nodeInput: scrap, outputs: {} });
            extracted = `OCR: ${text(object(result.result).text)}`;
          } else if (kind === 'voice' || kind === 'video') {
            const result = await fakeStt({ graphId: briefGraphId, runId: 'absorb-sim-extract', nodeId: `stt-${text(scrap.id)}`, input: scrap, nodeInput: scrap, outputs: {} });
            extracted = `STT: ${text(object(result.result).text)}`;
          } else extracted = kind === 'text' ? text(scrap.text) : `Extracted ${kind}: ${text(scrap.url)}`;
          return { id: scrap.id, kind, title: `${kind} scrap`, text: extracted, sourceRef: scrap.url ?? scrap.mediaRef ?? scrap.id };
        }));
      } catch (cause) {
        return { ok: false, outcome: 'failed', error: cause instanceof Error ? cause.message : String(cause) };
      }
      const result = mappedScrap && items[0] ? items[0] : { items, text: items.map((item) => item.text).join('\n') };
      return { ok: true, outcome: 'done', result,
        evidence: { extractionKinds: items.map((item) => item.kind), scrapIds: items.map((item) => item.id) } };
  };
  const notifyProvider: GraphCapabilityProvider = async ({ outputs, nodeInput }) => {
      const config = object(nodeInput);
      const channelsValue = config.channels ?? object(config.with).channels;
      const channels = Array.isArray(channelsValue) ? channelsValue as string[] : [];
      const brief = object(object(outputs.brief).evidence).briefing;
      const briefId = text(object(brief).id);
      const sent = channels.filter((channel) => {
        const key = `${briefId}:${channel}`;
        if (!briefId || delivered.has(key)) return false;
        delivered.add(key);
        calls.notifications.push(key);
        return true;
      });
      return { ok: true, outcome: 'done', result: { delivered: sent }, evidence: { briefingId: briefId } };
  };
  const boardEventProvider: GraphCapabilityProvider = async ({ nodeInput }) => {
      const config = object(nodeInput);
      const event = object(config.event);
      if (config.operation !== 'append' || !text(config.memberId) || event.memberId !== config.memberId
        || event.type !== 'board.card' || !text(event.cardId) || !text(event.at)) {
        return { ok: false, outcome: 'fail', error: 'invalid fake board event contract' };
      }
      calls.boardEvents.push(structuredClone(event));
      return { ok: true, outcome: 'ok', result: { appended: true } };
  };
  const appPublishProvider: GraphCapabilityProvider = async ({ runId, input, nodeInput, graphInput, outputs }) => {
      const context = inputContext(graphInput ?? input);
      const config = object(nodeInput);
      const action = text(config.action);
      const buildEvidence = object(object(outputs.build).evidence);
      const artifact = object(buildEvidence.artifact);
      const suggestion = object(object(object(outputs['lookup-suggestion']).evidence).suggestion);
      if (action === 'simulate') {
        if (text(config.requireOwner) !== text(context.memberId) || JSON.stringify(config.suggestion) !== JSON.stringify(suggestion)
          || JSON.stringify(config.artifact) !== JSON.stringify(artifact) || !text(artifact.id)
          || buildEvidence.owner !== context.memberId || suggestion.owner !== context.memberId) {
          return { ok: false, outcome: 'failed', evidence: { reason: 'artifact-or-owner-validation-failed' }, error: 'isolated simulation input rejected' };
        }
        const simulationOutcome = text(context.simulationOutcome);
        calls.appPublishSimulations.push({ runId, suggestionId: text(suggestion.id), outcome: simulationOutcome,
          requireOwnerRef: text(config.requireOwner), suggestionRef: text(config.suggestion), artifactRef: text(config.artifact) });
        if (simulationOutcome === 'missing') return { ok: true, outcome: 'done', result: { artifactId: artifact.id }, evidence: { artifactId: artifact.id, isolated: true } };
        const passed = simulationOutcome !== 'failed';
        const receipt = { id: `sim-receipt-${text(artifact.id)}`, artifactId: simulationOutcome === 'mismatched' ? 'foreign-artifact' : artifact.id,
          owner: context.memberId, status: passed ? 'passed' : 'failed' };
        const result = { artifactId: artifact.id };
        const evidence = { receipt, artifactId: artifact.id, isolated: true };
        await options.onAppPublish?.({ action, runId, suggestion, artifact, result, evidence });
        return { ok: passed, outcome: passed ? 'done' : 'failed', result, evidence };
      }
      if (action !== 'publish') return { ok: false, outcome: 'failed', evidence: { reason: 'unknown-action', action }, error: 'unsupported app-publish action' };
      const simulationEvidence = object(outputs.simulate);
      const receipt = object(object(simulationEvidence.evidence).receipt);
      calls.appPublishAttempts.push({ runId, requirePassingReceipt: config.requirePassingReceipt === true,
        receiptRef: JSON.stringify(config.receipt), artifactRef: JSON.stringify(config.artifact) });
      if (config.requirePassingReceipt !== true || JSON.stringify(config.receipt) !== JSON.stringify(receipt)
        || JSON.stringify(config.artifact) !== JSON.stringify(artifact)) {
        return { ok: false, outcome: 'failed', evidence: { reason: 'absorb-build-publish-receipt-contract-missing' }, error: 'publish receipt contract missing' };
      }
      const runAppHostCalls: string[] = [];
      const result = publishFakeSimulatedArtifact({ host, appId: String(app.id), owner: text(context.memberId), artifact, receipt, calls: runAppHostCalls });
      calls.appHost.push(...runAppHostCalls);
      calls.appHostByRun.set(runId, runAppHostCalls);
      if (result.ok) await options.onAppPublish?.({ action, runId, suggestion, artifact, result: object(result.result), evidence: object(result.evidence) });
      return result;
  };
  const providers = absorbSimulationCapabilityRegistry({
    'store.read@1': storeProvider,
    'store.write@1': storeProvider,
    'store.events@1': boardEventProvider,
    'extract.item@1': extractProvider,
    'notify.channel@1': notifyProvider,
    'app-publish.action@1': appPublishProvider,
  });

  const root = mkdtempSync(join(tmpdir(), 'absorb-v2-runGraph-sim-'));
  try {
    const run = async (graphFile: string, kstDay: string, runId: string,
      runOptions: { suggestionId?: string; simulationOutcome?: 'passed' | 'failed' | 'missing' | 'mismatched'; memberId?: string; resumeRunId?: string; boardAttachments?: readonly Row[] } = {}) => {
      const file = graphFile === 'absorb-build.yaml' && options.buildGraphFile
        ? options.buildGraphFile : resolve(join(import.meta.dir, '../../plugins/absorb/graph', graphFile));
      const graphOptions = { ...(!runOptions.resumeRunId ? { runId } : {}), ...(runOptions.resumeRunId ? { resumeRunId: runOptions.resumeRunId } : {}), quiet: true, input: { ask: 'run the member absorb graph', suggestionId: runOptions.suggestionId ?? 'suggestion-member-demo', startedAt: '2026-11-10T00:00:00.000Z', context: { memberId: member.id, kstDay, runId,
        appSlots, appRef: app.id, suggestionId: runOptions.suggestionId ?? 'suggestion-member-demo', mode: 'upgrade',
        simulationOutcome: runOptions.simulationOutcome ?? 'passed', ...(runOptions.memberId ? { memberId: runOptions.memberId } : {}) },
        attachments: runOptions.boardAttachments ?? [] },
        deps: { root: join(root, runId), callLLM: async (prompt: string) => {
          calls.llmPrompts.push(prompt);
          return fakeModel(prompt, world, calls.llm, kstDay);
        }, capabilityProviders: providers } } as unknown as GraphRunOptions;
      const selectedRouteBuild = graphFile === 'absorb-build.yaml'
        && runOptions.suggestionId === (options.routeSuggestionId ?? 'suggestion-2026-11-09-1');
      return options.dispatchGraph && selectedRouteBuild
        ? options.dispatchGraph(file, graphOptions)
        : runGraph(file, graphOptions);
    };

    const start = new Date(text(object(world.clock).start));
    if (!Number.isFinite(start.getTime())) throw new Error('absorb sim world clock.start is invalid');
    if (options.briefOnly) {
      const briefRun = await withSimClock(start, () => run('absorb-brief.yaml', '2026-11-09', 'absorb-brief-only'));
      const briefing = storedBriefings.find((row) => row.owner === member.id);
      const generatedSuggestions = storedSuggestions.filter((row) => row.owner === member.id);
      if (briefRun.status !== 'done' || !briefing || generatedSuggestions.length < 1)
        throw new Error(`absorb briefing graph did not save its owner records: ${JSON.stringify({ status: briefRun.status, briefing, generatedSuggestions })}`);
      await options.onSuggestion?.({ briefing, suggestions: generatedSuggestions });
      return { ok: true, status: briefRun.status, runId: briefRun.runId, graphId: briefGraphId,
        briefing, suggestions: generatedSuggestions, evidence: briefRun.nodes.map(({ nodeId, output, error }) => ({ nodeId, output, error })) };
    }
    if (options.buildOnly) {
      const selectedSuggestionId = options.routeSuggestionId;
      const selectedSuggestion = storedSuggestions.find((row) => row.id === selectedSuggestionId && row.owner === member.id);
      if (!selectedSuggestionId || !selectedSuggestion) throw new Error('absorb build-only simulation requires the saved owner suggestion from the briefing graph');
      let build = await run('absorb-build.yaml', '2026-11-10', options.approvalRunId ?? 'absorb-build-only', {
        suggestionId: selectedSuggestionId, simulationOutcome: 'passed', boardAttachments: options.boardAttachments ?? [] });
      if (build.status !== 'awaiting-approval' || !buildHitlNodeIds.includes(build.pending?.nodeId ?? ''))
        throw new Error(`absorb build-only graph did not stop at publish approval: ${JSON.stringify({ status: build.status, pending: build.pending?.nodeId })}`);
      decideGraphApproval(build.graphId, build.runId, 'approved', text(member.id), join(root, build.runId));
      build = await run('absorb-build.yaml', '2026-11-10', build.runId, {
        suggestionId: selectedSuggestionId, simulationOutcome: 'passed', resumeRunId: build.runId });
      await options.onAcceptedBuild?.(build);
      const lookupNodeId = ['lookup', 'suggestion'].join('-');
      const lookup = resultFrom(build.nodes.find((node) => node.nodeId === lookupNodeId)?.output);
      if (build.status !== 'done' || !build.path.includes('publish') || JSON.stringify(lookup) !== JSON.stringify(selectedSuggestion)) {
        throw new Error(`absorb build-only graph did not use its saved suggestion: ${JSON.stringify({ status: build.status, path: build.path, lookup })}`);
      }
      return { ok: true, started: true, graph: 'plugins/absorb/graph/absorb-build.yaml', status: build.status,
        path: build.path, selectedSuggestion, lookupSuggestion: lookup, llmInputs: calls.llmPrompts,
        boardProgress: calls.boardEvents.filter(event => event.runId === build.runId) };
    }
    if (options.routeReceiptOnly) {
      const sourceRun = await withSimClock(start, () => run('absorb-brief.yaml', '2026-11-09', 'absorb-classic-route-brief'));
      const selectedSuggestionId = options.routeSuggestionId ?? 'suggestion-2026-11-09-1';
      if (sourceRun.status !== 'done' || !storedSuggestions.some(row => row.owner === member.id && row.id === selectedSuggestionId)) {
        throw new Error('classic route receipt requires the fake member suggestion from absorb-brief');
      }
      const build = await run('absorb-build.yaml', '2026-11-09', 'absorb-classic-route-build', {
        suggestionId: selectedSuggestionId, simulationOutcome: 'passed',
      });
      if (build.status !== 'awaiting-approval' || !buildHitlNodeIds.includes(build.pending?.nodeId ?? '')) throw new Error(`classic route Graph v2 build did not reach publish approval: ${JSON.stringify(build)}`);
      return { ok: true, status: build.status, routeSuggestionId: selectedSuggestionId, owner: member.id, graphId: build.graphId };
    }
    if (options.receiptScenariosOnly) {
      const sourceRun = await withSimClock(start, () => run('absorb-brief.yaml', '2026-11-09', 'absorb-receipt-source'));
      const storedSuggestionIds = calls.storeWrites.filter((write) => write.startsWith(`suggestions:${member.id}:`))
        .map((write) => write.slice(`suggestions:${member.id}:`.length)).sort();
      const storedSuggestionId = storedSuggestionIds[0];
      if (sourceRun.status !== 'done' || !storedSuggestionId
        || !storedSuggestions.some((suggestion) => suggestion.id === storedSuggestionId && suggestion.owner === member.id)) {
        throw new Error(`absorb receipt scenarios require a suggestion saved by the actual brief graph: ${JSON.stringify({
          sourceStatus: sourceRun.status, storedSuggestionIds, storeWrites: calls.storeWrites })}`);
      }

      const runIds = {
        failed: 'absorb-receipt-failed',
        missing: 'absorb-receipt-missing',
        mismatched: 'absorb-receipt-mismatched',
        passed: 'absorb-receipt-passed',
        'foreign-owner': 'absorb-receipt-foreign-owner',
      } as const;
      const builds: Record<keyof typeof runIds, Awaited<ReturnType<typeof run>>> = {} as Record<keyof typeof runIds, Awaited<ReturnType<typeof run>>>;
      builds.failed = await run('absorb-build.yaml', '2026-11-09', runIds.failed,
        { suggestionId: storedSuggestionId, simulationOutcome: 'failed' });
      calls.appHostBodyByRun.set(runIds.failed, host.fetch(`${app.id}.app.sim.invalid`, '/').body);
      builds.missing = await run('absorb-build.yaml', '2026-11-09', runIds.missing,
        { suggestionId: storedSuggestionId, simulationOutcome: 'missing' });
      calls.appHostBodyByRun.set(runIds.missing, host.fetch(`${app.id}.app.sim.invalid`, '/').body);
      builds.mismatched = await run('absorb-build.yaml', '2026-11-09', runIds.mismatched,
        { suggestionId: storedSuggestionId, simulationOutcome: 'mismatched' });
      calls.appHostBodyByRun.set(runIds.mismatched, host.fetch(`${app.id}.app.sim.invalid`, '/').body);
      builds.passed = await run('absorb-build.yaml', '2026-11-09', runIds.passed,
        { suggestionId: storedSuggestionId, simulationOutcome: 'passed', boardAttachments: options.boardAttachments ?? [] });
      if (builds.passed.status === 'awaiting-approval' && buildHitlNodeIds.includes(builds.passed.pending?.nodeId ?? '')) {
        decideGraphApproval(builds.passed.graphId, builds.passed.runId, 'approved', 'simulated-owner', join(root, runIds.passed));
        builds.passed = await run('absorb-build.yaml', '2026-11-09', runIds.passed,
          { suggestionId: storedSuggestionId, simulationOutcome: 'passed', resumeRunId: runIds.passed });
      }
      for (const key of ['missing', 'mismatched'] as const) {
        const pendingBuild = builds[key];
        if (pendingBuild.status === 'awaiting-approval' && buildHitlNodeIds.includes(pendingBuild.pending?.nodeId ?? '')) {
          decideGraphApproval(pendingBuild.graphId, pendingBuild.runId, 'approved', 'simulated-owner', join(root, runIds[key]));
          builds[key] = await run('absorb-build.yaml', '2026-11-09', runIds[key], {
            suggestionId: storedSuggestionId, simulationOutcome: key, resumeRunId: runIds[key],
          });
        }
      }
      calls.appHostBodyByRun.set(runIds.passed, host.fetch(`${app.id}.app.sim.invalid`, '/').body);
      builds['foreign-owner'] = await run('absorb-build.yaml', '2026-11-09', runIds['foreign-owner'],
        { suggestionId: 'suggestion-other-member', simulationOutcome: 'passed' });
      calls.appHostBodyByRun.set(runIds['foreign-owner'], host.fetch(`${app.id}.app.sim.invalid`, '/').body);

      const receiptScenarios: Record<string, Row> = {};
      for (const key of Object.keys(runIds) as Array<keyof typeof runIds>) {
        const build = builds[key];
        const runId = runIds[key];
        const suggestionId = key === 'foreign-owner' ? 'suggestion-other-member' : storedSuggestionId;
        const simulation = calls.appPublishSimulations.find((call) => call.runId === runId);
        const publish = calls.appPublishAttempts.find((call) => call.runId === runId);
        const suggestionLookup = calls.suggestionLookupsByRun.get(runId)?.find((lookup) => lookup.suggestionId === suggestionId);
        const simulationOutput = object(typeof build.nodes.find(node => node.nodeId === ['sim', 'ulate'].join(''))?.output === 'string'
          ? JSON.parse(String(build.nodes.find(node => node.nodeId === ['sim', 'ulate'].join(''))?.output)) : build.nodes.find(node => node.nodeId === ['sim', 'ulate'].join(''))?.output);
        const buildOutput = object(typeof build.nodes.find(node => node.nodeId === ['buil', 'd'].join(''))?.output === 'string'
          ? JSON.parse(String(build.nodes.find(node => node.nodeId === ['buil', 'd'].join(''))?.output)) : build.nodes.find(node => node.nodeId === ['buil', 'd'].join(''))?.output);
        receiptScenarios[key] = { graphId: build.graphId, status: build.status, path: build.path, suggestionId,
          suggestionWasSavedByBrief: key === 'foreign-owner' ? false : storedSuggestionIds.includes(suggestionId),
          suggestionStoredForOtherOwner: key === 'foreign-owner' && storedSuggestions.some((suggestion) => suggestion.id === suggestionId && suggestion.owner !== member.id),
          suggestionLookupObserved: suggestionLookup !== undefined, suggestionLookupFound: suggestionLookup?.found,
          suggestionLookupReason: suggestionLookup?.reason,
          simulateReached: simulation !== undefined, simulateSuggestionId: simulation?.suggestionId, simulateOutcome: simulation?.outcome,
          publishNodeReached: publish !== undefined, requirePassingReceipt: publish?.requirePassingReceipt === true,
          receiptMapped: publish?.receiptRef === JSON.stringify(object(object(simulationOutput.evidence).receipt)),
          artifactMapped: publish?.artifactRef === JSON.stringify(object(object(buildOutput.evidence).artifact)),
          appHostCalls: calls.appHostByRun.get(runId) ?? [],
          ...(key === 'failed' || key === 'missing' || key === 'mismatched'
            ? { currentBody: calls.appHostBodyByRun.get(runId) } : {}) };
      }
      const receiptCasesPass = ['failed', 'missing', 'mismatched'].every((key) => {
        const scenario = object(receiptScenarios[key]);
        return scenario.graphId === buildGraphId && scenario.status === 'failed' && scenario.suggestionWasSavedByBrief === true
          && scenario.suggestionLookupObserved === true && scenario.simulateReached === true && scenario.simulateSuggestionId === storedSuggestionId
          && Array.isArray(scenario.appHostCalls) && scenario.appHostCalls.length === 0 && scenario.currentBody === '<main>v1</main>'
          && (key === 'failed' ? scenario.publishNodeReached === false
            : key === 'missing' ? scenario.publishNodeReached === false && Array.isArray(scenario.path) && scenario.path.includes('publish')
              : scenario.publishNodeReached === true && scenario.requirePassingReceipt === true && scenario.receiptMapped === true && scenario.artifactMapped === true);
      });
      const passed = object(receiptScenarios.passed);
      const foreign = object(receiptScenarios['foreign-owner']);
      const ok = receiptCasesPass && passed.graphId === buildGraphId && passed.status === 'done'
        && passed.simulateReached === true && passed.publishNodeReached === true && passed.requirePassingReceipt === true
        && Array.isArray(passed.appHostCalls) && passed.appHostCalls.length === 1
        && foreign.suggestionStoredForOtherOwner === true && foreign.suggestionLookupObserved === true && foreign.suggestionLookupFound === false
        && foreign.suggestionLookupReason === 'owner-mismatch' && foreign.status === 'failed' && foreign.simulateReached === false
        && Array.isArray(foreign.appHostCalls) && foreign.appHostCalls.length === 0;
      if (!ok) throw new Error(`absorb-build receipt boundary invariants failed: ${JSON.stringify({ storedSuggestionIds, receiptScenarios })}`);
      return { ok, started: true, graph: 'plugins/absorb/graph/absorb-build.yaml', storedSuggestionId, receiptScenarios,
        suggestionStoreWrites: calls.storeWrites.filter((write) => write.startsWith(`suggestions:${member.id}:`)),
        suggestionLookups: calls.suggestionLookups };
    }
    const first = await withSimClock(start, async (clock) => {
      const firstRun = await run('absorb-brief.yaml', '2026-11-09', 'absorb-demo-first');
      const repeatedRun = await run('absorb-brief.yaml', '2026-11-09', 'absorb-demo-repeat');
      const sameDayNotificationCount = calls.notifications.length;
      clock.setTime(new Date('2026-11-10T00:01:00+09:00'));
      const nextDayRun = await run('absorb-brief.yaml', '2026-11-10', 'absorb-demo-next-day');
      return { firstRun, repeatedRun, nextDayRun, sameDayNotificationCount, simulatedNow: new Date(clock.now()).toISOString() };
    });
    const acceptedSuggestionId = options.routeSuggestionId ?? 'suggestion-2026-11-09-1';
    let acceptedBuild = await run('absorb-build.yaml', '2026-11-10', options.approvalRunId ?? 'absorb-demo-build-pass', {
      suggestionId: acceptedSuggestionId, simulationOutcome: 'passed', boardAttachments: options.boardAttachments ?? [] });
    // Source: #36491; the KAIST test owner approves only after the simulated publish graph pauses at its explicit HITL node.
    if (options.onAcceptedBuild && acceptedBuild.status === 'awaiting-approval'
      && buildHitlNodeIds.includes(acceptedBuild.pending?.nodeId ?? '')) {
      decideGraphApproval(acceptedBuild.graphId, acceptedBuild.runId, 'approved', text(member.id), join(root, acceptedBuild.runId));
      acceptedBuild = await run('absorb-build.yaml', '2026-11-10', acceptedBuild.runId, {
        suggestionId: acceptedSuggestionId, simulationOutcome: 'passed', resumeRunId: acceptedBuild.runId });
    }
    await options.onAcceptedBuild?.(acceptedBuild);
    const acceptedBuildTwo = await run('absorb-build.yaml', '2026-11-10', 'absorb-demo-build-pass-two', {
      suggestionId: 'suggestion-2026-11-09-2', simulationOutcome: 'passed' });
    const rejectedBuild = await run('absorb-build.yaml', '2026-11-10', 'absorb-demo-build-fail', { simulationOutcome: 'failed' });
    const missingReceiptBuild = await run('absorb-build.yaml', '2026-11-10', 'absorb-demo-build-missing', { simulationOutcome: 'missing' });
    const mismatchedReceiptBuild = await run('absorb-build.yaml', '2026-11-10', 'absorb-demo-build-mismatch', { simulationOutcome: 'mismatched' });
    const foreignBuild = await run('absorb-build.yaml', '2026-11-10', 'absorb-demo-build-foreign', { suggestionId: 'suggestion-other-member' });
    const evidence = [first.firstRun, first.repeatedRun, first.nextDayRun].map((run) => ({ runId: run.runId, status: run.status, path: run.path,
      nodes: run.nodes.map(({ nodeId, output, error }) => ({ nodeId, output, error })) }));
    const actualKinds = [...new Set(calls.extractionKinds)].sort();
    const acceptedBuildCompleted = options.onAcceptedBuild
      ? acceptedBuild.status === 'done' && acceptedBuild.path.includes('publish')
      : acceptedBuild.status === 'awaiting-approval' && buildHitlNodeIds.includes(acceptedBuild.pending?.nodeId ?? '');
    const good = evidence.every((entry) => entry.status === 'done') && acceptedBuildCompleted && acceptedBuildTwo.status === 'awaiting-approval'
      && buildHitlNodeIds.includes(acceptedBuildTwo.pending?.nodeId ?? '')
      && rejectedBuild.status === 'failed' && missingReceiptBuild.status === 'failed' && mismatchedReceiptBuild.status === 'failed'
      && foreignBuild.status === 'failed' && calls.appHost.length === (options.onAcceptedBuild ? 1 : 0)
      && first.sameDayNotificationCount === 3 && calls.notifications.length === 6 && calls.llm.length > 0
      && actualKinds.join(',') === ['photo', 'text', 'video', 'voice', 'web', 'x', 'youtube'].join(',')
      && calls.storeWrites.includes(`suggestions:${member.id}:suggestion-2026-11-09-1`)
      && calls.storeWrites.includes(`suggestions:${member.id}:suggestion-2026-11-09-2`)
      && calls.suggestionLookups.includes(`${member.id}:${options.routeSuggestionId ?? 'suggestion-2026-11-09-1'}`)
      && calls.suggestionLookups.includes(`${member.id}:suggestion-2026-11-09-2`)
      && calls.ownersRead.every((owner) => owner === member.id);
    if (!good) throw new Error(`absorb graph simulation invariants failed: ${JSON.stringify({ evidence,
      builds: { accepted: { status: acceptedBuild.status, path: acceptedBuild.path }, acceptedTwo: { status: acceptedBuildTwo.status, path: acceptedBuildTwo.path }, rejected: { status: rejectedBuild.status, path: rejectedBuild.path },
        missingReceipt: { status: missingReceiptBuild.status, path: missingReceiptBuild.path }, mismatchedReceipt: { status: mismatchedReceiptBuild.status, path: mismatchedReceiptBuild.path },
        foreign: { status: foreignBuild.status, path: foreignBuild.path } },
      calls, actualKinds, sameDayNotificationCount: first.sameDayNotificationCount })}`);
    return { ok: true, started: true, route: acceptMatch.name, dispatch: confirmationDispatch.status,
      handlerCalls: acceptHandlerCalls, evidence, llmCalls: calls.llm.length, notificationDeliveries: calls.notifications,
      briefingSummary: text(first.firstRun.nodes.map((node) => resultFrom(node.output))
        .find((result) => typeof result.summary === 'string')?.summary),
      builds: { accepted: { status: acceptedBuild.status, path: acceptedBuild.path }, acceptedTwo: { status: acceptedBuildTwo.status, path: acceptedBuildTwo.path }, rejected: { status: rejectedBuild.status, path: rejectedBuild.path },
        missingReceipt: { status: missingReceiptBuild.status, path: missingReceiptBuild.path }, mismatchedReceipt: { status: mismatchedReceiptBuild.status, path: mismatchedReceiptBuild.path },
        foreign: { status: foreignBuild.status, path: foreignBuild.path } },
      appHostCalls: calls.appHost, sameDayNotificationCount: first.sameDayNotificationCount, nextDayNotificationCount: calls.notifications.length - first.sameDayNotificationCount,
      fakeClock: first.simulatedNow, memberIsolation: calls.ownersRead.every((owner) => owner === member.id), extractionKinds: actualKinds,
      routeSuggestionId: options.routeSuggestionId ?? 'suggestion-2026-11-09-1',
      suggestionStoreWrites: calls.storeWrites.filter((write) => write.startsWith('suggestions:')), suggestionLookups: calls.suggestionLookups,
      boardProgress: calls.boardEvents.filter(event => event.runId === acceptedBuild.runId) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const approvePublish = process.argv.includes('--approve-publish');
  runAbsorbGraphSimulation({ confirmation: process.argv[2] ?? 'N', boardAttachments: fakeBoardAttachmentReferences(),
    ...(approvePublish ? { onAcceptedBuild: async () => {} } : {}) }).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
